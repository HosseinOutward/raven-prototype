// Choosing messages in a conversation, to forward or save several at once. These are the
// pure parts; null means the conversation is not in selection mode.

import type { ChatMessage } from "./types";

/** How many messages one forward or save may take. */
export const MAX_SELECTED = 50;

export interface MessageSelection {
  ids: ReadonlySet<string>;
  /** Where a shift-click measures its range from: the message last clicked. */
  anchor: string;
}

/** System lines and deleted messages cannot be chosen. */
export function canSelect(message: Pick<ChatMessage, "kind" | "deletedAt">): boolean {
  return message.kind === "text" && !message.deletedAt;
}

export function startSelection(id: string): MessageSelection {
  return { ids: new Set([id]), anchor: id };
}

/**
 * A click on a message: it flips that message, or with shift adds everything from the anchor
 * to it. `order` is the choosable messages on screen, in conversation order.
 */
export function clickSelection(selection: MessageSelection, id: string, shift: boolean, order: readonly string[]): MessageSelection {
  const ids = new Set(selection.ids);
  const from = order.indexOf(selection.anchor);
  const to = order.indexOf(id);
  if (shift && from >= 0 && to >= 0) {
    for (const each of order.slice(Math.min(from, to), Math.max(from, to) + 1)) ids.add(each);
  } else if (ids.has(id)) {
    ids.delete(id);
  } else {
    ids.add(id);
  }
  return { ids, anchor: id };
}

/** Esc leaves selection mode; other keys change nothing. */
export function selectionAfterKey(selection: MessageSelection | null, key: string): MessageSelection | null {
  return key === "Escape" ? null : selection;
}
