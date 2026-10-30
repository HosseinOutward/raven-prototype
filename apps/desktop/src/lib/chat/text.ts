// The sentences the interface writes about conversations: who did what, who is typing,
// and the one line shown under a conversation's name in a list.

import { messageExcerpt } from "./attachments";
import type { ChatConversation, ChatMessage, ChatMessagePreview, ChatSystemPayload, TypingPerson } from "./types";

/** "Ava", "Ava and Sam", "Ava, Sam and 2 others". */
export function namesSentence(names: string[], max = 2): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length <= max) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const rest = names.length - max;
  return `${names.slice(0, max).join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}`;
}

/** What a system line says, for example "Ava added Sam" or "You left". */
export function systemLine(system: ChatSystemPayload | undefined, actorId: string, actorName: string, me: string): string {
  const actor = actorId === me ? "You" : actorName;
  const nameOf = (person: { id: string; displayName: string }) => (person.id === me ? "you" : person.displayName);
  switch (system?.event) {
    case "group_created":
      return `${actor} created the group`;
    case "members_added":
      return `${actor} added ${namesSentence((system.users ?? []).map(nameOf), 3) || "someone"}`;
    case "member_left":
      return `${system.user?.id === me ? "You" : system.user?.displayName ?? actorName} left`;
    case "member_removed":
      return `${actor} removed ${system.user ? nameOf(system.user) : "someone"}`;
    case "renamed":
      return `${actor} changed the name to “${system.name ?? ""}”`;
    case "topic_changed":
      return `${actor} changed the description`;
    default:
      return "";
  }
}

/** The line under a conversation's name in a list: who said what last. */
export function previewLine(conversation: ChatConversation, me: string): string {
  const last: ChatMessagePreview | undefined = conversation.lastMessage;
  if (!last) return "";
  if (last.kind === "system") return systemLine(last.system, last.senderId, last.senderName, me);
  const text = last.deleted ? "Message deleted" : messageExcerpt(last.excerpt, last.attachments);
  if (last.senderId === me) return `You: ${text}`;
  return conversation.kind === "dm" ? text : `${last.senderName}: ${text}`;
}

/** "Ava is typing…", "Ava and Sam are typing…". Empty when nobody is. */
export function typingLine(typing: Record<string, TypingPerson>): string {
  const names = Object.values(typing).map((person) => person.name);
  if (names.length === 0) return "";
  return `${namesSentence(names)} ${names.length === 1 ? "is" : "are"} typing…`;
}

/** How long two messages from one person may be apart and still read as one run. */
const RUN_GAP_MS = 5 * 60_000;

/** Whether a message continues the run of the one before it, so its name need not repeat. */
export function continuesRun(previous: ChatMessage | undefined, message: ChatMessage): boolean {
  if (!previous || previous.kind !== "text" || message.kind !== "text") return false;
  if (previous.senderId !== message.senderId) return false;
  const gap = Date.parse(message.createdAt) - Date.parse(previous.createdAt);
  return Number.isFinite(gap) && gap >= 0 && gap < RUN_GAP_MS;
}
