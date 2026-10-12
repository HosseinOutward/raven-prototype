import { describe, expect, test } from "bun:test";
import { isVisualTile, newestScreenShareKey, partitionStageTiles, resolveStageFocusKey } from "./stageState";

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

describe("voice and video on the stage", () => {
  const voiceOnly = (key: string) => ({ key, source: "camera" as const, cameraEnabled: false });
  const onCamera = (key: string) => ({ key, source: "camera" as const, cameraEnabled: true, streamUrl: "http://local/camera.mjpg" });
  const sharing = (key: string) => ({ key, source: "screenshare" as const, cameraEnabled: false, loading: true });

  test("a room where nobody is on camera has no video tiles", () => {
    const { visual, voice } = partitionStageTiles([voiceOnly("a"), voiceOnly("b")]);
    expect(visual).toEqual([]);
    expect(voice.map((tile) => tile.key)).toEqual(["a", "b"]);
  });

  test("cameras and screen shares get tiles, voice-only people do not, and order is kept", () => {
    const { visual, voice } = partitionStageTiles([voiceOnly("a"), onCamera("b"), sharing("c"), voiceOnly("d")]);
    expect(visual.map((tile) => tile.key)).toEqual(["b", "c"]);
    expect(voice.map((tile) => tile.key)).toEqual(["a", "d"]);
  });

  test("a camera that is starting or failed still holds a tile so its state can be shown", () => {
    expect(isVisualTile({ source: "camera", cameraEnabled: false, loading: true })).toBe(true);
    expect(isVisualTile({ source: "camera", cameraEnabled: false, mediaError: "Camera capture could not start" })).toBe(true);
    expect(isVisualTile({ source: "camera", cameraEnabled: false })).toBe(false);
  });
});
