import { describe, expect, test } from "bun:test";
import type { VoiceOverlayParticipant, VoiceOverlaySnapshot } from "./voiceOverlay";
import {
  advanceTalkState,
  diffRoster,
  isTalkActive,
  localSaying,
  nextTalkExpiry,
  orderByJoin,
  quietOpacity,
  rowStatus,
  selectCardRows,
  showsName,
  type TalkState,
} from "./voiceOverlayView";

function person(userId: string, patch: Partial<VoiceOverlayParticipant> = {}): VoiceOverlayParticipant {
  return {
    userId,
    displayName: userId,
    avatarUrl: null,
    isLocal: false,
    speaking: false,
    speakingLevel: 0,
    muted: false,
    deafened: false,
    screenSharing: false,
    watchers: [],
    cameraOn: false,
    connectionQuality: "good",
    joinedAt: null,
    ...patch,
  };
}

function snapshot(participants: VoiceOverlayParticipant[], patch: Partial<VoiceOverlaySnapshot> = {}): VoiceOverlaySnapshot {
  return {
    nestId: "nest",
    nestName: "Nest",
    locationLabel: "nest",
    connected: true,
    reconnecting: false,
    localMutedHint: false,
    participants,
    ...patch,
  };
}

const LINGER = 3000;

describe("row status", () => {
  test("goes lost, deafened, muted, weak", () => {
    expect(rowStatus(person("a", { connectionQuality: "lost", deafened: true, muted: true }), true)).toBe("lost");
    expect(rowStatus(person("a", { deafened: true, muted: true, connectionQuality: "poor" }), true)).toBe("deafened");
    expect(rowStatus(person("a", { muted: true, connectionQuality: "poor" }), true)).toBe("muted");
    expect(rowStatus(person("a", { connectionQuality: "poor" }), true)).toBe("weak");
    expect(rowStatus(person("a"), true)).toBeNull();
  });

  test("weak connections follow the switch but cut channels do not", () => {
    expect(rowStatus(person("a", { connectionQuality: "poor" }), false)).toBeNull();
    expect(rowStatus(person("a", { connectionQuality: "lost" }), false)).toBeNull();
    expect(rowStatus(person("a", { connectionQuality: "lost", muted: true }), false)).toBe("muted");
  });
});

describe("lingering", () => {
  test("a name stays for the window after talking stops", () => {
    let state: TalkState = advanceTalkState({}, [person("a", { speaking: true })], 1000, LINGER);
    state = advanceTalkState(state, [person("a")], 2000, LINGER);
    expect(isTalkActive(state.a, 2000, LINGER)).toBe(true);
    expect(isTalkActive(state.a, 4999, LINGER)).toBe(true);
    expect(isTalkActive(state.a, 5000, LINGER)).toBe(false);
    expect(nextTalkExpiry(state, 2500, LINGER)).toBe(5000);
    expect(nextTalkExpiry(state, 5000, LINGER)).toBeNull();
  });

  test("off means the name goes with the voice", () => {
    let state = advanceTalkState({}, [person("a", { speaking: true })], 1000, 0);
    state = advanceTalkState(state, [person("a")], 1500, 0);
    expect(isTalkActive(state.a, 1500, 0)).toBe(false);
  });

  test("talking again inside the window cancels the fade and keeps the place", () => {
    let state = advanceTalkState({}, [person("a", { speaking: true })], 1000, LINGER);
    state = advanceTalkState(state, [person("a")], 2000, LINGER);
    state = advanceTalkState(state, [person("a", { speaking: true })], 3000, LINGER);
    expect(state.a.startedAt).toBe(1000);
    expect(nextTalkExpiry(state, 3000, LINGER)).toBeNull();
  });

  test("talking again after the window starts a new run", () => {
    let state = advanceTalkState({}, [person("a", { speaking: true })], 1000, LINGER);
    state = advanceTalkState(state, [person("a")], 2000, LINGER);
    state = advanceTalkState(state, [person("a", { speaking: true })], 9000, LINGER);
    expect(state.a.startedAt).toBe(9000);
  });

  test("people who left are forgotten", () => {
    const state = advanceTalkState({}, [person("a", { speaking: true })], 1000, LINGER);
    expect(advanceTalkState(state, [], 2000, LINGER)).toEqual({});
  });
});

