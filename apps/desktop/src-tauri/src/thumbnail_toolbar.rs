use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewWindow};

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThumbnailToolbarSnapshot {
    pub generation: String,
    pub revision: u64,
    pub signed_in: bool,
    pub mic_enabled: bool,
    pub mic_supported: bool,
    pub deafened: bool,
    pub deafen_supported: bool,
    pub has_media_session: bool,
    pub busy: bool,
    pub mic_pending: bool,
    pub deafen_pending: bool,
    pub leave_pending: bool,
}

/// The call actions offered outside the window: thumbnail buttons and the tray menu.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CallAction {
    Mic,
    Deafen,
    Leave,
}

impl ThumbnailToolbarSnapshot {
    /// Whether a click on this action should do anything right now.
    pub(crate) fn allows(&self, action: CallAction) -> bool {
        match action {
            CallAction::Mic => {
                self.signed_in && self.mic_supported && !self.busy && !self.mic_pending
            }
            CallAction::Deafen => {
                self.signed_in && self.deafen_supported && !self.busy && !self.deafen_pending
            }
            CallAction::Leave => {
                self.signed_in && self.has_media_session && !self.leave_pending
            }
        }
    }
}

#[derive(Default)]
struct SnapshotRegistry {
    current: ThumbnailToolbarSnapshot,
    retired_generations: VecDeque<String>,
}

#[derive(Default)]
pub struct ThumbnailToolbarState(Mutex<SnapshotRegistry>);

/// Store state during setup; the native window is installed after Tauri is ready.
pub fn initialize(app: &AppHandle) {
    app.manage(Arc::new(ThumbnailToolbarState::default()));
}

#[cfg(windows)]
pub fn install(app: &AppHandle) {
    let registry = app.state::<Arc<ThumbnailToolbarState>>().inner().clone();
    if let Err(error) = platform::install(app, registry) {
        eprintln!("[raven] thumbnail toolbar initialization failed: {error}");
    }
}

#[cfg(not(windows))]
pub fn install(_app: &AppHandle) {}

