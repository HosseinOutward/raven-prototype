import { expect, test } from "bun:test";
import { DEFAULT_VIDEO_PROFILE, VIDEO_PROFILE_PRESETS } from "@/lib/video";
import { profileFromSelection } from "./customQuality";

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

import {
  followDraft,
  inheritedDraft,
  outputForBudget,
  reseededDraft,
  settleDraft,
  shapeFor,
  shapedDimensions,
} from "./customQuality";

const SIXTEEN_NINE = 16 / 9;

test("custom starts from what the preset would send for the chosen source", () => {
  // A 1920×1080 screen on High quality goes out at 1920×1080, 30 fps.
  expect(inheritedDraft(VIDEO_PROFILE_PRESETS.high, { width: 1920, height: 1080 })).toEqual({ width: "1920", height: "1080", fps: "30" });
  // A 4:3 window on Balanced keeps its shape inside the 1280×720 budget, as the summary says.
  const out = outputForBudget(1600, 1200, VIDEO_PROFILE_PRESETS.balanced.maxPixels)!;
  expect(inheritedDraft(VIDEO_PROFILE_PRESETS.balanced, { width: 1600, height: 1200 })).toEqual({
    width: String(out.width),
    height: String(out.height),
    fps: "30",
  });
  expect(out.width * out.height).toBeLessThanOrEqual(1280 * 720);
});

test("a share smaller than the budget is not scaled up", () => {
  expect(inheritedDraft(VIDEO_PROFILE_PRESETS.high, { width: 800, height: 600 })).toEqual({ width: "800", height: "600", fps: "30" });
});

test("without a source, or for the camera, custom starts from the preset itself", () => {
  expect(inheritedDraft(VIDEO_PROFILE_PRESETS.highMotion)).toEqual({ width: "1280", height: "720", fps: "60" });
  expect(inheritedDraft(VIDEO_PROFILE_PRESETS.low, null)).toEqual({ width: "854", height: "480", fps: "15" });
});

test("the shape comes from the source, then the preset", () => {
  expect(shapeFor(VIDEO_PROFILE_PRESETS.balanced, { width: 1000, height: 1000 })).toBe(1);
  expect(shapeFor(VIDEO_PROFILE_PRESETS.balanced, { width: 0, height: 0 })).toBeCloseTo(SIXTEEN_NINE);
  expect(shapeFor(VIDEO_PROFILE_PRESETS.balanced)).toBeCloseTo(SIXTEEN_NINE);
});

test("editing the width brings the height at the same shape, in even numbers", () => {
  expect(shapedDimensions("width", 1920, SIXTEEN_NINE)).toEqual({ width: 1920, height: 1080 });
  expect(shapedDimensions("width", 1281, SIXTEEN_NINE)).toEqual({ width: 1280, height: 720 });
  expect(shapedDimensions("height", 540, SIXTEEN_NINE)).toEqual({ width: 960, height: 540 });
  const portrait = shapedDimensions("height", 1920, 9 / 16);
  expect(portrait).toEqual({ width: 1080, height: 1920 });
});

test("shaping stays within the limits and pulls both sides back together", () => {
  expect(shapedDimensions("width", 99999, SIXTEEN_NINE)).toEqual({ width: 7680, height: 4320 });
  // Ultra-wide: the width limit hits first.
  const wide = shapedDimensions("height", 4320, 32 / 9);
  expect(wide.width).toBeLessThanOrEqual(7680);
  expect(wide.width / wide.height).toBeCloseTo(32 / 9, 1);
  const tiny = shapedDimensions("width", 1, SIXTEEN_NINE);
  expect(tiny.width).toBeGreaterThanOrEqual(2);
  expect(tiny.height).toBeGreaterThanOrEqual(2);
});

test("typing '1' on the way to '1280' does not move the height", () => {
  const draft = { width: "1", height: "720", fps: "30" };
  expect(followDraft(draft, "width", SIXTEEN_NINE)).toEqual(draft);
  expect(followDraft({ ...draft, width: "12" }, "width", SIXTEEN_NINE)).toEqual({ ...draft, width: "12" });
  expect(followDraft({ ...draft, width: "" }, "width", SIXTEEN_NINE)).toEqual({ ...draft, width: "" });
  expect(followDraft({ ...draft, width: "1280" }, "width", SIXTEEN_NINE)).toEqual({ width: "1280", height: "720", fps: "30" });
});

test("while typing, what was typed is left alone and only the other side follows", () => {
  const next = followDraft({ width: "1281", height: "720", fps: "30" }, "width", SIXTEEN_NINE);
  expect(next.width).toBe("1281");
  expect(next.height).toBe("720");
  expect(followDraft({ width: "1280", height: "400", fps: "30" }, "height", SIXTEEN_NINE)).toEqual({ width: "712", height: "400", fps: "30" });
});

test("settling a field makes both sizes valid at the kept shape", () => {
  expect(settleDraft({ width: "1281", height: "720", fps: "30" }, "width", SIXTEEN_NINE, DEFAULT_VIDEO_PROFILE)).toEqual({ width: "1280", height: "720", fps: "30" });
  expect(settleDraft({ width: "99999", height: "720", fps: "30" }, "width", SIXTEEN_NINE, DEFAULT_VIDEO_PROFILE)).toEqual({ width: "7680", height: "4320", fps: "30" });
});

test("settling an emptied size rebuilds it from the other one", () => {
  expect(settleDraft({ width: "", height: "540", fps: "30" }, "width", SIXTEEN_NINE, DEFAULT_VIDEO_PROFILE)).toEqual({ width: "960", height: "540", fps: "30" });
});

test("the frame rate is independent and only clamped", () => {
  expect(settleDraft({ width: "1280", height: "720", fps: "500" }, "fps", SIXTEEN_NINE, DEFAULT_VIDEO_PROFILE)).toEqual({ width: "1280", height: "720", fps: "120" });
  expect(followDraft({ width: "1280", height: "720", fps: "60" }, "width", SIXTEEN_NINE).fps).toBe("60");
});

test("a new source keeps the pixel count and takes the source's shape", () => {
  const draft = { width: "1920", height: "1080", fps: "45" };
  const next = reseededDraft(draft, { width: 1000, height: 1000 }, DEFAULT_VIDEO_PROFILE);
  const pixels = Number(next.width) * Number(next.height);
  expect(next.width).toBe(next.height);
  expect(pixels).toBeLessThanOrEqual(1920 * 1080);
  expect(pixels).toBeGreaterThan(1920 * 1080 * 0.99);
  expect(next.fps).toBe("45");
});

test("an unknown source shape leaves the draft as it is", () => {
  const draft = { width: "1280", height: "720", fps: "30" };
  expect(reseededDraft(draft, { width: 0, height: 0 }, DEFAULT_VIDEO_PROFILE)).toEqual(draft);
});
