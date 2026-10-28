use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, PoisonError},
};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use thiserror::Error;

pub const VOICE_OVERLAY_LABEL: &str = "voice-overlay";
pub const VOICE_OVERLAY_EVENT: &str = "voice-overlay-state-changed";
pub const VOICE_OVERLAY_SETTINGS_EVENT: &str = "voice-overlay-settings-changed";
pub const DEFAULT_OVERLAY_HOTKEY: &str = "Alt+F8";

const SETTINGS_FILE_NAME: &str = "voice-overlay-settings.json";
const VERTICAL_OVERLAY_WIDTH: i32 = 280;
const VERTICAL_OVERLAY_HEIGHT: i32 = 360;
const HORIZONTAL_OVERLAY_WIDTH: i32 = 320;
const HORIZONTAL_OVERLAY_HEIGHT: i32 = 112;
const DEFAULT_MONITOR_OFFSET: i32 = 24;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VoiceOverlaySettings {
    pub enabled: bool,
    pub hotkey: String,
    pub layout: VoiceOverlayLayout,
    pub show_names: bool,
    pub name_background: VoiceOverlayNameBackground,
    pub position: Option<VoiceOverlayPosition>,
}

impl Default for VoiceOverlaySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            hotkey: DEFAULT_OVERLAY_HOTKEY.to_string(),
            layout: VoiceOverlayLayout::Vertical,
            show_names: true,
            name_background: VoiceOverlayNameBackground::default(),
            position: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceOverlayLayout {
    #[default]
    Vertical,
    Horizontal,
}

