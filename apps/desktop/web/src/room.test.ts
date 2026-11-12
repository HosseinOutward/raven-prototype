import { beforeAll, describe, expect, test } from "bun:test";
import { Track } from "livekit-client";

// The API client reads localStorage as it loads, so the stand-in comes first.
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } });

let micTrackName: typeof import("./room").micTrackName;
let wantsTrack: typeof import("./room").wantsTrack;

beforeAll(async () => {
  ({ micTrackName, wantsTrack } = await import("./room"));
});

const ME = "0123456789abcdef0123456789abcdef";
const SAM = "fedcba9876543210fedcba9876543210";
const VOICE = "raven-audio-33333333-3333-4333-8333-333333333333";

describe("the phone's tracks", () => {
  test("the mic is named the way desktop's audio engine plays", () => {
    expect(micTrackName()).toMatch(/^raven-audio-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("hears other people's Raven audio only", () => {
    expect(wantsTrack(ME, `${SAM}#audio`, VOICE, Track.Kind.Audio, Track.Source.Microphone)).toBe(true);
    expect(wantsTrack(ME, `${SAM}#audio`, "browser-microphone", Track.Kind.Audio, Track.Source.Microphone)).toBe(false);
    expect(wantsTrack(ME, `${ME}#video`, VOICE, Track.Kind.Audio, Track.Source.Microphone)).toBe(false);
  });

  test("watches cameras and screen shares from video publishers, never its own", () => {
    expect(wantsTrack(ME, `${SAM}#video`, "camera", Track.Kind.Video, Track.Source.Camera)).toBe(true);
    expect(wantsTrack(ME, `${SAM}#video`, "screen", Track.Kind.Video, Track.Source.ScreenShare)).toBe(true);
    expect(wantsTrack(ME, SAM, "camera", Track.Kind.Video, Track.Source.Camera)).toBe(false);
    expect(wantsTrack(ME, `${ME}#video`, "camera", Track.Kind.Video, Track.Source.Camera)).toBe(false);
  });
});
