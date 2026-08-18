import { describe, expect, test } from "bun:test";
import { presenceForActiveNest } from "./state";

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
