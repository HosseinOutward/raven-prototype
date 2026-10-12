import { beforeAll, describe, expect, test } from "bun:test";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

let mediaReconnectDelayMs: typeof import("./useRavenMediaAdapter").mediaReconnectDelayMs;
let MEDIA_RECONNECT_DELAYS_MS: typeof import("./useRavenMediaAdapter").MEDIA_RECONNECT_DELAYS_MS;

beforeAll(async () => {
  ({ mediaReconnectDelayMs, MEDIA_RECONNECT_DELAYS_MS } = await import("./useRavenMediaAdapter"));
});

describe("media reconnect backoff", () => {
  test("starts quickly, backs off, and settles at the longest delay", () => {
    expect(mediaReconnectDelayMs(0)).toBe(1000);
    const delays = Array.from({ length: 12 }, (_, attempt) => mediaReconnectDelayMs(attempt));
    expect([...delays].sort((a, b) => a - b)).toEqual(delays);
    expect(delays.at(-1)).toBe(MEDIA_RECONNECT_DELAYS_MS.at(-1)!);
    expect(delays.at(-1)).toBeLessThanOrEqual(30_000);
  });

  test("tolerates nonsense attempt counts", () => {
    expect(mediaReconnectDelayMs(-3)).toBe(1000);
    expect(mediaReconnectDelayMs(Number.NaN)).toBe(1000);
    expect(mediaReconnectDelayMs(2.9)).toBe(mediaReconnectDelayMs(2));
  });
});
