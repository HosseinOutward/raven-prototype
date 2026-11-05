import { describe, expect, test } from "bun:test";
import type { TreeDetails, TreeMember } from "./api";
import { canModerateVoice } from "./permissions";

const member = (userId: string, role: TreeMember["role"]) => ({ userId, role }) as TreeMember;
const details = (role: TreeMember["role"]) =>
  ({
    members: [member("owner", "owner"), member("mod", "moderator"), member("mem", "member")],
    viewer: { role, permissions: role === "member" ? [] : ["voice.moderate"] },
  }) as unknown as TreeDetails;
const room = { creatorUserId: "owner", treeId: "t", type: "persistent" as const };

describe("canModerateVoice", () => {
  test("in a space it follows rank", () => {
    expect(canModerateVoice(room, details("moderator"), "mod", "mem")).toBe(true);
    expect(canModerateVoice(room, details("moderator"), "mod", "owner")).toBe(false);
    expect(canModerateVoice(room, details("owner"), "owner", "mod")).toBe(true);
    expect(canModerateVoice(room, details("member"), "mem", "mod")).toBe(false);
  });

  test("never yourself, and nothing without the space's details", () => {
    expect(canModerateVoice(room, details("owner"), "owner", "owner")).toBe(false);
    expect(canModerateVoice(room, undefined, "mod", "mem")).toBe(false);
    expect(canModerateVoice(room, details("owner"), "owner", "stranger")).toBe(false);
  });

  test("a temporary call belongs to whoever started it", () => {
    const call = { creatorUserId: "a", treeId: null, type: "temporary" as const };
    expect(canModerateVoice(call, undefined, "a", "b")).toBe(true);
    expect(canModerateVoice(call, undefined, "b", "a")).toBe(false);
    expect(canModerateVoice(call, undefined, "a", "a")).toBe(false);
  });
});
