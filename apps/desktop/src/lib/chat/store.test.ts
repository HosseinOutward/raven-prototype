import { describe, expect, test } from "bun:test";
import type { ChatApi } from "./chatApi";
import { ChatStore } from "./store";
import type { ChatConversation, ChatMessage, ChatPage } from "./types";

const ME = { id: "me", username: "me", displayName: "Me" };
const C = "c1";

function httpError(status: number, message = "refused", retryAfterSeconds?: number) {
  return Object.assign(new Error(message), { status, retryAfterSeconds });
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

async function until(done: () => boolean, what = "the expected state", timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(2);
  }
}

/**
 * A stand-in server holding one conversation. Tests reach in to make it fail, to hold an
 * answer back, or to add messages "from someone else" behind the client's back.
 */
function fakeServer() {
  const messages: ChatMessage[] = [];
  let lastSeq = 0;
  let readSeq = 0;
  const calls: string[] = [];
  const failures = new Map<string, Error[]>();
  const gates = new Map<string, Promise<void>>();
  let pageSays: Partial<ChatPage> = {};

  const summary = (): ChatConversation => ({
    id: C,
    kind: "dm",
    name: "Ava",
    topic: "",
    peer: { id: "ava", username: "ava", displayName: "Ava" },
    role: "member",
    canSend: true,
    canManage: false,
    memberCount: 2,
    lastSeq,
    lastActivityMs: lastSeq,
    unreadCount: messages.filter((item) => item.seq > readSeq && item.senderId !== ME.id && !item.deletedAt).length,
    readSeq,
    peerReadSeq: 0,
    hideRev: 0,
    visibleFromSeq: 0,
    archived: false,
    createdAt: "2026-10-11T10:00:00Z",
  });

  const store = (senderId: string, body: string, clientMessageId: string): ChatMessage => {
    lastSeq += 1;
    const message: ChatMessage = { id: `m${lastSeq}`, conversationId: C, seq: lastSeq, changedSeq: lastSeq, senderId, senderName: senderId, clientMessageId, kind: "text", body, createdAt: "2026-10-11T10:00:00Z" };
    messages.push(message);
    return message;
  };

  async function step<T>(name: string, run: () => T): Promise<T> {
    calls.push(name);
    const gate = gates.get(name.split(" ")[0]);
    if (gate) await gate;
    const failure = failures.get(name.split(" ")[0])?.shift();
    if (failure) throw failure;
    return run();
  }

  const page = (items: ChatMessage[], patch: Partial<ChatPage> = {}): ChatPage => ({ messages: items, hasMoreBefore: false, hasMoreAfter: false, asOfSeq: lastSeq, me: { readSeq, hideRev: 0, visibleFromSeq: 0 }, ...patch });

  const api = {
    listConversations: () => step("list", () => ({ conversations: lastSeq >= 0 ? [summary()] : [], settings: { shareReadStatus: true } })),
    getConversation: (id: string) => step(`summary ${id}`, () => ({ conversation: summary(), members: [] })),
    messages: (_id: string, cursor: { before?: number; after?: number } = {}) => step(`messages ${JSON.stringify(cursor)}`, () => page([...messages], pageSays)),
    changes: (_id: string, after: number) => step(`changes ${after}`, () => ({ messages: messages.filter((item) => item.changedSeq > after), reset: false, asOfSeq: lastSeq, me: { readSeq, hideRev: 0, visibleFromSeq: 0 } })),
    send: (_id: string, input: { clientMessageId: string; body: string }) =>
      step(`send ${input.clientMessageId}`, () => {
        const existing = messages.find((item) => item.clientMessageId === input.clientMessageId);
        if (existing) return { message: existing, duplicate: true };
        return { message: store(ME.id, input.body, input.clientMessageId) };
      }),
    markRead: (_id: string, seq: number) =>
      step(`read ${seq}`, () => {
        readSeq = Math.max(readSeq, Math.min(seq, lastSeq));
        return { readSeq, unreadCount: summary().unreadCount };
      }),
    typing: () => step("typing", () => undefined),
  } as unknown as ChatApi;

  return {
    api,
    calls,
    messages,
    /** A message from the other person, stored without the client hearing of it. */
    receive: (body: string) => store("ava", body, `ava-${lastSeq + 1}`),
    failNext: (method: string, ...errors: Error[]) => failures.set(method, [...(failures.get(method) ?? []), ...errors]),
    /** Holds every call to `method` until the returned function is called. */
    hold: (method: string) => {
      let release = () => {};
      gates.set(method, new Promise<void>((resolve) => {
        release = () => {
          gates.delete(method);
          resolve();
        };
      }));
      return release;
    },
    sends: () => calls.filter((call) => call.startsWith("send ")),
    pageLoads: () => calls.filter((call) => call.startsWith("messages ")).length,
    /** Makes history pages claim there is more before or after what they hold. */
    pagesSay: (patch: Partial<ChatPage>) => {
      pageSays = patch;
    },
  };
}

