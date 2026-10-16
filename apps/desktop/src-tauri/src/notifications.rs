//! Operating-system notifications for things that reach the user while Raven is in the
//! background. Today that is only a profile knock; the page decides which knocks are new
//! and whether the user wants them, and this side decides whether Raven is in front.

/// Whether this build can show a notification at all.
#[tauri::command]
pub fn notifications_supported() -> bool {
    cfg!(windows)
}

/// Show a knock notification unless the main window is visible, not minimised and
/// focused. Returns whether one was shown.
#[tauri::command]
pub fn notify_knock(app: tauri::AppHandle, title: String, body: String) -> Result<bool, String> {
    platform::notify_knock(&app, title.trim(), body.trim())
}

/// The user is looking at Raven only when its main window is shown, not minimised and
/// has keyboard focus. Anything else (hidden to the tray, minimised, behind another app)
/// is the background.
#[cfg_attr(not(windows), allow(dead_code))]
fn in_foreground(visible: bool, minimized: bool, focused: bool) -> bool {
    visible && !minimized && focused
}

#[cfg(windows)]
mod platform {
    use tauri::{AppHandle, Manager};
    use tauri_plugin_notification::NotificationExt;

    pub(super) fn notify_knock(app: &AppHandle, title: &str, body: &str) -> Result<bool, String> {
        if title.is_empty() {
            return Ok(false);
        }
        if let Some(window) = app.get_webview_window("main") {
            let visible = window.is_visible().unwrap_or(false);
            let minimized = window.is_minimized().unwrap_or(false);
            let focused = window.is_focused().unwrap_or(false);
            if super::in_foreground(visible, minimized, focused) {
                return Ok(false);
            }
        }
        // Desktop toasts from this plugin carry no activation callback. A click starts
        // Raven through its registered identity, and the single-instance handler brings
        // the running window forward.
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|error| error.to_string())?;
        Ok(true)
    }
}

#[cfg(not(windows))]
mod platform {
    use tauri::AppHandle;

    pub(super) fn notify_knock(
        _app: &AppHandle,
        _title: &str,
        _body: &str,
    ) -> Result<bool, String> {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::in_foreground;

    #[test]
    fn only_a_shown_focused_window_is_in_front() {
        assert!(in_foreground(true, false, true));
        assert!(!in_foreground(false, false, false), "hidden to the tray");
        assert!(!in_foreground(true, true, false), "minimised");
        assert!(!in_foreground(true, false, false), "behind another app");
        assert!(
            !in_foreground(true, true, true),
            "minimised but still reporting focus"
        );
    }
}
