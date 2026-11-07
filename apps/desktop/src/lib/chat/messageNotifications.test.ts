import { describe, expect, test } from "bun:test";
import { subscribeMessageNotifications, type MessageNotificationContext } from "./messageNotifications";
import { ChatStore } from "./store";
import type { ChatApi } from "./chatApi";
import type { ChatConversation, ChatMessage } from "./types";

async function setup(known = true) {
  let resolveSummary!: (value: { conversation: ChatConversation; members: [] }) => void;
  const summary = { id: "c", kind: "dm", name: "Sara", lastSeq: 0, readSeq: 0, hideRev: 0, visibleFromSeq: 0, unreadCount: 0 } as ChatConversation;
  const api = { getConversation: () => known ? Promise.resolve({ conversation: summary, members: [] }) : new Promise((resolve) => { resolveSummary = resolve; }) } as unknown as ChatApi;
  const chat = new ChatStore({ api, me: { id: "me", username: "me", displayName: "Me" } });
  if (known) { chat.refreshConversation("c"); await Bun.sleep(0); }
  const context: MessageNotificationContext = { userId: "me", dnd: false, active: false };
  const sounds: string[] = [];
  const toasts: string[] = [];
  let clock = 100;
  let didShow = true;
  let fail = false;
  const settings = { knocks: false, messages: true, messageText: true };
  const shown = new Map<string, number>();
  const stop = subscribeMessageNotifications(chat, () => context, {
    play: async () => { sounds.push("message"); },
    settings: () => settings,
    notify: async (title, body) => { toasts.push(`${title}: ${body}`); if (fail) throw new Error("no toast"); return didShow; },
  }, shown, { now: () => clock, waitMs: 20 });
  let seq = 0;
  const receive = (patch: Partial<ChatMessage> = {}) => {
    seq += 1;
    const message = { id: `m${seq}`, conversationId: "c", seq, changedSeq: seq, senderId: "sara", senderName: "Sara", kind: "text", body: "Hello", ...patch } as ChatMessage;
    chat.handleEvent({ type: "message.created", conversationId: "c", seq, message });
    return message;
  };
  return { chat, summary, context, settings, sounds, toasts, shown, receive,
    clock: (value: number) => { clock = value; }, result: (value: boolean) => { didShow = value; }, fail: () => { fail = true; },
    summaryArrives: () => resolveSummary({ conversation: summary, members: [] }),
    stop: () => { stop(); chat.dispose(); },
  };
}
const flush = () => Bun.sleep(0);

describe("live message notification subscription", () => {
  test("a friend's first message waits for its summary, then notifies once", async () => {
    const s = await setup(false);
    s.receive();
    expect(s.sounds).toEqual([]);
    s.summaryArrives();
    await flush();
    expect(s.sounds).toEqual(["message"]);
    expect(s.toasts).toEqual(["Sara: Hello"]);
    s.stop();
  });
  test("a missing summary expires and disposing cancels a pending wait", async () => {
    const s = await setup(false);
    s.receive();
    await Bun.sleep(30);
    s.summaryArrives();
    await flush();
    expect(s.sounds).toEqual([]);
    s.stop();
    const next = await setup(false);
    next.receive();
    next.stop();
    next.summaryArrives();
    await flush();
    expect(next.sounds).toEqual([]);
  });
  test("ignores own messages, system notes, deletes, DND and the active conversation", async () => {
    const s = await setup();
    s.receive({ senderId: "me" });
    s.receive({ kind: "system" });
    s.receive({ deletedAt: "now" });
    s.context.dnd = true;
    s.receive();
    s.context.dnd = false;
    s.context.active = true;
    s.context.conversationId = "c";
    s.receive();
    expect(s.sounds).toEqual([]);
    expect(s.toasts).toEqual([]);
    s.context.conversationId = "elsewhere";
    s.receive();
    expect(s.sounds).toEqual(["message"]);
    s.stop();
  });
  test("uses the summary's mute choice, including when it arrives later", async () => {
    for (const kind of ["dm", "group", "nest"] as const) {
      const s = await setup(false);
      s.summary.kind = kind;
      s.summary.notify = kind === "nest" ? "default" : "off";
      s.receive();
      s.summaryArrives();
      await flush();
      expect(s.sounds).toEqual([]);
      s.stop();
    }
  });
  test("limits shown toasts per conversation, including concurrent arrivals", async () => {
    const s = await setup();
    s.receive(); s.receive();
    expect(s.toasts).toHaveLength(1);
    await flush();
    s.clock(20_099); s.receive();
    expect(s.toasts).toHaveLength(1);
    s.clock(20_100); s.receive();
    expect(s.toasts).toHaveLength(2);
    expect(s.sounds).toHaveLength(4);
    s.stop();
  });
  test("foreground refusal and errors do not start cooldown; device settings hide text", async () => {
    const s = await setup();
    s.result(false); s.receive(); await flush();
    expect(s.shown.size).toBe(0);
    s.settings.messageText = false;
    s.receive(); await flush();
    expect(s.toasts[1]).toBe("Sara: Sent you a message");
    s.fail(); s.receive(); await flush();
    expect(s.shown.size).toBe(0);
    s.settings.messages = false;
    s.receive(); await flush();
    expect(s.toasts).toHaveLength(3);
    expect(s.sounds).toHaveLength(4);
    s.stop();
  });
  test("a mention gets through a mute and the quiet gap, never do not disturb", async () => {
    const s = await setup();
    s.summary.notify = "off";
    s.context.mentions = { nestSingular: "Room", person: (id) => (id === "me" ? { name: "Me", username: "me" } : null), nest: () => null };
    s.receive({ body: "no mention" });
    expect(s.sounds).toEqual([]);
    s.receive({ body: "hey <@u:me> look at <@n:gone>" });
    await flush();
    expect(s.toasts).toEqual(["Sara: hey Me look at a room"]);
    s.receive({ body: "<@u:me> again" });
    await flush();
    expect(s.toasts).toHaveLength(2);
    s.context.dnd = true;
    s.receive({ body: "<@u:me> during dnd" });
    expect(s.toasts).toHaveLength(2);
    s.context.dnd = false;
    s.context.active = true;
    s.context.conversationId = "c";
    s.receive({ body: "<@u:me> while open" });
    expect(s.toasts).toHaveLength(2);
    // Someone else's mention, or one inside code, is not yours.
    s.context.active = false;
    s.receive({ body: "<@u:sam> and `<@u:me>`" });
    expect(s.toasts).toHaveLength(2);
    s.stop();
  });
});
