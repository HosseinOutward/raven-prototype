import { VIDEO_PROFILE_PRESETS, type VideoQualityProfile, type VideoQualityProfileId } from "@/lib/video";

/** Limits the Custom fields accept, in pixels and frames per second. */
export const CUSTOM_LIMITS = {
  width: { min: 2, max: 7680 },
  height: { min: 2, max: 4320 },
  fps: { min: 1, max: 120 },
} as const;

/**
 * Below this a typed width or height is probably the start of a longer number ("1" on the
 * way to "1280"), so the other side is not moved to follow it yet.
 */
const FOLLOW_FROM = 16;

export type CustomVideoDraft = {
  width: string;
  height: string;
  fps: string;
};

export type CustomField = keyof CustomVideoDraft;

/** The size of the screen or app being shared. */
export interface SourceShape {
  width: number;
  height: number;
}

export function customDraftFromProfile(profile: VideoQualityProfile): CustomVideoDraft {
  return {
    width: String(profile.width),
    height: String(profile.height),
    fps: String(Math.round(profile.fps)),
  };
}

export function profileFromSelection(
  profileId: VideoQualityProfileId,
  customDraft: CustomVideoDraft,
  fallback: VideoQualityProfile,
): VideoQualityProfile {
  if (profileId !== "custom") return VIDEO_PROFILE_PRESETS[profileId];
  const width = evenNumber(clampNumber(customDraft.width, fallback.width, CUSTOM_LIMITS.width.min, CUSTOM_LIMITS.width.max));
  const height = evenNumber(clampNumber(customDraft.height, fallback.height, CUSTOM_LIMITS.height.min, CUSTOM_LIMITS.height.max));
  const fps = clampNumber(customDraft.fps, fallback.fps, CUSTOM_LIMITS.fps.min, CUSTOM_LIMITS.fps.max);
  return {
    profileId: "custom",
    maxPixels: Math.max(4, width * height),
    width,
    height,
    fps,
  };
}

/** What a share with this pixel budget is sent at: the source's shape, scaled down to fit. */
export function outputForBudget(sourceWidth: number, sourceHeight: number, maxPixels: number) {
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;
  const pixels = Math.max(1, sourceWidth * sourceHeight);
  const scale = Math.min(1, Math.sqrt(Math.max(4, maxPixels) / pixels));
  return trimToBudget(evenNumber(Math.round(sourceWidth * scale)), evenNumber(Math.round(sourceHeight * scale)), maxPixels);
}

/** Width over height, or null when either is missing. */
export function aspectOf(width: number, height: number): number | null {
  return width > 0 && height > 0 ? width / height : null;
}

/** The shape a draft keeps: the source's when there is one, otherwise the preset's. */
export function shapeFor(preset: VideoQualityProfile, source?: SourceShape | null): number {
  return (source ? aspectOf(source.width, source.height) : null) ?? aspectOf(preset.width, preset.height) ?? 16 / 9;
}

/**
 * What the Custom fields start from when someone switches to Custom: the same size and
 * rate the preset they were on would have sent. A share with a source selected is sent
 * at the source's shape within the preset's pixel budget, so that is what is shown.
 */
export function inheritedDraft(preset: VideoQualityProfile, source?: SourceShape | null): CustomVideoDraft {
  const output = source ? outputForBudget(source.width, source.height, preset.maxPixels) : null;
  return {
    width: String(output?.width ?? preset.width),
    height: String(output?.height ?? preset.height),
    fps: String(Math.round(preset.fps)),
  };
}

/**
 * The fields for a newly chosen source: its shape, with as many pixels as the draft
 * already had (as closely as even numbers allow). The frame rate stays.
 */
