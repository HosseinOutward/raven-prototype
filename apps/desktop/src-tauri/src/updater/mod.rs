pub mod model;
pub(crate) mod runtime;
mod service;

use model::{ServerContext, UpdateSettingsPatch, UpdaterSnapshot};
use runtime::UpdaterRuntime;
use std::sync::atomic::Ordering;
use tauri::{ExitRequestApi, Manager, State, WebviewWindow};

pub const UPDATE_ENDPOINT: &str =
    "https://updates.rvn.bluehour.cloud/v1/updates/check/{{target}}/{{arch}}/{{current_version}}";
pub const DECISION_ENDPOINT: &str = "https://updates.rvn.bluehour.cloud/v1/updates/decision";
pub const REVALIDATE_ENDPOINT: &str = "https://updates.rvn.bluehour.cloud/v1/updates/releases";
pub const ROLLBACK_ENDPOINT: &str = "https://updates.rvn.bluehour.cloud/v1/updates/releases";
pub const OUTCOMES_ENDPOINT: &str = "https://updates.rvn.bluehour.cloud/v1/updates/outcomes";
pub const DIAGNOSTICS_ENDPOINT: &str = "https://updates.rvn.bluehour.cloud/v1/updates/diagnostics";
pub const PUBLIC_KEY: &str = include_str!("../../updater/raven-updater.key.pub");

pub fn initialize(app: &tauri::AppHandle) -> Result<UpdaterRuntime, String> {
    let runtime = UpdaterRuntime::initialize(app)?;
    app.manage(runtime.clone());
    service::start_background_tasks(runtime.clone());
    Ok(runtime)
}

pub fn handle_exit_requested(runtime: UpdaterRuntime, api: &ExitRequestApi) {
    if runtime.0.allow_exit_after_install.load(Ordering::SeqCst) {
        return;
    }
    let install_on_close = runtime
        .0
        .state
        .lock()
        .expect("updater state poisoned")
        .install_on_close;
    if !install_on_close {
        return;
    }
    api.prevent_exit();
    if runtime
        .0
        .close_install_in_progress
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        match service::install_on_exit(runtime.clone()).await {
            Ok(snapshot) if snapshot.phase != model::UpdatePhase::InstallationFailed => {}
            _ => {
                if crate::should_start_api_sidecar() {
                    let _ = crate::start_api_sidecar(&runtime.0.app);
                }
                runtime
                    .0
                    .close_install_in_progress
                    .store(false, Ordering::SeqCst);
                if let Some(window) = runtime.0.app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        }
    });
}

#[tauri::command]
pub fn updater_get_state(state: State<'_, UpdaterRuntime>) -> UpdaterSnapshot {
    state.snapshot()
}

#[tauri::command]
pub async fn updater_check_now(
    window: WebviewWindow,
    state: State<'_, UpdaterRuntime>,
) -> Result<UpdaterSnapshot, String> {
    require_main(&window)?;
    service::check(state.inner().clone(), false).await
}

#[tauri::command]
pub async fn updater_download(
    window: WebviewWindow,
    state: State<'_, UpdaterRuntime>,
    approve_metered: bool,
) -> Result<UpdaterSnapshot, String> {
    require_main(&window)?;
    service::download(state.inner().clone(), approve_metered).await
}

#[tauri::command]
pub async fn updater_install_now(
    window: WebviewWindow,
    state: State<'_, UpdaterRuntime>,
) -> Result<UpdaterSnapshot, String> {
    require_main(&window)?;
    service::install_now(state.inner().clone()).await
}

#[tauri::command]
pub fn updater_schedule_install_on_close(
    window: WebviewWindow,
    state: State<'_, UpdaterRuntime>,
    enabled: bool,
) -> Result<UpdaterSnapshot, String> {
    require_main(&window)?;
    service::schedule_install_on_close(state.inner(), enabled)
}

#[tauri::command]
pub async fn updater_update_settings(
    window: WebviewWindow,
    state: State<'_, UpdaterRuntime>,
    patch: UpdateSettingsPatch,
) -> Result<UpdaterSnapshot, String> {
    require_main(&window)?;
    service::update_settings(state.inner().clone(), patch).await
}

#[tauri::command]
pub fn updater_set_active_session(
    window: WebviewWindow,
    state: State<'_, UpdaterRuntime>,
    active: bool,
    reason: String,
) -> Result<UpdaterSnapshot, String> {
    require_main(&window)?;
    Ok(state.set_active_session(active, reason))
}

#[tauri::command]
pub fn updater_set_server_context(
    window: WebviewWindow,
    state: State<'_, UpdaterRuntime>,
    context: ServerContext,
) -> Result<UpdaterSnapshot, String> {
    require_main(&window)?;
    service::set_server_context(state.inner(), context)
}

#[tauri::command]
pub fn updater_redacted_report(
    window: WebviewWindow,
    state: State<'_, UpdaterRuntime>,
) -> Result<String, String> {
    require_main(&window)?;
    service::redacted_report(state.inner())
}

#[tauri::command]
pub async fn updater_share_diagnostics(
    window: WebviewWindow,
    state: State<'_, UpdaterRuntime>,
) -> Result<UpdaterSnapshot, String> {
    require_main(&window)?;
    service::share_diagnostics(state.inner().clone()).await
}

#[tauri::command]
pub async fn updater_attempt_rollback(
    window: WebviewWindow,
    state: State<'_, UpdaterRuntime>,
) -> Result<UpdaterSnapshot, String> {
    require_main(&window)?;
    service::attempt_rollback(state.inner().clone()).await
}

#[tauri::command]
pub fn updater_mark_startup_healthy(
    window: WebviewWindow,
    state: State<'_, UpdaterRuntime>,
) -> Result<UpdaterSnapshot, String> {
    require_main(&window)?;
    service::mark_startup_healthy(state.inner())
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if is_main_window_label(window.label()) {
        Ok(())
    } else {
        Err("Updater mutations are restricted to Raven's main window.".to_string())
    }
}

fn is_main_window_label(label: &str) -> bool {
    label == "main"
}

#[cfg(test)]
mod tests {
    #[test]
    fn endpoint_and_key_are_fixed_release_inputs() {
        assert!(super::UPDATE_ENDPOINT.starts_with("https://updates.rvn.bluehour.cloud/"));
        assert!(super::UPDATE_ENDPOINT.contains("{{target}}"));
        assert!(super::PUBLIC_KEY.trim().len() > 100);
    }

    #[test]
    fn updater_mutations_are_main_window_only() {
        assert!(super::is_main_window_label("main"));
        assert!(!super::is_main_window_label("nest-window-123"));
        assert!(!super::is_main_window_label("studio-window-123"));
        assert!(!super::is_main_window_label("voice-overlay"));
    }
}
