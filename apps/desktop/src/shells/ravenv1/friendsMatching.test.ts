import { describe, expect, it } from "bun:test";
import type { Friend } from "@/lib/api";
import { friendsMatching } from "./people";

const friend = (userId: string, username: string, displayName = ""): Friend => ({
  userId,
  username,
  displayName,
  createdAt: "",
  presenceState: "offline",
  reachability: "open",
});

describe("friendsMatching", () => {
  const friends = [friend("1", "mina", "Mina"), friend("2", "amin"), friend("3", "sam", "Mina Sam")];

  it("matches usernames only, prefix matches first", () => {
    expect(friendsMatching(friends, "min", new Set()).map((f) => f.username)).toEqual(["mina", "amin"]);
  });

  it("ignores a leading @ and case", () => {
    expect(friendsMatching(friends, "@SAM", new Set()).map((f) => f.userId)).toEqual(["3"]);
  });

  it("leaves out people already in and returns nothing for an empty query", () => {
    expect(friendsMatching(friends, "min", new Set(["1"])).map((f) => f.userId)).toEqual(["2"]);
    expect(friendsMatching(friends, "  ", new Set())).toEqual([]);
  });
});