export function reseededDraft(draft: CustomVideoDraft, source: SourceShape, fallback: VideoQualityProfile): CustomVideoDraft {
  const aspect = aspectOf(source.width, source.height);
  if (!aspect) return draft;
  const width = clampNumber(draft.width, fallback.width, CUSTOM_LIMITS.width.min, CUSTOM_LIMITS.width.max);
  const height = clampNumber(draft.height, fallback.height, CUSTOM_LIMITS.height.min, CUSTOM_LIMITS.height.max);
  const pixels = Math.max(4, width * height);
  const wide = evenNumber(Math.round(Math.sqrt(pixels * aspect)));
  const tall = evenNumber(Math.round(wide / aspect));
  const fitted = trimToBudget(wide, tall, pixels);
  const shaped = shapedDimensions("width", fitted.width, aspect);
  return { ...draft, width: String(shaped.width), height: String(shaped.height) };
}

/**
 * Both sides for one that was chosen, at the given shape, even and within the limits.
 * If the other side would go past its limit, both are pulled back together.
 */
export function shapedDimensions(basis: "width" | "height", value: number, aspect: number) {
  let width: number;
  let height: number;
  if (basis === "width") {
    width = evenNumber(clamp(Math.round(value), CUSTOM_LIMITS.width.min, CUSTOM_LIMITS.width.max));
    height = nearestEven(width / aspect);
  } else {
    height = evenNumber(clamp(Math.round(value), CUSTOM_LIMITS.height.min, CUSTOM_LIMITS.height.max));
    width = nearestEven(height * aspect);
  }
  if (height > CUSTOM_LIMITS.height.max) {
    height = CUSTOM_LIMITS.height.max;
    width = nearestEven(height * aspect);
  }
  if (width > CUSTOM_LIMITS.width.max) {
    width = CUSTOM_LIMITS.width.max;
    height = nearestEven(width / aspect);
  }
  return { width: Math.max(CUSTOM_LIMITS.width.min, width), height: Math.max(CUSTOM_LIMITS.height.min, height) };
}

/**
 * While a number is being typed: moves the other side to keep the shape, and leaves
 * what was typed as it is. A number that is too short to be done yet moves nothing.
 */
export function followDraft(draft: CustomVideoDraft, edited: "width" | "height", aspect: number): CustomVideoDraft {
  const typed = Number(draft[edited]);
  if (draft[edited].trim() === "" || !Number.isFinite(typed) || typed < FOLLOW_FROM) return draft;
  const shaped = shapedDimensions(edited, typed, aspect);
  return edited === "width" ? { ...draft, height: String(shaped.height) } : { ...draft, width: String(shaped.width) };
}

/**
 * When a field is done (blur or Enter): both sizes (or the rate) are made valid. An empty
 * or unreadable size is rebuilt from the other one.
 */
export function settleDraft(draft: CustomVideoDraft, field: CustomField, aspect: number, fallback: VideoQualityProfile): CustomVideoDraft {
  if (field === "fps") {
    return { ...draft, fps: String(clampNumber(draft.fps, fallback.fps, CUSTOM_LIMITS.fps.min, CUSTOM_LIMITS.fps.max)) };
  }
  const other = field === "width" ? "height" : "width";
  const typed = Number(draft[field]);
  const usable = draft[field].trim() !== "" && Number.isFinite(typed) && typed >= CUSTOM_LIMITS[field].min;
  const basis = usable ? field : other;
  const value = usable ? typed : clampNumber(draft[other], other === "width" ? fallback.width : fallback.height, 2, 100000);
  const shaped = shapedDimensions(basis, value, aspect);
  return { ...draft, width: String(shaped.width), height: String(shaped.height) };
}

function trimToBudget(width: number, height: number, maxPixels: number) {
  const budget = Math.max(4, maxPixels);
  while (width * height > budget) {
    if (width >= height && width > 2) width -= 2;
    else if (height > 2) height -= 2;
    else break;
  }
  return { width, height };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function clampNumber(value: string, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(Math.round(parsed), min, max);
}

/** The even number closest to a derived size, so 711.1 becomes 712 rather than 710. */
function nearestEven(value: number) {
  return Math.max(2, Math.round(value / 2) * 2);
}

function evenNumber(value: number) {
  return Math.max(2, value - (value % 2));
}