async function openStore(server = fakeServer(), options: Partial<ConstructorParameters<typeof ChatStore>[0]> = {}) {
  const store = new ChatStore({ api: server.api, me: ME, delayScale: 0.001, ...options });
  store.streamOpened();
  await until(() => store.getState().listLoaded, "the conversation list");
  await store.openConversation(C);
  await until(() => store.getState().conversations[C]?.loaded === true, "the first page");
  return { store, server };
}

const conversation = (store: ChatStore) => store.getState().conversations[C];
const bodies = (store: ChatStore) => conversation(store).messages.map((item) => item.body);

describe("sending", () => {
  test("a message shows at once as pending, then becomes the stored message", async () => {
    const { store, server } = await openStore();
    const release = server.hold("send");
    const clientId = store.send(C, "  hello  ")!;

    expect(conversation(store).pending.map((item) => [item.body, item.state])).toEqual([["hello", "sending"]]);
    expect(conversation(store).messages).toEqual([]);
    release();
    await until(() => conversation(store).pending.length === 0, "the acknowledgement");

    expect(bodies(store)).toEqual(["hello"]);
    expect(conversation(store).messages[0].clientMessageId).toBe(clientId);
    expect(conversation(store).summary.unreadCount).toBe(0);
    store.dispose();
  });

  test("the event arriving first does not produce a second copy", async () => {
    const { store, server } = await openStore();
    const release = server.hold("send");
    const clientId = store.send(C, "hello")!;
    await until(() => server.sends().length === 1);
    // The server has stored it and told the stream; the answer is still on its way.
    const stored: ChatMessage = { id: "m1", conversationId: C, seq: 1, changedSeq: 1, senderId: ME.id, senderName: "Me", clientMessageId: clientId, kind: "text", body: "hello", createdAt: "2026-10-11T10:00:00Z" };
    store.handleEvent({ type: "message.created", conversationId: C, seq: 1, message: stored });
    expect(conversation(store).pending).toEqual([]);
    expect(bodies(store)).toEqual(["hello"]);

    release();
    await Bun.sleep(20);
    expect(bodies(store)).toEqual(["hello"]);
    store.dispose();
  });

  test("a send that gets no answer is retried with the same id until it gets through", async () => {
    const { store, server } = await openStore();
    server.failNext("send", new TypeError("Failed to fetch"), httpError(503), httpError(429, "slow down", 0));
    const clientId = store.send(C, "are you there")!;
    await until(() => bodies(store).length === 1, "the message to get through");

    expect(server.sends()).toEqual(Array(4).fill(`send ${clientId}`));
    expect(server.messages.length).toBe(1);
    expect(conversation(store).pending).toEqual([]);
    store.dispose();
  });

  test("a retry of something the server already stored does not create a second message", async () => {
    const { store, server } = await openStore();
    // The first attempt reaches the server, but its answer is lost.
    const original = server.api.send;
    let lostOnce = false;
    server.api.send = async (id, input) => {
      const result = await original(id, input);
      if (!lostOnce) {
        lostOnce = true;
        throw new TypeError("connection reset");
      }
      return result;
    };
    store.send(C, "only once");
    await until(() => conversation(store).pending.length === 0, "the retry to be answered");

    expect(server.messages.map((item) => item.body)).toEqual(["only once"]);
    expect(bodies(store)).toEqual(["only once"]);
    store.dispose();
  });

  test("a refusal is final: it is shown, and sending again or discarding is up to the person", async () => {
    const { store, server } = await openStore();
    server.failNext("send", httpError(403, "You can only message people you are friends with."));
    const clientId = store.send(C, "hello?")!;
    await until(() => conversation(store).pending[0]?.state === "failed", "the refusal");

    expect(conversation(store).pending[0].error).toBe("You can only message people you are friends with.");
    expect(server.sends().length).toBe(1);

    store.retry(C, clientId);
    await until(() => conversation(store).pending.length === 0, "the retry");
    expect(server.sends()).toEqual([`send ${clientId}`, `send ${clientId}`]);
    expect(bodies(store)).toEqual(["hello?"]);

    server.failNext("send", httpError(413, "That message is too long."));
    const second = store.send(C, "too long")!;
    await until(() => conversation(store).pending[0]?.state === "failed");
    store.discard(C, second);
    expect(conversation(store).pending).toEqual([]);
    store.dispose();
  });

  test("messages to one conversation go one at a time, in the order they were written", async () => {
    const { store, server } = await openStore();
    const release = server.hold("send");
    store.send(C, "first");
    store.send(C, "second");
    store.send(C, "third");
    await Bun.sleep(10);
    expect(server.sends().length).toBe(1);
    expect(conversation(store).pending.map((item) => item.state)).toEqual(["sending", "queued", "queued"]);

    release();
    await until(() => conversation(store).pending.length === 0, "all three to be sent");
    expect(server.messages.map((item) => item.body)).toEqual(["first", "second", "third"]);
    expect(bodies(store)).toEqual(["first", "second", "third"]);
    store.dispose();
  });

  test("one that failed for good steps aside for those behind it", async () => {
    const { store, server } = await openStore();
    server.failNext("send", httpError(400, "Raven couldn’t read that request."));
    store.send(C, "bad");
    store.send(C, "good");
    await until(() => bodies(store).length === 1, "the second message");
    expect(bodies(store)).toEqual(["good"]);
    expect(conversation(store).pending.map((item) => [item.body, item.state])).toEqual([["bad", "failed"]]);
    store.dispose();
  });

  test("an ended session is reported and the message is kept as not sent", async () => {
    const server = fakeServer();
    let signedOut = 0;
    const { store } = await openStore(server, { onSignedOut: () => signedOut += 1 });
    server.failNext("send", httpError(401, "authentication required"));
    store.send(C, "into the void");
    await until(() => signedOut === 1, "the sign-out to be reported");
    expect(conversation(store).pending[0].state).toBe("failed");
    store.dispose();
  });
});

