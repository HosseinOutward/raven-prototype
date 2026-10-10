import { audioCommands } from "@/lib/audio";
import { type VideoQualityReport, videoCommands } from "@/lib/video";

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
  screenShareQuality: VideoQualityReport | null;
}

export type NetworkCounters = Record<MeasuredNetworkCategory, NetworkTransferRate>;

export interface NetworkSample {
  counters: NetworkCounters;
  screenShareQuality: VideoQualityReport | null;
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

  const [audioTotals, videoTotals, screenShareQuality] = await Promise.all([
    plan.audio ? audioCommands.getNetworkTotals() : Promise.resolve(null),
    plan.video || plan.screenShare ? videoCommands.getNetworkTotals() : Promise.resolve(null),
    plan.screenShare ? videoCommands.getQualityReport() : Promise.resolve(null),
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
  return { counters, screenShareQuality };
}

export function screenShareQualityNotice(report: VideoQualityReport | null): string | null {
  const transmit = report?.screenShareTransmit;
  if (!transmit) return null;
  const outbound = transmit.outbound;
  if (!outbound || outbound.width === 0 || outbound.height === 0 || outbound.fps <= 0) {
    return "Screen share is starting; encoder measurements are not available yet.";
  }
  const configured = `${transmit.configured.width}×${transmit.configured.height} @ ${Math.round(transmit.configured.fps)} FPS · max ${formatBitrate(transmit.maxBitrateBps)}`;
  const actual = `${outbound.width}×${outbound.height} @ ${Math.round(outbound.fps)} FPS`;
  const limited = outbound.width < transmit.configured.width
    || outbound.height < transmit.configured.height
    || outbound.fps + 0.5 < transmit.configured.fps
    || (outbound.limitation && outbound.limitation !== "none");
  const feedback = [
    transmit.remoteLossFraction != null ? `remote loss ${(transmit.remoteLossFraction * 100).toFixed(1)}%` : null,
    transmit.roundTripTimeMs != null ? `RTT ${Math.round(transmit.roundTripTimeMs)} ms` : null,
  ].filter(Boolean).join(" · ");
  const suffix = feedback ? ` ${feedback}.` : "";
  if (limited) return `Sharing ${actual}; requested ${configured}. Encoder limit: ${outbound.limitation || "unknown"}.${suffix}`;
  return `Sharing ${actual}; requested ${configured}.${suffix}`;
}

function formatBitrate(bitsPerSecond: number) {
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bitsPerSecond / 1_000)} Kbps`;
}

export function receivedScreenShareQualityNotice(report: VideoQualityReport | null): string | null {
  const receive = report?.screenShareReceive;
  const inbound = receive?.inbound;
  if (!inbound || inbound.width === 0 || inbound.height === 0 || inbound.fps <= 0) return null;
  const loss = receive.lossFraction == null ? "" : ` · packet loss ${(receive.lossFraction * 100).toFixed(1)}%`;
  return `Receiving ${inbound.width}×${inbound.height} @ ${Math.round(inbound.fps)} FPS${loss}.`;
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
