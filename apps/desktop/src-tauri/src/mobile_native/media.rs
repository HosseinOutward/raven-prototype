//! The MobileNative lifecycle and permission owner. It turns Android events into the
//! eligibility state engines read through `crate::media_eligibility`.

use std::sync::{Mutex, MutexGuard};

use raven_mobile_native::{
    MobileNativeEvent, PermissionKind, PermissionSnapshot, PermissionStatus,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::gate::MobileNativeGate;

pub const MOBILE_NATIVE_MEDIA_STATE: &str = "mobile-native-media-state";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileNativeSnapshot {
    pub foreground: bool,
    pub epoch: u64,
    pub call_active: bool,
    pub microphone: PermissionStatus,
    pub camera: PermissionStatus,
    pub focus: bool,
    pub route: String,
}

struct MobileNativeInner {
    gate: MobileNativeGate,
    permissions: PermissionSnapshot,
    route: String,
}

impl MobileNativeInner {
    fn snapshot(&self) -> MobileNativeSnapshot {
        MobileNativeSnapshot {
            foreground: self.gate.foreground,
            epoch: self.gate.epoch,
            call_active: self.gate.call_active,
            microphone: self.permissions.microphone.clone(),
            camera: self.permissions.camera.clone(),
            focus: self.gate.focused,
            route: self.route.clone(),
        }
    }
}

pub struct MobileNativeMedia {
    /// Desired state. Never held across an await or a call into the plugin.
    state: Mutex<MobileNativeInner>,
    /// Serializes begin/end transitions, so a new call waits for a pending stop.
    transition: tokio::sync::Mutex<()>,
}

impl Default for MobileNativeMedia {
    fn default() -> Self {
        Self {
            state: Mutex::new(MobileNativeInner {
                gate: MobileNativeGate::default(),
                permissions: PermissionSnapshot {
                    microphone: PermissionStatus::NotRequested,
                    camera: PermissionStatus::NotRequested,
                },
                route: String::new(),
            }),
            transition: tokio::sync::Mutex::new(()),
        }
    }
}

impl MobileNativeMedia {
    fn lock(&self) -> Result<MutexGuard<'_, MobileNativeInner>, String> {
        self.state
            .lock()
            .map_err(|_| "MobileNative media state is unavailable.".into())
    }

    pub fn snapshot(&self) -> Result<MobileNativeSnapshot, String> {
        self.lock().map(|inner| inner.snapshot())
    }
}

pub fn audio_allowed(app: &AppHandle) -> bool {
    app.state::<MobileNativeMedia>()
        .lock()
        .is_ok_and(|inner| inner.gate.audio_allowed())
}

/// The OS microphone permission, or `Denied` when the state cannot be read.
pub fn microphone_permission(app: &AppHandle) -> PermissionStatus {
    app.state::<MobileNativeMedia>()
        .snapshot()
        .map_or(PermissionStatus::Denied, |s| s.microphone)
}

pub fn require_call(app: &AppHandle) -> Result<u64, String> {
    let snapshot = app.state::<MobileNativeMedia>().snapshot()?;
    if !snapshot.foreground || !snapshot.call_active {
        return Err("This foreground call has ended. Join again to continue.".into());
    }
    Ok(snapshot.epoch)
}

pub fn require_camera(app: &AppHandle) -> Result<u64, String> {
    let snapshot = app.state::<MobileNativeMedia>().snapshot()?;
    if !snapshot.foreground || snapshot.camera != PermissionStatus::Granted {
        return Err("Raven needs camera permission while in the foreground.".into());
    }
    Ok(snapshot.epoch)
}

pub fn epoch_matches(app: &AppHandle, epoch: u64) -> bool {
    app.state::<MobileNativeMedia>()
        .snapshot()
        .is_ok_and(|s| s.foreground && s.epoch == epoch)
}

fn emit(app: &AppHandle) -> Result<MobileNativeSnapshot, String> {
    let snapshot = app.state::<MobileNativeMedia>().snapshot()?;
    app.emit(MOBILE_NATIVE_MEDIA_STATE, &snapshot)
        .map_err(|e| e.to_string())?;
    Ok(snapshot)
}

fn store_permissions(app: &AppHandle, permissions: PermissionSnapshot) {
    if let Ok(mut inner) = app.state::<MobileNativeMedia>().lock() {
        inner.permissions = permissions;
    }
}

async fn resync_video(app: &AppHandle) {
    let video = app
        .state::<crate::video::state::SharedVideoEngineState>()
        .inner()
        .clone();
    crate::video::state::resync_video(app, &video).await;
}

pub fn initialize(app: &AppHandle) {
    let callback_app = app.clone();
    let channel = tauri::ipc::Channel::<MobileNativeEvent>::new(move |event| {
        let event = event.deserialize::<MobileNativeEvent>()?;
        handle_event(&callback_app, event);
        Ok(())
    });
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = raven_mobile_native::listen(&app, channel) {
            eprintln!("[mobile-native] could not subscribe to native lifecycle: {error}");
            handle_event(&app, MobileNativeEvent::BackgroundTerminal);
            return;
        }
        if let Ok(permissions) = raven_mobile_native::permission_status(&app) {
            store_permissions(&app, permissions);
        }
        let _ = emit(&app);
    });
}

