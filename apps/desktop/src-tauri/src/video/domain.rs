//! Serde types for the native video engine.
//!
//! Mirrors the shape of [`crate::audio::domain`] but for camera / screen-share capture.
//! Rust owns the complete video path: a `<userId>#video` publisher plus the base-identity
//! viewer used for remote media and optional RTC self-preview. The WebView receives only
//! reflected state and bounded presentation URLs; it never owns a WebRTC track or room.

use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::audio::domain::AudioSourceId;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct VideoSourceId(Uuid);

impl VideoSourceId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    pub fn parse(value: &str) -> Option<Self> {
        Uuid::parse_str(value).ok().map(Self)
    }
}

impl Default for VideoSourceId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for VideoSourceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PublishedVideoTrackId(Uuid);

impl PublishedVideoTrackId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for PublishedVideoTrackId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for PublishedVideoTrackId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// What kind of visual source a local video track captures.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoSourceKind {
    /// A webcam / capture device.
    Camera,
    /// A whole monitor / display.
    Display,
    /// A single application window.
    Window,
}

impl Default for VideoSourceKind {
    fn default() -> Self {
        Self::Camera
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoSourceRuntimeStatus {
    Inactive,
    Starting,
    Running,
    Error,
}

impl Default for VideoSourceRuntimeStatus {
    fn default() -> Self {
        Self::Inactive
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VideoSourceRuntimeState {
    pub status: VideoSourceRuntimeStatus,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f32>,
    pub error: Option<String>,
    pub updated_at: Option<String>,
}

impl Default for VideoSourceRuntimeState {
    fn default() -> Self {
        Self {
            status: VideoSourceRuntimeStatus::Inactive,
            width: None,
            height: None,
            fps: None,
            error: None,
            updated_at: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoQualityProfileId {
    Presentation,
    High,
    HighMotion,
    Balanced,
    Low,
    Custom,
}

impl Default for VideoQualityProfileId {
    fn default() -> Self {
        Self::Balanced
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VideoQualityProfile {
    pub profile_id: VideoQualityProfileId,
    pub max_pixels: u32,
    pub width: u32,
    pub height: u32,
    pub fps: f32,
}

impl VideoQualityProfile {
    pub fn presentation() -> Self {
        Self {
            profile_id: VideoQualityProfileId::Presentation,
            max_pixels: 1920 * 1080,
            width: 1920,
            height: 1080,
            fps: 5.0,
        }
    }

    pub fn high() -> Self {
        Self {
            profile_id: VideoQualityProfileId::High,
            max_pixels: 1920 * 1080,
            width: 1920,
            height: 1080,
            fps: 30.0,
        }
    }

    pub fn high_motion() -> Self {
        Self {
            profile_id: VideoQualityProfileId::HighMotion,
            max_pixels: 1280 * 720,
            width: 1280,
            height: 720,
            fps: 60.0,
        }
    }

    pub fn balanced() -> Self {
        Self {
            profile_id: VideoQualityProfileId::Balanced,
            max_pixels: 1280 * 720,
            width: 1280,
            height: 720,
            fps: 30.0,
        }
    }

    pub fn low() -> Self {
        Self {
            profile_id: VideoQualityProfileId::Low,
            max_pixels: 854 * 480,
            width: 854,
            height: 480,
            fps: 15.0,
        }
    }

    pub fn custom(width: u32, height: u32, fps: f32) -> Self {
        Self {
            profile_id: VideoQualityProfileId::Custom,
            max_pixels: width.saturating_mul(height).max(2 * 2),
            width,
            height,
            fps,
        }
        .normalized()
    }

    pub fn normalized(self) -> Self {
        match self.profile_id {
            VideoQualityProfileId::Presentation => self.normalized_preset(Self::presentation()),
            VideoQualityProfileId::High => self.normalized_preset(Self::high()),
            VideoQualityProfileId::HighMotion => self.normalized_preset(Self::high_motion()),
            VideoQualityProfileId::Balanced => self.normalized_preset(Self::balanced()),
            VideoQualityProfileId::Low => self.normalized_preset(Self::low()),
            VideoQualityProfileId::Custom => {
                let width = even_dimension(self.width.clamp(2, 7680));
                let height = even_dimension(self.height.clamp(2, 4320));
                Self {
                    profile_id: VideoQualityProfileId::Custom,
                    max_pixels: self.max_pixels.max(width.saturating_mul(height)).max(2 * 2),
                    width,
                    height,
                    fps: if self.fps.is_finite() {
                        self.fps.clamp(1.0, 120.0)
                    } else {
                        30.0
                    },
                }
            }
        }
    }

    fn normalized_preset(self, preset: Self) -> Self {
        Self {
            profile_id: preset.profile_id,
            max_pixels: preset.max_pixels,
            width: if self.width >= 2 {
                even_dimension(self.width)
            } else {
                preset.width
            },
            height: if self.height >= 2 {
                even_dimension(self.height)
            } else {
                preset.height
            },
            fps: preset.fps,
        }
    }

    pub fn resolved_for_source(self, source_width: u32, source_height: u32) -> Self {
        let profile = self.normalized();
        if source_width == 0 || source_height == 0 {
            return profile;
        }
        let (width, height) =
            output_dimensions_for_budget(source_width, source_height, profile.max_pixels);
        Self {
            width,
            height,
            ..profile
        }
    }

    pub fn publish_tuning(&self, source: VideoTrackSource) -> VideoPublishTuning {
        VideoPublishTuning::from_profile(source, self.clone().normalized())
    }
}

fn even_dimension(value: u32) -> u32 {
    value.saturating_sub(value % 2).max(2)
}

pub fn output_dimensions_for_budget(
    source_width: u32,
    source_height: u32,
    max_pixels: u32,
) -> (u32, u32) {
    let source_pixels = source_width.saturating_mul(source_height).max(1) as f64;
    let scale = (max_pixels.max(2 * 2) as f64 / source_pixels)
        .sqrt()
        .min(1.0);
    let mut width = even_dimension((source_width as f64 * scale).round() as u32);
    let mut height = even_dimension((source_height as f64 * scale).round() as u32);
    while width.saturating_mul(height) > max_pixels.max(2 * 2) {
        if width >= height && width > 2 {
            width = width.saturating_sub(2);
        } else if height > 2 {
            height = height.saturating_sub(2);
        } else {
            break;
        }
    }
    (width, height)
}

impl Default for VideoQualityProfile {
    fn default() -> Self {
        Self::balanced()
    }
}

/// LiveKit-facing classification of a published video track. Camera maps to the Camera
/// source; both display and window maps to Screenshare so peers render them as a screen.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoTrackSource {
    Camera,
    Screenshare,
}

impl VideoTrackSource {
    pub fn from_kind(kind: VideoSourceKind) -> Self {
        match kind {
            VideoSourceKind::Camera => Self::Camera,
            VideoSourceKind::Display | VideoSourceKind::Window => Self::Screenshare,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoContentHint {
    Fluid,
    Detailed,
    Text,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoDegradationPreference {
    MaintainFramerate,
    MaintainResolution,
    Balanced,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPublishTuning {
    pub source: VideoTrackSource,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
    pub max_bitrate_bps: u64,
    pub degradation_preference: VideoDegradationPreference,
    pub content_hint: VideoContentHint,
    pub simulcast: bool,
}

impl VideoPublishTuning {
    fn from_profile(source: VideoTrackSource, profile: VideoQualityProfile) -> Self {
        let content_hint = match (source, profile.profile_id) {
            (_, VideoQualityProfileId::Presentation) => VideoContentHint::Text,
            (VideoTrackSource::Screenshare, _) => VideoContentHint::Detailed,
            (_, VideoQualityProfileId::HighMotion) => VideoContentHint::Fluid,
            _ => VideoContentHint::Fluid,
        };
        let degradation_preference = match (source, profile.profile_id) {
            (_, VideoQualityProfileId::Presentation) => {
                VideoDegradationPreference::MaintainResolution
            }
            (VideoTrackSource::Screenshare, _) => VideoDegradationPreference::MaintainResolution,
            (_, VideoQualityProfileId::HighMotion) => VideoDegradationPreference::MaintainFramerate,
            _ => VideoDegradationPreference::Balanced,
        };
        let max_bitrate_bps = match profile.profile_id {
            VideoQualityProfileId::Presentation => 1_500_000,
            VideoQualityProfileId::High => 3_000_000,
            VideoQualityProfileId::HighMotion => 3_500_000,
            VideoQualityProfileId::Balanced => 1_700_000,
            VideoQualityProfileId::Low => 600_000,
            VideoQualityProfileId::Custom => {
                estimate_custom_bitrate(profile.width, profile.height, profile.fps, source)
            }
        };
        let simulcast = matches!(source, VideoTrackSource::Camera)
            && !matches!(
                profile.profile_id,
                VideoQualityProfileId::Low | VideoQualityProfileId::Presentation
            )
            && profile.width.max(profile.height) >= 960;

        Self {
            source,
            width: profile.width,
            height: profile.height,
            frame_rate: f64::from(profile.fps),
            max_bitrate_bps,
            degradation_preference,
            content_hint,
            simulcast,
        }
    }
}

fn estimate_custom_bitrate(width: u32, height: u32, fps: f32, source: VideoTrackSource) -> u64 {
    let pixels = f64::from(width.max(2)) * f64::from(height.max(2));
    let frame_rate = f64::from(fps.clamp(1.0, 120.0));
    let bits_per_pixel = match source {
        VideoTrackSource::Camera => 0.10,
        VideoTrackSource::Screenshare => 0.07,
    };
    let bitrate = (pixels * frame_rate * bits_per_pixel) as u64;
    bitrate.clamp(300_000, 6_000_000)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PublishedVideoTrack {
    pub track_id: PublishedVideoTrackId,
    pub webrtc_track_id: String,
    pub source: VideoTrackSource,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

impl Default for PublishedVideoTrack {
    fn default() -> Self {
        Self {
            track_id: PublishedVideoTrackId::new(),
            webrtc_track_id: String::new(),
            source: VideoTrackSource::Camera,
            created_at: None,
            updated_at: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VideoSourceState {
    pub id: VideoSourceId,
    pub kind: VideoSourceKind,
    pub display_name: String,
    /// The capture target: camera device id, monitor id, or window handle (as a string).
    pub target_id: String,
    /// Owning process id, when known (window shares). Used to link the app's audio.
    pub process_id: Option<u32>,
    pub enabled: bool,
    pub publishing: bool,
    pub profile: VideoQualityProfile,
    pub runtime: VideoSourceRuntimeState,
    /// When this share also captures audio, the id of the audio mixer source it created.
    pub linked_audio_source_id: Option<AudioSourceId>,
    pub published_track: Option<PublishedVideoTrack>,
}

impl VideoSourceState {
    pub fn new(
        kind: VideoSourceKind,
        display_name: impl Into<String>,
        target_id: impl Into<String>,
    ) -> Self {
        Self {
            id: VideoSourceId::new(),
            kind,
            display_name: display_name.into(),
            target_id: target_id.into(),
            process_id: None,
            enabled: true,
            publishing: false,
            profile: VideoQualityProfile::default(),
            runtime: VideoSourceRuntimeState::default(),
            linked_audio_source_id: None,
            published_track: None,
        }
    }
}

impl Default for VideoSourceState {
    fn default() -> Self {
        Self::new(VideoSourceKind::Camera, "Camera", String::new())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VideoMixerState {
    pub connected: bool,
    pub local_sources: Vec<VideoSourceState>,
    pub viewer_connected: bool,
    pub self_preview_mode: SelfPreviewMode,
    pub presentation: VideoPresentationSettings,
    pub participants: Vec<VideoParticipantState>,
    pub remote_tracks: Vec<RemoteVideoTrackState>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SelfPreviewMode {
    #[default]
    Local,
    Rtc,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoPresentationProfile {
    Efficiency,
    #[default]
    Balanced,
    Quality,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VideoPresentationSettings {
    pub profile: VideoPresentationProfile,
}

impl Default for VideoPresentationSettings {
    fn default() -> Self {
        Self {
            profile: VideoPresentationProfile::Balanced,
        }
    }
}

impl VideoPresentationSettings {
    pub fn limits(&self) -> (u32, u32, u32, f32) {
        match self.profile {
            VideoPresentationProfile::Efficiency => (640, 360, 10, 68.0),
            VideoPresentationProfile::Balanced => (960, 540, 15, 76.0),
            VideoPresentationProfile::Quality => (1280, 720, 30, 84.0),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoConnectionQuality {
    Excellent,
    Good,
    Poor,
    Lost,
    #[default]
    Unknown,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VideoParticipantState {
    pub participant_id: String,
    pub display_name: String,
    pub is_local: bool,
    pub audio_muted: bool,
    pub speaking: bool,
    pub connection_quality: VideoConnectionQuality,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RemoteVideoTrackState {
    pub stream_id: String,
    pub participant_id: String,
    pub display_name: String,
    pub source: VideoTrackSource,
    pub muted: bool,
    pub subscribed: bool,
    pub desired: bool,
    pub is_self: bool,
}

impl Default for RemoteVideoTrackState {
    fn default() -> Self {
        Self {
            stream_id: String::new(),
            participant_id: String::new(),
            display_name: String::new(),
            source: VideoTrackSource::Camera,
            muted: false,
            subscribed: false,
            desired: false,
            is_self: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Enumeration results for the picker dialogs
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CameraDevice {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DisplayTarget {
    /// Stable monitor identifier (device name on Windows).
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
    pub thumbnail_data_url: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WindowTarget {
    /// Window handle as a string (HWND on Windows).
    pub id: String,
    pub title: String,
    pub app_name: String,
    pub process_id: u32,
    pub width: u32,
    pub height: u32,
    pub icon_data_url: Option<String>,
    pub thumbnail_data_url: Option<String>,
}
