import { describe, expect, test } from "bun:test";
import { stripSidecarIdentity } from "./mediaIdentity";

describe("native media identities", () => {
  test("folds native media roles into one visible participant", () => {
    expect(stripSidecarIdentity("person#audio")).toBe("person");
    expect(stripSidecarIdentity("person#video")).toBe("person");
    expect(stripSidecarIdentity("person")).toBe("person");
  });

  test("matches the audio engine's hyphenated UUIDs to user ids", () => {
    const userId = "0f3c9a1b2d4e4f6a8b7c9d0e1f2a3b4c";
    expect(stripSidecarIdentity("0f3c9a1b-2d4e-4f6a-8b7c-9d0e1f2a3b4c")).toBe(userId);
    expect(stripSidecarIdentity("0F3C9A1B-2D4E-4F6A-8B7C-9D0E1F2A3B4C#audio")).toBe(userId);
    expect(stripSidecarIdentity(`${userId}#video`)).toBe(userId);
  });
});
