import { describe, expect, test } from "bun:test";
import type { RemoteVideoTrackState } from "@/lib/video";
import { participantVoiceFields, selectPresentationStreamId } from "./useNativeMediaTiles";

const rtcTrack: RemoteVideoTrackState = {
  streamId: "remote-track",
  participantId: "person",
  displayName: "Person",
  source: "camera",
  muted: false,
  subscribed: true,
  desired: true,
  isSelf: true,
  pausedReason: null,
};

describe("native media presentation", () => {
  test("local preview reads the native capture without receiving self RTC media", () => {
    expect(selectPresentationStreamId(true, "local", "source", undefined)).toBe("local-source");
  });

  test("RTC preview displays the server-delivered self track", () => {
    expect(selectPresentationStreamId(true, "rtc", "source", rtcTrack)).toBe("remote-track");
  });

  test("unsubscribed RTC tracks never create a presentation request", () => {
    expect(selectPresentationStreamId(false, "local", undefined, { ...rtcTrack, subscribed: false })).toBeUndefined();
  });

  test("uses one normalized activity value for every tile owned by a participant", () => {
    const activity = {
      "person": { speaking: true, intensity: 0.72, meterObserved: true },
    };

    expect(participantVoiceFields("person#video", false, activity)).toEqual({
      speaking: true,
      speakingIntensity: 0.72,
    });
  });
});
