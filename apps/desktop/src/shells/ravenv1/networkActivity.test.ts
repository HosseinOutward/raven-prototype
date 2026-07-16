import { describe, expect, test } from "bun:test";
import {
  createNetworkSamplingPlan,
  createZeroNetworkCounters,
  ratesFromNetworkSamples,
  type NetworkActivitySettings,
  type NetworkSample,
} from "./networkActivity";

const settings = (
  categories: NetworkActivitySettings["categories"],
  directions: NetworkActivitySettings["directions"] = ["incoming", "outgoing"],
): NetworkActivitySettings => ({ enabled: true, categories, directions });

const sample = (): NetworkSample => ({
  counters: createZeroNetworkCounters(),
});

describe("network activity sampling", () => {
  test("audio-only measurement does not query native video statistics", () => {
    expect(createNetworkSamplingPlan(settings(["audio"]))).toEqual({
      audio: true,
      video: false,
      screenShare: false,
    });
  });

  test("incoming video is measured by the native video owner", () => {
    expect(createNetworkSamplingPlan(settings(["video"], ["incoming"]))).toEqual({
      audio: false,
      video: true,
      screenShare: false,
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
});
