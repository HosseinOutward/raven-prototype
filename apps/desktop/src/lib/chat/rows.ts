// Turns the loaded messages of a conversation into the rows the list draws.
//
// The one rule here that is easy to break: what a row looks like may depend only on its
// own message and the message directly before it. The list holds a window of a long
// conversation and adds earlier pages in front as the person scrolls up. A row that
// changed its look when that happened would change height above what is being read, and
// the page would move under the reader's eyes.

import { continuesRun } from "./text";
import { dayLabel, sameDay } from "./time";
import type { ChatMessage, PendingMessage } from "./types";

export type ChatRow =
  | { key: string; kind: "message"; message: ChatMessage; dayHeading?: string; newDivider: boolean; continuation: boolean }
  | { key: string; kind: "pending"; pending: PendingMessage };

export interface RowsInput {
  messages: ChatMessage[];
  pending: PendingMessage[];
  me: string;
  /** The last message that had been read when the conversation was opened, if any were unread. */
  dividerAfterSeq: number | null;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export function buildRows({ messages, pending, me, dividerAfterSeq, hasMoreBefore, hasMoreAfter }: RowsInput): ChatRow[] {
  const rows: ChatRow[] = [];
  // While there is history before the loaded window, its oldest message is kept back and
  // not drawn. Drawn, it could only guess at what came before it: whether a new day
  // starts there, whether it continues someone's run. It is drawn once its own
  // predecessor has been loaded.
  const heldBack = hasMoreBefore && messages.length > 1 ? 1 : 0;
  for (let index = heldBack; index < messages.length; index += 1) {
    const message = messages[index];
    const previous = index > 0 ? messages[index - 1] : undefined;
    const dayHeading = !previous || !sameDay(previous.createdAt, message.createdAt) ? dayLabel(message.createdAt) : undefined;
    // "New messages" marks one fixed place: just after the last message that had been read.
    const newDivider = dividerAfterSeq !== null && message.seq > dividerAfterSeq && (!previous || previous.seq <= dividerAfterSeq);
    rows.push({
      // My own messages keep the key they had while pending, so the row does not jump.
      key: message.senderId === me ? `c:${message.clientMessageId}` : `m:${message.id}`,
      kind: "message",
      message,
      dayHeading,
      newDivider,
      continuation: !dayHeading && !newDivider && continuesRun(previous, message),
    });
  }
  // Unsent messages always sit at the newest end, whatever part of history is loaded.
  if (!hasMoreAfter) {
    for (const item of pending) rows.push({ key: `c:${item.clientMessageId}`, kind: "pending", pending: item });
  }
  return rows;
}