describe("views", () => {
  const people = [
    person("late", { joinedAt: "2026-01-01T10:05:00Z" }),
    person("me", { isLocal: true, joinedAt: "2026-01-01T10:00:00Z" }),
    person("early", { joinedAt: "2026-01-01T10:01:00Z" }),
    person("nodate"),
  ];

  test("order is by join time with unknown times last, and you are held apart", () => {
    expect(orderByJoin(people).map((p) => p.userId)).toEqual(["me", "early", "late", "nodate"]);
    const rows = selectCardRows({ view: "everyone", participants: people, talk: {}, now: 0, lingerMs: LINGER });
    expect(rows.rows.map((p) => p.userId)).toEqual(["early", "late", "nodate"]);
    expect(rows.local?.userId).toBe("me");
  });

  test("talkers first lists the talking in the order they started and folds the rest", () => {
    let talk = advanceTalkState({}, [person("late", { speaking: true })], 1000, LINGER);
    talk = advanceTalkState(talk, [person("late", { speaking: true }), person("early", { speaking: true })], 2000, LINGER);
    const rows = selectCardRows({ view: "talkersFirst", participants: people, talk, now: 2000, lingerMs: LINGER });
    expect(rows.rows.map((p) => p.userId)).toEqual(["late", "early"]);
    expect(rows.folded.map((p) => p.userId)).toEqual(["nodate"]);
  });

  test("a lingering talker keeps a full row", () => {
    let talk = advanceTalkState({}, [person("early", { speaking: true })], 1000, LINGER);
    talk = advanceTalkState(talk, [person("early")], 2000, LINGER);
    const kept = selectCardRows({ view: "talkersFirst", participants: people, talk, now: 3000, lingerMs: LINGER });
    expect(kept.rows.map((p) => p.userId)).toEqual(["early"]);
    const gone = selectCardRows({ view: "talkersFirst", participants: people, talk, now: 6000, lingerMs: LINGER });
    expect(gone.rows).toEqual([]);
    expect(gone.folded).toHaveLength(3);
  });

  test("only talking counts the others it does not list", () => {
    const talk = advanceTalkState({}, [person("early", { speaking: true })], 1000, LINGER);
    const rows = selectCardRows({ view: "onlyTalking", participants: people, talk, now: 1000, lingerMs: LINGER });
    expect(rows.rows.map((p) => p.userId)).toEqual(["early"]);
    expect(rows.hiddenOthers).toBe(2);
    const quiet = selectCardRows({ view: "onlyTalking", participants: people, talk: {}, now: 1000, lingerMs: LINGER });
    expect(quiet.hiddenOthers).toBe(3);
    const alone = selectCardRows({ view: "onlyTalking", participants: [people[1]], talk: {}, now: 0, lingerMs: LINGER });
    expect(alone.hiddenOthers).toBe(0);
  });
});

describe("names", () => {
  test("always, while talking and never", () => {
    expect(showsName({ names: "always", active: false, shape: "column" })).toBe(true);
    expect(showsName({ names: "whileTalking", active: false, shape: "column" })).toBe(false);
    expect(showsName({ names: "whileTalking", active: true, shape: "column" })).toBe(true);
    expect(showsName({ names: "never", active: true, shape: "column" })).toBe(false);
  });

  test("in a row only people who are talking widen", () => {
    expect(showsName({ names: "always", active: false, shape: "row" })).toBe(false);
    expect(showsName({ names: "always", active: true, shape: "row" })).toBe(true);
    expect(showsName({ names: "never", active: true, shape: "row" })).toBe(false);
  });
});

