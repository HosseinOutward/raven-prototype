import { describe, expect, test } from "bun:test";
import type { NestDetails, SessionSummary, User } from "./api";
import type { AudioMixerState } from "./audio";
import type { VideoMixerState } from "./video";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    length: 0,
    clear() {},
    getItem() { return null; },
    key() { return null; },
    removeItem() {},
    setItem() {},
  } satisfies Storage,
});

const {
  connectedPeerIds,
  ENTRY_CONNECT_GRACE_MS,
  ENTRY_CONNECTING_TTL_MS,
  ENTRY_HEADS_UP_MS,
  entryNoticePhase,
  isConnecting,
  knownConnectedPeerIds,
  nextEntryNoticeChange,
} = await import("./callArrivals");
const { buildVoiceOverlaySnapshot } = await import("./voiceOverlay");

const ME = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ANA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SAM = "cccccccccccccccccccccccccccccccc";
/** The audio engine reports user ids as hyphenated UUIDs. */
const SAM_AUDIO_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function session(...userIds: string[]): SessionSummary {
  return {
    id: "session-1",
    nestId: "nest-1",
    startedAt: "2026-10-25T10:00:00Z",
    status: "active",
    participants: userIds.map((userId) => ({ userId, username: userId, displayName: userId.slice(0, 3) })),
  } as unknown as SessionSummary;
}

function audio(...participantIds: string[]): AudioMixerState {
  return {
    remoteParticipants: participantIds.map((participantId) => ({ participantId, displayName: "Sam", tracks: [] })),
    remoteTracks: [],
    localSources: [],
  } as unknown as AudioMixerState;
}

/** What the video viewer sees: everyone LiveKit lists, and the video tracks published. */
function video(participantIds: string[], tracks: Array<{ participantId: string; source: "camera" | "screenshare" }> = []): VideoMixerState {
  return {
    participants: participantIds.map((participantId) => ({
      participantId,
      displayName: participantId,
      isLocal: participantId === ME,
      audioMuted: true,
      speaking: false,
      connectionQuality: "unknown",
    })),
    remoteTracks: tracks.map((track) => ({ ...track, displayName: "Sam", muted: false, subscribed: true, desired: true })),
    localSources: [],
  } as unknown as VideoMixerState;
}

describe("who is connected", () => {
  test("someone LiveKit lists but who sends nothing and is not in the session is not connected", () => {
    const connected = connectedPeerIds({ session: session(ME, ANA), audioState: audio(), videoState: video([ME, ANA, SAM]) });

    expect([...connected].sort()).toEqual([ME, ANA].sort());
  });

  test("the session listing them is enough", () => {
    expect(connectedPeerIds({ session: session(SAM), audioState: null, videoState: null }).has(SAM)).toBe(true);
  });

  test("a track of theirs arriving is enough, before the session refresh", () => {
    expect(connectedPeerIds({ session: session(ME), audioState: audio(`${SAM_AUDIO_ID}`), videoState: null }).has(SAM)).toBe(true);
    expect(
      connectedPeerIds({ session: session(ME), audioState: null, videoState: video([SAM], [{ participantId: `${SAM}#video`, source: "camera" }]) }).has(SAM),
    ).toBe(true);
  });

  test("nobody is marked connecting before the session was fetched once", () => {
    expect(knownConnectedPeerIds({ session: undefined, audioState: audio(), videoState: video([SAM]) })).toBeNull();
    expect(isConnecting(SAM, false, null)).toBe(false);
    // "No session" is an answer, not a gap.
    expect(knownConnectedPeerIds({ session: null, audioState: null, videoState: null })).toEqual(new Set());
  });

  test("you are never connecting to yourself", () => {
    expect(isConnecting(ME, true, new Set())).toBe(false);
    expect(isConnecting(SAM, false, new Set())).toBe(true);
    expect(isConnecting(`${SAM}#audio`, false, new Set([SAM]))).toBe(false);
  });
});

