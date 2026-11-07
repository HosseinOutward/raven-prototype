// Where messages can be forwarded to, and what hiding their source would change. Pure, so
// the dialog stays presentation.

import type { ChatKind, ChatMessage, ConversationState } from "./types";

export interface ForwardDestination {
  /** Empty for a Saved messages that has not been created yet. */
  id: string;
  kind: ChatKind;
  name: string;
  peerId?: string;
}

export interface ForwardSection {
  key: string;
  /** Empty for Saved messages, whose row names itself. */
  title: string;
  destinations: ForwardDestination[];
}

const SAVED_NAME = "Saved messages";

function destinationOf({ summary }: ConversationState): ForwardDestination {
  const peerName = summary.peer?.displayName || summary.peer?.username;
  return { id: summary.id, kind: summary.kind, name: summary.kind === "dm" ? peerName || summary.name : summary.name, peerId: summary.peer?.id };
}

/**
 * The picker's sections: Saved messages, then friends and groups, then one section per tree
 * holding its text nests. Only what the person can send in, and only sections with a match.
 */
export function forwardSections(conversations: ConversationState[], trees: Array<{ id: string; name: string }>, query: string): ForwardSection[] {
  const needle = query.trim().toLocaleLowerCase();
  const matches = (name: string) => !needle || name.toLocaleLowerCase().includes(needle);
  const byName = (a: ForwardDestination, b: ForwardDestination) => a.name.localeCompare(b.name);
  const sendable = conversations.filter(({ summary }) => summary.canSend && !summary.archived);

  const sections: ForwardSection[] = [];
  if (matches(SAVED_NAME)) {
    const saved = conversations.find(({ summary }) => summary.kind === "saved");
    sections.push({ key: "saved", title: "", destinations: [{ id: saved?.summary.id ?? "", kind: "saved", name: SAVED_NAME }] });
  }
  const direct = sendable
    .filter(({ summary }) => summary.kind === "dm" || summary.kind === "group")
    .map(destinationOf)
    .filter((destination) => matches(destination.name))
    .sort(byName);
  if (direct.length > 0) sections.push({ key: "people", title: "Friends and groups", destinations: direct });
  for (const tree of trees) {
    const nests = sendable
      .filter(({ summary }) => summary.kind === "nest" && summary.treeId === tree.id)
      .map(destinationOf)
      .filter((destination) => matches(destination.name) || matches(tree.name))
      .sort(byName);
    if (nests.length > 0) sections.push({ key: tree.id, title: tree.name, destinations: nests });
  }
  return sections;
}

/**
 * Whether anyone could see where these messages came from. A message written here shows this
 * chat, except in Saved messages, which is nobody's place to go; a copy shows its source
 * only if it still has one. A message no longer loaded counts as showing it.
 */
export function sourceWouldShow(messages: Array<ChatMessage | undefined>, from: ChatKind): boolean {
  return messages.some((message) => {
    if (!message) return true;
    return message.origin ? Boolean(message.origin.source) : from !== "saved";
  });
}