/// How much of a fill sits behind each name so it stays readable over any game.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceOverlayNameBackground {
    Off,
    #[default]
    Light,
    Strong,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceOverlayPosition {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VoiceOverlaySnapshot {
    pub nest_id: Option<String>,
    pub nest_name: Option<String>,
    pub location_label: String,
    pub connected: bool,
    /// False against a server that predates the shared call state.
    pub away_supported: bool,
    pub participants: Vec<VoiceOverlayParticipant>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VoiceOverlayParticipant {
    pub user_id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub is_local: bool,
    pub speaking: bool,
    pub speaking_level: u8,
    pub muted: bool,
    pub deafened: bool,
    /// "Back in a bit": a marker with no time or duration.
    pub away: bool,
    pub screen_sharing: bool,
    pub camera_on: bool,
}

#[derive(Debug)]
pub struct VoiceOverlayState {
    settings: Mutex<VoiceOverlaySettings>,
    snapshot: Mutex<VoiceOverlaySnapshot>,
    registered_hotkey: Mutex<Option<String>>,
    registration_error: Mutex<Option<String>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceOverlaySettingsView {
    pub supported: bool,
    pub enabled: bool,
    pub hotkey: String,
    pub layout: VoiceOverlayLayout,
    pub show_names: bool,
    pub name_background: VoiceOverlayNameBackground,
    pub position: Option<VoiceOverlayPosition>,
    pub registration_error: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VoiceOverlaySettingsPatch {
    pub enabled: Option<bool>,
    pub hotkey: Option<String>,
    pub layout: Option<VoiceOverlayLayout>,
    pub show_names: Option<bool>,
    pub name_background: Option<VoiceOverlayNameBackground>,
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "code", content = "detail", rename_all = "camelCase")]
pub enum VoiceOverlayError {
    #[error("voice overlay state is unavailable")]
    StatePoisoned,
    #[error("voice overlay settings I/O failed: {message}")]
    Io { message: String },
    #[error("voice overlay window failed: {message}")]
    Window { message: String },
    #[error("voice overlay hotkey failed: {message}")]
    Shortcut { message: String },
}

pub fn new_voice_overlay_state() -> VoiceOverlayState {
    VoiceOverlayState {
        settings: Mutex::new(VoiceOverlaySettings::default()),
        snapshot: Mutex::new(VoiceOverlaySnapshot::default()),
        registered_hotkey: Mutex::new(None),
        registration_error: Mutex::new(None),
    }
}

pub fn initialize_voice_overlay(app: &AppHandle) -> Result<(), VoiceOverlayError> {
    let state = app.state::<VoiceOverlayState>();
    let settings = load_settings_from_path(&settings_path(app)?);
    *state.settings.lock().map_err(state_poisoned)? = settings.clone();

    if !overlay_supported() {
        clear_registered_hotkey(&state)?;
        return Ok(());
    }

    if let Err(err) = reconcile_hotkey_registration(app, &state, &settings) {
        set_registration_error(&state, Some(err.to_string()))?;
        eprintln!("[raven] voice overlay hotkey registration failed: {err}");
    }
    Ok(())
}

#[tauri::command]
pub fn overlay_is_supported() -> bool {
    overlay_supported()
}

#[tauri::command]
pub fn overlay_get_settings(
    state: State<'_, VoiceOverlayState>,
) -> Result<VoiceOverlaySettingsView, VoiceOverlayError> {
    let settings = state.settings.lock().map_err(state_poisoned)?.clone();
    settings_view(&state, &settings)
}

#[tauri::command]
pub fn overlay_update_settings(
    app: AppHandle,
    state: State<'_, VoiceOverlayState>,
    patch: VoiceOverlaySettingsPatch,
) -> Result<VoiceOverlaySettingsView, VoiceOverlayError> {
    let current = state.settings.lock().map_err(state_poisoned)?.clone();
    if !overlay_supported() {
        return settings_view(&state, &current);
    }

    let next = apply_settings_patch(&current, patch);
    reconcile_hotkey_registration(&app, &state, &next)?;

    *state.settings.lock().map_err(state_poisoned)? = next.clone();
    save_settings(&app, &next)?;
    if !next.enabled {
        hide_existing_overlay_window(&app)?;
    } else if let Some(window) = app.get_webview_window(VOICE_OVERLAY_LABEL) {
        apply_overlay_dimensions(&window, next.layout)?;
        restore_overlay_position(&window, &next)?;
    }
    let view = settings_view(&state, &next)?;
    if let Some(window) = app.get_webview_window(VOICE_OVERLAY_LABEL) {
        let _ = window.emit(VOICE_OVERLAY_SETTINGS_EVENT, view.clone());
    }
    Ok(view)
}

#[tauri::command]
pub fn overlay_toggle(
    app: AppHandle,
    state: State<'_, VoiceOverlayState>,
) -> Result<bool, VoiceOverlayError> {
    if !overlay_supported() || !state.settings.lock().map_err(state_poisoned)?.enabled {
        return Ok(false);
    }
    toggle_overlay_window(&app, None)
}

#[tauri::command]
pub fn overlay_show(
    app: AppHandle,
    state: State<'_, VoiceOverlayState>,
) -> Result<(), VoiceOverlayError> {
    if !overlay_supported() || !state.settings.lock().map_err(state_poisoned)?.enabled {
        return Ok(());
    }
    let _ = toggle_overlay_window(&app, Some(true))?;
    Ok(())
}

#[tauri::command]
pub fn overlay_hide(app: AppHandle) -> Result<(), VoiceOverlayError> {
    if !overlay_supported() {
        return Ok(());
    }
    hide_existing_overlay_window(&app)
}

#[tauri::command]
pub fn overlay_save_position(
    app: AppHandle,
    state: State<'_, VoiceOverlayState>,
    position: VoiceOverlayPosition,
) -> Result<VoiceOverlaySettingsView, VoiceOverlayError> {
    if !overlay_supported() {
        let settings = state.settings.lock().map_err(state_poisoned)?.clone();
        return settings_view(&state, &settings);
    }

    let next = {
        let mut settings = state.settings.lock().map_err(state_poisoned)?;
        settings.position = Some(position);
        settings.clone()
    };
    save_settings(&app, &next)?;
    settings_view(&state, &next)
}

#[tauri::command]
pub fn overlay_get_snapshot(
    state: State<'_, VoiceOverlayState>,
) -> Result<VoiceOverlaySnapshot, VoiceOverlayError> {
    Ok(state.snapshot.lock().map_err(state_poisoned)?.clone())
}

#[tauri::command]
pub fn overlay_update_snapshot(
    app: AppHandle,
    state: State<'_, VoiceOverlayState>,
    snapshot: VoiceOverlaySnapshot,
) -> Result<(), VoiceOverlayError> {
    let changed = replace_overlay_snapshot(&state, &snapshot)?;
    if changed {
        if let Some(window) = app.get_webview_window(VOICE_OVERLAY_LABEL) {
            let _ = window.emit(VOICE_OVERLAY_EVENT, snapshot);
        }
    }
    Ok(())
}

fn replace_overlay_snapshot(
    state: &VoiceOverlayState,
    snapshot: &VoiceOverlaySnapshot,
) -> Result<bool, VoiceOverlayError> {
    let mut current = state.snapshot.lock().map_err(state_poisoned)?;
    if *current == *snapshot {
        return Ok(false);
    }
    *current = snapshot.clone();
    Ok(true)
}

fn overlay_supported() -> bool {
    cfg!(windows)
}

fn apply_settings_patch(
    current: &VoiceOverlaySettings,
    patch: VoiceOverlaySettingsPatch,
) -> VoiceOverlaySettings {
    let mut next = current.clone();
    if let Some(enabled) = patch.enabled {
        next.enabled = enabled;
    }
    if let Some(hotkey) = patch.hotkey {
        let trimmed = hotkey.trim();
        next.hotkey = if trimmed.is_empty() {
            DEFAULT_OVERLAY_HOTKEY.to_string()
        } else {
            trimmed.to_string()
        };
    }
    if let Some(layout) = patch.layout {
        next.layout = layout;
    }
    if let Some(show_names) = patch.show_names {
        next.show_names = show_names;
    }
    if let Some(name_background) = patch.name_background {
        next.name_background = name_background;
    }
    next
}

fn settings_view(
    state: &VoiceOverlayState,
    settings: &VoiceOverlaySettings,
) -> Result<VoiceOverlaySettingsView, VoiceOverlayError> {
    let supported = overlay_supported();
    Ok(VoiceOverlaySettingsView {
        supported,
        enabled: supported && settings.enabled,
        hotkey: settings.hotkey.clone(),
        layout: settings.layout,
        show_names: settings.show_names,
        name_background: settings.name_background,
        position: settings.position,
        registration_error: state
            .registration_error
            .lock()
            .map_err(state_poisoned)?
            .clone(),
    })
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, VoiceOverlayError> {
    Ok(app.path().app_data_dir()?.join(SETTINGS_FILE_NAME))
}

fn save_settings(
    app: &AppHandle,
    settings: &VoiceOverlaySettings,
) -> Result<(), VoiceOverlayError> {
    let path = settings_path(app)?;
    save_settings_to_path(&path, settings)
}

fn load_settings_from_path(path: &Path) -> VoiceOverlaySettings {
    match fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => VoiceOverlaySettings::default(),
        Err(_) => VoiceOverlaySettings::default(),
    }
}

fn save_settings_to_path(
    path: &Path,
    settings: &VoiceOverlaySettings,
) -> Result<(), VoiceOverlayError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let contents = serde_json::to_string_pretty(settings).map_err(|err| VoiceOverlayError::Io {
        message: err.to_string(),
    })?;
    fs::write(path, contents).map_err(io_error)
}

fn toggle_overlay_window(
    app: &AppHandle,
    force_visible: Option<bool>,
) -> Result<bool, VoiceOverlayError> {
    let state = app.state::<VoiceOverlayState>();
    let settings = state.settings.lock().map_err(state_poisoned)?.clone();
    let window = ensure_overlay_window(app, &settings)?;
    let should_show = match force_visible {
        Some(visible) => visible,
        None => !window.is_visible().map_err(window_error)?,
    };

    if should_show {
        restore_overlay_position(&window, &settings)?;
        window.set_always_on_top(true).map_err(window_error)?;
        window.show().map_err(window_error)?;
    } else {
        window.hide().map_err(window_error)?;
    }

    Ok(should_show)
}

fn hide_existing_overlay_window(app: &AppHandle) -> Result<(), VoiceOverlayError> {
    if let Some(window) = app.get_webview_window(VOICE_OVERLAY_LABEL) {
        window.hide().map_err(window_error)?;
    }
    Ok(())
}

fn ensure_overlay_window(
    app: &AppHandle,
    settings: &VoiceOverlaySettings,
) -> Result<WebviewWindow, VoiceOverlayError> {
    if let Some(window) = app.get_webview_window(VOICE_OVERLAY_LABEL) {
        return Ok(window);
    }

    let (width, height) = overlay_dimensions(settings.layout);
    let window = WebviewWindowBuilder::new(
        app,
        VOICE_OVERLAY_LABEL,
        WebviewUrl::App("/#/overlay".into()),
    )
    .title("Raven Voice Overlay")
    .inner_size(width as f64, height as f64)
    .min_inner_size(width as f64, height as f64)
    .max_inner_size(width as f64, height as f64)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .shadow(false)
    .visible(false)
    .build()
    .map_err(window_error)?;

    restore_overlay_position(&window, settings)?;
    Ok(window)
}

fn overlay_dimensions(layout: VoiceOverlayLayout) -> (i32, i32) {
    match layout {
        VoiceOverlayLayout::Vertical => (VERTICAL_OVERLAY_WIDTH, VERTICAL_OVERLAY_HEIGHT),
        VoiceOverlayLayout::Horizontal => (HORIZONTAL_OVERLAY_WIDTH, HORIZONTAL_OVERLAY_HEIGHT),
    }
}

fn apply_overlay_dimensions(
    window: &WebviewWindow,
    layout: VoiceOverlayLayout,
) -> Result<(), VoiceOverlayError> {
    let (width, height) = overlay_dimensions(layout);
    let size = PhysicalSize::new(width as u32, height as u32);
    window
        .set_min_size(None::<PhysicalSize<u32>>)
        .map_err(window_error)?;
    window
        .set_max_size(None::<PhysicalSize<u32>>)
        .map_err(window_error)?;
    window
        .set_size(Size::Physical(size))
        .map_err(window_error)?;
    window.set_min_size(Some(size)).map_err(window_error)?;
    window.set_max_size(Some(size)).map_err(window_error)
}

fn restore_overlay_position(
    window: &WebviewWindow,
    settings: &VoiceOverlaySettings,
) -> Result<(), VoiceOverlayError> {
    let monitors = window.available_monitors().map_err(window_error)?;
    let (width, height) = overlay_dimensions(settings.layout);
    let position = clamp_overlay_position(settings.position, &monitors, width, height);
    window
        .set_position(Position::Physical(PhysicalPosition::new(
            position.x, position.y,
        )))
        .map_err(window_error)
}

fn clamp_overlay_position(
    position: Option<VoiceOverlayPosition>,
    monitors: &[tauri::Monitor],
    overlay_width: i32,
    overlay_height: i32,
) -> VoiceOverlayPosition {
    if monitors.is_empty() {
        return position.unwrap_or(VoiceOverlayPosition {
            x: DEFAULT_MONITOR_OFFSET,
            y: DEFAULT_MONITOR_OFFSET,
        });
    }

    let fallback = {
        let monitor_position = monitors[0].position();
        VoiceOverlayPosition {
            x: monitor_position.x + DEFAULT_MONITOR_OFFSET,
            y: monitor_position.y + DEFAULT_MONITOR_OFFSET,
        }
    };
    let position = position.unwrap_or(fallback);

    for monitor in monitors {
        let monitor_position = monitor.position();
        let monitor_size = monitor.size();
        let left = monitor_position.x;
        let top = monitor_position.y;
        let right = left + monitor_size.width as i32;
        let bottom = top + monitor_size.height as i32;
        if position.x >= left && position.x < right && position.y >= top && position.y < bottom {
            return clamp_to_monitor(
                position,
                left,
                top,
                right,
                bottom,
                overlay_width,
                overlay_height,
            );
        }
    }

    let monitor_position = monitors[0].position();
    let monitor_size = monitors[0].size();
    clamp_to_monitor(
        position,
        monitor_position.x,
        monitor_position.y,
        monitor_position.x + monitor_size.width as i32,
        monitor_position.y + monitor_size.height as i32,
        overlay_width,
        overlay_height,
    )
}

fn clamp_to_monitor(
    position: VoiceOverlayPosition,
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    overlay_width: i32,
    overlay_height: i32,
) -> VoiceOverlayPosition {
    let max_x = (right - overlay_width).max(left);
    let max_y = (bottom - overlay_height).max(top);
    VoiceOverlayPosition {
        x: position.x.clamp(left, max_x),
        y: position.y.clamp(top, max_y),
    }
}

#[cfg(windows)]
fn reconcile_hotkey_registration(
    app: &AppHandle,
    state: &VoiceOverlayState,
    settings: &VoiceOverlaySettings,
) -> Result<(), VoiceOverlayError> {
    let current = state
        .registered_hotkey
        .lock()
        .map_err(state_poisoned)?
        .clone();
    let desired = settings.enabled.then(|| settings.hotkey.clone());
    if current == desired {
        set_registration_error(state, None)?;
        return Ok(());
    }

    if let Some(current_hotkey) = current.as_deref() {
        if let Err(err) = unregister_hotkey(app, current_hotkey) {
            set_registration_error(state, Some(err.to_string()))?;
            return Err(err);
        }
    }

    if let Some(desired_hotkey) = desired.as_deref() {
        if let Err(err) = register_hotkey(app, desired_hotkey) {
            if let Some(current_hotkey) = current.as_deref() {
                let _ = register_hotkey(app, current_hotkey);
            }
            *state.registered_hotkey.lock().map_err(state_poisoned)? = current;
            set_registration_error(state, Some(err.to_string()))?;
            return Err(err);
        }
    }

    *state.registered_hotkey.lock().map_err(state_poisoned)? = desired;
    set_registration_error(state, None)
}

#[cfg(not(windows))]
fn reconcile_hotkey_registration(
    _app: &AppHandle,
    state: &VoiceOverlayState,
    _settings: &VoiceOverlaySettings,
) -> Result<(), VoiceOverlayError> {
    clear_registered_hotkey(state)
}

#[cfg(windows)]
fn register_hotkey(app: &AppHandle, hotkey: &str) -> Result<(), VoiceOverlayError> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    app.global_shortcut()
        .on_shortcut(hotkey, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                if let Err(err) = toggle_overlay_window(app, None) {
                    eprintln!("[raven] voice overlay toggle failed: {err}");
                }
            }
        })
        .map_err(shortcut_error)
}

