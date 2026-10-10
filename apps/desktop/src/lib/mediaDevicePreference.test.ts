import { describe, expect, test } from "bun:test";
import { normalizeSelectedDeviceId, selectedDeviceIdForSource } from "./mediaDevicePreference";

describe("microphone device preference", () => {
  test("restores a saved device when a recreated source has no active selection", () => {
    expect(selectedDeviceIdForSource(null, "Focusrite USB")).toBe("Focusrite USB");
  });

  test("preserves an explicit Default selection", () => {
    expect(selectedDeviceIdForSource(null, null)).toBeNull();
  });

  test("does not replace a missing saved device with Default", () => {
    // Availability is validated by native capture; the UI keeps the requested id
    // visible so a reconnected device can be restored instead of being forgotten.
    expect(selectedDeviceIdForSource(null, "Disconnected microphone")).toBe("Disconnected microphone");
  });

  test("rejects malformed persisted ids as an explicit Default choice", () => {
    expect(normalizeSelectedDeviceId("   ")).toBeNull();
    expect(normalizeSelectedDeviceId(null)).toBeNull();
    expect(normalizeSelectedDeviceId("Voicemeeter Input")).toBe("Voicemeeter Input");
  });
});