#[tauri::command]
pub fn thumbnail_toolbar_update(
    window: WebviewWindow,
    state: State<'_, Arc<ThumbnailToolbarState>>,
    snapshot: ThumbnailToolbarSnapshot,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("thumbnail toolbar updates are only available to the main window".into());
    }

    {
        let mut registry = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !apply_snapshot(&mut registry, snapshot) {
            return Ok(());
        }
    }

    #[cfg(windows)]
    {
        let native_window = window.clone();
        let registry = state.inner().clone();
        window
            .app_handle()
            .run_on_main_thread(move || {
                let hwnd = match native_window.hwnd() {
                    Ok(hwnd) => hwnd.0 as usize,
                    Err(error) => {
                        eprintln!(
                            "[raven] thumbnail toolbar window handle is unavailable: {error}"
                        );
                        return;
                    }
                };
                if let Err(error) = unsafe { platform::update_registered_toolbar(hwnd, &registry) }
                {
                    eprintln!("[raven] thumbnail toolbar update failed: {error}");
                }
            })
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn apply_snapshot(registry: &mut SnapshotRegistry, snapshot: ThumbnailToolbarSnapshot) -> bool {
    if snapshot.generation == registry.current.generation {
        if snapshot.revision <= registry.current.revision {
            return false;
        }
    } else {
        if registry.retired_generations.contains(&snapshot.generation) {
            return false;
        }
        if !registry.current.generation.is_empty() {
            let current_generation = registry.current.generation.clone();
            registry.retired_generations.push_back(current_generation);
            if registry.retired_generations.len() > 8 {
                registry.retired_generations.pop_front();
            }
        }
    }
    registry.current = snapshot;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(generation: &str, revision: u64) -> ThumbnailToolbarSnapshot {
        ThumbnailToolbarSnapshot {
            generation: generation.into(),
            revision,
            signed_in: true,
            mic_enabled: true,
            mic_supported: true,
            deafen_supported: true,
            ..Default::default()
        }
    }

    #[test]
    fn snapshots_ignore_old_revisions_and_retired_windows() {
        let mut registry = SnapshotRegistry::default();
        assert!(apply_snapshot(&mut registry, snapshot("first", 4)));
        assert!(!apply_snapshot(&mut registry, snapshot("first", 3)));
        assert_eq!(registry.current.revision, 4);

        assert!(apply_snapshot(&mut registry, snapshot("second", 1)));
        assert!(!apply_snapshot(&mut registry, snapshot("first", 5)));
        assert_eq!(registry.current.generation, "second");
    }
}

#[cfg(windows)]
mod platform {
    use super::{CallAction, ThumbnailToolbarSnapshot, ThumbnailToolbarState};
    use std::{
        ffi::c_void,
        sync::{Arc, OnceLock},
    };

    use tauri::{AppHandle, Emitter, Manager};
    use windows::{
        core::w,
        Win32::{
            Foundation::{HWND, LPARAM, LRESULT, WPARAM},
            System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER},
            UI::{
                Shell::{
                    DefSubclassProc, ITaskbarList3, RemoveWindowSubclass, SetWindowSubclass,
                    TaskbarList, THBF_DISABLED, THBF_DISMISSONCLICK, THBF_ENABLED, THBF_HIDDEN,
                    THB_FLAGS, THB_ICON, THB_TOOLTIP, THUMBBUTTON,
                },
                WindowsAndMessaging::{
                    CreateIconFromResourceEx, DestroyIcon, RegisterWindowMessageW, IMAGE_FLAGS,
                    WM_COMMAND, WM_NCDESTROY,
                },
            },
        },
    };

    const SUBCLASS_ID: usize = 0x5241_5645_4E54;
    const MIC_BUTTON: u32 = 1;
    const DEAFEN_BUTTON: u32 = 2;
    const LEAVE_BUTTON: u32 = 3;
    const THBN_CLICKED: usize = 0x1800;
    const EVENT_NAME: &str = "thumbnail-toolbar-action";

    static TASKBAR_BUTTON_CREATED: OnceLock<u32> = OnceLock::new();
    static TASKBAR_CREATED: OnceLock<u32> = OnceLock::new();

    struct NativeWindowState {
        app: AppHandle,
        registry: Arc<ThumbnailToolbarState>,
        registered: bool,
        icons: NativeIcons,
    }

    #[derive(Clone, Copy)]
    struct NativeIcons {
        mic_on: windows::Win32::UI::WindowsAndMessaging::HICON,
        mic_off: windows::Win32::UI::WindowsAndMessaging::HICON,
        headphones_on: windows::Win32::UI::WindowsAndMessaging::HICON,
        headphones_off: windows::Win32::UI::WindowsAndMessaging::HICON,
        leave: windows::Win32::UI::WindowsAndMessaging::HICON,
    }

    impl Drop for NativeWindowState {
        fn drop(&mut self) {
            unsafe {
                for icon in [
                    self.icons.mic_on,
                    self.icons.mic_off,
                    self.icons.headphones_on,
                    self.icons.headphones_off,
                    self.icons.leave,
                ] {
                    let _ = DestroyIcon(icon);
                }
            }
        }
    }

    pub(super) fn install(
        app: &AppHandle,
        registry: Arc<ThumbnailToolbarState>,
    ) -> Result<(), String> {
        let native_app = app.clone();
        app.run_on_main_thread(move || unsafe {
            let native_window = match native_app.get_webview_window("main") {
                Some(window) => window,
                None => {
                    eprintln!("[raven] thumbnail toolbar main window is unavailable");
                    return;
                }
            };
            let tauri_hwnd = match native_window.hwnd() {
                Ok(hwnd) => hwnd,
                Err(error) => {
                    eprintln!("[raven] thumbnail toolbar window handle is unavailable: {error}");
                    return;
                }
            };
            let hwnd = HWND(tauri_hwnd.0 as *mut c_void);
            let icons = match load_icons() {
                Ok(icons) => icons,
                Err(error) => {
                    eprintln!("[raven] thumbnail toolbar icons could not be loaded: {error}");
                    return;
                }
            };
            let native = Box::new(NativeWindowState {
                app: native_app.clone(),
                registry,
                registered: false,
                icons: NativeIcons {
                    mic_on: icons[0],
                    mic_off: icons[1],
                    headphones_on: icons[2],
                    headphones_off: icons[3],
                    leave: icons[4],
                },
            });
            let reference = Box::into_raw(native);
            if !SetWindowSubclass(
                hwnd,
                Some(window_subclass_proc),
                SUBCLASS_ID,
                reference as usize,
            )
            .as_bool()
            {
                drop(Box::from_raw(reference));
                eprintln!("[raven] thumbnail toolbar could not attach to the main window");
                return;
            }
            // TaskbarButtonCreated can be sent before the subclass is attached.
            // Try now, and retry on that message or the next state update if
            // Explorer has not associated the window with a taskbar button yet.
            if let Err(error) = add_toolbar(hwnd, &mut *reference) {
                eprintln!("[raven] thumbnail toolbar initial registration deferred: {error}");
            }
        })
        .map_err(|error| error.to_string())
    }

    fn load_icons() -> Result<[windows::Win32::UI::WindowsAndMessaging::HICON; 5], String> {
        let sources: [&[u8]; 5] = [
            include_bytes!("../icons/taskbar/mic-on.ico"),
            include_bytes!("../icons/taskbar/mic-off.ico"),
            include_bytes!("../icons/taskbar/headphones-on.ico"),
            include_bytes!("../icons/taskbar/headphones-off.ico"),
            include_bytes!("../icons/taskbar/leave.ico"),
        ];
        let mut loaded = Vec::with_capacity(sources.len());
        for source in sources {
            if source.len() < 22 {
                release_icons(&mut loaded);
                return Err("an embedded thumbnail icon is truncated".into());
            }
            let size =
                u32::from_le_bytes(source[14..18].try_into().expect("ICO image size")) as usize;
            if source.len() < 22 + size {
                release_icons(&mut loaded);
                return Err("an embedded thumbnail icon is truncated".into());
            }
            let image = &source[22..22 + size];
            let icon = match unsafe {
                CreateIconFromResourceEx(image, true, 0x0003_0000, 16, 16, IMAGE_FLAGS(0))
            } {
                Ok(icon) => icon,
                Err(error) => {
                    release_icons(&mut loaded);
                    return Err(error.to_string());
                }
            };
            loaded.push(icon);
        }
        loaded
            .try_into()
            .map_err(|_| "thumbnail icons could not be loaded".into())
    }

    fn release_icons(icons: &mut Vec<windows::Win32::UI::WindowsAndMessaging::HICON>) {
        for icon in icons.drain(..) {
            unsafe {
                let _ = DestroyIcon(icon);
            }
        }
    }

    fn taskbar_messages() -> (u32, u32) {
        let button_created = *TASKBAR_BUTTON_CREATED
            .get_or_init(|| unsafe { RegisterWindowMessageW(w!("TaskbarButtonCreated")) });
        let taskbar_created = *TASKBAR_CREATED
            .get_or_init(|| unsafe { RegisterWindowMessageW(w!("TaskbarCreated")) });
        (button_created, taskbar_created)
    }

    unsafe extern "system" fn window_subclass_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _subclass_id: usize,
        reference: usize,
    ) -> LRESULT {
        let state = &mut *(reference as *mut NativeWindowState);
        let (taskbar_button_created, taskbar_created) = taskbar_messages();

        if message == taskbar_created {
            state.registered = false;
            if let Err(error) = add_toolbar(hwnd, state) {
                eprintln!("[raven] thumbnail toolbar could not be restored: {error}");
            }
            return DefSubclassProc(hwnd, message, wparam, lparam);
        }
        if message == taskbar_button_created {
            if let Err(error) = add_toolbar(hwnd, state) {
                eprintln!("[raven] thumbnail toolbar could not be registered: {error}");
            }
            return DefSubclassProc(hwnd, message, wparam, lparam);
        }
        if message == WM_COMMAND && (wparam.0 >> 16) & 0xffff == THBN_CLICKED {
            let snapshot = current_snapshot(&state.registry);
            let action = action_for(&snapshot, (wparam.0 & 0xffff) as u32);
            if let Some(action) = action {
                let _ = state.app.emit_to("main", EVENT_NAME, action);
            }
            return LRESULT(0);
        }
        if message == WM_NCDESTROY {
            let _ = RemoveWindowSubclass(hwnd, Some(window_subclass_proc), SUBCLASS_ID);
            drop(Box::from_raw(reference as *mut NativeWindowState));
            return DefSubclassProc(hwnd, message, wparam, lparam);
        }

        DefSubclassProc(hwnd, message, wparam, lparam)
    }

    fn current_snapshot(registry: &ThumbnailToolbarState) -> ThumbnailToolbarSnapshot {
        registry
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .current
            .clone()
    }

    fn action_for(snapshot: &ThumbnailToolbarSnapshot, id: u32) -> Option<&'static str> {
        let (action, name) = match id {
            MIC_BUTTON => (CallAction::Mic, "mic"),
            DEAFEN_BUTTON => (CallAction::Deafen, "deafen"),
            LEAVE_BUTTON => (CallAction::Leave, "leave"),
            _ => return None,
        };
        snapshot.allows(action).then_some(name)
    }

    unsafe fn taskbar() -> Result<ITaskbarList3, String> {
        let list: ITaskbarList3 = CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| error.to_string())?;
        list.HrInit().map_err(|error| error.to_string())?;
        Ok(list)
    }

    unsafe fn add_toolbar(hwnd: HWND, state: &mut NativeWindowState) -> Result<(), String> {
        if state.registered {
            return Ok(());
        }
        let list = taskbar()?;
        list.ThumbBarAddButtons(
            hwnd,
            &buttons(&state.icons, &current_snapshot(&state.registry)),
        )
        .map_err(|error| error.to_string())?;
        state.registered = true;
        Ok(())
    }

    unsafe fn update_toolbar(hwnd: HWND, state: &mut NativeWindowState) -> Result<(), String> {
        let list = taskbar()?;
        list.ThumbBarUpdateButtons(
            hwnd,
            &buttons(&state.icons, &current_snapshot(&state.registry)),
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    unsafe fn refresh_from_window(hwnd: HWND, state: &mut NativeWindowState) -> Result<(), String> {
        if state.registered {
            update_toolbar(hwnd, state)
        } else {
            add_toolbar(hwnd, state)
        }
    }

    unsafe fn window_state(hwnd: HWND) -> Option<&'static mut NativeWindowState> {
        let mut reference = 0;
        windows::Win32::UI::Shell::GetWindowSubclass(
            hwnd,
            Some(window_subclass_proc),
            SUBCLASS_ID,
            Some(&mut reference),
        )
        .as_bool()
        .then(|| &mut *(reference as *mut NativeWindowState))
    }

    pub(super) unsafe fn update_registered_toolbar(
        hwnd: usize,
        registry: &Arc<ThumbnailToolbarState>,
    ) -> Result<(), String> {
        let hwnd = HWND(hwnd as *mut c_void);
        let state = window_state(hwnd)
            .ok_or_else(|| "the main window toolbar is not installed".to_string())?;
        if !Arc::ptr_eq(&state.registry, registry) {
            return Err("the main window toolbar state is no longer current".into());
        }
        if let Err(error) = refresh_from_window(hwnd, state) {
            state.registered = false;
            return Err(error);
        }
        Ok(())
    }

    fn buttons(icons: &NativeIcons, snapshot: &ThumbnailToolbarSnapshot) -> [THUMBBUTTON; 3] {
        let mic_present = snapshot.signed_in;
        let deafen_present = snapshot.signed_in;
        let leave_present = snapshot.signed_in && snapshot.has_media_session;
        let mic_enabled = snapshot.allows(CallAction::Mic);
        let deafen_enabled = snapshot.allows(CallAction::Deafen);
        let leave_enabled = snapshot.allows(CallAction::Leave);

        [
            make_button(
                MIC_BUTTON,
                if snapshot.mic_enabled {
                    icons.mic_on
                } else {
                    icons.mic_off
                },
                if snapshot.mic_enabled {
                    "Mute microphone"
                } else {
                    "Unmute microphone"
                },
                mic_present,
                mic_enabled,
                false,
            ),
            make_button(
                DEAFEN_BUTTON,
                if snapshot.deafened {
                    icons.headphones_off
                } else {
                    icons.headphones_on
                },
                if snapshot.deafened {
                    "Undeafen"
                } else {
                    "Deafen"
                },
                deafen_present,
                deafen_enabled,
                false,
            ),
            make_button(
                LEAVE_BUTTON,
                icons.leave,
                "Leave media session",
                leave_present,
                leave_enabled,
                true,
            ),
        ]
    }

    fn make_button(
        id: u32,
        icon: windows::Win32::UI::WindowsAndMessaging::HICON,
        tooltip: &str,
        visible: bool,
        enabled: bool,
        dismiss: bool,
    ) -> THUMBBUTTON {
        let mut button = THUMBBUTTON {
            dwMask: THB_FLAGS | THB_TOOLTIP | THB_ICON,
            iId: id,
            hIcon: icon,
            ..Default::default()
        };
        let mut flags = if enabled { THBF_ENABLED } else { THBF_DISABLED };
        if !visible {
            flags |= THBF_HIDDEN;
        }
        if dismiss {
            flags |= THBF_DISMISSONCLICK;
        }
        button.dwFlags = flags;
        let encoded = tooltip
            .encode_utf16()
            .take(button.szTip.len() - 1)
            .collect::<Vec<_>>();
        button.szTip[..encoded.len()].copy_from_slice(&encoded);
        button
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn snapshot() -> ThumbnailToolbarSnapshot {
            ThumbnailToolbarSnapshot {
                signed_in: true,
                mic_enabled: true,
                mic_supported: true,
                deafen_supported: true,
                ..Default::default()
            }
        }

        fn icons() -> NativeIcons {
            NativeIcons {
                mic_on: windows::Win32::UI::WindowsAndMessaging::HICON(1usize as *mut c_void),
                mic_off: windows::Win32::UI::WindowsAndMessaging::HICON(2usize as *mut c_void),
                headphones_on: windows::Win32::UI::WindowsAndMessaging::HICON(
                    3usize as *mut c_void,
                ),
                headphones_off: windows::Win32::UI::WindowsAndMessaging::HICON(
                    4usize as *mut c_void,
                ),
                leave: windows::Win32::UI::WindowsAndMessaging::HICON(5usize as *mut c_void),
            }
        }

        #[test]
        fn switches_state_icons_and_tooltips_with_mute_and_deafen() {
            let icon_set = icons();
            let mut current = snapshot();
            let audible = buttons(&icon_set, &current);
            assert_eq!(audible[0].hIcon, icon_set.mic_on);
            assert_eq!(audible[1].hIcon, icon_set.headphones_on);

            current.mic_enabled = false;
            current.deafened = true;
            let muted = buttons(&icon_set, &current);
            assert_eq!(muted[0].hIcon, icon_set.mic_off);
            assert_eq!(muted[1].hIcon, icon_set.headphones_off);
            assert_eq!(
                String::from_utf16_lossy(&muted[0].szTip[..17]),
                "Unmute microphone"
            );
            assert_eq!(String::from_utf16_lossy(&muted[1].szTip[..8]), "Undeafen");
        }

        #[test]
        fn embedded_png_icons_load_as_native_windows_icons() {
            let loaded = load_icons().expect("every taskbar icon should decode on Windows");
            for icon in loaded {
                unsafe {
                    DestroyIcon(icon).expect("the test should release each icon");
                }
            }
        }

        #[test]
        fn hides_leave_outside_a_session_and_all_actions_after_sign_out() {
            let icon_set = icons();
            let mut current = snapshot();
            let outside_call = buttons(&icon_set, &current);
            assert!(!outside_call[0].dwFlags.contains(THBF_HIDDEN));
            assert!(outside_call[2].dwFlags.contains(THBF_HIDDEN));

            current.signed_in = false;
            let signed_out = buttons(&icon_set, &current);
            assert!(signed_out
                .iter()
                .all(|button| button.dwFlags.contains(THBF_HIDDEN)));
        }

        #[test]
        fn disables_unsupported_and_busy_controls_but_keeps_leave_available_while_joining() {
            let icon_set = icons();
            let mut current = snapshot();
            current.mic_supported = false;
            current.busy = true;
            current.has_media_session = true;
            let buttons = buttons(&icon_set, &current);
            assert!(buttons[0].dwFlags.contains(THBF_DISABLED));
            assert!(buttons[1].dwFlags.contains(THBF_DISABLED));
            assert!(!buttons[2].dwFlags.contains(THBF_DISABLED));
        }

        #[test]
        fn accepts_only_known_enabled_clicks() {
            let mut current = snapshot();
            current.has_media_session = true;
            assert_eq!(action_for(&current, MIC_BUTTON), Some("mic"));
            assert_eq!(action_for(&current, DEAFEN_BUTTON), Some("deafen"));
            assert_eq!(action_for(&current, LEAVE_BUTTON), Some("leave"));
            assert_eq!(action_for(&current, 99), None);

            current.mic_pending = true;
            assert_eq!(action_for(&current, MIC_BUTTON), None);
            current.mic_pending = false;
            current.deafen_supported = false;
            assert_eq!(action_for(&current, DEAFEN_BUTTON), None);
            current.deafen_supported = true;
            current.leave_pending = true;
            assert_eq!(action_for(&current, LEAVE_BUTTON), None);
        }
    }
}