#[cfg(windows)]
fn unregister_hotkey(app: &AppHandle, hotkey: &str) -> Result<(), VoiceOverlayError> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    app.global_shortcut()
        .unregister(hotkey)
        .map_err(shortcut_error)
}

fn clear_registered_hotkey(state: &VoiceOverlayState) -> Result<(), VoiceOverlayError> {
    *state.registered_hotkey.lock().map_err(state_poisoned)? = None;
    set_registration_error(state, None)
}

fn set_registration_error(
    state: &VoiceOverlayState,
    error: Option<String>,
) -> Result<(), VoiceOverlayError> {
    *state.registration_error.lock().map_err(state_poisoned)? = error;
    Ok(())
}

fn state_poisoned<T>(_err: PoisonError<T>) -> VoiceOverlayError {
    VoiceOverlayError::StatePoisoned
}

fn io_error(err: std::io::Error) -> VoiceOverlayError {
    VoiceOverlayError::Io {
        message: err.to_string(),
    }
}

fn window_error(err: tauri::Error) -> VoiceOverlayError {
    VoiceOverlayError::Window {
        message: err.to_string(),
    }
}

#[cfg(windows)]
fn shortcut_error(err: tauri_plugin_global_shortcut::Error) -> VoiceOverlayError {
    VoiceOverlayError::Shortcut {
        message: err.to_string(),
    }
}

