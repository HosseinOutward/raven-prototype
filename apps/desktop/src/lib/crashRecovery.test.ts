import { beforeAll, describe, expect, test } from "bun:test";

const store = new Map<string, string>();

beforeAll(() => {
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  // A reload in the middle of a call: the previous page left its Nest behind.
  store.set("raven.activeNest", "nest-1");
});

describe("crash recovery", () => {
  test("hands back the call a reloaded window was in, once", async () => {
    const { takeNestToRejoin, rememberActiveNest } = await import("./crashRecovery");
    // The new page records its own empty state before the shell asks.
    rememberActiveNest(null);
    expect(takeNestToRejoin()).toBe("nest-1");
    expect(takeNestToRejoin()).toBeNull();
  });

  test("reloads on its own at most once a minute", async () => {
    const { claimAutoReload } = await import("./crashRecovery");
    expect(claimAutoReload(1_000_000)).toBe(true);
    expect(claimAutoReload(1_030_000)).toBe(false);
    expect(claimAutoReload(1_061_000)).toBe(true);
  });
});
