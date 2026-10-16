import { describe, expect, test } from "bun:test";
import { effectiveReceiving, settlePending } from "./useVideoReceiving";

describe("what you chose to receive", () => {
  test("a click shows at once, then the engine's state takes over", () => {
    expect(effectiveReceiving(false, true)).toBe(true);
    expect(effectiveReceiving(true, undefined)).toBe(true);
    expect(effectiveReceiving(false, undefined)).toBe(false);
  });

  test("pending choices are dropped once the engine agrees or the track is gone", () => {
    const engine: Record<string, boolean> = { "sara:screenshare": true, "omid:screenshare": false };
    const pending = { "sara:screenshare": true, "omid:screenshare": true, "gone:camera": false };
    expect(settlePending(pending, (key) => engine[key])).toEqual({ "omid:screenshare": true });
  });

  test("nothing to settle keeps the same object so React skips the update", () => {
    const pending = { "omid:screenshare": true };
    expect(settlePending(pending, () => false)).toBe(pending);
  });
});
