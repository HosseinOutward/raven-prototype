import { beforeAll, describe, expect, test } from "bun:test";
import type { HomeState, TreeDetails } from "@/lib/api";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

let derivePeople: typeof import("./useRavenShellData").derivePeople;

beforeAll(async () => {
  ({ derivePeople } = await import("./useRavenShellData"));
});

describe("derivePeople", () => {
  test("uses direct friend presence and places available friends before offline ones", () => {
    const home = {
      user: { id: "self" },
      friends: [
        { userId: "offline-friend", username: "offline", displayName: "Offline friend", presenceState: "offline", reachability: "unavailable" },
        { userId: "dnd-friend", username: "dnd", displayName: "DND friend", presenceState: "dnd", reachability: "unavailable" },
      ],
      activeNests: [],
      pendingKnocks: [],
      incomingFriendRequests: [],
      outgoingFriendRequests: [],
    } as HomeState;
    const treeDetails = {
      team: {
        tree: { id: "team" },
        members: [
          { userId: "dnd-friend", username: "dnd", displayName: "DND friend", presenceState: "available", reachability: "open" },
          { userId: "context-person", username: "context", displayName: "Context person", presenceState: "available", reachability: "focused" },
        ],
      },
    } as Record<string, TreeDetails>;

    const people = derivePeople(home, treeDetails);

    expect(people.map((person) => [person.id, person.presence])).toEqual([
      ["dnd-friend", "dnd"],
      ["offline-friend", "offline"],
      ["context-person", "focused"],
    ]);
  });
});
