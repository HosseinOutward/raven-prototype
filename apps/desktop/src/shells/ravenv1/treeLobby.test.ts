import { describe, expect, test } from "bun:test";
import type { TreeMember } from "@/lib/api";
import { groupMembers, lobbyMenus, treeSubtitleParts } from "./treeLobby";

describe("lobbyMenus", () => {
  test("a room manager with chat can create all three and arrange", () => {
    expect(lobbyMenus({ canRooms: true, canMembers: false, hasChat: true })).toEqual({ create: ["voice", "text", "category"], more: ["arrange"] });
  });

  test("without chat only a voice nest can be made and there is nothing to arrange", () => {
    expect(lobbyMenus({ canRooms: true, canMembers: false, hasChat: false })).toEqual({ create: ["voice"], more: [] });
  });

  test("someone who may add people but not rooms still gets Add a person", () => {
    expect(lobbyMenus({ canRooms: false, canMembers: true, hasChat: true })).toEqual({ create: [], more: ["addPerson"] });
  });

  test("someone with neither gets nothing", () => {
    expect(lobbyMenus({ canRooms: false, canMembers: false, hasChat: true })).toEqual({ create: [], more: [] });
  });
});

describe("treeSubtitleParts", () => {
  test("says visibility and the member count, and who is inside only when someone is", () => {
    expect(treeSubtitleParts({ visibility: "private", members: 5, inside: 2, nestSingular: "nest" })).toEqual({ visibility: "Private", members: "5 members", inside: "2 in a nest" });
    expect(treeSubtitleParts({ visibility: "public", members: 1, inside: 0, nestSingular: "nest" })).toEqual({ visibility: "Public", members: "1 member", inside: null });
  });
});

const member = (userId: string, patch: Partial<TreeMember> = {}): TreeMember =>
  ({ treeId: "t", userId, username: userId, displayName: userId, role: "member", state: "joined", presenceState: "available", reachability: "around", ...patch }) as TreeMember;

describe("groupMembers", () => {
  test("splits into here, online and offline, open people first", () => {
    const groups = groupMembers([
      member("zed", { presenceState: "offline" }),
      member("bea", { activeNestId: "n1" }),
      member("cal", { reachability: "focused" }),
      member("dan", { reachability: "open" }),
      member("eve", { presenceState: "invisible" }),
    ]);
    expect(groups.here.map((item) => item.userId)).toEqual(["bea"]);
    expect(groups.online.map((item) => item.userId)).toEqual(["dan", "cal"]);
    expect(groups.offline.map((item) => item.userId).sort()).toEqual(["eve", "zed"]);
  });

  test("someone who is away is never listed as here", () => {
    const groups = groupMembers([member("ava", { presenceState: "offline", activeNestId: "n1" })]);
    expect(groups.here).toEqual([]);
    expect(groups.offline).toHaveLength(1);
  });
});
