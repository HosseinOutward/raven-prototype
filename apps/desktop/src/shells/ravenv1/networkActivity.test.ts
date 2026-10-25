import { describe, expect, test } from "bun:test";
import type { VideoOutboundQuality, VideoQualityReport } from "@/lib/video";
import {
  codecImplementationNotice,
  connectionNeedsAttention,
  connectionText,
  createNetworkSamplingPlan,
  createZeroNetworkCounters,
  DEFAULT_NETWORK_ACTIVITY_SETTINGS,
  formatRoundTrip,
  networkReadoutActive,
  normalizeNetworkActivitySettings,
  ratesFromNetworkSamples,
  receivedScreenShareQualityNotice,
  screenShareCaptureFps,
  screenShareQualityNotice,
  type NetworkActivitySettings,
  type NetworkSample,
} from "./networkActivity";

const settings = (
  categories: NetworkActivitySettings["categories"],
  directions: NetworkActivitySettings["directions"] = ["incoming", "outgoing"],
): NetworkActivitySettings => ({ enabled: true, categories, directions });

const outbound = (
  fields: Pick<VideoOutboundQuality, "width" | "height" | "fps" | "targetBitrateBps" | "limitation">,
): VideoOutboundQuality => ({
  encoderImplementation: "libvpx",
  powerEfficientEncoder: false,
  sourceFrames: 0,
  framesEncoded: 0,
  framesSent: 0,
  totalEncodeTimeSeconds: 0,
  ...fields,
});

const sample = (): NetworkSample => ({
  counters: createZeroNetworkCounters(),
  screenShareQuality: null,
  connection: null,
});

describe("network activity sampling", () => {
  test("audio-only measurement does not query native video statistics", () => {
    expect(createNetworkSamplingPlan(settings(["audio"]))).toEqual({
      audio: true,
      video: false,
      screenShare: false,
      connection: false,
    });
  });

  test("incoming video is measured by the native video owner", () => {
    expect(createNetworkSamplingPlan(settings(["video"], ["incoming"]))).toEqual({
      audio: false,
      video: true,
      screenShare: false,
      connection: false,
    });
  });

  test("calculates rates from native cumulative counters in both directions", () => {
    const previous = sample();
    previous.counters.audio.incoming = 1000;
    previous.counters.audio.outgoing = 2000;
    previous.counters.video.outgoing = 3000;

    const next = sample();
    next.counters.audio.incoming = 3000;
    next.counters.audio.outgoing = 5000;
    next.counters.video.incoming = 12_500;
    next.counters.video.outgoing = 7000;

    const rates = ratesFromNetworkSamples(previous, next, 2);
    expect(rates.audio).toEqual({ incoming: 8000, outgoing: 12_000 });
    expect(rates.video).toEqual({ incoming: 50_000, outgoing: 16_000 });
    expect(rates.total).toEqual({ incoming: 58_000, outgoing: 28_000 });
  });

  test("treats a reset cumulative counter as zero traffic instead of a negative rate", () => {
    const previous = sample();
    previous.counters.audio.outgoing = 10_000;
    const next = sample();
    next.counters.audio.outgoing = 100;
    expect(ratesFromNetworkSamples(previous, next, 2).audio.outgoing).toBe(0);
  });

  test("explains when the screen-share encoder is below the requested profile", () => {
    expect(screenShareQualityNotice({
      screenShareTransmit: {
        configured: { width: 1920, height: 1080, fps: 10 },
        maxBitrateBps: 4_000_000,
        outbound: outbound({ width: 1280, height: 720, fps: 8, targetBitrateBps: 1_200_000, limitation: "bandwidth" }),
        remoteLossFraction: 0.02,
        roundTripTimeMs: 95,
        capture: null,
      },
      screenShareReceive: null,
    })).toBe("Sharing 1280×720 @ 8 FPS; requested 1920×1080 @ 10 FPS · max 4.0 Mbps. Encoder limit: bandwidth. remote loss 2.0% · RTT 95 ms. Encoder: libvpx (software).");
  });

  test("blames a still screen only when the capture itself delivered fewer frames", () => {
    const report = (fps: number): VideoQualityReport => ({
      screenShareTransmit: {
        configured: { width: 1920, height: 1080, fps: 30 },
        maxBitrateBps: 6_000_000,
        outbound: outbound({ width: 1920, height: 1080, fps, targetBitrateBps: 6_000_000, limitation: "none" }),
        remoteLossFraction: null,
        roundTripTimeMs: null,
        capture: null,
      },
      screenShareReceive: null,
    });
    expect(screenShareQualityNotice(report(4), 4)).toBe("Sharing 1920×1080 @ 4 FPS; requested 1920×1080 @ 30 FPS · max 6.0 Mbps. Fewer frames are sent while the screen is still. Encoder: libvpx (software).");
    expect(screenShareQualityNotice(report(27), 58)).toBe("Sharing 1920×1080 @ 27 FPS; requested 1920×1080 @ 30 FPS · max 6.0 Mbps. The encoder skipped some frames. Encoder: libvpx (software).");
    expect(screenShareQualityNotice(report(27), null)).toBe("Sharing 1920×1080 @ 27 FPS; requested 1920×1080 @ 30 FPS · max 6.0 Mbps. Encoder: libvpx (software).");
  });

  test("measures the capture rate between two reports and ignores a restarted capture", () => {
    const report = (captured: number): VideoQualityReport => ({
      screenShareTransmit: {
        configured: { width: 1920, height: 1080, fps: 30 },
        maxBitrateBps: 6_000_000,
        outbound: null,
        remoteLossFraction: null,
        roundTripTimeMs: null,
        capture: { captured, forwarded: 0 },
      },
      screenShareReceive: null,
    });
    expect(screenShareCaptureFps(report(100), report(220), 2)).toBe(60);
    expect(screenShareCaptureFps(report(220), report(10), 2)).toBeNull();
    expect(screenShareCaptureFps(null, report(10), 2)).toBeNull();
  });

  test("names a hardware encoder and leaves out an unreported one", () => {
    expect(codecImplementationNotice("Encoder", "NVENC", true)).toBe("Encoder: NVENC (hardware).");
    expect(codecImplementationNotice("Encoder", "", false)).toBeNull();
    expect(codecImplementationNotice("Decoder", "unknown", false)).toBeNull();
  });

  test("reports the local decode dimensions for received screen shares", () => {
    expect(receivedScreenShareQualityNotice({
      screenShareTransmit: null,
      screenShareReceive: {
        inbound: { width: 1920, height: 1080, fps: 10 },
        lossFraction: 0.005,
        decoderImplementation: "libvpx",
        powerEfficientDecoder: false,
      },
    })).toBe("Receiving 1920×1080 @ 10 FPS · packet loss 0.5%. Decoder: libvpx (software).");
  });
});

