import { describe, expect, test } from "bun:test";
import type { VideoMixerState } from "./video";
import type { VoiceOverlayParticipant } from "./voiceOverlay";

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
  cameraUserIdsForOverlay,
  shareWatchersForOverlay,
  formatHotkeyEvent,
  normalizeVoiceOverlayLocationLabel,
} = await import("./voiceOverlay");

function participant(userId: string, speaking = false): VoiceOverlayParticipant {
  return {
    userId,
    displayName: userId,
    avatarUrl: null,
    isLocal: false,
    speaking,
    speakingLevel: speaking ? 35 : 0,
    muted: false,
    deafened: false,
    away: false,
    screenSharing: false,
    watchers: [],
    cameraOn: false,
    connectionQuality: "unknown",
    joinedAt: null,
  };
}

describe("voice overlay presentation", () => {
  test("detects local and normalized remote camera publishers", () => {
    const videoMixer = {
      localSources: [
        { kind: "camera", publishing: false, publishedTrack: { trackId: "local-camera" } },
      ],
      remoteTracks: [
        { participantId: "local-user#video", source: "camera", muted: false },
        { participantId: "remote-user#video", source: "camera", muted: false },
        { participantId: "muted-user#video", source: "camera", muted: true },
        { participantId: "sharing-user#video", source: "screenshare", muted: false },
      ],
    } as unknown as VideoMixerState;

    expect(Array.from(cameraUserIdsForOverlay(videoMixer, "local-user"))).toEqual([
      "local-user",
      "remote-user",
    ]);
  });

  test("records the modifier the user actually pressed", () => {
    expect(formatHotkeyEvent({
      key: "v",
      code: "KeyV",
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      metaKey: false,
    })).toBe("Control+Shift+V");
    expect(formatHotkeyEvent({
      key: "v",
      code: "KeyV",
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      metaKey: true,
    })).toBe("Command+Shift+V");
  });

  test("normalizes Room and Nest wording for overlay sentences", () => {
    expect(normalizeVoiceOverlayLocationLabel("Room")).toBe("room");
    expect(normalizeVoiceOverlayLocationLabel(" Nest ")).toBe("nest");
    expect(normalizeVoiceOverlayLocationLabel(" ")).toBe("nest");
  });
});

describe("shareWatchersForOverlay", () => {
  test("lists others watching each share, by name, without you or the sharer", () => {
    const person = (participantId: string, displayName: string, watching: string[], isLocal = false) => ({
      participantId,
      displayName,
      isLocal,
      audioMuted: false,
      speaking: false,
      connectionQuality: "good" as const,
      watching,
    });
    const videoMixer = {
      participants: [
        person("me", "Me", ["sara"], true),
        person("omid", "Omid", ["sara", "omid"]),
        person("ali", "Ali", ["sara"]),
        person("sara", "Sara", []),
      ],
    } as unknown as VideoMixerState;
    const names: Record<string, string> = { omid: "Omid", ali: "Ali" };
    const watchers = shareWatchersForOverlay(videoMixer, (id) => names[id] ?? id);
    expect(watchers.get("sara")).toEqual(["ali", "omid"]);
    expect(watchers.has("omid")).toBe(false);
  });
});
