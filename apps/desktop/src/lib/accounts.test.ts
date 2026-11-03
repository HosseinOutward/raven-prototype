import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  ACCOUNTS_KEY,
  accountCaption,
  readAccounts,
  removeBySession,
  sortForMenu,
  upsertAccount,
  writeAccounts,
  type SavedAccount,
} from "./accounts";

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
}

function account(overrides: Partial<SavedAccount> = {}): SavedAccount {
  return {
    serverUrl: "https://a.example",
    sessionId: "s1",
    userId: "u1",
    username: "mina",
    displayName: "Mina",
    serverName: "Alpha",
    lastUsedAt: 100,
    ...overrides,
  };
}

describe("accountCaption", () => {
  test("a named server shows its name, without the username", () => {
    const only = account();
    expect(accountCaption(only, [only])).toEqual({ handle: undefined, server: "Alpha", serverIsHost: false });
  });

  test("an unnamed or default-named server shows its host", () => {
    for (const serverName of ["", "Raven"]) {
      const only = account({ serverName });
      expect(accountCaption(only, [only])).toEqual({ handle: undefined, server: "a.example", serverIsHost: true });
    }
  });

  test("two servers sharing a name show their hosts", () => {
    const first = account();
    const second = account({ serverUrl: "https://b.example", sessionId: "s2" });
    expect(accountCaption(second, [first, second])).toEqual({ handle: undefined, server: "b.example", serverIsHost: true });
  });

  test("two people with one name on a server show their usernames", () => {
    const first = account();
    const second = account({ userId: "u2", sessionId: "s2", username: "mina2" });
    expect(accountCaption(second, [first, second]).handle).toBe("@mina2");
    expect(accountCaption(first, [first, account({ userId: "u3", displayName: "Other" })]).handle).toBeUndefined();
  });
});

describe("saved accounts storage", () => {
  test("a missing, unreadable or non-list value reads as empty", () => {
    expect(readAccounts(memoryStorage())).toEqual([]);
    expect(readAccounts(memoryStorage({ [ACCOUNTS_KEY]: "not json" }))).toEqual([]);
    expect(readAccounts(memoryStorage({ [ACCOUNTS_KEY]: '{"a":1}' }))).toEqual([]);
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readAccounts(throwing)).toEqual([]);
    expect(() => writeAccounts(throwing, [account()])).not.toThrow();
  });

  test("malformed entries are dropped and good ones kept", () => {
    const good = account();
    const raw = JSON.stringify([good, null, "x", { ...good, sessionId: 4 }, { ...good, userId: "" }, { ...good, lastUsedAt: "now" }]);
    expect(readAccounts(memoryStorage({ [ACCOUNTS_KEY]: raw }))).toEqual([good]);
  });

  test("what is written reads back", () => {
    const storage = memoryStorage();
    writeAccounts(storage, [account(), account({ userId: "u2" })]);
    expect(readAccounts(storage)).toHaveLength(2);
  });
});

describe("upserting an account", () => {
  test("a new server + user is appended", () => {
    const first = account();
    const second = account({ userId: "u2", sessionId: "s2" });
    const { list, replacedSessionId } = upsertAccount([first], second);
    expect(list).toEqual([first, second]);
    expect(replacedSessionId).toBeUndefined();
  });

  test("the same user on another server is a different account", () => {
    const { list } = upsertAccount([account()], account({ serverUrl: "https://b.example", sessionId: "s2" }));
    expect(list).toHaveLength(2);
  });

  test("the same server + user replaces the entry and reports the older session", () => {
    const { list, replacedSessionId } = upsertAccount([account()], account({ sessionId: "s9", lastUsedAt: 500 }));
    expect(list).toHaveLength(1);
    expect(list[0].sessionId).toBe("s9");
    expect(replacedSessionId).toBe("s1");
  });

  test("saving the same session again reports nothing to sign out", () => {
    const { list, replacedSessionId } = upsertAccount([account()], account({ lastUsedAt: 500 }));
    expect(list[0].lastUsedAt).toBe(500);
    expect(replacedSessionId).toBeUndefined();
  });
});

