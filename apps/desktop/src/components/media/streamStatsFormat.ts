import type { VideoPresentationProfile, VideoStreamStats, VideoTrackSource } from "@/lib/video";

/** The highest rate a tile is drawn at, per Settings › Video smoothness. Mirrors `limits_for` in `video/domain.rs`. */
export function presentationFpsCap(profile: VideoPresentationProfile, source: VideoTrackSource) {
  if (source === "screenshare") return profile === "efficiency" ? 15 : profile === "quality" ? 60 : 30;
  return profile === "efficiency" ? 10 : profile === "quality" ? 30 : 15;
}

export function formatFps(fps: number | null) {
  return fps === null ? "…" : `${Math.round(fps)} fps`;
}

export function formatBitrate(bps: number | null) {
  if (bps === null) return "…";
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}

export function formatResolution(width: number | null, height: number | null) {
  return width && height ? `${width}×${height}` : "…";
}

export function formatLoss(fraction: number | null) {
  if (fraction === null) return "…";
  const percent = fraction * 100;
  return `${percent > 0 && percent < 0.1 ? "<0.1" : percent.toFixed(percent >= 10 ? 0 : 1)}%`;
}

export function formatCodec(stats: Pick<VideoStreamStats, "codec" | "decoderImplementation">) {
  const codec = stats.codec?.replace(/^video\//i, "") ?? null;
  const decoder = stats.decoderImplementation?.trim() || null;
  if (codec && decoder) return `${codec} · ${decoder}`;
  return codec ?? decoder ?? "…";
}

/**
 * True when the smoothness setting, not the network or the sender, is why fewer frames
 * are shown than arrive. Allows a frame or two of measurement noise.
 */
export function shownIsCappedBySetting(stats: Pick<VideoStreamStats, "receivedFps" | "shownFps">, cap: number) {
  if (stats.receivedFps === null) return false;
  return stats.receivedFps > cap + 1.5 && (stats.shownFps === null || stats.shownFps <= cap + 1.5);
}
