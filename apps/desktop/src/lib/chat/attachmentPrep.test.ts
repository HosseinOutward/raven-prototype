import { describe, expect, test } from "bun:test";
import { asciiJson, prepareErrorText } from "./attachmentPrep";

describe("talking to the native side", () => {
  test("header JSON is ASCII and reads back as the same text", () => {
    const options = { name: "عکس سفر 😀.jpg", mode: "standard" };
    const header = asciiJson(options);
    expect(/^[\x20-\x7e]*$/.test(header)).toBe(true);
    // The emoji is a surrogate pair, escaped as two.
    expect(header).toContain(String.raw`\ud83d\ude00`);
    expect(JSON.parse(header)).toEqual(options);
  });

  test("each preparation error has words", () => {
    expect(prepareErrorText("unsupported")).toBe("Raven can only send images for now.");
    expect(prepareErrorText("tooLarge")).toBe("That image is too large to send.");
    expect(prepareErrorText("damaged")).toBe("That image couldn’t be read.");
    expect(prepareErrorText("io")).toContain("Try adding it again");
  });
});
