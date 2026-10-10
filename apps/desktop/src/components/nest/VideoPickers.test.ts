import { expect, test } from "bun:test";
import { DEFAULT_VIDEO_PROFILE, VIDEO_PROFILE_PRESETS } from "@/lib/video";
import { profileFromSelection } from "./VideoPickers";

test("Presentation share profile targets readable 1080p text at 10 FPS", () => {
  expect(profileFromSelection("presentation", { width: "", height: "", fps: "" }, DEFAULT_VIDEO_PROFILE)).toEqual({
    profileId: "presentation",
    maxPixels: 1920 * 1080,
    width: 1920,
    height: 1080,
    fps: 10,
  });
});

test("every named selection ignores stale custom fields and returns its exact contract", () => {
  const staleDraft = { width: "2", height: "2", fps: "1" };
  expect(profileFromSelection("high", staleDraft, DEFAULT_VIDEO_PROFILE)).toEqual(VIDEO_PROFILE_PRESETS.high);
  expect(profileFromSelection("highMotion", staleDraft, DEFAULT_VIDEO_PROFILE)).toEqual(VIDEO_PROFILE_PRESETS.highMotion);
  expect(profileFromSelection("balanced", staleDraft, DEFAULT_VIDEO_PROFILE)).toEqual(VIDEO_PROFILE_PRESETS.balanced);
  expect(profileFromSelection("low", staleDraft, DEFAULT_VIDEO_PROFILE)).toEqual(VIDEO_PROFILE_PRESETS.low);
});

test("custom selection keeps its displayed dimensions, fps, and pixel budget in sync", () => {
  expect(profileFromSelection("custom", { width: "1281", height: "721", fps: "30" }, DEFAULT_VIDEO_PROFILE)).toEqual({
    profileId: "custom",
    maxPixels: 1280 * 720,
    width: 1280,
    height: 720,
    fps: 30,
  });
});
