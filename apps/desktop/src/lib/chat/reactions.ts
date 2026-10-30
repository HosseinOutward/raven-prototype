import type { ChatReaction } from "./types";

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

/** The server has the final say on which of a person's reactions was oldest. */
export function toggledReactions(reactions: ChatReaction[], userId: string, emoji: string, maxPerPerson: number): ChatReaction[] {
  const removing = reactions.some((reaction) => reaction.emoji === emoji && reaction.userIds.includes(userId));
  const held = reactions.filter((reaction) => reaction.userIds.includes(userId));
  const oldest = !removing && held.length >= maxPerPerson ? held[0]?.emoji : undefined;
  const next = reactions.map((reaction) => {
    const userIds = reaction.emoji === oldest || (removing && reaction.emoji === emoji)
      ? reaction.userIds.filter((id) => id !== userId) : [...reaction.userIds];
    if (!removing && reaction.emoji === emoji) userIds.push(userId);
    return { ...reaction, userIds, count: userIds.length };
  }).filter((reaction) => reaction.count > 0);
  if (!removing && !next.some((reaction) => reaction.emoji === emoji)) next.push({ emoji, count: 1, userIds: [userId] });
  return next;
}

/** Separate name parts let the caller isolate each name's direction. */
export function reactorsParts(reaction: ChatReaction, userId: string, nameOf: (id: string) => string): Array<{ text: string; name?: boolean }> {
  const others = reaction.userIds.filter((id) => id !== userId);
  const mine = reaction.userIds.includes(userId);
  const parts: Array<{ text: string; name?: boolean }> = others.slice(0, 2).map((id) => ({ text: nameOf(id), name: true }));
  const remaining = others.length - parts.length;
  if (remaining > 0) parts.push({ text: `${remaining} ${remaining === 1 ? "other" : "others"}` });
  if (mine) parts.push({ text: parts.length ? "you" : "You" });
  return parts.flatMap((part, index) => index === 0 ? [part] : [{ text: index === parts.length - 1 ? " and " : ", " }, part]);
}

export function reactorsLine(reaction: ChatReaction, userId: string, nameOf: (id: string) => string): string {
  return reactorsParts(reaction, userId, nameOf).map((part) => part.text).join("");
}