describe("your own row", () => {
  const base = { mutedHint: true, showWeakConnections: true };

  test("reconnecting always shows, with every switch off", () => {
    const saying = localSaying({
      snapshot: { reconnecting: true, localMutedHint: false },
      local: person("me", { isLocal: true, muted: true }),
      mutedHint: false,
      showWeakConnections: false,
    });
    expect(saying?.words).toBe("Reconnecting…");
    expect(saying?.caption).toBe("They can't hear you.");
    expect(saying?.tone).toBe("warning");
  });

  test("muted is an icon, and words only when you talked", () => {
    const local = person("me", { isLocal: true, muted: true });
    expect(localSaying({ ...base, snapshot: { reconnecting: false, localMutedHint: false }, local })).toMatchObject({
      icon: "muted",
      words: null,
    });
    expect(localSaying({ ...base, snapshot: { reconnecting: false, localMutedHint: true }, local })?.words).toBe("You're muted");
    expect(
      localSaying({ ...base, mutedHint: false, snapshot: { reconnecting: false, localMutedHint: true }, local })?.words,
    ).toBeNull();
  });

  test("deafened beats muted, weak comes last and follows its switch", () => {
    const snap = { reconnecting: false, localMutedHint: false };
    expect(localSaying({ ...base, snapshot: snap, local: person("me", { isLocal: true, muted: true, deafened: true }) })?.words).toBe("Deafened");
    const weak = person("me", { isLocal: true, connectionQuality: "poor" });
    expect(localSaying({ ...base, snapshot: snap, local: weak })?.words).toBe("Weak connection");
    expect(localSaying({ ...base, showWeakConnections: false, snapshot: snap, local: weak })).toBeNull();
    expect(localSaying({ ...base, snapshot: snap, local: person("me", { isLocal: true }) })).toBeNull();
  });
});

describe("quiet fade", () => {
  test("opacity per setting", () => {
    expect(quietOpacity("none")).toBe(1);
    expect(quietOpacity("some")).toBe(0.8);
    expect(quietOpacity("lots")).toBe(0.45);
  });
});

describe("joins and leaves", () => {
  const me = person("me", { isLocal: true });

  test("the first snapshot of a call announces nobody", () => {
    const diff = diffRoster(null, snapshot([me, person("a"), person("b")]));
    expect(diff.joined).toEqual([]);
    expect(diff.left).toEqual([]);
    expect(diff.memory?.participants).toHaveLength(3);
  });

  test("someone arriving and leaving", () => {
    const first = diffRoster(null, snapshot([me, person("a")])).memory;
    const arrived = diffRoster(first, snapshot([me, person("a"), person("b")]));
    expect(arrived.joined.map((p) => p.userId)).toEqual(["b"]);
    const gone = diffRoster(arrived.memory, snapshot([me, person("b")]));
    expect(gone.left.map((p) => p.userId)).toEqual(["a"]);
  });

  test("your own arrival and departure are not announced", () => {
    const before = diffRoster(null, snapshot([person("a")], { connected: true })).memory;
    expect(diffRoster(before, snapshot([person("a"), me])).joined).toEqual([]);
    expect(diffRoster(before, snapshot([me])).left.map((p) => p.userId)).toEqual(["a"]);
  });

  test("another nest, or the end of the call, resets", () => {
    const first = diffRoster(null, snapshot([me, person("a")])).memory;
    const other = diffRoster(first, snapshot([me, person("b")], { nestId: "other" }));
    expect(other.joined).toEqual([]);
    expect(other.left).toEqual([]);
    expect(diffRoster(first, snapshot([], { connected: false })).memory).toBeNull();
    expect(diffRoster(first, snapshot([], { nestId: null })).memory).toBeNull();
  });

  test("while reconnecting nothing is announced and the memory stays", () => {
    const first = diffRoster(null, snapshot([me, person("a")])).memory;
    const during = diffRoster(first, snapshot([me], { reconnecting: true }));
    expect(during.left).toEqual([]);
    expect(during.memory).toBe(first);
    const after = diffRoster(during.memory, snapshot([me, person("a")]));
    expect(after.joined).toEqual([]);
    expect(after.left).toEqual([]);
  });
});
