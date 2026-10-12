import { describe, expect, test } from "bun:test";
import type { AudioSourceState } from "@/lib/audio";
import type { VideoSourceState } from "@/lib/video";
import {
  isConfirmedMicrophoneActive,
  isConfirmedVideoSourceActive,
  isLocalVideoChosen,
  localVideoStatus,
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

describe("what the user chose versus what is being sent", () => {
  const withRuntime = (status: string) => ({ ...camera, runtime: { ...camera.runtime, status } }) as VideoSourceState;

  test("a camera turned on outside a call is ready, not live", () => {
    // The engine keeps the source but opens no device until there is a call.
    const waiting = withRuntime("inactive");
    expect(localVideoStatus(waiting)).toBe("ready");
    expect(isLocalVideoChosen(localVideoStatus(waiting))).toBe(true);
    expect(isConfirmedVideoSourceActive(waiting)).toBe(false);
  });

  test("only a confirmed source is live", () => {
    expect(localVideoStatus(camera)).toBe("live");
    expect(localVideoStatus(withRuntime("starting"))).toBe("starting");
    expect(localVideoStatus({ ...camera, publishedTrack: null })).toBe("starting");
  });

  test("a failed or missing source reads as not chosen, so the next click starts it again", () => {
    expect(localVideoStatus(withRuntime("error"))).toBe("error");
    expect(isLocalVideoChosen("error")).toBe(false);
    expect(localVideoStatus(null)).toBe("off");
    expect(localVideoStatus({ ...camera, enabled: false })).toBe("off");
    expect(isLocalVideoChosen("off")).toBe(false);
  });
});
