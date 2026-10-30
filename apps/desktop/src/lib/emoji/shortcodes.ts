import type { EmojiData } from "./data";

function inCode(text: string): boolean {
  const fences = text.match(/```/g)?.length ?? 0;
  if (fences % 2) return true;
  const line = text.slice(text.lastIndexOf("\n") + 1).replace(/```/g, "");
  return (line.match(/`/g)?.length ?? 0) % 2 === 1;
}

/** The :token before the caret, with at least two characters after the colon. */
export function shortcodeQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  if (inCode(before)) return null;
  const match = /(?:^|[\s(]):([a-z0-9_+\-]{2,})$/.exec(before);
  return match ? { start: caret - match[1].length - 1, query: match[1] } : null;
}

export function completedShortcode(text: string, caret: number, data: EmojiData): { start: number; emoji: string } | null {
  const before = text.slice(0, caret);
  if (inCode(before)) return null;
  const match = /(?:^|[\s(]):([a-z0-9_+\-]+):$/.exec(before);
  const entry = match && data.byShortcode.get(match[1]);
  return entry ? { start: caret - match![1].length - 2, emoji: entry.emoji } : null;
}