describe("staying in step", () => {
  test("a gap in the stream is filled from the server", async () => {
    const { store, server } = await openStore();
    server.receive("one");
    const two = server.receive("two");
    const three = server.receive("three");
    // Events for "one" and "two" never arrive; only the third does.
    store.handleEvent({ type: "message.created", conversationId: C, seq: three.seq, message: three });
    await until(() => conversation(store).syncedSeq === 3, "the gap to be filled");

    expect(bodies(store)).toEqual(["one", "two", "three"]);
    expect(server.calls).toContain("changes 0");
    expect(two.seq).toBe(2);
    store.dispose();
  });

  test("after a reconnect, what was missed while away is fetched for the open conversation", async () => {
    const { store, server } = await openStore();
    const first = server.receive("before the drop");
    store.handleEvent({ type: "message.created", conversationId: C, seq: 1, message: first });
    store.streamClosed();
    expect(store.getState().connection).toBe("offline");
    server.receive("while away 1");
    server.receive("while away 2");

    store.streamOpened();
    await until(() => bodies(store).length === 3, "the missed messages");
    expect(bodies(store)).toEqual(["before the drop", "while away 1", "while away 2"]);
    expect(conversation(store).summary.unreadCount).toBe(3);
    expect(store.getState().connection).toBe("live");
    expect(server.calls).toContain("changes 1");
    store.dispose();
  });

  test("a failed catch-up is tried again until it works", async () => {
    const server = fakeServer();
    server.failNext("list", new TypeError("Failed to fetch"), httpError(502));
    const store = new ChatStore({ api: server.api, me: ME, delayScale: 0.001 });
    store.streamOpened();
    await until(() => store.getState().listLoaded, "the list, after two failures");
    expect(server.calls.filter((call) => call === "list").length).toBe(3);

    await store.openConversation(C);
    const message = server.receive("late");
    server.receive("later");
    server.failNext("changes", httpError(500));
    store.handleEvent({ type: "message.created", conversationId: C, seq: 2, message: { ...message, seq: 2, id: "m2", changedSeq: 2 } });
    await until(() => conversation(store).syncedSeq === 2, "the changes, after one failure");
    expect(server.calls.filter((call) => call.startsWith("changes")).length).toBeGreaterThanOrEqual(2);
    store.dispose();
  });

  test("a conversation that is gone on the server is dropped here", async () => {
    const { store, server } = await openStore();
    server.failNext("summary", httpError(404, "This conversation isn’t available."));
    store.handleEvent({ type: "conversation.changed", conversationId: C });
    await until(() => !store.getState().conversations[C], "the conversation to be dropped");
    store.dispose();
  });

  test("an ended session during a catch-up is reported once and not retried", async () => {
    const server = fakeServer();
    let signedOut = 0;
    server.failNext("list", httpError(401));
    const store = new ChatStore({ api: server.api, me: ME, delayScale: 0.001, onSignedOut: () => signedOut += 1 });
    store.streamOpened();
    await until(() => signedOut === 1);
    await Bun.sleep(50);
    expect(server.calls.filter((call) => call === "list").length).toBe(1);
    store.dispose();
  });
});

