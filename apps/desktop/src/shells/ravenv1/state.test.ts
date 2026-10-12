import { describe, expect, test } from "bun:test";
import { PRESENCE, presenceForActiveNest, presenceFromApi } from "./state";

describe("presenceForActiveNest", () => {
  test("keeps manually selected DND and Invisible states", () => {
    expect(presenceForActiveNest({ state: "dnd", reachability: "unavailable" })).toEqual({
      state: "dnd",
      reachability: "unavailable",
    });
    expect(presenceForActiveNest({ state: "invisible", reachability: "unavailable" })).toEqual({
      state: "invisible",
      reachability: "unavailable",
    });
  });

  test("keeps the selected reachable status while marking the user in a Nest", () => {
    expect(presenceForActiveNest({ state: "available", reachability: "open" })).toEqual({
      state: "in_nest",
      reachability: "open",
    });
    expect(presenceForActiveNest({ state: "available", reachability: "focused" })).toEqual({
      state: "in_nest",
      reachability: "focused",
    });
  });
});

describe("presenceFromApi", () => {
  test("keeps Offline separate from Invisible for friends", () => {
    expect(presenceFromApi({ state: "offline", reachability: "unavailable" })).toBe("offline");
    expect(presenceFromApi({ state: "invisible", reachability: "unavailable" })).toBe("invisible");
    expect(PRESENCE.offline.label).toBe("Offline");
    expect(PRESENCE.invisible.label).toBe("Invisible");
  });
});
