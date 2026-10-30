import { describe, expect, test } from "bun:test";
import { loadEmoji, searchEmoji, withTone } from "./data";

const data = await loadEmoji();
describe("bundled emoji data", () => {
  test("loads once and offers only supported non-component emoji", async () => {
    expect(await loadEmoji()).toBe(data);
    expect(data.list.some((entry) => entry.emoji === "🏻" || entry.group === 2)).toBe(false);
    expect(data.list.some((entry) => entry.emoji === "🐦‍🔥")).toBe(false);
    expect(data.list.length).toBeGreaterThan(1500);
    expect(data.list.map((entry) => entry.order)).toEqual(data.list.map((entry) => entry.order).sort((a, b) => a - b));
  });
  test("searches shortcodes, words and tags with exact shortcodes first", () => {
    expect(searchEmoji(data, "heart")[0].emoji).toBe("❤️");
    expect(searchEmoji(data, ":+1")[0].emoji).toBe("👍");
    expect(searchEmoji(data, "  :SMI  ", 6).map((entry) => entry.emoji)).toContain("😄");
    expect(searchEmoji(data, "no_such_emoji_123")).toEqual([]);
    expect(searchEmoji(data, "")).toHaveLength(64);
  });
  test("applies tones and leaves untoned emoji alone", () => {
    const thumb = data.byShortcode.get("+1")!;
    expect(withTone(thumb, 3)).toBe("👍🏽");
    expect(withTone(thumb, 0)).toBe("👍");
    expect(withTone(data.byShortcode.get("heart")!, 3)).toBe("❤️");
  });
});
