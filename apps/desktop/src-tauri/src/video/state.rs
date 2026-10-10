//! Tauri command surface + shared state for the native video engine.
//!
//! Mirrors [`crate::audio::state`] for native publish and receive ownership. Each mutation runs through
//! [`mutate_video_state`], which reconciles LiveKit publications and capture runtimes and
//! emits `video-state-changed` with the full [`VideoMixerState`] snapshot.
//!
//! Screen / window shares that opt to also capture audio reach into the **audio** engine
//! via [`crate::audio::state::add_and_publish_shared_audio_source`], so the shared audio
//! shows up as a normal mixer channel. The audio mutation is performed before the video
//! state lock is taken (never nested), keeping a single, deadlock-free lock order.

use std::sync::{Arc, RwLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use thiserror::Error;

use crate::audio::capture::system_audio_runtime_readiness;
use crate::audio::domain::{AudioSourceId, AudioSourceType};
use crate::audio::state::{
    add_and_publish_shared_audio_source, remove_shared_audio_source, AudioStateError,
    SharedAudioEngineState,
};
use crate::video::capture::{
    list_cameras, list_displays, list_windows, screen_capture_runtime_readiness, VideoCaptureError,
    VideoCaptureManager,
};
use crate::video::domain::{
    CameraDevice, DisplayTarget, PublishedVideoTrack, PublishedVideoTrackId, SelfPreviewMode,
    VideoMixerState, VideoPresentationProfile, VideoPresentationSettings, VideoQualityProfile,
    VideoSourceId, VideoSourceKind, VideoSourceState, VideoTrackSource, WindowTarget,
};
use crate::video::engine::{
    measure_video_network_totals, measure_video_quality_report, stable_video_track_id, VideoEngine,
    VideoNetworkTotals, VideoQualityReport,
};
use crate::video::preview::VideoPreviewController;
use crate::video::stream::{VideoFrameHub, VideoFrameService, VideoStreamEndpoint};

pub const VIDEO_STATE_CHANGED_EVENT: &str = "video-state-changed";

pub type SharedVideoEngineState = Arc<RwLock<VideoEngineState>>;

pub fn new_shared_video_engine_state(hub: VideoFrameHub) -> SharedVideoEngineState {
    Arc::new(RwLock::new(VideoEngineState::new(hub)))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVideoCapabilityReport {
    pub os: String,
    pub issues: Vec<String>,
    pub supported_source_kinds: Vec<VideoSourceKind>,
    pub supports_camera: bool,
    pub supports_display_capture: bool,
    pub supports_window_capture: bool,
    pub supports_display_audio: bool,
    pub supports_window_audio: bool,
}

#[derive(Debug)]
pub struct VideoEngineState {
    pub mixer: VideoMixerState,
    pub capture: VideoCaptureManager,
    pub engine: VideoEngine,
    pub preview: VideoPreviewController,
    pub presentation: Arc<RwLock<VideoPresentationSettings>>,
}

impl VideoEngineState {
    pub fn new(hub: VideoFrameHub) -> Self {
        let presentation = Arc::new(RwLock::new(VideoPresentationSettings::default()));
        let mixer = VideoMixerState {
            presentation: presentation
                .read()
                .map(|settings| settings.clone())
                .unwrap_or_default(),
            ..VideoMixerState::default()
        };
        Self {
            mixer,
            capture: VideoCaptureManager::default(),
            engine: VideoEngine::new(hub.clone(), Arc::clone(&presentation)),
            preview: VideoPreviewController::new(hub, Arc::clone(&presentation)),
            presentation,
        }
    }

    pub fn snapshot(&self) -> VideoMixerState {
        let mut snapshot = self.mixer.clone();
        snapshot.connected = self.engine.is_connected();
        snapshot.viewer_connected = self.engine.is_viewer_connected();
        snapshot
    }

    /// Append a publishing video source, pre-populating its published-track identity so the
    /// engine publishes a stably-named `raven-video-<uuid>` track.
    fn add_publishing_source(
        &mut self,
        kind: VideoSourceKind,
        display_name: String,
        target_id: String,
        process_id: Option<u32>,
        linked_audio_source_id: Option<AudioSourceId>,
        profile: VideoQualityProfile,
    ) -> VideoSourceId {
        let mut source = VideoSourceState::new(kind, display_name, target_id);
        source.process_id = process_id;
        source.linked_audio_source_id = linked_audio_source_id;
        source.publishing = true;
        // The command boundary has already normalized camera/custom profiles and resolved
        // display/window profiles to their real source aspect ratio. Preserve that resolved
        // profile through capture and publishing.
        source.profile = profile;
        let track_id = PublishedVideoTrackId::new();
        source.published_track = Some(PublishedVideoTrack {
            track_id,
            webrtc_track_id: stable_video_track_id(track_id),
            source: VideoTrackSource::from_kind(kind),
            created_at: None,
            updated_at: None,
        });
        let id = source.id;
        self.mixer.local_sources.push(source);
        id
    }

    fn remove_source(&mut self, source_id: VideoSourceId) -> Option<VideoSourceState> {
        let index = self
            .mixer
            .local_sources
            .iter()
            .position(|source| source.id == source_id)?;
        Some(self.mixer.local_sources.remove(index))
    }
}

#[derive(Clone, Debug, Error, Serialize)]
#[serde(tag = "code", content = "detail", rename_all = "camelCase")]
pub enum VideoStateError {
    #[error("video engine state is poisoned")]
    StatePoisoned,
    #[error("video source not found")]
    SourceNotFound { source_id: VideoSourceId },
    #[error("video engine failed: {message}")]
    EngineFailed { message: String },
    #[error("video state event emit failed: {message}")]
    EventEmitFailed { message: String },
    #[error("video capture failed: {0}")]
    Capture(VideoCaptureError),
    #[error("linked audio failed: {message}")]
    Audio { message: String },
}

impl From<VideoCaptureError> for VideoStateError {
    fn from(error: VideoCaptureError) -> Self {
        VideoStateError::Capture(error)
    }
}

impl From<AudioStateError> for VideoStateError {
    fn from(error: AudioStateError) -> Self {
        VideoStateError::Audio {
            message: error.to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn video_get_state(
    state: State<'_, SharedVideoEngineState>,
) -> Result<VideoMixerState, VideoStateError> {
    let guard = state.read().map_err(|_| VideoStateError::StatePoisoned)?;
    Ok(guard.snapshot())
}

#[tauri::command]
pub async fn video_get_network_totals(
    state: State<'_, SharedVideoEngineState>,
) -> Result<VideoNetworkTotals, VideoStateError> {
    let (published_tracks, subscribed_tracks) = {
        let guard = state.read().map_err(|_| VideoStateError::StatePoisoned)?;
        (
            guard.engine.published_tracks(),
            guard.engine.subscribed_tracks(),
        )
    };
    measure_video_network_totals(published_tracks, subscribed_tracks)
        .await
        .map_err(|message| VideoStateError::EngineFailed { message })
}

#[tauri::command]
pub async fn video_get_quality_report(
    state: State<'_, SharedVideoEngineState>,
) -> Result<VideoQualityReport, VideoStateError> {
    let (published_screen_shares, subscribed_screen_shares) = {
        let guard = state.read().map_err(|_| VideoStateError::StatePoisoned)?;
        (
            guard.engine.published_screen_share_tracks(),
            guard.engine.subscribed_screen_share_tracks(),
        )
    };
    measure_video_quality_report(published_screen_shares, subscribed_screen_shares)
        .await
        .map_err(|message| VideoStateError::EngineFailed { message })
}

#[tauri::command]
pub fn video_get_capabilities() -> NativeVideoCapabilityReport {
    let mut supported_source_kinds = vec![VideoSourceKind::Camera];
    let mut issues = Vec::new();

    let screen_capture_available = match screen_capture_runtime_readiness() {
        Ok(()) => cfg!(any(
            target_os = "windows",
            target_os = "linux",
            target_os = "macos"
        )),
        Err(issue) => {
            issues.push(issue);
            false
        }
    };
    let display_audio_available = system_audio_runtime_readiness().is_ok()
        && cfg!(any(
            target_os = "windows",
            target_os = "linux",
            target_os = "macos"
        ));

    if screen_capture_available {
        supported_source_kinds.push(VideoSourceKind::Display);
        supported_source_kinds.push(VideoSourceKind::Window);
    }

    NativeVideoCapabilityReport {
        os: std::env::consts::OS.to_string(),
        issues,
        supported_source_kinds,
        supports_camera: true,
        supports_display_capture: screen_capture_available,
        supports_window_capture: screen_capture_available,
        supports_display_audio: display_audio_available,
        supports_window_audio: cfg!(any(target_os = "windows", target_os = "macos")),
    }
}

#[tauri::command]
pub fn video_set_local_preview_enabled(
    state: State<'_, SharedVideoEngineState>,
    enabled: bool,
) -> Result<(), VideoStateError> {
    let guard = state.read().map_err(|_| VideoStateError::StatePoisoned)?;
    guard.preview.set_enabled(enabled);
    Ok(())
}

#[tauri::command]
pub fn video_get_stream_endpoint(service: State<'_, VideoFrameService>) -> VideoStreamEndpoint {
    service.endpoint()
}

#[tauri::command]
pub fn video_set_self_preview_mode(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    mode: SelfPreviewMode,
) -> Result<VideoMixerState, VideoStateError> {
    mutate_video_state(&app, &state, |state| {
        state.mixer.self_preview_mode = mode;
        state.engine.set_self_preview_mode(mode);
        Ok(())
    })
}

#[tauri::command]
pub fn video_set_presentation_profile(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    profile: VideoPresentationProfile,
) -> Result<VideoMixerState, VideoStateError> {
    mutate_video_state(&app, &state, |state| {
        let settings = VideoPresentationSettings { profile };
        *state
            .presentation
            .write()
            .map_err(|_| VideoStateError::StatePoisoned)? = settings.clone();
        state.mixer.presentation = settings;
        Ok(())
    })
}

#[tauri::command]
pub fn video_set_remote_video_receiving(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    participant_id: String,
    source: VideoTrackSource,
    receiving: bool,
) -> Result<VideoMixerState, VideoStateError> {
    mutate_video_state(&app, &state, |state| {
        state.engine.set_remote_video_receiving(
            &participant_id,
            source,
            receiving,
            state.mixer.self_preview_mode,
        );
        Ok(())
    })
}

#[tauri::command]
pub fn video_list_cameras() -> Result<Vec<CameraDevice>, VideoStateError> {
    Ok(list_cameras()?)
}

#[tauri::command]
pub fn video_list_displays() -> Result<Vec<DisplayTarget>, VideoStateError> {
    Ok(list_displays()?)
}

#[tauri::command]
pub fn video_list_windows() -> Result<Vec<WindowTarget>, VideoStateError> {
    Ok(list_windows()?)
}

#[tauri::command]
pub fn video_connect_room(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    url: String,
    token: String,
    viewer_token: String,
) -> Result<VideoMixerState, VideoStateError> {
    {
        let mut guard = state.write().map_err(|_| VideoStateError::StatePoisoned)?;
        guard
            .engine
            .connect(&app, state.inner(), &url, &token, &viewer_token)
            .map_err(|message| VideoStateError::EngineFailed { message })?;
    }
    mutate_video_state(&app, &state, |_engine| Ok(()))
}

#[tauri::command]
pub fn video_disconnect_room(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    audio_state: State<'_, SharedAudioEngineState>,
) -> Result<VideoMixerState, VideoStateError> {
    // Tear down any audio sources created by active shares, then drop all video sources.
    let linked: Vec<AudioSourceId> = {
        let guard = state.read().map_err(|_| VideoStateError::StatePoisoned)?;
        guard
            .mixer
            .local_sources
            .iter()
            .filter_map(|source| source.linked_audio_source_id)
            .collect()
    };
    for audio_id in linked {
        let _ = remove_shared_audio_source(&app, audio_state.inner(), audio_id);
    }

    {
        let mut guard = state.write().map_err(|_| VideoStateError::StatePoisoned)?;
        guard.engine.disconnect();
        guard.mixer.local_sources.clear();
        guard.mixer.participants.clear();
        guard.mixer.remote_tracks.clear();
        guard.mixer.viewer_connected = false;
    }
    mutate_video_state(&app, &state, |_engine| Ok(()))
}

#[tauri::command]
pub fn video_start_camera(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    camera_id: String,
    display_name: String,
    profile: VideoQualityProfile,
) -> Result<VideoMixerState, VideoStateError> {
    mutate_video_state(&app, &state, |engine| {
        engine.add_publishing_source(
            VideoSourceKind::Camera,
            display_name,
            camera_id,
            None,
            None,
            profile.normalized(),
        );
        Ok(())
    })
}

#[tauri::command]
pub fn video_start_display_share(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    audio_state: State<'_, SharedAudioEngineState>,
    display_id: String,
    display_name: String,
    with_system_audio: bool,
    profile: VideoQualityProfile,
    source_width: u32,
    source_height: u32,
) -> Result<VideoMixerState, VideoStateError> {
    // Create the linked system-audio source first (outside the video lock).
    let linked_audio = if with_system_audio {
        Some(add_and_publish_shared_audio_source(
            &app,
            audio_state.inner(),
            AudioSourceType::SystemAudio,
            format!("{display_name} audio"),
            None,
        )?)
    } else {
        None
    };

    let result = mutate_video_state(&app, &state, |engine| {
        engine.add_publishing_source(
            VideoSourceKind::Display,
            display_name,
            display_id,
            None,
            linked_audio,
            profile.resolved_for_source(source_width, source_height),
        );
        Ok(())
    });
    if result.is_err() {
        if let Some(audio_id) = linked_audio {
            let _ = remove_shared_audio_source(&app, audio_state.inner(), audio_id);
        }
    }
    result
}

#[tauri::command]
pub fn video_start_window_share(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    audio_state: State<'_, SharedAudioEngineState>,
    window_id: String,
    process_id: u32,
    display_name: String,
    with_app_audio: bool,
    profile: VideoQualityProfile,
    source_width: u32,
    source_height: u32,
) -> Result<VideoMixerState, VideoStateError> {
    // Create the linked per-app audio source first (outside the video lock), capturing the
    // window's owning process via the platform app-audio backend.
    let linked_audio = if with_app_audio {
        Some(add_and_publish_shared_audio_source(
            &app,
            audio_state.inner(),
            AudioSourceType::AppAudio,
            format!("{display_name} audio"),
            Some(process_id.to_string()),
        )?)
    } else {
        None
    };

    let result = mutate_video_state(&app, &state, |engine| {
        engine.add_publishing_source(
            VideoSourceKind::Window,
            display_name,
            window_id,
            Some(process_id),
            linked_audio,
            profile.resolved_for_source(source_width, source_height),
        );
        Ok(())
    });
    if result.is_err() {
        if let Some(audio_id) = linked_audio {
            let _ = remove_shared_audio_source(&app, audio_state.inner(), audio_id);
        }
    }
    result
}

#[tauri::command]
pub fn video_set_source_profile(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    source_id: VideoSourceId,
    profile: VideoQualityProfile,
) -> Result<VideoMixerState, VideoStateError> {
    mutate_video_state(&app, &state, |engine| {
        let Some(source) = engine
            .mixer
            .local_sources
            .iter_mut()
            .find(|source| source.id == source_id)
        else {
            return Err(VideoStateError::SourceNotFound { source_id });
        };
        source.profile = profile.normalized();
        Ok(())
    })
}

#[tauri::command]
pub fn video_stop_source(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    audio_state: State<'_, SharedAudioEngineState>,
    source_id: VideoSourceId,
) -> Result<VideoMixerState, VideoStateError> {
    let removed = {
        let mut guard = state.write().map_err(|_| VideoStateError::StatePoisoned)?;
        guard.remove_source(source_id)
    };
    let Some(removed) = removed else {
        return Err(VideoStateError::SourceNotFound { source_id });
    };
    if let Some(audio_id) = removed.linked_audio_source_id {
        let _ = remove_shared_audio_source(&app, audio_state.inner(), audio_id);
    }
    mutate_video_state(&app, &state, |_engine| Ok(()))
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn mutate_video_state(
    app: &AppHandle,
    state: &SharedVideoEngineState,
    mutation: impl FnOnce(&mut VideoEngineState) -> Result<(), VideoStateError>,
) -> Result<VideoMixerState, VideoStateError> {
    let (updated, media_error) = {
        let mut guard = state.write().map_err(|_| VideoStateError::StatePoisoned)?;
        mutation(&mut guard)?;
        let VideoEngineState {
            mixer,
            capture,
            engine,
            preview,
            ..
        } = &mut *guard;
        // Publish/unpublish LiveKit tracks first so the capture manager can attach the
        // matching publish sinks to the capture threads it starts.
        let publication_error = engine.reconcile_publications(&mixer.local_sources).err();
        let source_types = mixer
            .local_sources
            .iter()
            .map(|source| (source.id, VideoTrackSource::from_kind(source.kind)))
            .collect();
        let sinks = preview.wrap_publish_sinks(engine.sink_map(), &source_types);
        let capture_error = capture.reconcile(&mut mixer.local_sources, &sinks);
        (
            guard.snapshot(),
            publication_error
                .map(|message| VideoStateError::EngineFailed { message })
                .or_else(|| {
                    capture_error.map(|message| {
                        VideoStateError::Capture(VideoCaptureError::StreamFailed { message })
                    })
                }),
        )
    };
    emit_video_state_changed(app, &updated)?;
    if let Some(error) = media_error {
        return Err(error);
    }
    Ok(updated)
}

fn emit_video_state_changed(
    app: &AppHandle,
    state: &VideoMixerState,
) -> Result<(), VideoStateError> {
    app.emit(VIDEO_STATE_CHANGED_EVENT, state.clone())
        .map_err(|error| VideoStateError::EventEmitFailed {
            message: error.to_string(),
        })
}