describe("removing and ordering", () => {
  test("removeBySession drops only the matching server + session", () => {
    const keep = account({ sessionId: "s2", userId: "u2" });
    const otherServer = account({ serverUrl: "https://b.example" });
    expect(removeBySession([account(), keep, otherServer], "https://a.example", "s1")).toEqual([keep, otherServer]);
    expect(removeBySession([keep], "https://a.example", "nope")).toEqual([keep]);
  });

  test("the menu lists the active account first, then the most recently used", () => {
    const old = account({ sessionId: "s1", userId: "u1", lastUsedAt: 100 });
    const recent = account({ sessionId: "s2", userId: "u2", lastUsedAt: 300 });
    const active = account({ sessionId: "s3", userId: "u3", lastUsedAt: 50 });
    const sorted = sortForMenu([old, recent, active], "https://a.example", "s3");
    expect(sorted.map((item) => item.sessionId)).toEqual(["s3", "s2", "s1"]);
  });

  test("with no active account the order is by last use", () => {
    const sorted = sortForMenu([account({ lastUsedAt: 1 }), account({ sessionId: "s2", userId: "u2", lastUsedAt: 2 })], "https://a.example", "");
    expect(sorted.map((item) => item.sessionId)).toEqual(["s2", "s1"]);
  });
});

describe("the API client and saved accounts", () => {
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
  let originalFetch: typeof fetch;

  beforeAll(async () => {
    ({ ApiClient } = await import("./api"));
    originalFetch = globalThis.fetch;
  });

  beforeEach(() => storage.clear());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function clientWith(accounts: SavedAccount[], active?: SavedAccount) {
    if (active) {
      storage.set("raven.apiServerUrl", active.serverUrl);
      storage.set("raven.sessionId", active.sessionId);
    }
    storage.set(ACCOUNTS_KEY, JSON.stringify(accounts));
    return new ApiClient();
  }

  test("a rotated session id updates the saved entry", () => {
    const mine = account();
    const other = account({ userId: "u2", sessionId: "s2" });
    const client = clientWith([mine, other], mine);
    client.setSessionId("s1-rotated");
    const saved = readAccounts(localStorage);
    expect(saved.find((item) => item.userId === "u1")?.sessionId).toBe("s1-rotated");
    expect(saved.find((item) => item.userId === "u2")?.sessionId).toBe("s2");
    expect(storage.get("raven.sessionId")).toBe("s1-rotated");
  });

  test("clearing the session drops only the matching account", () => {
    const mine = account();
    const other = account({ userId: "u2", sessionId: "s2" });
    const elsewhere = account({ serverUrl: "https://b.example", sessionId: "s1" });
    const client = clientWith([mine, other, elsewhere], mine);
    client.clearSession();
    expect(readAccounts(localStorage)).toEqual([other, elsewhere]);
    expect(storage.has("raven.sessionId")).toBe(false);
  });

  test("clearing with no session drops nothing", () => {
    const saved = [account(), account({ userId: "u2", sessionId: "s2" })];
    const client = clientWith(saved);
    client.clearSession();
    expect(readAccounts(localStorage)).toEqual(saved);
  });

  test("remembering the same user again signs the older session out", async () => {
    const old = account({ sessionId: "old" });
    const calls: Array<{ url: string; session: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), session: new Headers(init?.headers).get("X-Session-ID") });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    clientWith([old]);
    storage.set("raven.apiServerUrl", old.serverUrl);
    const fresh = new ApiClient();
    fresh.setSessionId("fresh");
    fresh.rememberAccount({ id: "u1", username: "mina", displayName: "Mina" }, "Alpha");
    await Bun.sleep(10);
    expect(readAccounts(localStorage).map((item) => item.sessionId)).toEqual(["fresh"]);
    expect(calls).toEqual([{ url: "https://a.example/v1/auth/logout", session: "old" }]);
  });

  test("activating and starting to add an account move the active pointers", () => {
    const mine = account();
    const other = account({ serverUrl: "https://b.example", userId: "u2", sessionId: "s2", lastUsedAt: 1 });
    const client = clientWith([mine, other], mine);
    client.activateAccount(other);
    expect(storage.get("raven.apiServerUrl")).toBe("https://b.example");
    expect(storage.get("raven.sessionId")).toBe("s2");
    expect(readAccounts(localStorage).find((item) => item.sessionId === "s2")!.lastUsedAt).toBeGreaterThan(1);
    client.beginAddAccount();
    expect(storage.has("raven.sessionId")).toBe(false);
    expect(readAccounts(localStorage)).toHaveLength(2);
  });
});
