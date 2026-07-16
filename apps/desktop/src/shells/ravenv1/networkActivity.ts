import { audioCommands } from "@/lib/audio";
import { videoCommands } from "@/lib/video";

export type NetworkActivityDirection = "incoming" | "outgoing";
export type NetworkActivityCategory = "audio" | "video" | "screenShare" | "other" | "total";
export type MeasuredNetworkCategory = Exclude<NetworkActivityCategory, "total">;

export interface NetworkActivitySettings {
  enabled: boolean;
  directions: NetworkActivityDirection[];
  categories: NetworkActivityCategory[];
}

export interface NetworkTransferRate {
  incoming: number;
  outgoing: number;
}

export interface NetworkActivitySnapshot extends NetworkActivitySettings {
  rates: Record<MeasuredNetworkCategory | "total", NetworkTransferRate>;
  active: boolean;
  updatedAt: number | null;
}

export type NetworkCounters = Record<MeasuredNetworkCategory, NetworkTransferRate>;

export interface NetworkSample {
  counters: NetworkCounters;
}

export interface NetworkSamplingPlan {
  audio: boolean;
  video: boolean;
  screenShare: boolean;
}

export function createZeroNetworkCounters(): NetworkCounters {
  return {
    audio: { incoming: 0, outgoing: 0 },
    video: { incoming: 0, outgoing: 0 },
    screenShare: { incoming: 0, outgoing: 0 },
    other: { incoming: 0, outgoing: 0 },
  };
}

export function createZeroNetworkRates(): Record<MeasuredNetworkCategory | "total", NetworkTransferRate> {
  return {
    ...createZeroNetworkCounters(),
    total: { incoming: 0, outgoing: 0 },
  };
}

export function createNetworkSamplingPlan(settings: NetworkActivitySettings): NetworkSamplingPlan {
  const total = settings.categories.includes("total");
  const audio = total || settings.categories.includes("audio");
  const video = total || settings.categories.includes("video");
  const screenShare = total || settings.categories.includes("screenShare");
  const incoming = settings.directions.includes("incoming");
  const outgoing = settings.directions.includes("outgoing");
  return {
    audio: audio && (incoming || outgoing),
    // Rust owns both directions, so one cumulative counter snapshot covers
    // received and published video without browser RTC statistics polling.
    video,
    screenShare,
  };
}

/**
 * Collect cumulative counters from the native media owners. Keeping RTC statistics
 * collection in Rust avoids browser-side RTCStatsReport allocation churn.
 */
export async function collectNetworkSample(
  settings: NetworkActivitySettings,
): Promise<NetworkSample> {
  const plan = createNetworkSamplingPlan(settings);
  const counters = createZeroNetworkCounters();

  const [audioTotals, videoTotals] = await Promise.all([
    plan.audio ? audioCommands.getNetworkTotals() : Promise.resolve(null),
    plan.video || plan.screenShare ? videoCommands.getNetworkTotals() : Promise.resolve(null),
  ]);
  if (audioTotals) {
    counters.audio.incoming = audioTotals.receivedBytes;
    counters.audio.outgoing = audioTotals.sentBytes;
  }
  if (videoTotals) {
    if (plan.video) {
      counters.video.incoming = videoTotals.cameraReceivedBytes;
      counters.video.outgoing = videoTotals.cameraSentBytes;
    }
    if (plan.screenShare) {
      counters.screenShare.incoming = videoTotals.screenShareReceivedBytes;
      counters.screenShare.outgoing = videoTotals.screenShareSentBytes;
    }
  }
  return { counters };
}

export function ratesFromNetworkSamples(
  previous: NetworkSample,
  next: NetworkSample,
  elapsedSeconds: number,
): Record<MeasuredNetworkCategory | "total", NetworkTransferRate> {
  const rates = createZeroNetworkRates();
  const seconds = Math.max(elapsedSeconds, 0.001);
  (["audio", "video", "screenShare"] as MeasuredNetworkCategory[]).forEach((category) => {
    rates[category] = {
      incoming: (counterDelta(previous.counters[category].incoming, next.counters[category].incoming) * 8) / seconds,
      outgoing: (counterDelta(previous.counters[category].outgoing, next.counters[category].outgoing) * 8) / seconds,
    };
  });
  (["audio", "video", "screenShare"] as MeasuredNetworkCategory[]).forEach((category) => {
    rates.total.incoming += rates[category].incoming;
    rates.total.outgoing += rates[category].outgoing;
  });
  return rates;
}

function counterDelta(previous: number, next: number) {
  return Math.max(next - previous, 0);
}
