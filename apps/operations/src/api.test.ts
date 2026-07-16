import { afterEach, describe, expect, test } from "bun:test";

const stored = new Map<string, string>();

Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => stored.get(key) ?? null,
    removeItem: (key: string) => stored.delete(key),
    setItem: (key: string, value: string) => stored.set(key, value),
  },
});

const originalFetch = globalThis.fetch;
const { OperationsApi } = await import("./api");

afterEach(() => {
  globalThis.fetch = originalFetch;
  stored.clear();
});

describe("operations authentication", () => {
  test("preserves same-origin Basic Auth for account and operations sessions", async () => {
    const credentials: RequestCredentials[] = [];
    let request = 0;
    globalThis.fetch = async (_input, init) => {
      credentials.push(init?.credentials ?? "same-origin");
      request += 1;
      if (request === 1) {
        return new Response(JSON.stringify({ sessionId: "account-session" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Session-ID": "account-session",
          },
        });
      }
      return new Response(
        JSON.stringify({
          opsSessionToken: "ops-session",
          expiresAt: "2099-01-01T00:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const api = new OperationsApi();
    await api.login("soroush", "password");

    expect(credentials).toEqual(["same-origin", "same-origin"]);
  });
});
