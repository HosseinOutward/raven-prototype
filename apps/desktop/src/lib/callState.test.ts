import { describe, expect, test } from "bun:test";
import type { ParticipantSummary } from "./api";
import { callStateCatchUp, callStatesByUser, callStateSupported, participantCallState } from "./callState";

const person = (userId: string, extra: Partial<ParticipantSummary> = {}): ParticipantSummary => ({
  userId,
  username: userId,
  displayName: userId,
  joinedAt: "2026-10-27T10:00:00Z",
  ...extra,
});

describe("callStateSupported", () => {
  test("an older server sends neither field", () => {
    expect(callStateSupported({ participants: [person("a"), person("b")] })).toBe(false);
    expect(callStateSupported(null)).toBe(false);
    expect(callStateSupported({ participants: [] })).toBe(false);
  });

  test("a server with the route always sends away", () => {
    expect(callStateSupported({ participants: [person("a", { away: false, deafened: false })] })).toBe(true);
  });
});

describe("participantCallState", () => {
  test("reads one person and treats a missing field or person as off", () => {
    const participants = [person("a", { away: true, deafened: false }), person("b")];
    expect(participantCallState(participants, "a")).toEqual({ away: true, deafened: false, serverMuted: false, serverDeafened: false });
    expect(participantCallState(participants, "b")).toEqual({ away: false, deafened: false, serverMuted: false, serverDeafened: false });
    expect(participantCallState(participants, "nobody")).toEqual({ away: false, deafened: false, serverMuted: false, serverDeafened: false });
  });
});

describe("callStatesByUser", () => {
  test("your own markers come from what you just set, not the server's echo", () => {
    const states = callStatesByUser(
      [person("me", { away: false, deafened: false }), person("them", { away: true, deafened: true })],
      { userId: "me", away: true, deafened: false },
    );
    expect(states.get("me")).toEqual({ away: true, deafened: false, serverMuted: false, serverDeafened: false });
    expect(states.get("them")).toEqual({ away: true, deafened: true, serverMuted: false, serverDeafened: false });
  });

  test("your own server mute still comes from the server", () => {
    const states = callStatesByUser(
      [person("me", { away: false, deafened: false, serverMuted: true })],
      { userId: "me", away: false, deafened: true },
    );
    expect(states.get("me")).toEqual({ away: false, deafened: true, serverMuted: true, serverDeafened: false });
  });
});

describe("callStateCatchUp", () => {
  const clear = { away: false, deafened: false };

  test("a first join with nothing set sends nothing", () => {
    expect(callStateCatchUp(clear, clear)).toBeNull();
  });

  test("rejoining after a dropped connection puts back what the person had set", () => {
    expect(callStateCatchUp(clear, { away: true, deafened: true })).toEqual({ away: true, deafened: true });
    expect(callStateCatchUp(clear, { away: false, deafened: true })).toEqual({ deafened: true });
    expect(callStateCatchUp(clear, { away: true, deafened: false })).toEqual({ away: true });
  });

  test("a server that kept a marker the person already cleared gets told", () => {
    expect(callStateCatchUp({ away: true, deafened: true }, clear)).toEqual({ away: false, deafened: false });
  });
});
