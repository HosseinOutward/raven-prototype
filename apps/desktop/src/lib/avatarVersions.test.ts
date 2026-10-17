import { afterEach, beforeAll, describe, expect, test } from "bun:test";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

let ApiClient: typeof import("./api").ApiClient;
let versions: typeof import("./avatarVersions");

beforeAll(async () => {
  ({ ApiClient } = await import("./api"));
  versions = await import("./avatarVersions");
});

afterEach(() => versions.clearAvatarVersions());

describe("avatar versions", () => {
  test("userAvatarUrl is unversioned until a version is known", () => {
    const client = new ApiClient();
    expect(client.userAvatarUrl("alice")).toEndWith("/v1/media/users/alice/avatar");
    expect(client.userAvatarUrl("alice", "1")).toEndWith("/v1/media/users/alice/avatar?v=1");
  });

  test("a known version reaches every caller, and wins over an older one passed in", () => {
    const client = new ApiClient();
    versions.noteAvatarVersion("alice", "2026-10-17T10:00:00Z");
    expect(client.userAvatarUrl("alice")).toEndWith("/v1/media/users/alice/avatar?v=2026-10-17T10%3A00%3A00Z");
    expect(client.userAvatarUrl("alice", "old")).toEndWith("?v=2026-10-17T10%3A00%3A00Z");
    expect(client.userAvatarUrl("bob")).toEndWith("/v1/media/users/bob/avatar");
  });

  test("freshAvatarSrc rewrites only a known person's picture", () => {
    versions.noteAvatarVersion("a b", "7");
    expect(versions.freshAvatarSrc("http://x/v1/media/users/a%20b/avatar")).toBe("http://x/v1/media/users/a%20b/avatar?v=7");
    expect(versions.freshAvatarSrc("http://x/v1/media/users/a%20b/avatar?v=3")).toBe("http://x/v1/media/users/a%20b/avatar?v=7");
    expect(versions.freshAvatarSrc("http://x/v1/media/users/c/avatar?v=3")).toBe("http://x/v1/media/users/c/avatar?v=3");
    expect(versions.freshAvatarSrc("http://x/v1/media/trees/a%20b/avatar?v=3")).toBe("http://x/v1/media/trees/a%20b/avatar?v=3");
  });

  test("an upload's route records the version, and listeners hear each change once", () => {
    let calls = 0;
    const unsubscribe = versions.subscribeAvatarVersions(() => calls++);
    versions.noteAvatarRoute("/v1/media/users/alice/avatar?v=2026-10-17T10%3A00%3A00Z");
    versions.noteAvatarVersion("alice", "2026-10-17T10:00:00Z");
    unsubscribe();
    expect(versions.avatarVersion("alice")).toBe("2026-10-17T10:00:00Z");
    expect(calls).toBe(1);
  });
});
