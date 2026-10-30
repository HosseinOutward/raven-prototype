const RECENT = "raven.emoji.recent";
const TONE = "raven.emoji.tone";
export function recentEmoji(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT) ?? "[]");
    return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))].slice(0, 24) : [];
  } catch { return []; }
}
export function recordEmoji(emoji: string): void {
  try { localStorage.setItem(RECENT, JSON.stringify([emoji, ...recentEmoji().filter((item) => item !== emoji)].slice(0, 24))); } catch { /* Storage may be unavailable. */ }
}
export function skinTone(): number {
  try {
    const tone = Number(localStorage.getItem(TONE));
    return Number.isInteger(tone) && tone >= 0 && tone <= 5 ? tone : 0;
  } catch { return 0; }
}
export function setSkinTone(tone: number): void {
  try { localStorage.setItem(TONE, String(Number.isInteger(tone) && tone >= 0 && tone <= 5 ? tone : 0)); } catch { /* Storage may be unavailable. */ }
}
