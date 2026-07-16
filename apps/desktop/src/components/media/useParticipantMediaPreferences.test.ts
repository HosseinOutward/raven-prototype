import { describe, expect, test } from "bun:test";
import { preferenceForParticipant, updateParticipantPreference } from "./useParticipantMediaPreferences";

describe("participant-local media preferences", () => {
  test("uses safe per-session defaults", () => {
    expect(preferenceForParticipant({}, "person")).toMatchObject({ voiceVolume: 1, sharedAudioVolume: 1, cameraReceiving: true });
  });

  test("keeps controls isolated by participant identity", () => {
    const first = updateParticipantPreference({}, "alice", { voiceVolume: 0.35, cameraReceiving: false });
    const second = updateParticipantPreference(first, "bob", { voiceMuted: true });
    expect(preferenceForParticipant(second, "alice")).toMatchObject({ voiceVolume: 0.35, cameraReceiving: false, voiceMuted: false });
    expect(preferenceForParticipant(second, "bob")).toMatchObject({ voiceVolume: 1, cameraReceiving: true, voiceMuted: true });
  });
});
