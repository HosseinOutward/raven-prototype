import { describe, expect, test } from "bun:test";
import type { RemoteVideoTrackState } from "@/lib/video";
import { selectPresentationStreamId } from "./useNativeMediaTiles";

const rtcTrack: RemoteVideoTrackState = {
  streamId: "remote-track",
  participantId: "person",
  displayName: "Person",
  source: "camera",
  muted: false,
  subscribed: true,
  desired: true,
  isSelf: true,
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
});