fn handle_event(app: &AppHandle, event: MobileNativeEvent) {
    let background = matches!(event, MobileNativeEvent::BackgroundTerminal);
    let foregrounded = matches!(event, MobileNativeEvent::Foregrounded);
    let focus_lost = matches!(event, MobileNativeEvent::AudioFocus { focused: false, .. });
    {
        let state = app.state::<MobileNativeMedia>();
        let Ok(mut inner) = state.lock() else {
            return;
        };
        match event {
            MobileNativeEvent::Foregrounded => inner.gate.foreground = true,
            MobileNativeEvent::BackgroundTerminal => inner.gate.background(),
            MobileNativeEvent::AudioFocus { focused, route } => {
                inner.gate.focused = focused;
                inner.route = route;
            }
        }
    }
    // This callback closes the gate before waiting for any engine operation. Device
    // workers also observe it while a connect/reconcile is holding the ops lock.
    let _ = emit(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if background {
            if let Err(error) = complete_pending_stop(&app).await {
                eprintln!("[mobile-native] foreground call shutdown failed: {error}");
            }
            return;
        }
        if foregrounded {
            if let Ok(permissions) =
                tokio::task::block_in_place(|| raven_mobile_native::permission_status(&app))
            {
                store_permissions(&app, permissions);
                let _ = emit(&app);
            }
            resync_video(&app).await;
        }
        crate::audio::state::resync_audio_eligibility(&app, focus_lost).await;
    });
}

async fn stop_native_media(app: &AppHandle) -> Result<(), String> {
    let audio = app
        .state::<crate::audio::state::SharedAudioEngineState>()
        .inner()
        .clone();
    let video = app
        .state::<crate::video::state::SharedVideoEngineState>()
        .inner()
        .clone();
    if let Ok(mut engine) = audio.write() {
        engine.capture_demand.call_active = false;
        engine.capture_demand.monitoring = false;
    }
    let (audio_result, video_result) = tokio::join!(
        crate::audio::state::disconnect_audio_room(app, &audio),
        crate::video::state::disconnect_video_room(app, &video, &audio),
    );
    audio_result.map_err(|error| format!("Could not stop native audio: {error}"))?;
    video_result.map_err(|error| format!("Could not stop native video: {error}"))?;
    Ok(())
}

async fn complete_pending_stop(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<MobileNativeMedia>();
    let _transition = state.transition.lock().await;
    drain_pending_stop(app, &state).await
}

/// Called under the transition lock, separate from both the desired-state lock and
/// engine ops locks. A begin must finish any queued stop before opening a new lease.
async fn drain_pending_stop(app: &AppHandle, state: &MobileNativeMedia) -> Result<(), String> {
    loop {
        let Some(epoch) = state.lock()?.gate.pending_stop else {
            return Ok(());
        };
        stop_native_media(app).await?;
        tokio::task::block_in_place(|| raven_mobile_native::audio_focus(app, false))?;
        state.lock()?.gate.finish_stop(epoch);
    }
}

#[tauri::command]
pub async fn mobile_native_get_state(
    app: AppHandle,
    state: State<'_, MobileNativeMedia>,
) -> Result<MobileNativeSnapshot, String> {
    let permissions = tokio::task::block_in_place(|| raven_mobile_native::permission_status(&app))?;
    state.lock()?.permissions = permissions;
    crate::audio::state::resync_audio_eligibility(&app, false).await;
    resync_video(&app).await;
    emit(&app)
}

#[tauri::command]
pub async fn mobile_native_begin_call(
    app: AppHandle,
    state: State<'_, MobileNativeMedia>,
    expected_epoch: u64,
) -> Result<MobileNativeSnapshot, String> {
    let _transition = state.transition.lock().await;
    drain_pending_stop(&app, &state).await?;
    state.lock()?.gate.begin(expected_epoch)?;
    let focus = tokio::task::block_in_place(|| raven_mobile_native::audio_focus(&app, true));
    let mut inner = state.lock()?;
    if inner.gate.epoch != expected_epoch || !inner.gate.foreground || !inner.gate.call_active {
        return Err("The call was cancelled while acquiring audio focus.".into());
    }
    match focus {
        Ok(focus) if focus.focused => {
            inner.gate.focused = true;
            inner.route = focus.route;
        }
        Ok(_) => {
            inner.gate.end();
            return Err("Another app currently owns communication audio.".into());
        }
        Err(error) => {
            inner.gate.end();
            return Err(error);
        }
    }
    drop(inner);
    emit(&app)
}

#[tauri::command]
pub async fn mobile_native_end_call(
    app: AppHandle,
    state: State<'_, MobileNativeMedia>,
) -> Result<MobileNativeSnapshot, String> {
    state.lock()?.gate.end();
    emit(&app)?;
    complete_pending_stop(&app).await?;
    emit(&app)
}

#[tauri::command]
pub async fn mobile_native_request_permission(
    app: AppHandle,
    state: State<'_, MobileNativeMedia>,
    kind: PermissionKind,
    expected_epoch: u64,
) -> Result<MobileNativeSnapshot, String> {
    if !epoch_matches(&app, expected_epoch) {
        return Err("The device action was cancelled.".into());
    }
    let result = tokio::task::block_in_place(|| {
        raven_mobile_native::request_permission(&app, kind.clone(), expected_epoch)
    })?;
    if result.request_id != expected_epoch || !epoch_matches(&app, expected_epoch) {
        return Err("The device action was cancelled while requesting permission.".into());
    }
    {
        let mut inner = state.lock()?;
        match kind {
            PermissionKind::Microphone => inner.permissions.microphone = result.status,
            PermissionKind::Camera => inner.permissions.camera = result.status,
        }
    }
    emit(&app)
}

#[tauri::command]
pub async fn mobile_native_open_settings(app: AppHandle) -> Result<(), String> {
    tokio::task::block_in_place(|| raven_mobile_native::open_settings(&app))
}
