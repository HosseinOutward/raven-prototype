import { describe, expect, test } from "bun:test";
import { newestScreenShareKey, resolveStageFocusKey } from "./stageState";

const camera = (key: string) => ({ key, source: "camera" as const, speaking: false, streamUrl: "http://local/camera.mjpg" });
const share = (key: string, shareStartedAt: number) => ({ key, source: "screenshare" as const, speaking: false, streamUrl: "http://local/share.mjpg", shareStartedAt });

describe("stage focus", () => {
  test("the newest active screen share has automatic priority", () => {
    expect(newestScreenShareKey([share("first", 1), share("latest", 3), share("middle", 2)])).toBe("latest");
  });

  test("a manual pin overrides newly started screen shares", () => {
    expect(resolveStageFocusKey({ tiles: [camera("person"), share("latest", 8)], manualPinKey: "person", followScreenShares: true, focusMode: false })).toBe("person");
  });

  test("removing a manual pin falls back to the newest active share", () => {
    expect(resolveStageFocusKey({ tiles: [share("older", 2), share("newer", 4)], manualPinKey: "gone", followScreenShares: true, focusMode: false })).toBe("newer");
  });

  test("ending the focused share falls back through the remaining shares, then grid", () => {
    expect(resolveStageFocusKey({ tiles: [share("older", 2)], manualPinKey: null, followScreenShares: true, focusMode: false })).toBe("older");
    expect(resolveStageFocusKey({ tiles: [camera("person")], manualPinKey: null, followScreenShares: true, focusMode: false })).toBeNull();
  });
});
