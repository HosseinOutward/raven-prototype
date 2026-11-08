import { describe, expect, test } from "bun:test";
import { profileActions, type ProfileActionsInput } from "./profile";

const base: ProfileActionsInput = { isSelf: false, hasChat: true, inNest: false, isFriend: false, knockHeld: false, incoming: false, outgoing: false, sharesTree: false };
const actions = (patch: Partial<ProfileActionsInput>) => profileActions({ ...base, ...patch });

describe("profileActions", () => {
  test("your own page edits your profile, with Saved messages when there is chat", () => {
    expect(actions({ isSelf: true })).toEqual({ primary: "editProfile", secondary: ["saved"] });
    expect(actions({ isSelf: true, hasChat: false })).toEqual({ primary: "editProfile", secondary: [] });
  });

  test("someone in a nest you can see: go there, or knock", () => {
    expect(actions({ inNest: true })).toEqual({ primary: "goToNest", secondary: ["knock"] });
    expect(actions({ inNest: true, isFriend: true })).toEqual({ primary: "goToNest", secondary: ["knock", "message"] });
  });

  test("a friend you can knock on", () => {
    expect(actions({ isFriend: true })).toEqual({ primary: "knock", secondary: ["message"] });
  });

  test("a friend whose answer holds your knock: message first, the knock stays visible", () => {
    expect(actions({ isFriend: true, knockHeld: true })).toEqual({ primary: "message", secondary: ["knock"] });
    expect(actions({ isFriend: true, knockHeld: true, hasChat: false })).toEqual({ primary: "knock", secondary: [] });
  });

  test("not friends: add friend, and knock when you share a tree", () => {
    expect(actions({ sharesTree: true })).toEqual({ primary: "addFriend", secondary: ["knock"] });
    expect(actions({})).toEqual({ primary: "addFriend", secondary: [] });
  });

  test("they asked you: answer before anything else", () => {
    expect(actions({ incoming: true, inNest: true, sharesTree: true })).toEqual({ primary: "accept", secondary: ["decline"] });
  });

  test("you asked them: nothing but the request row", () => {
    expect(actions({ outgoing: true, sharesTree: true })).toEqual({ primary: null, secondary: [] });
  });
});
