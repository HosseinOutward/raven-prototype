//! Lets the main window really fill the monitor when a video goes full screen.
//!
//! Tao clips the client area of a maximized borderless window to the monitor's work area, so
//! it does not cover the taskbar, and does so in full screen too. Full screen from a maximized
//! window then leaves a blank strip the height of the taskbar.

use tauri::AppHandle;

/// Must run on the window's own thread, after Tao has attached its own subclass: the newest
/// subclass sees a message first.
#[cfg(windows)]
pub fn install(app: &AppHandle) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[raven] full screen fix: the main window is unavailable");
        return;
    };
    match window.hwnd() {
        Ok(hwnd) => platform::attach(hwnd.0 as isize),
        Err(error) => eprintln!("[raven] full screen fix: no window handle: {error}"),
    }
}

#[cfg(not(windows))]
pub fn install(_app: &AppHandle) {}

#[cfg(windows)]
mod platform {
    use windows::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        Graphics::Gdi::{GetMonitorInfoW, MonitorFromRect, MONITORINFO, MONITOR_DEFAULTTONULL},
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{NCCALCSIZE_PARAMS, WM_NCCALCSIZE, WM_NCDESTROY},
        },
    };

    const SUBCLASS_ID: usize = 0x4655_4C4C;

    pub fn attach(hwnd: isize) {
        let hwnd = HWND(hwnd as *mut _);
        // Safety: called on the window's own thread, and the procedure lives for the process.
        let attached = unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0) };
        if !attached.as_bool() {
            eprintln!("[raven] full screen fix could not attach");
        }
    }

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _subclass_id: usize,
        _reference: usize,
    ) -> LRESULT {
        if message == WM_NCDESTROY {
            let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
        } else if message == WM_NCCALCSIZE && wparam.0 != 0 {
            // Safety: for WM_NCCALCSIZE with a non-zero wparam, lparam points at these params.
            let params = &*(lparam.0 as *const NCCALCSIZE_PARAMS);
            let monitor = MonitorFromRect(&params.rgrc[0], MONITOR_DEFAULTTONULL);
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            // Only full screen asks for exactly the monitor: a resizable window that is merely
            // maximized overhangs it by its frame. Leaving the rectangle as it is and returning
            // 0 makes the whole window client area, and Tao never gets to clip it.
            if GetMonitorInfoW(monitor, &mut info).as_bool() && params.rgrc[0] == info.rcMonitor {
                return LRESULT(0);
            }
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }
}
