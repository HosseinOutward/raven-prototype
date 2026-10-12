import { describe, expect, test } from "bun:test";
import { classifySendFailure, loadOutbox, newClientMessageId, nextToSend, retryDelayMs, saveOutbox } from "./outbox";
import type { PendingMessage } from "./types";

function httpError(status: number, message = "refused", retryAfterSeconds?: number) {
  return Object.assign(new Error(message), { status, retryAfterSeconds });
}

function pending(id: string, state: PendingMessage["state"]): PendingMessage {
  return { clientMessageId: id, conversationId: "c1", body: `body ${id}`, createdAt: "2026-10-11T10:00:00Z", state, attempts: 1 };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("what a failed send means", () => {
  test("no answer at all, and server trouble, are worth another try", () => {
    expect(classifySendFailure(new TypeError("Failed to fetch"), 1)).toEqual({ kind: "retry", delayMs: 1000 });
    expect(classifySendFailure(httpError(500), 2)).toEqual({ kind: "retry", delayMs: 2000 });
    expect(classifySendFailure(httpError(503), 3)).toEqual({ kind: "retry", delayMs: 4000 });
    expect(classifySendFailure(httpError(408), 1).kind).toBe("retry");
  });

  test("being told to slow down waits as long as the server asked", () => {
    expect(classifySendFailure(httpError(429, "slow down", 7), 1)).toEqual({ kind: "retry", delayMs: 7000 });
    expect(classifySendFailure(httpError(429, "slow down"), 2)).toEqual({ kind: "retry", delayMs: 2000 });
  });

  test("the server's final word is shown as it came and not retried", () => {
    expect(classifySendFailure(httpError(403, "You can only message people you are friends with."), 1)).toEqual({ kind: "fail", message: "You can only message people you are friends with." });
    expect(classifySendFailure(httpError(404, "This conversation isn’t available."), 1).kind).toBe("fail");
    expect(classifySendFailure(httpError(413, "That message is too long."), 1).kind).toBe("fail");
    expect(classifySendFailure(httpError(426, "Update required"), 1).kind).toBe("fail");
  });

  test("an ended session stops sending altogether", () => {
    expect(classifySendFailure(httpError(401), 1)).toEqual({ kind: "signedOut" });
  });

  test("waits grow and then level off", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000, 15_000, 30_000, 30_000, 30_000]);
    expect(retryDelayMs(0)).toBe(1000);
  });
});

describe("order", () => {
  test("the oldest message that has not failed goes next", () => {
    expect(nextToSend([pending("a", "sending"), pending("b", "queued")])?.clientMessageId).toBe("a");
    expect(nextToSend([pending("a", "failed"), pending("b", "queued"), pending("c", "queued")])?.clientMessageId).toBe("b");
    expect(nextToSend([pending("a", "failed")])).toBeUndefined();
    expect(nextToSend([])).toBeUndefined();
  });

  test("ids are unique and in the shape the server accepts", () => {
    const ids = new Set(Array.from({ length: 200 }, newClientMessageId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

describe("unsent messages across a restart", () => {
  test("they come back marked as not sent, never sending by themselves", () => {
    const storage = memoryStorage();
    saveOutbox(storage, "me", [pending("a", "sending"), { ...pending("b", "queued"), replyTo: { id: "m1", senderName: "Ava", excerpt: "hello" } }]);

    const restored = loadOutbox(storage, "me");
    expect(restored.map((item) => [item.clientMessageId, item.state, item.error])).toEqual([["a", "failed", "Not sent."], ["b", "failed", "Not sent."]]);
    expect(restored[1].replyTo).toEqual({ id: "m1", senderName: "Ava", excerpt: "hello" });
    expect(restored[0].body).toBe("body a");
  });

  test("each account has its own, and an empty outbox leaves nothing stored", () => {
    const storage = memoryStorage();
    saveOutbox(storage, "me", [pending("a", "failed")]);
    expect(loadOutbox(storage, "someone-else")).toEqual([]);
    saveOutbox(storage, "me", []);
    expect(storage.values.size).toBe(0);
  });

  test("damaged or foreign data is ignored", () => {
    const storage = memoryStorage();
    storage.setItem("raven.chat.outbox.me", "{not json");
    expect(loadOutbox(storage, "me")).toEqual([]);
    storage.setItem("raven.chat.outbox.me", JSON.stringify({ version: 2, items: [pending("a", "queued")] }));
    expect(loadOutbox(storage, "me")).toEqual([]);
    storage.setItem("raven.chat.outbox.me", JSON.stringify({ version: 1, items: [null, { clientMessageId: 5 }, pending("ok", "queued")] }));
    expect(loadOutbox(storage, "me").map((item) => item.clientMessageId)).toEqual(["ok"]);
  });
});