describe("leaving and coming back", () => {
  test("a conversation left at its newest messages is still there when reopened", async () => {
    const server = fakeServer();
    server.receive("hello");
    const { store } = await openStore(server);

    store.closeConversation(C);
    expect(conversation(store).loaded).toBe(true);
    await store.openConversation(C);

    expect(bodies(store)).toEqual(["hello"]);
    expect(server.pageLoads()).toBe(1);
    store.dispose();
  });

  test("one left somewhere back in its history starts over at the newest, in one request", async () => {
    const server = fakeServer();
    server.receive("old");
    server.pagesSay({ hasMoreAfter: true });
    const { store } = await openStore(server);
    expect(conversation(store).hasMoreAfter).toBe(true);

    store.closeConversation(C);
    expect(conversation(store).loaded).toBe(false);
    expect(conversation(store).messages).toEqual([]);

    server.pagesSay({});
    await store.openConversation(C);
    await until(() => conversation(store).loaded, "the newest page");
    expect(conversation(store).hasMoreAfter).toBe(false);
    expect(server.pageLoads()).toBe(2);
    store.dispose();
  });
});

describe("reading and typing", () => {
  test("reading updates the count at once and tells the server once, with the furthest position", async () => {
    const { store, server } = await openStore();
    for (const body of ["one", "two", "three"]) {
      const message = server.receive(body);
      store.handleEvent({ type: "message.created", conversationId: C, seq: message.seq, message });
    }
    expect(conversation(store).summary.unreadCount).toBe(3);

    store.markRead(C, 1);
    store.markRead(C, 3);
    store.markRead(C, 2);
    expect(conversation(store).summary.unreadCount).toBe(0);
    expect(conversation(store).summary.readSeq).toBe(3);
    await until(() => server.calls.some((call) => call.startsWith("read")), "the read to be reported");
    await Bun.sleep(20);
    expect(server.calls.filter((call) => call.startsWith("read"))).toEqual(["read 3"]);
    store.dispose();
  });

  test("typing is reported at most once every few seconds", async () => {
    let now = 1_000_000;
    const server = fakeServer();
    const { store } = await openStore(server, { now: () => now });
    store.typing(C);
    store.typing(C);
    now += 3999;
    store.typing(C);
    expect(server.calls.filter((call) => call === "typing").length).toBe(1);
    now += 2;
    store.typing(C);
    expect(server.calls.filter((call) => call === "typing").length).toBe(2);
    store.dispose();
  });
});

describe("unsent messages and restarts", () => {
  test("what was unsent when the app closed comes back as not sent, and can then be sent", async () => {
    const storage = memoryStorage();
    const server = fakeServer();
    const first = await openStore(server, { storage });
    server.hold("send");
    const clientId = first.store.send(C, "written just before closing")!;
    await until(() => storage.values.size === 1, "the outbox to be saved");
    first.store.dispose();

    // The app starts again. The server never saw the message.
    const second = fakeServer();
    const { store } = await openStore(second, { storage });
    expect(conversation(store).pending.map((item) => [item.clientMessageId, item.state, item.error])).toEqual([[clientId, "failed", "Not sent."]]);
    expect(second.sends()).toEqual([]);

    store.retry(C, clientId);
    await until(() => conversation(store).pending.length === 0, "the message to be sent");
    expect(second.messages.map((item) => item.body)).toEqual(["written just before closing"]);
    expect(storage.values.size).toBe(0);
    store.dispose();
  });

  test("signing out discards what was unsent; a window without storage keeps nothing", async () => {
    const storage = memoryStorage();
    const server = fakeServer();
    server.failNext("send", httpError(403, "no"));
    const { store } = await openStore(server, { storage });
    store.send(C, "never mind");
    await until(() => storage.values.size === 1);
    store.dispose(true);
    expect(storage.values.size).toBe(0);

    const other = fakeServer();
    other.failNext("send", httpError(403, "no"));
    const plain = await openStore(other);
    plain.store.send(C, "second window");
    await until(() => conversation(plain.store).pending[0]?.state === "failed");
    plain.store.dispose();
  });
});

describe("subscribers", () => {
  test("are told of changes and only of changes", async () => {
    const { store, server } = await openStore();
    let notified = 0;
    const unsubscribe = store.subscribe(() => notified += 1);
    const message = server.receive("hello");
    store.handleEvent({ type: "message.created", conversationId: C, seq: 1, message });
    expect(notified).toBe(1);
    // The same event again changes nothing, so nobody is told.
    store.handleEvent({ type: "message.created", conversationId: C, seq: 1, message });
    expect(notified).toBe(1);
    unsubscribe();
    store.handleEvent({ type: "conversation.bump", conversationId: C, seq: 2 });
    expect(notified).toBe(1);
    store.dispose();
  });
});
