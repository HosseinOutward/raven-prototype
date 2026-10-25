import { useEffect, useMemo, useState } from "react";
import {
  collectNetworkSample,
  createZeroNetworkRates,
  networkReadoutActive,
  ratesFromNetworkSamples,
  screenShareCaptureFps,
  type NetworkActivitySettings,
  type NetworkActivitySnapshot,
} from "./networkActivity";

const NETWORK_SAMPLE_INTERVAL_MS = 2000;

type Measurement = Pick<NetworkActivitySnapshot, "rates" | "updatedAt" | "screenShareQuality" | "screenShareCaptureFps" | "connection">;

export function useNetworkActivity(
  connected: boolean,
  settings: NetworkActivitySettings,
): NetworkActivitySnapshot {
  const [measurement, setMeasurement] = useState<Measurement>(() => emptyMeasurement());
  const active = networkReadoutActive(connected, settings);
  useEffect(() => {
    setMeasurement((current) => current.updatedAt === null ? current : emptyMeasurement());
    if (!active) return;

    let cancelled = false;
    let sampling = false;
    let timer: number | null = null;
    let previous: { at: number; sample: Awaited<ReturnType<typeof collectNetworkSample>> } | null = null;

    const schedule = (delay = NETWORK_SAMPLE_INTERVAL_MS) => {
      if (!cancelled) timer = window.setTimeout(() => void sample(), delay);
    };
    const sample = async () => {
      timer = null;
      if (cancelled || sampling) return;
      if (document.visibilityState === "hidden") {
        schedule();
        return;
      }
      sampling = true;
      try {
        const next = await collectNetworkSample(settings);
        if (cancelled) return;
        const at = performance.now();
        if (previous) {
          const seconds = (at - previous.at) / 1000;
          const rates = ratesFromNetworkSamples(previous.sample, next, seconds);
          setMeasurement({
            rates,
            updatedAt: Date.now(),
            screenShareQuality: next.screenShareQuality,
            screenShareCaptureFps: screenShareCaptureFps(previous.sample.screenShareQuality, next.screenShareQuality, seconds),
            connection: next.connection,
          });
        } else if (next.connection) {
          // A rate needs two samples; the connection reading is ready after one.
          setMeasurement((current) => ({ ...current, connection: next.connection }));
        }
        previous = { at, sample: next };
      } catch {
        // Keep the last complete sample; partial statistics must not become fake zero traffic.
      } finally {
        sampling = false;
        schedule();
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden" || sampling) return;
      if (timer !== null) window.clearTimeout(timer);
      schedule(0);
    };

    document.addEventListener("visibilitychange", handleVisibility);
    void sample();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [active, settings]);

  return useMemo(() => ({ ...settings, ...measurement, active }), [active, measurement, settings]);
}

function emptyMeasurement(): Measurement {
  return { rates: createZeroNetworkRates(), updatedAt: null, screenShareQuality: null, screenShareCaptureFps: null, connection: null };
}
