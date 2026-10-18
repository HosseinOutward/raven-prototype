import { describe, expect, test } from "bun:test";
import { noiseSuppressionCaption } from "./noiseSuppression";

describe("noise suppression caption", () => {
  test("describes the chosen mode while it is what runs", () => {
    expect(noiseSuppressionCaption("strong", null)).toBe("Also keyboards, clicks and room noise.");
    expect(noiseSuppressionCaption("strong", { active: "strong", fallback: null })).toBe(
      "Also keyboards, clicks and room noise.",
    );
  });

  test("says what is really on when the engine could not run the choice", () => {
    expect(noiseSuppressionCaption("strong", { active: "standard", fallback: "failedToStart" })).toBe(
      "Strong couldn’t start, so Standard is on.",
    );
    expect(noiseSuppressionCaption("studio", { active: "strong", fallback: "notAvailable" })).toBe(
      "Studio isn’t available, so Strong is on.",
    );
  });
});
