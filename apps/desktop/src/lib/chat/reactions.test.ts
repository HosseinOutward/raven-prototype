import { describe, expect, test } from "bun:test";
import { reactionLimits } from "./attachments";
import { reactorsLine, toggledReactions } from "./reactions";
import type { ChatReaction } from "./types";

const reaction = (emoji: string, ...userIds: string[]): ChatReaction => ({ emoji, userIds, count: userIds.length });

describe("reaction toggles", () => {
  test("adds a new kind at the end without changing the input", () => {
    const before = [reaction("👍", "sara")];
    const snapshot = structuredClone(before);
    expect(toggledReactions(before, "me", "❤️", 3)).toEqual([...before, reaction("❤️", "me")]);
    expect(before).toEqual(snapshot);
  });
  test("joins an existing kind in place and corrects counts", () => {
    expect(toggledReactions([{ ...reaction("👍", "sara"), count: 99 }], "me", "👍", 3)).toEqual([reaction("👍", "sara", "me")]);
  });
  test("removes mine, keeping other people and dropping empty kinds", () => {
    expect(toggledReactions([reaction("👍", "me", "sara"), reaction("❤️", "me")], "me", "👍", 3)).toEqual([reaction("👍", "sara"), reaction("❤️", "me")]);
    expect(toggledReactions([reaction("❤️", "me")], "me", "❤️", 3)).toEqual([]);
  });
  test("a fourth removes my earliest reaction, preserving everyone else's", () => {
    const before = [reaction("👍", "sara"), reaction("❤️", "me", "sara"), reaction("😂", "me"), reaction("😮", "me")];
    expect(toggledReactions(before, "me", "🙏", 3)).toEqual([reaction("👍", "sara"), reaction("❤️", "sara"), reaction("😂", "me"), reaction("😮", "me"), reaction("🙏", "me")]);
  });
  test("replacement drops an empty oldest kind and can join an existing kind", () => {
    expect(toggledReactions([reaction("❤️", "me"), reaction("👍", "sara")], "me", "👍", 1)).toEqual([reaction("👍", "sara", "me")]);
  });
});

describe("who reacted", () => {
  const line = (...ids: string[]) => reactorsLine(reaction("👍", ...ids), "me", (id) => ({ sara: "Sara", omid: "Omid" }[id] ?? "Someone"));
  test("one person and you alone", () => {
    expect(line("me")).toBe("You");
    expect(line("sara")).toBe("Sara");
  });
  test("you always come last", () => {
    expect(line("me", "sara")).toBe("Sara and you");
    expect(line("me", "sara", "omid")).toBe("Sara, Omid and you");
  });
  test("only two other names, with a singular or plural remainder", () => {
    expect(line("sara", "omid", "a")).toBe("Sara, Omid and 1 other");
    expect(line("sara", "omid", "a", "b", "c")).toBe("Sara, Omid and 3 others");
    expect(line("me", "sara", "omid", "a")).toBe("Sara, Omid, 1 other and you");
    expect(line("sara", "omid", "a", "b", "me")).toBe("Sara, Omid, 2 others and you");
  });
});

describe("server reaction limits", () => {
  test("reads both limits", () => {
    expect(reactionLimits({ chat: { reactions: { maxPerPerson: 3, maxKinds: 20 } } })).toEqual({ maxPerPerson: 3, maxKinds: 20 });
  });
  test("older servers and malformed limits have no controls", () => {
    for (const properties of [undefined, {}, { chat: true }, { chat: { reactions: true } }, { chat: { reactions: { maxPerPerson: 3 } } }]) expect(reactionLimits(properties)).toBeNull();
    for (const value of [0, -1, 0.5, Infinity, NaN, "3", null]) {
      expect(reactionLimits({ chat: { reactions: { maxPerPerson: value, maxKinds: 20 } } })).toBeNull();
      expect(reactionLimits({ chat: { reactions: { maxPerPerson: 3, maxKinds: value } } })).toBeNull();
    }
  });
});
