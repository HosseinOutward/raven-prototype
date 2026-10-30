import { describe, expect, test } from "bun:test";
import { loadEmoji } from "./data";
import { shortcodeQuery, completedShortcode } from "./shortcodes";
const data = await loadEmoji();
const query = (text: string) => shortcodeQuery(text, text.length);
const complete = (text: string) => completedShortcode(text, text.length, data);
describe("shortcodes around the caret", () => {
  test("requires two characters and a token boundary", () => {
    expect(query(":s")).toBeNull();
    expect(query(":smi")).toEqual({ start: 0, query: "smi" });
    expect(query("hi (:smi")).toEqual({ start: 4, query: "smi" });
    expect(query("hi\n:+1")).toEqual({ start: 3, query: "+1" });
    for (const text of ["https:smi", "a:smi", ":smile:", ":bad!", ":SMI"]) expect(query(text)).toBeNull();
    expect(shortcodeQuery(":smi suffix", 4)).toEqual({ start: 0, query: "smi" });
  });
  test("does not suggest or complete inside code", () => {
    for (const prefix of ["`", "text `code ", "```\n", "```ts\nconst a = "]) {
      expect(query(prefix + ":smi")).toBeNull();
      expect(complete(prefix + ":smile:")).toBeNull();
    }
    expect(query("`done` :smi")).not.toBeNull();
    expect(query("```\nx\n```\n:smi")).not.toBeNull();
    expect(query("`unfinished\n:smi")).not.toBeNull();
  });
  test("completes only known codes at a boundary", () => {
    expect(complete(":smile:")).toEqual({ start: 0, emoji: "😄" });
    expect(complete("hello :+1:")).toEqual({ start: 6, emoji: "👍" });
    expect(complete(":unknown_code:")).toBeNull();
    expect(complete("x:smile:")).toBeNull();
    expect(completedShortcode(":heart: suffix", 7, data)).toEqual({ start: 0, emoji: "❤️" });
  });
});
