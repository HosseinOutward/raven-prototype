import { describe, expect, test } from "bun:test";
import { captureAllowed, isNewerState, stateTransition, type MobileNativeMediaState } from "./media";

const snapshot = (epoch: number, patch: Partial<MobileNativeMediaState> = {}): MobileNativeMediaState => ({
  foreground: true,
  epoch,
  callActive: false,
  microphone: "notRequested",
  camera: "notRequested",
  focus: true,
  route: "speaker",
  ...patch,
});

describe("MobileNative lifecycle snapshots", () => {
  test("ends the old call when JavaScript resumes after missing background events", () => {
    const call = snapshot(4, { callActive: true, microphone: "granted" });
    const resumed = snapshot(5, { foreground: true, callActive: false, microphone: "granted" });
    expect(stateTransition(call, resumed).stopCall).toBe(true);
    expect(stateTransition(resumed, resumed).stopCall).toBe(false);
  });
  test("discards an older query result after a newer lifecycle event", () => {
    const backgrounded = snapshot(8, { foreground: false, callActive: false });
    expect(isNewerState(backgrounded, snapshot(7))).toBe(false);
    expect(isNewerState(backgrounded, snapshot(8, { microphone: "granted" }))).toBe(true);
  });

  test("represents background teardown as terminal while permission return stays foreground", () => {
    const call = snapshot(4, { callActive: true, microphone: "granted" });
    const stopped = snapshot(5, { foreground: false, callActive: false, microphone: "granted" });
    const settingsReturn = snapshot(6, { foreground: true, callActive: false, microphone: "requiresSettings" });
    expect(isNewerState(call, stopped)).toBe(true);
    expect(isNewerState(stopped, settingsReturn)).toBe(true);
    expect(settingsReturn.callActive).toBe(false);
    expect(stateTransition(call, stopped)).toEqual({ stopCall: true, refresh: false });
    expect(stateTransition(stopped, settingsReturn)).toEqual({ stopCall: false, refresh: true });
  });

  test("keeps denied-mic joins receive-only and blocks stale background capture", () => {
    const deniedReceiveOnly = snapshot(2, { callActive: true, microphone: "denied", camera: "granted" });
    const background = snapshot(3, { foreground: false, callActive: false, microphone: "granted", camera: "granted" });
    expect(captureAllowed(deniedReceiveOnly, "microphone")).toBe(false);
    expect(captureAllowed(deniedReceiveOnly, "camera")).toBe(true);
    expect(captureAllowed(background, "microphone")).toBe(false);
    expect(captureAllowed(background, "camera")).toBe(false);
  });
});