describe("connection readout", () => {
  test("is off by default: the readout is off and Connection is not among its categories", () => {
    expect(DEFAULT_NETWORK_ACTIVITY_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_NETWORK_ACTIVITY_SETTINGS.categories).not.toContain("connection");
    expect(normalizeNetworkActivitySettings(undefined).categories).not.toContain("connection");
    // Settings saved before Connection existed keep exactly what they had.
    expect(normalizeNetworkActivitySettings({ enabled: true, directions: ["incoming"], categories: ["audio", "total"] })).toEqual({
      enabled: true,
      directions: ["incoming"],
      categories: ["audio", "total"],
    });
  });

  test("keeps Connection when saved and drops unknown or retired categories", () => {
    const saved = { enabled: true, directions: ["outgoing", "sideways"], categories: ["connection", "other", "bogus", "video"] } as unknown as NetworkActivitySettings;
    expect(normalizeNetworkActivitySettings(saved)).toEqual({ enabled: true, directions: ["outgoing"], categories: ["connection", "video"] });
  });

  test("measures the connection only when it is chosen, and Total does not include it", () => {
    expect(createNetworkSamplingPlan(settings(["total"])).connection).toBe(false);
    expect(createNetworkSamplingPlan(settings(["connection"]))).toEqual({ audio: false, video: false, screenShare: false, connection: true });
    expect(createNetworkSamplingPlan(settings(["connection", "audio"]))).toEqual({ audio: true, video: false, screenShare: false, connection: true });
  });

  test("a connection-only readout needs no direction and does not sample while off or outside a call", () => {
    expect(networkReadoutActive(true, settings(["connection"], []))).toBe(true);
    expect(networkReadoutActive(true, settings(["audio"], []))).toBe(false);
    expect(networkReadoutActive(true, settings([]))).toBe(false);
    expect(networkReadoutActive(false, settings(["connection"]))).toBe(false);
    expect(networkReadoutActive(true, { ...settings(["connection"]), enabled: false })).toBe(false);
  });

  test("reads as round trip and a quality word", () => {
    expect(connectionText({ roundTripMs: 42.4, quality: "good" })).toBe("42 ms · Good");
    expect(connectionText({ roundTripMs: 0.3, quality: "excellent" })).toBe("<1 ms · Excellent");
    expect(connectionText({ roundTripMs: 180, quality: "poor" })).toBe("180 ms · Poor");
    expect(connectionText({ roundTripMs: null, quality: "lost" })).toBe("Lost");
    expect(connectionText({ roundTripMs: 55, quality: null })).toBe("55 ms");
    expect(connectionText(null)).toBe("Measuring…");
    expect(formatRoundTrip(Number.NaN)).toBe("");
    expect(formatRoundTrip(-3)).toBe("");
  });

  test("only a poor or lost link asks for attention", () => {
    expect(connectionNeedsAttention({ roundTripMs: 40, quality: "good" })).toBe(false);
    expect(connectionNeedsAttention({ roundTripMs: 400, quality: "poor" })).toBe(true);
    expect(connectionNeedsAttention({ roundTripMs: null, quality: "lost" })).toBe(true);
    expect(connectionNeedsAttention(null)).toBe(false);
  });
});
