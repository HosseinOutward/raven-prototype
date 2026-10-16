import { useCallback, useEffect, useState } from "react";
import { type VideoTrackSource, videoCommands } from "@/lib/video";

export function receivingKey(participantId: string, source: VideoTrackSource) {
  return `${participantId}:${source}`;
}

/**
 * What you chose to receive. The engine is the source of truth (its `desired` flag
 * survives reconnects and is cleared on Leave); a click is shown at once and held until
 * the engine's state agrees, so Watch and Stop watching never lag a round trip.
 */
export function effectiveReceiving(engineDesired: boolean, pending: boolean | undefined) {
  return pending ?? engineDesired;
}

/** Drop pending choices the engine has caught up with. Returns the same object when nothing changed. */
export function settlePending(pending: Record<string, boolean>, engineDesired: (key: string) => boolean | undefined) {
  let changed = false;
  const next: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(pending)) {
    const desired = engineDesired(key);
    if (desired === undefined || desired === value) {
      changed = true;
      continue;
    }
    next[key] = value;
  }
  return changed ? next : pending;
}

export function useVideoReceiving(connected: boolean, engineDesired: (key: string) => boolean | undefined) {
  const [pending, setPending] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!connected) setPending({});
  }, [connected]);

  useEffect(() => {
    setPending((current) => settlePending(current, engineDesired));
  }, [engineDesired]);

  const setReceiving = useCallback((participantId: string, source: VideoTrackSource, receiving: boolean) => {
    const key = receivingKey(participantId, source);
    setPending((current) => ({ ...current, [key]: receiving }));
    void videoCommands.setRemoteVideoReceiving(participantId, source, receiving).catch(() => {
      setPending(({ [key]: _dropped, ...rest }) => rest);
    });
  }, []);

  const pendingFor = useCallback((participantId: string, source: VideoTrackSource) => pending[receivingKey(participantId, source)], [pending]);

  return { pendingFor, setReceiving };
}
