import { describe, expect, test } from "bun:test";
import { noiseSuppressionCaption, studioJustFellBack, studioTooSlowNotice } from "./noiseSuppression";

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
      "Studio isn’t available in this build.",
    );
    expect(noiseSuppressionCaption("studio", { active: "strong", fallback: "failedToStart" })).toBe(
      "Studio couldn’t start, so Strong is on.",
    );
    expect(noiseSuppressionCaption("studio", { active: "strong", fallback: "tooSlow" })).toBe(
      "Studio was too heavy for this computer, so Strong is on for this call.",
    );
  });

  test("says Studio is starting while the previous mode still runs", () => {
    expect(noiseSuppressionCaption("studio", { active: "standard", fallback: "starting" })).toBe("Starting Studio…");
  });

  test("describes Studio honestly, cost included, once it runs", () => {
    expect(noiseSuppressionCaption("studio", { active: "studio", fallback: null })).toBe(
      "Removes the most noise. Adds a slight delay and uses more of your computer.",
    );
  });
});

describe("Studio fallback notice", () => {
  test("says people still hear you only while the microphone is live", () => {
    expect(studioTooSlowNotice(false).description).toBe("People can still hear you.");
    expect(studioTooSlowNotice(true).description).toBeUndefined();
  });

  test("fires on the change to too slow, not while it stays there or for other states", () => {
    const studio = { active: "studio", fallback: null } as const;
    const tooSlow = { active: "strong", fallback: "tooSlow" } as const;
    expect(studioJustFellBack(studio, tooSlow)).toBe(true);
    expect(studioJustFellBack(null, tooSlow)).toBe(true);
    expect(studioJustFellBack(tooSlow, tooSlow)).toBe(false);
    expect(studioJustFellBack(studio, { active: "strong", fallback: "starting" })).toBe(false);
    expect(studioJustFellBack(studio, { active: "strong", fallback: "failedToStart" })).toBe(false);
  });
});
