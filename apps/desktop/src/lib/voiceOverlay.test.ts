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
  formatHotkeyEvent,
  normalizeVoiceOverlayLocationLabel,
  visibleHorizontalVoiceOverlayParticipants,
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
    cameraOn: false,
  };
}

describe("voice overlay presentation", () => {
  test("prioritizes current speakers before applying the five-person limit", () => {
    const people = [
      participant("one"),
      participant("two"),
      participant("three", true),
      participant("four"),
      participant("five", true),
      participant("six"),
      participant("seven"),
    ];

    const visible = visibleHorizontalVoiceOverlayParticipants(people);

    expect(visible.participants.map((person) => person.userId)).toEqual([
      "three",
      "five",
      "one",
      "two",
      "four",
    ]);
    expect(visible.hiddenCount).toBe(2);
  });

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