describe("the room view and the overlay agree on a slow joiner", () => {
  const user = { id: ME, username: "me", displayName: "Me" } as unknown as User;
  const details = { nest: { id: "nest-1", name: "Standup" } } as unknown as NestDetails;
  function overlayIds(input: { session: SessionSummary; audioState: AudioMixerState; videoState: VideoMixerState }) {
    return buildVoiceOverlaySnapshot({
      user,
      details,
      activeSession: input.session,
      connected: true,
      mixerState: input.audioState,
      videoMixer: input.videoState,
      speakingActivity: {},
      screenSharingUserIds: [],
      locationLabel: "Nest",
    }).participants.map((participant) => participant.userId).sort();
  }
  function roomIds(input: { session: SessionSummary; audioState: AudioMixerState; videoState: VideoMixerState }) {
    const connected = knownConnectedPeerIds(input);
    return input.videoState.participants
      .filter((participant) => !isConnecting(participant.participantId, participant.isLocal, connected))
      .map((participant) => participant.participantId)
      .sort();
  }

  test("while Sam's media is still connecting, neither counts him", () => {
    const state = { session: session(ME, ANA), audioState: audio(), videoState: video([ME, ANA, SAM]) };

    expect(roomIds(state)).toEqual([ME, ANA].sort());
    expect(overlayIds(state)).toEqual([ME, ANA].sort());
  });

  test("the moment his microphone arrives, both do", () => {
    const state = { session: session(ME, ANA), audioState: audio(SAM_AUDIO_ID), videoState: video([ME, ANA, SAM]) };

    expect(roomIds(state)).toEqual([ME, ANA, SAM].sort());
    expect(overlayIds(state)).toEqual(roomIds(state));
  });

  test("a joiner without a microphone arrives with the session", () => {
    const state = { session: session(ME, ANA, SAM), audioState: audio(), videoState: video([ME, ANA, SAM]) };

    expect(roomIds(state)).toEqual([ME, ANA, SAM].sort());
    expect(overlayIds(state)).toEqual(roomIds(state));
  });
});

describe("the join toast", () => {
  const notice = { actorId: SAM, receivedAt: 10_000 };
  const connectingAt = notice.receivedAt + ENTRY_HEADS_UP_MS + ENTRY_CONNECT_GRACE_MS;

  test("says they are about to join during the heads-up", () => {
    expect(entryNoticePhase(notice, notice.receivedAt, new Set())).toBe("announced");
    expect(entryNoticePhase(notice, connectingAt - 1, new Set())).toBe("announced");
  });

  test("a session row left from an earlier visit does not swallow the heads-up", () => {
    expect(entryNoticePhase(notice, notice.receivedAt + 500, new Set([SAM]))).toBe("announced");
  });

  test("says they are connecting once the heads-up is over and they are not here yet", () => {
    expect(entryNoticePhase(notice, connectingAt, new Set())).toBe("connecting");
    expect(entryNoticePhase(notice, notice.receivedAt + 20_000, new Set([ANA]))).toBe("connecting");
  });

  test("goes away when they arrive", () => {
    expect(entryNoticePhase(notice, connectingAt, new Set([SAM]))).toBeNull();
    expect(entryNoticePhase(notice, notice.receivedAt + 20_000, new Set([SAM]))).toBeNull();
  });

  test("gives up on its own if nothing more is heard", () => {
    expect(entryNoticePhase(notice, notice.receivedAt + ENTRY_CONNECTING_TTL_MS, new Set())).toBeNull();
  });

  test("knows when it next has to change by itself", () => {
    expect(nextEntryNoticeChange([notice], notice.receivedAt)).toBe(ENTRY_HEADS_UP_MS + ENTRY_CONNECT_GRACE_MS);
    expect(nextEntryNoticeChange([notice], connectingAt)).toBe(ENTRY_CONNECTING_TTL_MS - ENTRY_HEADS_UP_MS - ENTRY_CONNECT_GRACE_MS);
    expect(nextEntryNoticeChange([notice], notice.receivedAt + ENTRY_CONNECTING_TTL_MS)).toBeNull();
    expect(nextEntryNoticeChange([], 0)).toBeNull();
  });
});
