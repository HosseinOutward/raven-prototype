// Sending, and what happens when it does not work.
//
// A message is shown the moment it is written and sent in the background. Every attempt
// carries the same `clientMessageId`, which the server uses to recognise a repeat, so
// trying again can never produce a second message.

import { isHttpFailure } from "./errors";
import type { PendingMessage } from "./types";

/** How long a message keeps being retried on its own before the person is asked. */
export const SEND_RETRY_WINDOW_MS = 10 * 60_000;

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];

export function retryDelayMs(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1];
}

export type SendFailure =
  /** Worth another attempt after `delayMs`. */
  | { kind: "retry"; delayMs: number }
  /** Another attempt would get the same answer. */
  | { kind: "fail"; message: string }
  /** The session is gone; nothing can be sent until the person signs in again. */
  | { kind: "signedOut" };

/**
 * Decides what a failed send means.
 *
 * A request that never got an answer, a server error and "slow down" all pass with time.
 * Anything else the server said about this message (not allowed, too long, the
 * conversation is gone) is its final word and is shown as it came.
 */
export function classifySendFailure(error: unknown, attempts: number): SendFailure {
  if (!isHttpFailure(error)) return { kind: "retry", delayMs: retryDelayMs(attempts) };
  if (error.status === 401) return { kind: "signedOut" };
  if (error.status === 429) {
    const asked = (error.retryAfterSeconds ?? 0) * 1000;
    return { kind: "retry", delayMs: Math.max(asked, retryDelayMs(attempts)) };
  }
  if (error.status === 408 || error.status >= 500) return { kind: "retry", delayMs: retryDelayMs(attempts) };
  return { kind: "fail", message: error.message };
}

export function newClientMessageId(): string {
  return crypto.randomUUID();
}

/**
 * The one message of a conversation that may be sent now: the oldest that has not
 * failed. Messages to a conversation go one at a time so they keep the order they were
 * written in; one that has failed for good steps aside for those behind it.
 */
export function nextToSend(pending: PendingMessage[]): PendingMessage | undefined {
  return pending.find((item) => item.state !== "failed");
}

// ---- keeping unsent messages across a restart -----------------------------------------

export type OutboxStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const storageKey = (userId: string) => `raven.chat.outbox.${userId}`;

export function saveOutbox(storage: OutboxStorage, userId: string, pending: PendingMessage[]): void {
  try {
    if (pending.length === 0) storage.removeItem(storageKey(userId));
    else storage.setItem(storageKey(userId), JSON.stringify({ version: 1, items: pending }));
  } catch {
    // Storage is full or unavailable. The messages are still on screen for this session.
  }
}

/**
 * Reads back what was unsent when the app last closed. Nothing is sent again by itself:
 * it may be hours old, so each message comes back marked as not sent and waits for the
 * person to send it or discard it.
 */
export function loadOutbox(storage: OutboxStorage, userId: string): PendingMessage[] {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(userId)) ?? "null") as { version?: number; items?: unknown } | null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.items)) return [];
    return parsed.items.flatMap((item): PendingMessage[] => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<PendingMessage>;
      if (typeof candidate.clientMessageId !== "string" || typeof candidate.conversationId !== "string" || typeof candidate.body !== "string") return [];
      return [{
        clientMessageId: candidate.clientMessageId,
        conversationId: candidate.conversationId,
        body: candidate.body,
        replyTo: candidate.replyTo,
        createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date().toISOString(),
        state: "failed",
        error: "Not sent.",
        attempts: 0,
      }];
    });
  } catch {
    return [];
  }
}

export function clearOutbox(storage: OutboxStorage, userId: string): void {
  try {
    storage.removeItem(storageKey(userId));
  } catch {
    // Nothing to clear.
  }
}

/**
 * Removes every account's unsent messages from this device. Called when someone signs
 * out on purpose, so what they wrote is not left behind for whoever uses the app next.
 */
export function forgetUnsentMessages(storage: Storage): void {
  try {
    for (const key of Object.keys(storage)) {
      if (key.startsWith("raven.chat.outbox.")) storage.removeItem(key);
    }
  } catch {
    // Nothing to clear.
  }
}
