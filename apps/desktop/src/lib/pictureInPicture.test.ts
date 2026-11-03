import { describe, expect, test } from "bun:test";
import { parseRoute } from "./route";
import { findPipTile, pipKey, pipRect, pipRoutePath, pipShapedSize, pipStatus, pipTargetForTile, type PipTile } from "./pictureInPicture";

const screen = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: 0, width: 2560, height: 1400 };

function tile(patch: Partial<PipTile> = {}): PipTile {
  return { participantId: "ada", isLocal: false, source: "camera", cameraEnabled: true, receiving: true, ...patch };
}

describe("routes", () => {
  test("a person's id survives the trip through the hash", () => {
    const target = { participantId: "ada#video/1", source: "screen" as const };
    expect(parseRoute(pipRoutePath(target).slice(1))).toEqual({ kind: "pip", target });
  });

  test("your own camera is addressed by role", () => {
    const target = pipTargetForTile(tile({ isLocal: true, participantId: "local" }));
    expect(target).toEqual({ participantId: null, source: "camera" });
    expect(pipRoutePath(target)).toBe("/#/pip/self/camera");
    expect(parseRoute("#/pip/self/camera")).toEqual({ kind: "pip", target });
  });

  test("a route that names no video is the main app", () => {
    expect(parseRoute("#/pip/ada/audio").kind).toBe("app");
    expect(parseRoute("#/pip/self/screen").kind).toBe("app");
    expect(parseRoute("#/pip").kind).toBe("app");
  });
});

describe("finding the tile", () => {
  test("own camera is found whatever the local id is", () => {
    const own = tile({ isLocal: true, participantId: "local" });
    expect(findPipTile([tile(), own], { participantId: null, source: "camera" })).toBe(own);
  });

  test("camera and screen of one person are different videos", () => {
    const share = tile({ source: "screenshare" });
    expect(findPipTile([tile(), share], { participantId: "ada", source: "screen" })).toBe(share);
    expect(pipKey({ participantId: "ada", source: "screen" })).not.toBe(pipKey({ participantId: "ada", source: "camera" }));
  });
});

describe("pipStatus", () => {
  const connected = { viewerConnected: true };

  test("a lost connection is not the end of the video", () => {
    expect(pipStatus({ viewerConnected: false }, undefined)).toBe("reconnecting");
    expect(pipStatus(null, undefined)).toBe("reconnecting");
  });

  test("the video is gone when there is nothing left to show", () => {
    expect(pipStatus(connected, undefined)).toBe("gone");
    expect(pipStatus(connected, tile({ cameraEnabled: false }))).toBe("gone");
    expect(pipStatus(connected, tile({ receiving: false }))).toBe("gone");
  });

  test("a share has no camera to check", () => {
    expect(pipStatus(connected, tile({ source: "screenshare", cameraEnabled: false }))).toBe("live");
  });
});

describe("pipShapedSize", () => {
  test("a landscape picture keeps the width", () => {
    expect(pipShapedSize({ width: 800, height: 300 }, 16 / 9, 1)).toEqual({ width: 800, height: 450 });
  });

  test("a portrait picture keeps the height", () => {
    expect(pipShapedSize({ width: 400, height: 640 }, 9 / 16, 1)).toEqual({ width: 360, height: 640 });
  });

  test("the right shape needs no change, rounding included", () => {
    expect(pipShapedSize({ width: 400, height: 225 }, 16 / 9, 1)).toBeNull();
    expect(pipShapedSize({ width: 401, height: 225 }, 16 / 9, 1)).toBeNull();
  });

  test("a very wide picture grows to the minimum height with its shape", () => {
    expect(pipShapedSize({ width: 240, height: 135 }, 32 / 9, 1)).toEqual({ width: 480, height: 135 });
    expect(pipShapedSize({ width: 240, height: 135 }, 32 / 9, 2)).toEqual({ width: 960, height: 270 });
  });
});

describe("pipRect", () => {
  const base = { areas: [screen, second], fallbackArea: screen, scale: 1, source: "screen" as const, openCount: 0 };

  test("the first window goes to the corner", () => {
    expect(pipRect({ ...base, remembered: null })).toEqual({ x: 1504, y: 799, width: 400, height: 225 });
  });

  test("scale applies to the default size and the margin", () => {
    const rect = pipRect({ ...base, remembered: null, scale: 2 });
    expect(rect.width).toBe(800);
    expect(rect.x).toBe(1920 - 800 - 32);
  });

  test("a remembered spot on another screen is kept", () => {
    const remembered = { x: 2100, y: 300, width: 500, height: 300 };
    expect(pipRect({ ...base, remembered })).toEqual(remembered);
  });

  test("a spot on an unplugged screen keeps the size and comes home", () => {
    const rect = pipRect({ ...base, areas: [screen], remembered: { x: 2100, y: 300, width: 500, height: 300 } });
    expect(rect).toEqual({ x: 1404, y: 724, width: 500, height: 300 });
  });

  test("windows in the default corner stack instead of covering each other", () => {
    const share = pipRect({ ...base, remembered: null });
    const camera = pipRect({ ...base, remembered: null, source: "camera", openCount: 1 });
    expect(camera.y + camera.height).toBeLessThanOrEqual(share.y);
  });

  test("windows from a remembered spot step away and stay on the screen", () => {
    expect(pipRect({ ...base, remembered: { x: 500, y: 500, width: 400, height: 225 }, openCount: 2 })).toEqual({ x: 452, y: 452, width: 400, height: 225 });
    const corner = pipRect({ ...base, remembered: { x: 0, y: 0, width: 400, height: 225 }, openCount: 2 });
    expect([corner.x, corner.y]).toEqual([0, 0]);
  });

  test("a window never outgrows the screen", () => {
    const small = { x: 0, y: 0, width: 300, height: 200 };
    expect(pipRect({ ...base, areas: [small], fallbackArea: small, remembered: null })).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  });
});
