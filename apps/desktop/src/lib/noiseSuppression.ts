import type { NoiseSuppressionDepth, NoiseSuppressionMode, NoiseSuppressionRuntime } from "@/lib/audio";

/** The modes the interface offers, quietest to strongest. */
export const NOISE_SUPPRESSION_MODES: NoiseSuppressionMode[] = ["off", "standard", "strong", "studio"];

export const NOISE_SUPPRESSION_LABEL: Record<NoiseSuppressionMode, string> = {
  off: "Off",
  standard: "Standard",
  strong: "Strong",
  studio: "Studio",
};

/** The depths the interface offers, gentlest to deepest. */
export const NOISE_SUPPRESSION_DEPTHS: NoiseSuppressionDepth[] = ["gentle", "balanced", "full"];

export const NOISE_SUPPRESSION_DEPTH_LABEL: Record<NoiseSuppressionDepth, string> = {
  gentle: "A little",
  balanced: "Balanced",
  full: "As much as possible",
};

export const NOISE_SUPPRESSION_DEPTH_CAPTION: Partial<Record<NoiseSuppressionDepth, string>> = {
  full: "Silence between words may sound unnatural.",
};

const NOISE_SUPPRESSION_CAPTION: Record<NoiseSuppressionMode, string> = {
  off: "Your microphone as it is.",
  standard: "Steady noise like fans and hum.",
  strong: "Also keyboards, clicks and room noise.",
  studio: "Removes the most noise. Adds a slight delay and uses more of your computer.",
};

/**
 * Said once, as a toast, when Studio hands over to Strong in the middle of a call. While
 * the microphone is live it adds that people still hear you, so nobody wonders whether
 * they went silent; while muted that would not be true, so it says nothing more.
 */
export function studioTooSlowNotice(muted: boolean): { title: string; description?: string } {
  return {
    title: "Studio was too heavy for this computer, so Strong is on for this call.",
    description: muted ? undefined : "People can still hear you.",
  };
}

/**
 * What the chosen mode does, or, when the engine runs something else, what it runs
 * instead. The choice is the user's; the runtime is what is live.
 */
export function noiseSuppressionCaption(chosen: NoiseSuppressionMode, runtime?: NoiseSuppressionRuntime | null): string {
  if (runtime && runtime.active !== chosen) {
    const label = NOISE_SUPPRESSION_LABEL[chosen];
    const instead = NOISE_SUPPRESSION_LABEL[runtime.active];
    switch (runtime.fallback) {
      case "starting":
        return `Starting ${label}…`;
      case "tooSlow":
        return `${label} was too heavy for this computer, so ${instead} is on for this call.`;
      case "failedToStart":
        return `${label} couldn’t start, so ${instead} is on.`;
      default:
        return `${label} isn’t available in this build.`;
    }
  }
  return NOISE_SUPPRESSION_CAPTION[chosen];
}

/**
 * Whether Studio has just handed over to Strong because this computer couldn't keep up.
 * The engine reports it once per capture, so a call shows the notice at most once.
 */
export function studioJustFellBack(
  previous: NoiseSuppressionRuntime | null | undefined,
  current: NoiseSuppressionRuntime | null | undefined,
): boolean {
  return current?.fallback === "tooSlow" && previous?.fallback !== "tooSlow";
}
