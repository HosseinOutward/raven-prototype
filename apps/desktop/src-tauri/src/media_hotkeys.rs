use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, PoisonError},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use thiserror::Error;

pub const MEDIA_HOTKEY_EVENT: &str = "media-hotkey-pressed";
const SETTINGS_FILE_NAME: &str = "media-hotkeys.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MediaHotkeySettings {
    pub mic: String,
    pub camera: String,
    pub deafen: String,
    pub screen_share: String,
}

impl Default for MediaHotkeySettings {
    fn default() -> Self {
        let primary_modifier = if cfg!(target_os = "macos") {
            "Command"
        } else {
            "Control"
        };
        Self {
            mic: format!("{primary_modifier}+Shift+M"),
            camera: format!("{primary_modifier}+Shift+V"),
            deafen: format!("{primary_modifier}+Shift+D"),
            screen_share: format!("{primary_modifier}+Shift+S"),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MediaHotkeySettingsPatch {
    pub mic: Option<String>,
    pub camera: Option<String>,
    pub deafen: Option<String>,
    pub screen_share: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaHotkeySettingsView {
    pub supported: bool,
    pub mic: String,
    pub camera: String,
    pub deafen: String,
    pub screen_share: String,
    pub registration_error: Option<String>,
}

#[derive(Debug)]
pub struct MediaHotkeyState {
    settings: Mutex<MediaHotkeySettings>,
    registered: Mutex<Vec<(String, String)>>,
    registration_error: Mutex<Option<String>>,
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "code", content = "detail", rename_all = "camelCase")]
pub enum MediaHotkeyError {
    #[error("media hotkey state is unavailable")]
    StatePoisoned,
    #[error("media hotkey settings I/O failed: {message}")]
    Io { message: String },
    #[error("each media action needs a different hotkey")]
    Duplicate,
    #[error("media hotkey failed: {message}")]
    Shortcut { message: String },
}

pub fn new_media_hotkey_state() -> MediaHotkeyState {
    MediaHotkeyState {
        settings: Mutex::new(MediaHotkeySettings::default()),
        registered: Mutex::new(Vec::new()),
        registration_error: Mutex::new(None),
    }
}

pub fn initialize(app: &AppHandle) -> Result<(), MediaHotkeyError> {
    let state = app.state::<MediaHotkeyState>();
    let settings = load_settings_from_path(&settings_path(app)?);
    *state.settings.lock().map_err(state_poisoned)? = settings.clone();
    if let Err(error) = reconcile_registration(app, &state, &settings) {
        set_registration_error(&state, Some(error.to_string()))?;
        eprintln!("[raven] media hotkey registration failed: {error}");
    }
    Ok(())
}

#[tauri::command]
pub fn media_hotkeys_get_settings(
    state: State<'_, MediaHotkeyState>,
) -> Result<MediaHotkeySettingsView, MediaHotkeyError> {
    let settings = state.settings.lock().map_err(state_poisoned)?.clone();
    settings_view(&state, &settings)
}

#[tauri::command]
pub fn media_hotkeys_update_settings(
    app: AppHandle,
    state: State<'_, MediaHotkeyState>,
    patch: MediaHotkeySettingsPatch,
) -> Result<MediaHotkeySettingsView, MediaHotkeyError> {
    let current = state.settings.lock().map_err(state_poisoned)?.clone();
    let next = apply_patch(&current, patch);
    validate_unique(&next)?;
    reconcile_registration(&app, &state, &next)?;
    *state.settings.lock().map_err(state_poisoned)? = next.clone();
    save_settings_to_path(&settings_path(&app)?, &next)?;
    settings_view(&state, &next)
}

fn apply_patch(
    current: &MediaHotkeySettings,
    patch: MediaHotkeySettingsPatch,
) -> MediaHotkeySettings {
    let defaults = MediaHotkeySettings::default();
    let mut next = current.clone();
    if let Some(value) = patch.mic {
        next.mic = normalized(value, defaults.mic);
    }
    if let Some(value) = patch.camera {
        next.camera = normalized(value, defaults.camera);
    }
    if let Some(value) = patch.deafen {
        next.deafen = normalized(value, defaults.deafen);
    }
    if let Some(value) = patch.screen_share {
        next.screen_share = normalized(value, defaults.screen_share);
    }
    next
}

fn normalized(value: String, fallback: String) -> String {
    let value = value.trim();
    if value.is_empty() {
        fallback
    } else {
        value.to_string()
    }
}

fn bindings(settings: &MediaHotkeySettings) -> Vec<(String, String)> {
    vec![
        (settings.mic.clone(), "mic".into()),
        (settings.camera.clone(), "camera".into()),
        (settings.deafen.clone(), "deafen".into()),
        (settings.screen_share.clone(), "screenShare".into()),
    ]
}

fn validate_unique(settings: &MediaHotkeySettings) -> Result<(), MediaHotkeyError> {
    let mut seen = HashSet::new();
    if bindings(settings)
        .into_iter()
        .all(|(hotkey, _)| seen.insert(hotkey.to_ascii_lowercase()))
    {
        Ok(())
    } else {
        Err(MediaHotkeyError::Duplicate)
    }
}

fn settings_view(
    state: &MediaHotkeyState,
    settings: &MediaHotkeySettings,
) -> Result<MediaHotkeySettingsView, MediaHotkeyError> {
    Ok(MediaHotkeySettingsView {
        supported: cfg!(windows),
        mic: settings.mic.clone(),
        camera: settings.camera.clone(),
        deafen: settings.deafen.clone(),
        screen_share: settings.screen_share.clone(),
        registration_error: state
            .registration_error
            .lock()
            .map_err(state_poisoned)?
            .clone(),
    })
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, MediaHotkeyError> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(SETTINGS_FILE_NAME))
        .map_err(|error| MediaHotkeyError::Io {
            message: error.to_string(),
        })
}

fn load_settings_from_path(path: &Path) -> MediaHotkeySettings {
    let settings = fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default();
    platform_specific_settings(settings)
}

fn platform_specific_settings(mut settings: MediaHotkeySettings) -> MediaHotkeySettings {
    let modifier = if cfg!(target_os = "macos") {
        "Command"
    } else {
        "Control"
    };
    settings.mic = settings.mic.replace("CommandOrControl", modifier);
    settings.camera = settings.camera.replace("CommandOrControl", modifier);
    settings.deafen = settings.deafen.replace("CommandOrControl", modifier);
    settings.screen_share = settings.screen_share.replace("CommandOrControl", modifier);
    settings
}

fn save_settings_to_path(
    path: &Path,
    settings: &MediaHotkeySettings,
) -> Result<(), MediaHotkeyError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let contents =
        serde_json::to_string_pretty(settings).map_err(|error| MediaHotkeyError::Io {
            message: error.to_string(),
        })?;
    fs::write(path, contents).map_err(io_error)
}

#[cfg(windows)]
fn reconcile_registration(
    app: &AppHandle,
    state: &MediaHotkeyState,
    settings: &MediaHotkeySettings,
) -> Result<(), MediaHotkeyError> {
    validate_unique(settings)?;
    let current = state.registered.lock().map_err(state_poisoned)?.clone();
    let desired = bindings(settings);
    if current == desired {
        return set_registration_error(state, None);
    }

    for (hotkey, _) in &current {
        unregister(app, hotkey)?;
    }

    let mut newly_registered: Vec<(String, String)> = Vec::new();
    for (hotkey, action) in &desired {
        if let Err(error) = register(app, hotkey, action) {
            for (registered, _) in &newly_registered {
                let _ = unregister(app, registered);
            }
            for (old_hotkey, old_action) in &current {
                let _ = register(app, old_hotkey, old_action);
            }
            *state.registered.lock().map_err(state_poisoned)? = current;
            set_registration_error(state, Some(error.to_string()))?;
            return Err(error);
        }
        newly_registered.push((hotkey.clone(), action.clone()));
    }

    *state.registered.lock().map_err(state_poisoned)? = desired;
    set_registration_error(state, None)
}

#[cfg(not(windows))]
fn reconcile_registration(
    _app: &AppHandle,
    state: &MediaHotkeyState,
    _settings: &MediaHotkeySettings,
) -> Result<(), MediaHotkeyError> {
    *state.registered.lock().map_err(state_poisoned)? = Vec::new();
    set_registration_error(state, None)
}

#[cfg(windows)]
fn register(app: &AppHandle, hotkey: &str, action: &str) -> Result<(), MediaHotkeyError> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let action = action.to_string();
    app.global_shortcut()
        .on_shortcut(hotkey, move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let _ = app.emit(MEDIA_HOTKEY_EVENT, action.clone());
            }
        })
        .map_err(shortcut_error)
}

