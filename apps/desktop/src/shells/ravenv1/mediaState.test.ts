import { describe, expect, test } from "bun:test";
import type { AudioSourceState } from "@/lib/audio";
import type { VideoSourceState } from "@/lib/video";
import {
  isConfirmedMicrophoneActive,
  isConfirmedVideoSourceActive,
  microphonesToMuteBeforeJoin,
} from "./mediaState";

const microphone = {
  sourceType: "microphone",
  enabled: true,
  publishing: true,
  publishedTrack: { trackId: "track" },
  runtime: { status: "running" },
  channelStrip: { mute: { muted: false } },
} as AudioSourceState;

const camera = {
  kind: "camera",
  enabled: true,
  publishing: true,
  publishedTrack: { trackId: "track" },
  runtime: { status: "running" },
} as VideoSourceState;

describe("confirmed local media state", () => {
  test("requires microphone capture, publication, and an unmuted channel", () => {
    expect(isConfirmedMicrophoneActive(microphone)).toBe(true);
    expect(isConfirmedMicrophoneActive({ ...microphone, runtime: { ...microphone.runtime, status: "error" } })).toBe(false);
    expect(isConfirmedMicrophoneActive({ ...microphone, publishedTrack: null })).toBe(false);
    expect(isConfirmedMicrophoneActive({
      ...microphone,
      channelStrip: { ...microphone.channelStrip, mute: { ...microphone.channelStrip.mute, muted: true } },
    })).toBe(false);
  });

  test("requires video capture and publication", () => {
    expect(isConfirmedVideoSourceActive(camera)).toBe(true);
    expect(isConfirmedVideoSourceActive({ ...camera, runtime: { ...camera.runtime, status: "error" } })).toBe(false);
    expect(isConfirmedVideoSourceActive({ ...camera, publishedTrack: null })).toBe(false);
    expect(isConfirmedVideoSourceActive(null)).toBe(false);
  });

  test("includes a retained published microphone in the pre-join mute set", () => {
    expect(microphonesToMuteBeforeJoin([microphone])).toEqual([microphone]);
  });
});
