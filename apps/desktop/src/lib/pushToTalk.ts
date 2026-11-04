import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const PUSH_TO_TALK_STATE_EVENT = "push-to-talk-state";

export interface PushToTalkSettings {
  supported: boolean;
  /** Why push to talk is unavailable in this session, when `supported` is false. */
  unsupportedReason?: string | null;
  enabled: boolean;
  /** Empty until the person picks one. */
  key: string;
  /** Play the unmute and mute cues on press and release. */
  cue: boolean;
  talking: boolean;
  /** Why the key cannot be read right now, while the mode is on. */
  error: string | null;
}

export type PushToTalkSettingsPatch = Partial<Pick<PushToTalkSettings, "enabled" | "key" | "cue">>;

export const pushToTalkCommands = {
  getSettings: () => invoke<PushToTalkSettings>("push_to_talk_get_settings"),
  updateSettings: (patch: PushToTalkSettingsPatch) =>
    invoke<PushToTalkSettings>("push_to_talk_update_settings", { patch }),
};

export function subscribePushToTalkState(onChange: (state: PushToTalkSettings) => void) {
  return listen<PushToTalkSettings>(PUSH_TO_TALK_STATE_EVENT, (event) => onChange(event.payload));
}

const MODIFIER_CODES: Record<string, string> = {
  ControlLeft: "Control",
  ControlRight: "Control",
  AltLeft: "Alt",
  AltRight: "Alt",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
  MetaLeft: "Command",
  MetaRight: "Command",
};

const NAMED_CODES: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  NumpadEnter: "Enter",
};

const PASSED_THROUGH_CODES = new Set([
  "Space", "Tab", "CapsLock", "Enter", "Backspace", "Insert", "Delete", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Pause", "ScrollLock", "PrintScreen", "NumLock", "ContextMenu",
]);

/** The key name for a physical key. Null when it is a modifier or not one Raven can read. */
function keyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return code;
  if (PASSED_THROUGH_CODES.has(code)) return code;
  return NAMED_CODES[code] ?? null;
}

type KeyEventFields = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/**
 * The binding for a key press, from the physical key rather than its character: on a Persian
 * layout the character is a Persian letter, and the engine reads the key's position anyway.
 * Null for a modifier on its own, which only counts once it is released with nothing else
 * pressed (see `formatPushToTalkModifier`).
 */
export function formatPushToTalkEvent(event: KeyEventFields): string | null {
  const key = keyFromCode(event.code);
  if (!key) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Control");
  if (event.metaKey) parts.push("Command");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

export function formatPushToTalkModifier(code: string): string | null {
  return MODIFIER_CODES[code] ?? null;
}

/** Left and right click are never offered: you would talk on every click. */
export function formatPushToTalkMouseButton(button: number): string | null {
  if (button === 1) return "MouseMiddle";
  if (button === 3) return "MouseBack";
  if (button === 4) return "MouseForward";
  return null;
}

const KEY_LABELS: Record<string, string> = {
  MouseMiddle: "Middle mouse button",
  MouseBack: "Mouse back button",
  MouseForward: "Mouse forward button",
  Control: "Ctrl",
  Command: "Win",
};

/** A binding as a person reads it. */
export function pushToTalkKeyLabel(key: string) {
  return key.split("+").map((part) => KEY_LABELS[part] ?? part).join(" + ");
}
