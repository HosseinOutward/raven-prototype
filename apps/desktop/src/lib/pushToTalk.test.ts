import { describe, expect, test } from "bun:test";
import { formatPushToTalkEvent, formatPushToTalkModifier, formatPushToTalkMouseButton, pushToTalkKeyLabel } from "./pushToTalk";

const key = (code: string, modifiers: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...modifiers,
});

describe("formatPushToTalkEvent", () => {
  test("names the physical key, so a Persian layout gives the same binding", () => {
    expect(formatPushToTalkEvent(key("KeyV"))).toBe("V");
    expect(formatPushToTalkEvent(key("Digit7"))).toBe("7");
    expect(formatPushToTalkEvent(key("Backquote"))).toBe("`");
  });

  test("keeps function, numpad and named keys", () => {
    expect(formatPushToTalkEvent(key("F13"))).toBe("F13");
    expect(formatPushToTalkEvent(key("Numpad3"))).toBe("Numpad3");
    expect(formatPushToTalkEvent(key("CapsLock"))).toBe("CapsLock");
    expect(formatPushToTalkEvent(key("NumpadEnter"))).toBe("Enter");
  });

  test("includes modifiers held with the key", () => {
    expect(formatPushToTalkEvent(key("KeyX", { ctrlKey: true, shiftKey: true }))).toBe("Control+Shift+X");
  });

  test("leaves a modifier alone and refuses unknown keys", () => {
    expect(formatPushToTalkEvent(key("ShiftLeft", { shiftKey: true }))).toBeNull();
    expect(formatPushToTalkEvent(key("F25"))).toBeNull();
    expect(formatPushToTalkEvent(key("IntlBackslash"))).toBeNull();
  });
});

test("a modifier alone binds to its plain name", () => {
  expect(formatPushToTalkModifier("ControlRight")).toBe("Control");
  expect(formatPushToTalkModifier("KeyA")).toBeNull();
});

test("left and right click are refused", () => {
  expect(formatPushToTalkMouseButton(0)).toBeNull();
  expect(formatPushToTalkMouseButton(2)).toBeNull();
  expect(formatPushToTalkMouseButton(1)).toBe("MouseMiddle");
  expect(formatPushToTalkMouseButton(3)).toBe("MouseBack");
  expect(formatPushToTalkMouseButton(4)).toBe("MouseForward");
});

test("labels read as words", () => {
  expect(pushToTalkKeyLabel("MouseBack")).toBe("Mouse back button");
  expect(pushToTalkKeyLabel("Control+Shift+X")).toBe("Ctrl + Shift + X");
});
