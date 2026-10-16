import { describe, expect, test } from "bun:test";
import { formatBitrate, formatCodec, formatFps, formatLoss, formatResolution, presentationFpsCap, shownIsCappedBySetting } from "./streamStatsFormat";

describe("stream info", () => {
  test("caps follow the smoothness setting per source", () => {
    expect(presentationFpsCap("efficiency", "screenshare")).toBe(15);
    expect(presentationFpsCap("balanced", "screenshare")).toBe(30);
    expect(presentationFpsCap("quality", "screenshare")).toBe(60);
    expect(presentationFpsCap("balanced", "camera")).toBe(15);
  });

  test("numbers read plainly, and unknown values wait", () => {
    expect(formatResolution(1920, 1080)).toBe("1920×1080");
    expect(formatResolution(null, null)).toBe("…");
    expect(formatFps(29.6)).toBe("30 fps");
    expect(formatFps(null)).toBe("…");
    expect(formatBitrate(2_450_000)).toBe("2.5 Mbps");
    expect(formatBitrate(640_000)).toBe("640 kbps");
    expect(formatLoss(0)).toBe("0.0%");
    expect(formatLoss(0.0004)).toBe("<0.1%");
    expect(formatLoss(0.123)).toBe("12%");
    expect(formatCodec({ codec: "video/VP8", decoderImplementation: "libvpx" })).toBe("VP8 · libvpx");
    expect(formatCodec({ codec: null, decoderImplementation: null })).toBe("…");
  });

  test("the setting is named only when it is what holds the shown rate down", () => {
    expect(shownIsCappedBySetting({ receivedFps: 30, shownFps: 15 }, 15)).toBe(true);
    expect(shownIsCappedBySetting({ receivedFps: 30, shownFps: 29 }, 30)).toBe(false);
    expect(shownIsCappedBySetting({ receivedFps: 12, shownFps: 10 }, 15)).toBe(false);
    expect(shownIsCappedBySetting({ receivedFps: null, shownFps: null }, 15)).toBe(false);
  });
});
