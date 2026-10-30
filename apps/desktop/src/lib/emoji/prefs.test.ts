import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { recentEmoji, recordEmoji, skinTone, setSkinTone } from "./prefs";
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const memory = new Map<string, string>();
beforeEach(() => {
  memory.clear();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) } });
});
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
describe("emoji preferences", () => {
  test("stores up to 24 unique recent picks, newest first", () => {
    for (let i = 0; i < 30; i++) recordEmoji(String(i));
    recordEmoji("15");
    expect(recentEmoji()).toHaveLength(24);
    expect(recentEmoji()[0]).toBe("15");
    expect(recentEmoji().filter((emoji) => emoji === "15")).toHaveLength(1);
  });
  test("validates saved values", () => {
    expect(skinTone()).toBe(0);
    setSkinTone(3); expect(skinTone()).toBe(3);
    setSkinTone(6); expect(skinTone()).toBe(0);
    memory.set("raven.emoji.tone", "1.5"); expect(skinTone()).toBe(0);
    memory.set("raven.emoji.recent", '{'); expect(recentEmoji()).toEqual([]);
    memory.set("raven.emoji.recent", '[null,2,"❤️","❤️"]'); expect(recentEmoji()).toEqual(["❤️"]);
  });
  test("works when storage is blocked", () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    expect(recentEmoji()).toEqual([]); expect(skinTone()).toBe(0);
    expect(() => recordEmoji("❤️")).not.toThrow(); expect(() => setSkinTone(2)).not.toThrow();
  });
});
