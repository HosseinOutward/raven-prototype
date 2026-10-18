import type { NoiseSuppressionMode, NoiseSuppressionRuntime } from "@/lib/audio";

/** The modes the interface offers, quietest to strongest. */
export const NOISE_SUPPRESSION_MODES: NoiseSuppressionMode[] = ["off", "standard", "strong"];

export const NOISE_SUPPRESSION_LABEL: Record<NoiseSuppressionMode, string> = {
  off: "Off",
  standard: "Standard",
  strong: "Strong",
  studio: "Studio",
};

const NOISE_SUPPRESSION_CAPTION: Record<NoiseSuppressionMode, string> = {
  off: "Your microphone as it is.",
  standard: "Steady noise like fans and hum.",
  strong: "Also keyboards, clicks and room noise.",
  studio: "Not available yet.",
};

/**
 * What the chosen mode does, or, when the engine runs something else, what it runs
 * instead. The choice is the user's; the runtime is what is live.
 */
export function noiseSuppressionCaption(chosen: NoiseSuppressionMode, runtime?: NoiseSuppressionRuntime | null): string {
  if (runtime && runtime.active !== chosen) {
    const instead = NOISE_SUPPRESSION_LABEL[runtime.active];
    return runtime.fallback === "failedToStart"
      ? `${NOISE_SUPPRESSION_LABEL[chosen]} couldn’t start, so ${instead} is on.`
      : `${NOISE_SUPPRESSION_LABEL[chosen]} isn’t available, so ${instead} is on.`;
  }
  return NOISE_SUPPRESSION_CAPTION[chosen];
}
