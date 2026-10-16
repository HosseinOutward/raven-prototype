import { describe, expect, test } from "bun:test";
import type { FriendRequest, HomeState, Nest } from "@/lib/api";
import { friendStanding, personNestAction } from "./people";
import type { ShellPerson } from "./state";
import { derivePeople } from "./useRavenShellData";

function request(id: string, fromUserId: string, toUserId: string): FriendRequest {
  return {
    id, fromUserId, fromUsername: fromUserId, fromDisplayName: fromUserId,
    toUserId, toUsername: toUserId, toDisplayName: toUserId, status: "pending", createdAt: "2026-10-12T00:00:00Z",
  };
}

const me = { id: "me" } as HomeState["user"];
const friend = { userId: "fay", username: "fay", displayName: "Fay", createdAt: "", presenceState: "available", reachability: "open" } as HomeState["friends"][number];

describe("friendStanding", () => {
  const data = {
    user: me,
    friends: [friend],
    incomingFriendRequests: [request("in-1", "ivy", "me")],
    outgoingFriendRequests: [request("out-1", "me", "omar")],
  };

  test("reads how things stand now, with the request that can be answered", () => {
    expect(friendStanding("me", data)).toEqual({ relationship: "self" });
    expect(friendStanding("fay", data)).toEqual({ relationship: "friends" });
    expect(friendStanding("ivy", data)).toEqual({ relationship: "incoming_pending", requestId: "in-1" });
    expect(friendStanding("omar", data)).toEqual({ relationship: "outgoing_pending", requestId: "out-1" });
    expect(friendStanding("nobody", data)).toEqual({ relationship: "none" });
  });

  test("follows the data once a request is answered", () => {
    const accepted = { ...data, friends: [friend, { ...friend, userId: "ivy" }], incomingFriendRequests: [] };
    expect(friendStanding("ivy", accepted)).toEqual({ relationship: "friends" });
    const cancelled = { ...data, outgoingFriendRequests: [] };
    expect(friendStanding("omar", cancelled)).toEqual({ relationship: "none" });
  });
});

describe("derivePeople", () => {
  test("someone known only through a friend request has no presence to show", () => {
    const home = {
      user: me,
      friends: [friend],
      activeNests: [],
      pendingKnocks: [],
      incomingFriendRequests: [request("in-1", "ivy", "me")],
      outgoingFriendRequests: [request("out-1", "me", "omar")],
    } as unknown as HomeState;
    const people = derivePeople(home, {});
    const byId = Object.fromEntries(people.map((person) => [person.id, person]));
    expect(byId.fay.presenceUnknown).toBeUndefined();
    expect(byId.fay.presence).toBe("open");
    expect(byId.ivy.presenceUnknown).toBe(true);
    expect(byId.omar.presenceUnknown).toBe(true);
  });
});

describe("personNestAction", () => {
  const nest = (id: string, lifecycleState: Nest["lifecycleState"] = "active") => ({ id, name: id, lifecycleState }) as Nest;
  const nests = new Map([["standup", nest("standup")], ["quiet", nest("quiet", "empty")]]);
  const data = { getNest: (id: string) => nests.get(id) };
  const sam = (activeNestIds: string[]): ShellPerson => ({ id: "sam", name: "Sam", presence: "open", treeIds: [], activeNestIds, relationship: "friend" });
  const idle = { activeNestId: null, entering: false };

  test("nothing when they are in no nest this client knows", () => {
    expect(personNestAction(sam([]), data, idle)).toBeNull();
    expect(personNestAction(sam(["unknown"]), data, idle)).toBeNull();
  });

  test("join only from outside a call, into a live nest", () => {
    expect(personNestAction(sam(["standup"]), data, idle)?.action).toBe("join");
    expect(personNestAction(sam(["standup"]), data, { activeNestId: "other", entering: false })?.action).toBe("open");
    expect(personNestAction(sam(["standup"]), data, { activeNestId: null, entering: true })?.action).toBe("open");
    expect(personNestAction(sam(["quiet"]), data, idle)?.action).toBe("open");
  });

  test("here when you are in it together", () => {
    expect(personNestAction(sam(["standup"]), data, { activeNestId: "standup", entering: false })?.action).toBe("here");
  });
});
