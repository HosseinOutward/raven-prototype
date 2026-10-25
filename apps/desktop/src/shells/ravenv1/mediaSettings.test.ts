import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// The adapter's module reads localStorage as it loads, so the stand-in comes first.
const store = new Map<string, string>();
const localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
  removeItem: (key: string) => store.delete(key),
};
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage } });

let readMediaSettings: typeof import("./useRavenMediaAdapter").readMediaSettings;

beforeAll(async () => {
  ({ readMediaSettings } = await import("./useRavenMediaAdapter"));
});

beforeEach(() => store.clear());
afterAll(() => {
  Reflect.deleteProperty(globalThis, "window");
});

function saved(value: unknown) {
  store.set("raven.mediaSettings", JSON.stringify(value));
}

describe("remembered media settings", () => {
  test("leave what was never chosen to the engine's default", () => {
    expect(readMediaSettings()).toEqual({});
    saved({ selectedMic: "usb" });
    const settings = readMediaSettings();
    expect(settings.noiseSuppression).toBeUndefined();
    expect(settings.noiseSuppressionDepth).toBeUndefined();
    expect(settings.echoCancellation).toBeUndefined();
    expect(settings.autoGainControl).toBeUndefined();
  });

  test("keep the microphone's processing choices", () => {
    saved({ noiseSuppression: "standard", noiseSuppressionDepth: "full", echoCancellation: false, autoGainControl: true });
    expect(readMediaSettings()).toMatchObject({
      noiseSuppression: "standard",
      noiseSuppressionDepth: "full",
      echoCancellation: false,
      autoGainControl: true,
    });
  });

  test("drop values that are not valid choices", () => {
    saved({ noiseSuppression: "extreme", noiseSuppressionDepth: "max", echoCancellation: "no", autoGainControl: 1 });
    const settings = readMediaSettings();
    expect(settings.noiseSuppression).toBeUndefined();
    expect(settings.noiseSuppressionDepth).toBeUndefined();
    expect(settings.echoCancellation).toBeUndefined();
    expect(settings.autoGainControl).toBeUndefined();
  });
});
