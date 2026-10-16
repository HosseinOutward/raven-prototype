import { useEffect, useState } from "react";
import { type VideoPresentationProfile, type VideoStreamStats, type VideoTrackSource, videoCommands } from "@/lib/video";
import {
  formatBitrate,
  formatCodec,
  formatFps,
  formatLoss,
  formatResolution,
  presentationFpsCap,
  shownIsCappedBySetting,
} from "./streamStatsFormat";

const POLL_MS = 1500;

/**
 * Live specs of one received stream, shown on request from a tile's menu. It polls only
 * while mounted, which is only while the popover is open.
 */
export function StreamInfo({
  streamId,
  source,
  presentationProfile,
}: {
  streamId: string;
  source: VideoTrackSource;
  presentationProfile: VideoPresentationProfile;
}) {
  const [stats, setStats] = useState<VideoStreamStats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const [next] = await videoCommands.getStreamStats([streamId]);
        if (cancelled) return;
        setStats(next ?? null);
        setFailed(false);
      } catch {
        if (!cancelled) setFailed(true);
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [streamId]);

  const cap = presentationFpsCap(presentationProfile, source);

  return (
    <div className="space-y-2.5">
      <div className="text-small font-medium">Stream info</div>
      {failed && !stats ? (
        <p className="text-caption text-muted-foreground" role="status">Couldn’t read this stream’s numbers. They’ll appear when it’s receiving.</p>
      ) : !stats ? (
        <p className="text-caption text-muted-foreground" role="status">Measuring…</p>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-caption">
            <Row label="Resolution" value={formatResolution(stats.width, stats.height)} />
            <Row label="Arriving" value={formatFps(stats.receivedFps)} />
            <Row label="Shown" value={formatFps(stats.shownFps)} />
            <Row label="Bitrate" value={formatBitrate(stats.bitrateBps)} />
            <Row label="Packet loss" value={formatLoss(stats.packetLossFraction)} />
            <Row label="Codec" value={formatCodec(stats)} />
          </dl>
          {shownIsCappedBySetting(stats, cap) ? (
            <p className="text-caption text-subtle">Shown at up to {cap} fps by Video smoothness in Settings.</p>
          ) : null}
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="rv-mono min-w-0 truncate text-right tabular-nums" title={value}>{value}</dd>
    </>
  );
}