#[cfg(windows)]
fn unregister(app: &AppHandle, hotkey: &str) -> Result<(), MediaHotkeyError> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    app.global_shortcut()
        .unregister(hotkey)
        .map_err(shortcut_error)
}

fn set_registration_error(
    state: &MediaHotkeyState,
    error: Option<String>,
) -> Result<(), MediaHotkeyError> {
    *state.registration_error.lock().map_err(state_poisoned)? = error;
    Ok(())
}

fn state_poisoned<T>(_error: PoisonError<T>) -> MediaHotkeyError {
    MediaHotkeyError::StatePoisoned
}

fn io_error(error: std::io::Error) -> MediaHotkeyError {
    MediaHotkeyError::Io {
        message: error.to_string(),
    }
}

#[cfg(windows)]
fn shortcut_error(error: tauri_plugin_global_shortcut::Error) -> MediaHotkeyError {
    MediaHotkeyError::Shortcut {
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_duplicate_bindings() {
        let mut settings = MediaHotkeySettings::default();
        settings.camera = settings.mic.clone();
        assert!(matches!(
            validate_unique(&settings),
            Err(MediaHotkeyError::Duplicate)
        ));
    }

    #[test]
    fn blank_patch_restores_default() {
        let current = MediaHotkeySettings::default();
        let next = apply_patch(
            &current,
            MediaHotkeySettingsPatch {
                mic: Some("  ".into()),
                ..Default::default()
            },
        );
        assert_eq!(next.mic, MediaHotkeySettings::default().mic);
    }

    #[test]
    fn migrates_legacy_platform_agnostic_modifiers() {
        let mut settings = MediaHotkeySettings::default();
        settings.camera = "CommandOrControl+Shift+V".into();
        let migrated = platform_specific_settings(settings);
        assert!(!migrated.camera.contains("CommandOrControl"));
        assert!(migrated.camera.starts_with(if cfg!(target_os = "macos") {
            "Command+"
        } else {
            "Control+"
        }));
    }
}
