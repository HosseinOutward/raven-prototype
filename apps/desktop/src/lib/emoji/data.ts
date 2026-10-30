export interface EmojiEntry {
  emoji: string;
  label: string;
  group: number;
  order: number;
  tags: string[];
  shortcodes: string[];
  skins?: string[];
}
export interface EmojiData { list: EmojiEntry[]; byShortcode: Map<string, EmojiEntry> }
let loading: Promise<EmojiData> | undefined;

/** Loaded once, lazily, outside the main bundle. */
export function loadEmoji(): Promise<EmojiData> {
  return loading ??= Promise.all([
    import("emojibase-data/en/data.json"),
    import("emojibase-data/en/shortcodes/github.json"),
  ]).then(([{ default: raw }, { default: codes }]) => {
    const shortcodes = codes as Record<string, string | string[]>;
    const list: EmojiEntry[] = raw.filter((entry) => entry.group !== undefined && entry.group !== 2 && entry.version <= 15).map((entry) => ({
      emoji: entry.emoji,
      label: entry.label,
      group: entry.group!,
      order: entry.order ?? 0,
      tags: entry.tags ?? [],
      shortcodes: [shortcodes[entry.hexcode] ?? []].flat(),
      skins: entry.skins?.filter((skin) => skin.group !== undefined && skin.group !== 2 && skin.version <= 15 && typeof skin.tone === "number").sort((a, b) => Number(a.tone) - Number(b.tone)).map((skin) => skin.emoji),
    })).sort((a, b) => a.order - b.order);
    const byShortcode = new Map<string, EmojiEntry>();
    for (const entry of list) for (const code of entry.shortcodes) byShortcode.set(code, entry);
    return { list, byShortcode };
  });
}

export function searchEmoji(data: EmojiData, query: string, limit = 64): EmojiEntry[] {
  const q = query.trim().replace(/^:/, "").toLowerCase();
  const rank = (entry: EmojiEntry) => {
    if (entry.shortcodes.some((code) => code.toLowerCase() === q)) return -1;
    if (entry.shortcodes.some((code) => code.toLowerCase().startsWith(q))) return 0;
    if (entry.label.toLowerCase().split(/\s+/).some((word) => word.startsWith(q))) return 1;
    if (entry.tags.some((tag) => tag.toLowerCase().startsWith(q))) return 2;
    return entry.label.toLowerCase().includes(q) ? 3 : 4;
  };
  return data.list.map((entry) => ({ entry, rank: rank(entry) })).filter((item) => item.rank < 4)
    .sort((a, b) => a.rank - b.rank || a.entry.order - b.entry.order).slice(0, limit).map((item) => item.entry);
}

export function withTone(entry: EmojiEntry, tone: number): string {
  return tone >= 1 && tone <= 5 ? entry.skins?.[tone - 1] ?? entry.emoji : entry.emoji;
}

