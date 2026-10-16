import { describe, expect, test } from "bun:test";
import type { ChatConversation, ConversationState } from "@/lib/chat/types";
import { friendsAndGroups, GROUP_RECENT_MS, GROUPS_SHOWN, visibleTextNests, type FriendsAndGroupsRow } from "./friendsAndGroups";
import { strangerNamed } from "./people";
import type { ShellPerson } from "./state";

const NOW = 1_800_000_000_000;

function person(id: string, presence: ShellPerson["presence"], activeNestIds: string[] = []): ShellPerson {
  return { id, name: id[0].toUpperCase() + id.slice(1), presence, treeIds: [], activeNestIds, relationship: "friend" };
}

function conversation(patch: Partial<ChatConversation>): ChatConversation {
  return {
    id: "c",
    kind: "dm",
    name: "",
    topic: "",
    role: "member",
    canSend: true,
    canManage: false,
    memberCount: 2,
    lastSeq: 1,
    lastActivityMs: NOW,
    unreadCount: 0,
    readSeq: 0,
    hideRev: 0,
    visibleFromSeq: 0,
    archived: false,
    createdAt: "2026-10-16T00:00:00Z",
    ...patch,
  };
}

const dm = (peer: string, patch: Partial<ChatConversation> = {}) =>
  conversation({ id: `dm-${peer}`, name: peer, peer: { id: peer, username: peer, displayName: peer }, ...patch });
const group = (id: string, patch: Partial<ChatConversation> = {}) => conversation({ id, kind: "group", name: id, memberCount: 3, ...patch });

const label = (row: FriendsAndGroupsRow) => (row.kind === "group" ? `group:${row.conversation.id}` : `${row.former ? "former" : "person"}:${row.person.id}`);
const run = (friends: ShellPerson[], conversations: ChatConversation[], activeConversationId = "") =>
  friendsAndGroups({ friends, conversations, personFor: strangerNamed, activeConversationId, now: NOW });

describe("friendsAndGroups", () => {
  test("reachable friends first by reachability then name, then groups, then offline friends", () => {
    const result = run(
      [person("zoe", "open"), person("ava", "around"), person("sam", "dnd", ["nest-1"]), person("omar", "offline"), person("ivy", "invisible")],
      [group("crew", { lastActivityMs: NOW - 1000 }), group("book-club", { lastActivityMs: NOW - 10 })],
    );
    expect(result.shown.map(label)).toEqual(["person:sam", "person:zoe", "person:ava", "group:book-club", "group:crew"]);
    expect(result.offline.map(label)).toEqual(["person:ivy", "person:omar"]);
  });

  test("a friend's row carries their direct message and its unread count, without moving", () => {
    const quiet = run([person("ava", "open"), person("ben", "open")], []);
    const loud = run([person("ava", "open"), person("ben", "open")], [dm("ben", { unreadCount: 5, lastActivityMs: NOW })]);
    expect(loud.shown.map(label)).toEqual(quiet.shown.map(label));
    const ben = loud.shown[1];
    expect(ben.kind === "person" && ben.conversation?.unreadCount).toBe(5);
  });

  test("an offline friend with unread messages is lifted out of the disclosure", () => {
    const result = run([person("ava", "open"), person("omar", "offline"), person("pia", "offline")], [dm("omar", { unreadCount: 2 })]);
    expect(result.shown.map(label)).toEqual(["person:ava", "person:omar"]);
    expect(result.offline.map(label)).toEqual(["person:pia"]);
  });

  test("the open conversation with an offline friend stays in view", () => {
    const result = run([person("omar", "offline")], [dm("omar")], "dm-omar");
    expect(result.shown.map(label)).toEqual(["person:omar"]);
    expect(result.offline).toEqual([]);
  });

  test("someone who is no longer a friend shows only while something is unread", () => {
    expect(run([], [dm("kai")]).shown).toEqual([]);
    const unread = run([], [dm("kai", { unreadCount: 1 })]);
    expect(unread.shown.map(label)).toEqual(["former:kai"]);
    const row = unread.shown[0];
    expect(row.kind === "person" && row.person.presenceUnknown).toBe(true);
  });

  test("groups: unread or recently active, newest first, at most a handful", () => {
    const stale = group("stale", { lastActivityMs: NOW - GROUP_RECENT_MS - 1 });
    const staleUnread = group("stale-unread", { lastActivityMs: NOW - GROUP_RECENT_MS - 2, unreadCount: 1 });
    const recent = Array.from({ length: GROUPS_SHOWN + 2 }, (_, index) => group(`g${index}`, { lastActivityMs: NOW - index }));
    const result = run([], [stale, staleUnread, ...recent]);
    const shown = result.shown.map(label);
    expect(shown).toHaveLength(GROUPS_SHOWN);
    expect(shown).toContain("group:stale-unread");
    expect(shown).not.toContain("group:stale");
    expect(shown[0]).toBe("group:g0");
    expect(shown[shown.length - 1]).toBe("group:stale-unread");
  });

  test("the open group is listed even when it is old", () => {
    const result = run([], [group("old", { lastActivityMs: 0 })], "old");
    expect(result.shown.map(label)).toEqual(["group:old"]);
  });
});

describe("visibleTextNests", () => {
  const nest = (id: string, unreadCount = 0) => ({ summary: conversation({ id, kind: "nest", treeId: "t", unreadCount }) }) as ConversationState;

  test("lists only unread text nests and the open one, in the order given", () => {
    const nests = [nest("general"), nest("links", 3), nest("random"), nest("plans", 1)];
    expect(visibleTextNests(nests).map((item) => item.summary.id)).toEqual(["links", "plans"]);
    expect(visibleTextNests(nests, "random").map((item) => item.summary.id)).toEqual(["links", "random", "plans"]);
    expect(visibleTextNests([nest("general")])).toEqual([]);
  });
});
