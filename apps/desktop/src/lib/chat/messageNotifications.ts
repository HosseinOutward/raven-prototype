import type { NotificationSettings } from "../notifications";
import { mentionsUser, type MentionResolver } from "./mentions";
import { notifies, notificationText } from "./notify";
import type { ChatStore } from "./store";
import type { ChatMessage } from "./types";

export interface MessageNotificationContext {
  userId: string;
  dnd: boolean;
  active: boolean;
  conversationId?: string;
  /** Names for mentions in the notification's text. */
  mentions?: MentionResolver;
}

/** One live subscription, with bounded waits for new conversations and quiet bursts. */
export function subscribeMessageNotifications(
  chat: ChatStore,
  context: () => MessageNotificationContext,
  commands: {
    play: () => Promise<unknown>;
    settings: () => NotificationSettings;
    notify: (title: string, body: string) => Promise<boolean>;
  },
  shown: Map<string, number>,
  options: { now?: () => number; waitMs?: number } = {},
): () => void {
  const now = options.now ?? Date.now;
  const waiting = new Map<string, { message: ChatMessage; timer: ReturnType<typeof setTimeout> }>();
  const inFlight = new Set<string>();
  let stopped = false;

  const decide = (message: ChatMessage): boolean => {
    const current = context();
    if (!current.userId || message.senderId === current.userId || message.kind !== "text" || message.deletedAt) return true;
    const summary = chat.getState().conversations[message.conversationId]?.summary;
    if (!summary) return false;
    // A mention of you gets through a muted conversation and its quiet gap, never do not disturb.
    const mentioned = mentionsUser(message.body, current.userId);
    if (!(notifies(summary.kind, summary.notify) || mentioned) || current.dnd || (current.active && current.conversationId === summary.id)) return true;
    void commands.play().catch(() => undefined);
    const settings = commands.settings();
    const last = shown.get(summary.id);
    if (settings.messages && !inFlight.has(summary.id) && (mentioned || last === undefined || now() - last >= 20_000)) {
      const { title, body } = notificationText(message, summary, settings.messageText, current.mentions);
      inFlight.add(summary.id);
      void commands.notify(title, body).then((didShow) => {
        if (didShow && !stopped) shown.set(summary.id, now());
      }).catch(() => undefined).finally(() => inFlight.delete(summary.id));
    }
    return true;
  };

  const offIncoming = chat.onIncoming((message) => {
    if (decide(message) || waiting.has(message.id)) return;
    const timer = setTimeout(() => waiting.delete(message.id), options.waitMs ?? 5000);
    waiting.set(message.id, { message, timer });
  });
  const offChanges = chat.subscribe(() => {
    for (const [id, entry] of waiting) {
      if (decide(entry.message)) {
        clearTimeout(entry.timer);
        waiting.delete(id);
      }
    }
  });
  return () => {
    stopped = true;
    offIncoming();
    offChanges();
    for (const entry of waiting.values()) clearTimeout(entry.timer);
    waiting.clear();
  };
}