impl From<tauri::Error> for VoiceOverlayError {
    fn from(value: tauri::Error) -> Self {
        VoiceOverlayError::Window {
            message: value.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn settings_defaults_when_missing() {
        let path = temp_settings_path("missing");
        let _ = fs::remove_file(&path);

        let settings = load_settings_from_path(&path);

        assert_eq!(settings, VoiceOverlaySettings::default());
    }

    #[test]
    fn settings_round_trip() {
        let path = temp_settings_path("round-trip");
        let settings = VoiceOverlaySettings {
            enabled: false,
            hotkey: "Control+Alt+O".to_string(),
            layout: VoiceOverlayLayout::Horizontal,
            show_names: false,
            name_background: VoiceOverlayNameBackground::Strong,
            position: Some(VoiceOverlayPosition { x: 100, y: 120 }),
        };

        save_settings_to_path(&path, &settings).expect("settings should save");
        let loaded = load_settings_from_path(&path);

        assert_eq!(loaded, settings);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn legacy_settings_receive_overlay_display_defaults() {
        let settings: VoiceOverlaySettings =
            serde_json::from_str(r#"{"enabled":false,"hotkey":"Alt+F9","position":{"x":4,"y":5}}"#)
                .expect("legacy settings should deserialize");

        assert_eq!(settings.layout, VoiceOverlayLayout::Vertical);
        assert!(settings.show_names);
        assert_eq!(settings.name_background, VoiceOverlayNameBackground::Light);
        assert_eq!(settings.position, Some(VoiceOverlayPosition { x: 4, y: 5 }));
    }

    #[test]
    fn participant_speaking_level_is_backward_compatible() {
        let legacy: VoiceOverlayParticipant =
            serde_json::from_str(r#"{"userId":"person","displayName":"Person","speaking":true}"#)
                .expect("legacy participant should deserialize");
        assert_eq!(legacy.speaking_level, 0);

        let current: VoiceOverlayParticipant = serde_json::from_str(
            r#"{"userId":"person","displayName":"Person","speaking":true,"speakingLevel":73}"#,
        )
        .expect("current participant should deserialize");
        assert_eq!(current.speaking_level, 73);
    }

    #[test]
    fn call_state_fields_survive_the_snapshot_and_default_off() {
        let legacy: VoiceOverlaySnapshot = serde_json::from_str(
            r#"{"connected":true,"participants":[{"userId":"person","displayName":"Person"}]}"#,
        )
        .expect("a snapshot without call state should deserialize");
        assert!(!legacy.away_supported);
        assert!(!legacy.participants[0].away);

        let current: VoiceOverlaySnapshot = serde_json::from_str(
            r#"{"awaySupported":true,"participants":[{"userId":"person","away":true,"deafened":true}]}"#,
        )
        .expect("a snapshot with call state should deserialize");
        assert!(current.away_supported);
        assert!(current.participants[0].away && current.participants[0].deafened);
        let echoed = serde_json::to_value(&current).expect("snapshot should serialize");
        assert_eq!(echoed["awaySupported"], true);
        assert_eq!(echoed["participants"][0]["away"], true);
    }

    #[test]
    fn corrupt_settings_falls_back_to_defaults() {
        let path = temp_settings_path("corrupt");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("temp settings parent");
        }
        fs::write(&path, "{not-json").expect("corrupt settings write");

        let settings = load_settings_from_path(&path);

        assert_eq!(settings, VoiceOverlaySettings::default());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn patch_normalizes_empty_hotkey_to_default() {
        let settings = apply_settings_patch(
            &VoiceOverlaySettings {
                enabled: false,
                hotkey: "Alt+F9".to_string(),
                layout: VoiceOverlayLayout::Vertical,
                show_names: true,
                name_background: VoiceOverlayNameBackground::Light,
                position: Some(VoiceOverlayPosition { x: 2, y: 3 }),
            },
            VoiceOverlaySettingsPatch {
                enabled: Some(true),
                hotkey: Some("   ".to_string()),
                layout: Some(VoiceOverlayLayout::Horizontal),
                show_names: Some(false),
                name_background: Some(VoiceOverlayNameBackground::Off),
            },
        );

        assert!(settings.enabled);
        assert_eq!(settings.hotkey, DEFAULT_OVERLAY_HOTKEY);
        assert_eq!(settings.layout, VoiceOverlayLayout::Horizontal);
        assert!(!settings.show_names);
        assert_eq!(settings.name_background, VoiceOverlayNameBackground::Off);
        assert_eq!(settings.position, Some(VoiceOverlayPosition { x: 2, y: 3 }));
    }

    #[test]
    fn layout_dimensions_are_fixed_per_orientation() {
        assert_eq!(overlay_dimensions(VoiceOverlayLayout::Vertical), (280, 360));
        assert_eq!(
            overlay_dimensions(VoiceOverlayLayout::Horizontal),
            (320, 112)
        );
    }

    #[test]
    fn identical_snapshots_do_not_emit_work() {
        let state = new_voice_overlay_state();
        let snapshot = VoiceOverlaySnapshot::default();
        assert!(!replace_overlay_snapshot(&state, &snapshot).expect("snapshot comparison"));

        let changed = VoiceOverlaySnapshot {
            nest_id: Some("nest-1".to_string()),
            connected: true,
            ..VoiceOverlaySnapshot::default()
        };
        assert!(replace_overlay_snapshot(&state, &changed).expect("snapshot update"));
        assert!(!replace_overlay_snapshot(&state, &changed).expect("snapshot deduplication"));
    }

    fn temp_settings_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir()
            .join("raven-overlay-tests")
            .join(format!("{name}-{nanos}.json"))
    }
}
