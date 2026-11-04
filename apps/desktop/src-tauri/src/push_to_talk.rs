//! Push to talk: silence the microphones unless a key or mouse button is held.
//!
//! The key is read by polling on a native thread, only while the mode is on and the user is
//! in a call. A global shortcut would swallow the key and could not take a mouse button; a
//! game has to keep receiving what the person presses. Polling also cannot miss a release.
//! The result goes straight to the capture thread through an atomic (see `talk_gate` in
//! `audio::capture`), never through the WebView, and is not a mute: the track is not flagged
//! muted, so other people see someone who is not speaking.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::audio::state::{talk_gate, SharedAudioEngineState};
use crate::media_hotkeys;

pub const PUSH_TO_TALK_STATE_EVENT: &str = "push-to-talk-state";
const SETTINGS_FILE_NAME: &str = "push-to-talk.json";
const POLL_INTERVAL: Duration = Duration::from_millis(10);
/// Keeps the last syllable when the key comes up a moment before the voice stops.
const RELEASE_TAIL: Duration = Duration::from_millis(200);

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PushToTalkSettings {
    pub enabled: bool,
    /// Empty until the person picks one: there is no key that suits everybody.
    pub key: String,
    /// Play the unmute and mute cues on press and release.
    pub cue: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PushToTalkSettingsPatch {
    pub enabled: Option<bool>,
    pub key: Option<String>,
    pub cue: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushToTalkSettingsView {
    pub supported: bool,
    pub unsupported_reason: Option<String>,
    pub enabled: bool,
    pub key: String,
    pub cue: bool,
    pub talking: bool,
    /// Why the key cannot be read right now, while the mode is on.
    pub error: Option<String>,
}

struct Poller {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

#[derive(Default)]
pub struct PushToTalkState {
    settings: Mutex<PushToTalkSettings>,
    call_active: AtomicBool,
    poller: Mutex<Option<Poller>>,
    talking: AtomicBool,
    error: Mutex<Option<String>>,
}

pub fn new_push_to_talk_state() -> PushToTalkState {
    PushToTalkState::default()
}

pub fn initialize(app: &AppHandle) {
    let state = app.state::<PushToTalkState>();
    if let Ok(path) = settings_path(app) {
        *lock(&state.settings) = load_settings(&path);
    }
}

/// Called when the user joins and really leaves, not across the app's reconnect cycle.
pub fn set_call_active(app: &AppHandle, active: bool) {
    let state = app.state::<PushToTalkState>();
    state.call_active.store(active, Ordering::Relaxed);
    reconcile(app, &state);
}

#[tauri::command]
pub fn push_to_talk_get_settings(state: State<'_, PushToTalkState>) -> PushToTalkSettingsView {
    settings_view(&state)
}

#[tauri::command]
pub fn push_to_talk_update_settings(
    app: AppHandle,
    state: State<'_, PushToTalkState>,
    patch: PushToTalkSettingsPatch,
) -> Result<PushToTalkSettingsView, String> {
    let current = lock(&state.settings).clone();
    let next = apply_patch(&current, patch, &media_hotkeys::bound_hotkeys(&app))?;
    let path = settings_path(&app)?;
    save_settings(&path, &next)?;
    *lock(&state.settings) = next;
    reconcile(&app, &state);
    Ok(settings_view(&state))
}

fn apply_patch(
    current: &PushToTalkSettings,
    patch: PushToTalkSettingsPatch,
    bound_hotkeys: &[String],
) -> Result<PushToTalkSettings, String> {
    let mut next = current.clone();
    if let Some(key) = patch.key {
        let key = key.trim().to_string();
        Binding::parse(&key)?;
        if bound_hotkeys
            .iter()
            .any(|hotkey| hotkey.eq_ignore_ascii_case(&key))
        {
            return Err(format!(
                "{key} is already one of your shortcuts. Pick a different key."
            ));
        }
        next.key = key;
    }
    if let Some(cue) = patch.cue {
        next.cue = cue;
    }
    if let Some(enabled) = patch.enabled {
        next.enabled = enabled;
    }
    if next.enabled && next.key.is_empty() {
        return Err("Pick a key before turning on push to talk.".to_string());
    }
    Ok(next)
}

/// Make the polling thread and the gate match the settings and the call.
fn reconcile(app: &AppHandle, state: &PushToTalkState) {
    let Ok(gate) = talk_gate(&app.state::<SharedAudioEngineState>()) else {
        return;
    };
    let settings = lock(&state.settings).clone();
    let binding = (settings.enabled
        && state.call_active.load(Ordering::Relaxed)
        && media_hotkeys::platform_support().is_ok())
    .then(|| Binding::parse(&settings.key));

    let mut poller = lock(&state.poller);
    if let Some(running) = poller.take() {
        running.stop.store(true, Ordering::Relaxed);
        let _ = running.thread.join();
    }
    state.talking.store(false, Ordering::Relaxed);
    *lock(&state.error) = None;

    match binding {
        // Off, or not in a call: the mic is open, so the Mixer's meter still moves.
        None => gate.store(false, Ordering::Relaxed),
        // Closed until the key is read. If it never can be, say so and stay silent: a mic
        // that should be silent must not open because something failed.
        Some(Err(message)) => {
            gate.store(true, Ordering::Relaxed);
            *lock(&state.error) = Some(message);
        }
        Some(Ok(binding)) => {
            gate.store(true, Ordering::Relaxed);
            *poller = Some(start_polling(app.clone(), binding, gate));
        }
    }
    drop(poller);
    emit_state(app);
}

fn start_polling(app: AppHandle, binding: Binding, gate: Arc<AtomicBool>) -> Poller {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let thread = thread::spawn(move || {
        let state = app.state::<PushToTalkState>();
        // On this thread: an X11 connection belongs to the thread that opened it.
        let mut reader = match KeyReader::new(&binding) {
            Ok(reader) => reader,
            Err(message) => {
                *lock(&state.error) = Some(message);
                emit_state(&app);
                return;
            }
        };
        let mut release = ReleaseTail::default();
        let mut current = false;
        while !thread_stop.load(Ordering::Relaxed) {
            let next = release.step(reader.held(), Instant::now());
            if next != current {
                current = next;
                gate.store(!next, Ordering::Relaxed);
                state.talking.store(next, Ordering::Relaxed);
                emit_state(&app);
            }
            thread::sleep(POLL_INTERVAL);
        }
    });
    Poller { stop, thread }
}

/// The whole view, so the dock follows a change made in Settings too.
fn emit_state(app: &AppHandle) {
    let _ = app.emit(
        PUSH_TO_TALK_STATE_EVENT,
        settings_view(&app.state::<PushToTalkState>()),
    );
}

fn settings_view(state: &PushToTalkState) -> PushToTalkSettingsView {
    let support = media_hotkeys::platform_support();
    let settings = lock(&state.settings).clone();
    PushToTalkSettingsView {
        supported: support.is_ok(),
        unsupported_reason: support.err().map(str::to_string),
        enabled: settings.enabled,
        key: settings.key,
        cue: settings.cue,
        talking: state.talking.load(Ordering::Relaxed),
        error: lock(&state.error).clone(),
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(SETTINGS_FILE_NAME))
        .map_err(|error| error.to_string())
}

fn load_settings(path: &Path) -> PushToTalkSettings {
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

fn save_settings(path: &Path, settings: &PushToTalkSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let contents = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Whether the mic should be open, given the key and how long ago it came up.
#[derive(Default)]
struct ReleaseTail {
    talking: bool,
    closes_at: Option<Instant>,
}

impl ReleaseTail {
    fn step(&mut self, held: bool, now: Instant) -> bool {
        if held {
            self.talking = true;
            self.closes_at = None;
        } else if self.talking {
            let closes_at = *self.closes_at.get_or_insert(now + RELEASE_TAIL);
            if now >= closes_at {
                self.talking = false;
                self.closes_at = None;
            }
        }
        self.talking
    }
}

const NAMED_KEYS: &[&str] = &[
    "Space",
    "Tab",
    "CapsLock",
    "Enter",
    "Backspace",
    "Insert",
    "Delete",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Pause",
    "ScrollLock",
    "PrintScreen",
    "NumLock",
    "ContextMenu",
];
const PUNCTUATION: &str = "`-=[]\\;',./";
const MODIFIERS: &[&str] = &["Control", "Alt", "Shift", "Command"];
const MOUSE_BUTTONS: &[&str] = &["MouseMiddle", "MouseBack", "MouseForward"];

/// A key or mouse button, with any modifiers that must be held with it. Extra keys held at
/// the same time do not matter: sprinting with Shift must not cut you off.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Binding {
    modifiers: Vec<String>,
    key: String,
}

impl Binding {
    fn parse(value: &str) -> Result<Self, String> {
        let mut parts: Vec<&str> = value.split('+').map(str::trim).collect();
        // "+" is not a key we offer, so an empty part only ever means a malformed value.
        let key = parts.pop().unwrap_or_default();
        if !is_key(key) || parts.iter().any(|part| !MODIFIERS.contains(part)) {
            return Err(if value.is_empty() {
                "Pick a key before turning on push to talk.".to_string()
            } else {
                format!("Raven can't listen for {value}. Pick a different key.")
            });
        }
        Ok(Self {
            modifiers: parts.into_iter().map(str::to_string).collect(),
            key: key.to_string(),
        })
    }
}

fn is_key(key: &str) -> bool {
    let mut chars = key.chars();
    let single = match (chars.next(), chars.next()) {
        (Some(only), None) => {
            only.is_ascii_uppercase() || only.is_ascii_digit() || PUNCTUATION.contains(only)
        }
        _ => false,
    };
    single
        || NAMED_KEYS.contains(&key)
        || MODIFIERS.contains(&key)
        || MOUSE_BUTTONS.contains(&key)
        || function_number(key).is_some()
        || numpad_digit(key).is_some()
}

/// `F13` to 13.
fn function_number(key: &str) -> Option<u32> {
    let number: u32 = key.strip_prefix('F')?.parse().ok()?;
    (1..=24).contains(&number).then_some(number)
}

/// `Numpad3` to 3.
fn numpad_digit(key: &str) -> Option<u32> {
    let digit: u32 = key.strip_prefix("Numpad")?.parse().ok()?;
    (digit <= 9).then_some(digit)
}

#[cfg(windows)]
mod platform {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

    use super::{function_number, numpad_digit, Binding};

    /// Virtual keys for a token; any one of them being down counts.
    pub(super) fn virtual_keys(key: &str) -> Option<Vec<i32>> {
        if let Some(number) = function_number(key) {
            return Some(vec![0x6F + number as i32]);
        }
        if let Some(digit) = numpad_digit(key) {
            return Some(vec![0x60 + digit as i32]);
        }
        let vk = match key {
            "Control" => 0x11,
            "Alt" => 0x12,
            "Shift" => 0x10,
            "Command" => return Some(vec![0x5B, 0x5C]),
            "MouseMiddle" => 0x04,
            "MouseBack" => 0x05,
            "MouseForward" => 0x06,
            "Space" => 0x20,
            "Tab" => 0x09,
            "CapsLock" => 0x14,
            "Enter" => 0x0D,
            "Backspace" => 0x08,
            "Insert" => 0x2D,
            "Delete" => 0x2E,
            "Home" => 0x24,
            "End" => 0x23,
            "PageUp" => 0x21,
            "PageDown" => 0x22,
            "ArrowUp" => 0x26,
            "ArrowDown" => 0x28,
            "ArrowLeft" => 0x25,
            "ArrowRight" => 0x27,
            "Pause" => 0x13,
            "ScrollLock" => 0x91,
            "PrintScreen" => 0x2C,
            "NumLock" => 0x90,
            "ContextMenu" => 0x5D,
            ";" => 0xBA,
            "=" => 0xBB,
            "," => 0xBC,
            "-" => 0xBD,
            "." => 0xBE,
            "/" => 0xBF,
            "`" => 0xC0,
            "[" => 0xDB,
            "\\" => 0xDC,
            "]" => 0xDD,
            "'" => 0xDE,
            // Letters and digits share their ASCII code.
            single if single.len() == 1 => i32::from(single.as_bytes()[0]),
            _ => return None,
        };
        Some(vec![vk])
    }

    pub(super) struct KeyReader {
        modifiers: Vec<Vec<i32>>,
        key: Vec<i32>,
    }

    impl KeyReader {
        pub(super) fn new(binding: &Binding) -> Result<Self, String> {
            let lookup = |token: &str| {
                virtual_keys(token).ok_or_else(|| format!("Raven can't listen for {token}."))
            };
            Ok(Self {
                modifiers: binding
                    .modifiers
                    .iter()
                    .map(|modifier| lookup(modifier))
                    .collect::<Result<_, _>>()?,
                key: lookup(&binding.key)?,
            })
        }

        pub(super) fn held(&mut self) -> bool {
            self.modifiers.iter().all(|keys| any_down(keys)) && any_down(&self.key)
        }
    }

    fn any_down(keys: &[i32]) -> bool {
        // SAFETY: GetAsyncKeyState only reads the key state; any key code is accepted.
        keys.iter().any(|key| unsafe { GetAsyncKeyState(*key) } < 0)
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::{
        os::raw::{c_char, c_int},
        ptr,
    };

    use x11_dl::{xinput2, xlib};

    use super::{function_number, numpad_digit, Binding};

    /// X keysyms for a token; any one of them being down counts.
    pub(super) fn keysyms(key: &str) -> Option<Vec<u32>> {
        if let Some(number) = function_number(key) {
            return Some(vec![0xFFBD + number]);
        }
        if let Some(digit) = numpad_digit(key) {
            return Some(vec![0xFFB0 + digit]);
        }
        let keysym = match key {
            "Control" => return Some(vec![0xFFE3, 0xFFE4]),
            "Shift" => return Some(vec![0xFFE1, 0xFFE2]),
            "Alt" => return Some(vec![0xFFE9, 0xFFEA]),
            "Command" => return Some(vec![0xFFEB, 0xFFEC]),
            "Space" => 0x20,
            "Tab" => 0xFF09,
            "CapsLock" => 0xFFE5,
            "Enter" => 0xFF0D,
            "Backspace" => 0xFF08,
            "Insert" => 0xFF63,
            "Delete" => 0xFFFF,
            "Home" => 0xFF50,
            "End" => 0xFF57,
            "PageUp" => 0xFF55,
            "PageDown" => 0xFF56,
            "ArrowUp" => 0xFF52,
            "ArrowDown" => 0xFF54,
            "ArrowLeft" => 0xFF51,
            "ArrowRight" => 0xFF53,
            "Pause" => 0xFF13,
            "ScrollLock" => 0xFF14,
            "PrintScreen" => 0xFF61,
            "NumLock" => 0xFF7F,
            "ContextMenu" => 0xFF67,
            // Latin letters are keysyms in lower case; digits and punctuation as they are.
            single if single.len() == 1 => u32::from(single.as_bytes()[0].to_ascii_lowercase()),
            _ => return None,
        };
        Some(vec![keysym])
    }

    /// The X button number for a mouse token.
    fn mouse_button(key: &str) -> Option<u8> {
        match key {
            "MouseMiddle" => Some(2),
            "MouseBack" => Some(8),
            "MouseForward" => Some(9),
            _ => None,
        }
    }

    pub(super) struct KeyReader {
        xlib: xlib::Xlib,
        display: *mut xlib::Display,
        modifiers: Vec<Vec<u8>>,
        keycodes: Vec<u8>,
        mouse: Option<MouseReader>,
    }

    struct MouseReader {
        xinput: xinput2::XInput2,
        device: c_int,
        button: u8,
    }

    impl KeyReader {
        pub(super) fn new(binding: &Binding) -> Result<Self, String> {
            let xlib = xlib::Xlib::open().map_err(|_| "Raven could not open X11.".to_string())?;
            // SAFETY: null asks for the default display; the result is checked.
            let display = unsafe { (xlib.XOpenDisplay)(ptr::null()) };
            if display.is_null() {
                return Err("Raven could not connect to X11.".to_string());
            }
            let mut reader = Self {
                xlib,
                display,
                modifiers: Vec::new(),
                keycodes: Vec::new(),
                mouse: None,
            };
            for modifier in &binding.modifiers {
                let codes = reader.keycodes_for(modifier)?;
                reader.modifiers.push(codes);
            }
            if let Some(button) = mouse_button(&binding.key) {
                reader.mouse = Some(reader.open_mouse(button)?);
            } else {
                reader.keycodes = reader.keycodes_for(&binding.key)?;
            }
            Ok(reader)
        }

        fn keycodes_for(&self, token: &str) -> Result<Vec<u8>, String> {
            let unavailable =
                || format!("{token} isn't on your keyboard layout. Pick a different key.");
            let codes: Vec<u8> = keysyms(token)
                .ok_or_else(unavailable)?
                .into_iter()
                // SAFETY: the display is open; an unknown keysym returns 0.
                .map(|keysym| unsafe {
                    (self.xlib.XKeysymToKeycode)(self.display, xlib::KeySym::from(keysym))
                })
                .filter(|code| *code != 0)
                .collect();
            if codes.is_empty() {
                return Err(unavailable());
            }
            Ok(codes)
        }

        fn open_mouse(&self, button: u8) -> Result<MouseReader, String> {
            let missing = || {
                "Mouse buttons need the X Input extension (libXi). Pick a keyboard key.".to_string()
            };
            let xinput = xinput2::XInput2::open().map_err(|_| missing())?;
            let (mut opcode, mut event, mut error) = (0, 0, 0);
            let name = b"XInputExtension\0".as_ptr() as *const c_char;
            // SAFETY: the display is open and the out pointers live for the calls. Checking
            // the extension first matters: Xlib's default error handler exits the process.
            let device = unsafe {
                if (self.xlib.XQueryExtension)(
                    self.display,
                    name,
                    &mut opcode,
                    &mut event,
                    &mut error,
                ) == 0
                {
                    return Err(missing());
                }
                let (mut major, mut minor) = (2, 0);
                if (xinput.XIQueryVersion)(self.display, &mut major, &mut minor) != 0 {
                    return Err(missing());
                }
                let mut device = 0;
                (xinput.XIGetClientPointer)(self.display, 0, &mut device);
                device
            };
            Ok(MouseReader {
                xinput,
                device,
                button,
            })
        }

        pub(super) fn held(&mut self) -> bool {
            let mut keymap: [c_char; 32] = [0; 32];
            // SAFETY: XQueryKeymap writes exactly 32 bytes.
            unsafe { (self.xlib.XQueryKeymap)(self.display, keymap.as_mut_ptr()) };
            let down = |code: &u8| keymap[usize::from(*code / 8)] as u8 & (1 << (*code % 8)) != 0;
            if !self.modifiers.iter().all(|codes| codes.iter().any(down)) {
                return false;
            }
            match &self.mouse {
                Some(mouse) => self.mouse_down(mouse),
                None => self.keycodes.iter().any(down),
            }
        }

        fn mouse_down(&self, mouse: &MouseReader) -> bool {
            // SAFETY: the out pointers live for the call; the button mask Xlib allocates is
            // read within its stated length and then freed.
            unsafe {
                let root = (self.xlib.XDefaultRootWindow)(self.display);
                let (mut root_return, mut child) = (0, 0);
                let (mut root_x, mut root_y, mut win_x, mut win_y) = (0.0, 0.0, 0.0, 0.0);
                let mut buttons: xinput2::XIButtonState = std::mem::zeroed();
                let mut mods: xinput2::XIModifierState = std::mem::zeroed();
                let mut group: xinput2::XIGroupState = std::mem::zeroed();
                let found = (mouse.xinput.XIQueryPointer)(
                    self.display,
                    mouse.device,
                    root,
                    &mut root_return,
                    &mut child,
                    &mut root_x,
                    &mut root_y,
                    &mut win_x,
                    &mut win_y,
                    &mut buttons,
                    &mut mods,
                    &mut group,
                );
                let byte = c_int::from(mouse.button / 8);
                let down = found != 0
                    && !buttons.mask.is_null()
                    && byte < buttons.mask_len
                    && *buttons.mask.add(byte as usize) & (1 << (mouse.button % 8)) != 0;
                if !buttons.mask.is_null() {
                    (self.xlib.XFree)(buttons.mask.cast());
                }
                down
            }
        }
    }

    impl Drop for KeyReader {
        fn drop(&mut self) {
            // SAFETY: the display was opened in `new` and is closed once, here.
            unsafe { (self.xlib.XCloseDisplay)(self.display) };
        }
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    use super::Binding;

    /// Never reached: `platform_support` refuses the mode here.
    pub(super) struct KeyReader;

    impl KeyReader {
        pub(super) fn new(_binding: &Binding) -> Result<Self, String> {
            Err("Push to talk is not available on this platform yet.".to_string())
        }

        pub(super) fn held(&mut self) -> bool {
            false
        }
    }
}

use platform::KeyReader;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mic_stays_open_for_the_release_tail_then_closes() {
        let start = Instant::now();
        let mut tail = ReleaseTail::default();
        assert!(!tail.step(false, start), "starts closed");
        assert!(tail.step(true, start), "opens at once");
        assert!(tail.step(false, start + Duration::from_millis(10)));
        assert!(tail.step(false, start + Duration::from_millis(209)));
        assert!(!tail.step(false, start + Duration::from_millis(210)));
    }

    #[test]
    fn pressing_again_during_the_tail_cancels_it() {
        let start = Instant::now();
        let mut tail = ReleaseTail::default();
        tail.step(true, start);
        tail.step(false, start + Duration::from_millis(10));
        assert!(tail.step(true, start + Duration::from_millis(100)));
        // The tail restarts from this release, not the first one.
        assert!(tail.step(false, start + Duration::from_millis(300)));
        assert!(tail.step(false, start + Duration::from_millis(499)));
        assert!(!tail.step(false, start + Duration::from_millis(500)));
    }

    #[test]
    fn parses_what_the_key_field_produces() {
        for key in [
            "V",
            "7",
            "F13",
            "F24",
            "Space",
            "CapsLock",
            "`",
            "\\",
            "Numpad3",
            "Control",
            "MouseBack",
            "MouseForward",
            "MouseMiddle",
        ] {
            assert_eq!(Binding::parse(key).expect(key).key, key);
        }
        let chord = Binding::parse("Control+Shift+X").expect("chord");
        assert_eq!(chord.modifiers, ["Control", "Shift"]);
        assert_eq!(chord.key, "X");
    }

    #[test]
    fn refuses_what_it_cannot_read() {
        for key in [
            "",
            "MouseLeft",
            "MouseRight",
            "F25",
            "Numpad10",
            "ش",
            "v",
            "Nope+X",
            "Control+",
        ] {
            assert!(Binding::parse(key).is_err(), "{key}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn every_accepted_key_has_a_virtual_key() {
        assert_eq!(platform::virtual_keys("F13"), Some(vec![0x7C]));
        assert_eq!(platform::virtual_keys("F1"), Some(vec![0x70]));
        assert_eq!(platform::virtual_keys("V"), Some(vec![0x56]));
        assert_eq!(platform::virtual_keys("Numpad3"), Some(vec![0x63]));
        assert_eq!(platform::virtual_keys("MouseBack"), Some(vec![0x05]));
        for key in NAMED_KEYS.iter().chain(MODIFIERS).chain(MOUSE_BUTTONS) {
            assert!(platform::virtual_keys(key).is_some(), "{key}");
        }
        for mark in PUNCTUATION.chars() {
            assert!(
                platform::virtual_keys(&mark.to_string()).is_some(),
                "{mark}"
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn every_accepted_key_has_a_keysym() {
        assert_eq!(platform::keysyms("F1"), Some(vec![0xFFBE]));
        assert_eq!(platform::keysyms("V"), Some(vec![0x76]));
        for key in NAMED_KEYS.iter().chain(MODIFIERS) {
            assert!(platform::keysyms(key).is_some(), "{key}");
        }
    }

    #[test]
    fn turning_it_on_needs_a_key() {
        let on = PushToTalkSettingsPatch {
            enabled: Some(true),
            ..Default::default()
        };
        assert!(apply_patch(&PushToTalkSettings::default(), on.clone(), &[]).is_err());

        let with_key = PushToTalkSettings {
            key: "F13".into(),
            ..Default::default()
        };
        assert!(apply_patch(&with_key, on, &[]).expect("has a key").enabled);
    }

    #[test]
    fn refuses_a_key_that_is_already_a_shortcut() {
        let patch = PushToTalkSettingsPatch {
            key: Some("Control+Shift+M".into()),
            ..Default::default()
        };
        let refused = apply_patch(
            &PushToTalkSettings::default(),
            patch,
            &["control+shift+m".to_string()],
        );
        assert!(refused.is_err_and(|message| message.contains("already one of your shortcuts")));
    }
}
