import { describe, expect, test } from "bun:test";
import { stripSidecarIdentity } from "./mediaIdentity";

describe("native media identities", () => {
  test("folds native media roles into one visible participant", () => {
    expect(stripSidecarIdentity("person#audio")).toBe("person");
    expect(stripSidecarIdentity("person#video")).toBe("person");
    expect(stripSidecarIdentity("person")).toBe("person");
  });
});
