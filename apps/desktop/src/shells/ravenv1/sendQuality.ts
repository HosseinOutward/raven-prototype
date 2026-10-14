import { useEffect, useState } from "react";
import { audioCommands, type AudioNetworkTotals } from "@/lib/audio";

/**
 * How you sound to everyone else, in words. The server reports which packets of your
 * audio never reached it, and how late and uneven the rest arrive. Opus hides a few
 * percent of loss well; past that people hear gaps, and a long or uneven delay makes
 * people talk over each other.
 */
export type SendQuality = "clear" | "unsteady" | "choppy";

export interface SendQualityReading {
  /** Share of your audio packets lost on the way to the server, 0..1, over the last interval. */
  loss: number;
  roundTripMs: number | null;
  jitterMs: number | null;
}

export const SEND_QUALITY_SAMPLE_INTERVAL_MS = 2000;
/** Readings in a row needed to change the verdict, so one bad moment does not flash a warning. */
const ENTER_READINGS = 2;
const LEAVE_READINGS = 3;

export function readingFromTotals(previous: AudioNetworkTotals, next: AudioNetworkTotals): SendQualityReading | null {
  const sent = (next.sentPackets ?? 0) - (previous.sentPackets ?? 0);
  // Nothing sent in the interval (muted is still sent, as silence) means nothing to judge.
  if (sent <= 0) return null;
  const lost = Math.max(0, (next.sentPacketsLost ?? 0) - (previous.sentPacketsLost ?? 0));
  return {
    loss: Math.min(1, lost / sent),
    roundTripMs: next.sentRoundTripMs ?? null,
    jitterMs: next.sentJitterMs ?? null,
  };
}

export function classifyReading(reading: SendQualityReading): SendQuality {
  const roundTrip = reading.roundTripMs ?? 0;
  const jitter = reading.jitterMs ?? 0;
  if (reading.loss >= 0.08 || roundTrip >= 600 || jitter >= 80) return "choppy";
  if (reading.loss >= 0.03 || roundTrip >= 350 || jitter >= 40) return "unsteady";
  return "clear";
}

/** Turns readings into a verdict that only changes after it has held for a few readings. */
export class SendQualityTracker {
  private verdict: SendQuality = "clear";
  private candidate: SendQuality = "clear";
  private streak = 0;

  push(reading: SendQualityReading): SendQuality {
    const next = classifyReading(reading);
    if (next === this.verdict) {
      this.candidate = next;
      this.streak = 0;
      return this.verdict;
    }
    this.streak = next === this.candidate ? this.streak + 1 : 1;
    this.candidate = next;
    const needed = severity(next) > severity(this.verdict) ? ENTER_READINGS : LEAVE_READINGS;
    if (this.streak >= needed) {
      this.verdict = next;
      this.streak = 0;
    }
    return this.verdict;
  }
}

function severity(quality: SendQuality) {
  return quality === "choppy" ? 2 : quality === "unsteady" ? 1 : 0;
}

export function sendQualityTitle(quality: SendQuality) {
  if (quality === "choppy") return "You may sound choppy";
  if (quality === "unsteady") return "Your connection is a little unsteady";
  return "People hear you clearly";
}

export function sendQualityExplanation(quality: SendQuality, reading: SendQualityReading | null) {
  const lostPercent = reading ? Math.round(reading.loss * 100) : 0;
  if (quality === "clear") return "Your sound is reaching the server without gaps.";
  const cause = lostPercent >= 3
    ? `About ${lostPercent}% of your sound isn’t reaching the server, so people here may hear gaps.`
    : "Your sound arrives late or unevenly, so people here may hear you with a delay.";
  return `${cause} A wired connection, or pausing downloads and video on this network, usually helps.`;
}

export function sendQualityDetail(reading: SendQualityReading | null) {
  if (!reading) return null;
  return [
    `loss ${(reading.loss * 100).toFixed(1)}%`,
    reading.roundTripMs != null ? `delay ${Math.round(reading.roundTripMs)} ms` : null,
    reading.jitterMs != null ? `jitter ${Math.round(reading.jitterMs)} ms` : null,
  ].filter(Boolean).join(" · ");
}

/** Measures how you sound to others while you are in a call. Measured locally, sent nowhere. */
export function useSendQuality(inCall: boolean) {
  const [state, setState] = useState<{ quality: SendQuality; reading: SendQualityReading | null }>({
    quality: "clear",
    reading: null,
  });

  useEffect(() => {
    setState({ quality: "clear", reading: null });
    if (!inCall) return;
    let cancelled = false;
    let timer: number | null = null;
    let previous: AudioNetworkTotals | null = null;
    const tracker = new SendQualityTracker();

    const sample = async () => {
      timer = null;
      try {
        const next = await audioCommands.getNetworkTotals();
        if (cancelled) return;
        const reading = previous ? readingFromTotals(previous, next) : null;
        previous = next;
        if (reading) setState({ quality: tracker.push(reading), reading });
      } catch {
        // No statistics this time; keep the last verdict rather than inventing one.
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void sample(), SEND_QUALITY_SAMPLE_INTERVAL_MS);
      }
    };
    void sample();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [inCall]);

  return state;
}
