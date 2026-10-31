import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { AudioMixerState } from "./audio";
import {
  formatOutputVolume,
  migrateLegacyOutputVolume,
  readLegacyOutputVolume,
  normalizeOutputVolumeDb,
  OUTPUT_VOLUME_MAX_DB,
  OUTPUT_VOLUME_MIN_DB,
  volumeAfterKey,
} from "./outputVolume";

describe("normalizeOutputVolumeDb", () => {
  test("clamps to the range and falls back to 0 dB", () => {
    expect(normalizeOutputVolumeDb(-12)).toBe(-12);
    expect(normalizeOutputVolumeDb(-100)).toBe(OUTPUT_VOLUME_MIN_DB);
    expect(normalizeOutputVolumeDb(100)).toBe(OUTPUT_VOLUME_MAX_DB);
    expect(normalizeOutputVolumeDb(undefined)).toBe(0);
    expect(normalizeOutputVolumeDb("3")).toBe(0);
    expect(normalizeOutputVolumeDb(Number.NaN)).toBe(0);
    expect(normalizeOutputVolumeDb(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("volumeAfterKey", () => {
  test("arrows move 1 dB, page keys 6 dB, Home and End the ends", () => {
    expect(volumeAfterKey(0, "ArrowUp")).toBe(1);
    expect(volumeAfterKey(0, "ArrowLeft")).toBe(-1);
    expect(volumeAfterKey(0, "PageDown")).toBe(-6);
    expect(volumeAfterKey(-3, "PageUp")).toBe(3);
    expect(volumeAfterKey(-3, "Home")).toBe(-40);
    expect(volumeAfterKey(-3, "End")).toBe(6);
  });

  test("stops at the ends and ignores other keys", () => {
    expect(volumeAfterKey(6, "ArrowUp")).toBe(6);
    expect(volumeAfterKey(-40, "PageDown")).toBe(-40);
    expect(volumeAfterKey(0, "a")).toBeNull();
  });
});

describe("formatOutputVolume", () => {
  test("shows the sign the way the other faders do", () => {
    expect(formatOutputVolume(0)).toBe("0 dB");
    expect(formatOutputVolume(-12)).toBe("−12 dB");
    expect(formatOutputVolume(6)).toBe("+6 dB");
  });
});

const store = new Map<string, string>();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    },
  },
});
afterAll(() => Reflect.deleteProperty(globalThis, "window"));
beforeEach(() => store.clear());

const SETTINGS = "raven.mediaSettings";
const legacyStored = () => JSON.parse(store.get(SETTINGS) ?? "{}") as Record<string, unknown>;
const fakeState = {} as AudioMixerState;

describe("moving a volume saved by an older version", () => {
  test("reads it clamped, and null when there is none", () => {
    expect(readLegacyOutputVolume()).toBeNull();
    store.set(SETTINGS, JSON.stringify({ selectedMic: "usb" }));
    expect(readLegacyOutputVolume()).toBeNull();
    store.set(SETTINGS, JSON.stringify({ outputVolumeDb: -99 }));
    expect(readLegacyOutputVolume()).toBe(-40);
    store.set(SETTINGS, JSON.stringify({ outputVolumeDb: "loud" }));
    expect(readLegacyOutputVolume()).toBeNull();
  });

  test("pushes it once when the engine has none, then drops the key and keeps the other settings", async () => {
    store.set(SETTINGS, JSON.stringify({ selectedMic: "usb", outputVolumeDb: -20 }));
    const sent: number[] = [];
    const state = await migrateLegacyOutputVolume(-20, false, async (db) => {
      sent.push(db);
      return fakeState;
    });
    expect(sent).toEqual([-20]);
    expect(state).toBe(fakeState);
    expect(legacyStored()).toEqual({ selectedMic: "usb" });
  });

  test("never overrides a volume the engine already saved, but still drops the key", async () => {
    store.set(SETTINGS, JSON.stringify({ outputVolumeDb: -20 }));
    const sent: number[] = [];
    const state = await migrateLegacyOutputVolume(-20, true, async (db) => {
      sent.push(db);
      return fakeState;
    });
    expect(sent).toEqual([]);
    expect(state).toBeNull();
    expect(legacyStored()).toEqual({});
  });

  test("keeps the key when the push fails, and does nothing without one", async () => {
    store.set(SETTINGS, JSON.stringify({ outputVolumeDb: -12 }));
    await expect(
      migrateLegacyOutputVolume(-12, false, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow();
    expect(legacyStored()).toEqual({ outputVolumeDb: -12 });
    expect(await migrateLegacyOutputVolume(null, false)).toBeNull();
  });
});
