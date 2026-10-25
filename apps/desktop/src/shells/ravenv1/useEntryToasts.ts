import { useEffect, useMemo, useState } from "react";
import { entryNoticePhase, nextEntryNoticeChange, type EntryNoticePhase } from "@/lib/callArrivals";
import type { NestEntryNotice } from "./state";

export interface EntryToast {
  notice: NestEntryNotice;
  phase: EntryNoticePhase;
}

/**
 * The join toasts to show for the room you are in: "about to join" during the heads-up,
 * then "connecting" until the person is connected (`connected`), withdraws, or the notice
 * runs out. Re-renders by itself when a phase changes with time.
 */
export function useEntryToasts(notices: readonly NestEntryNotice[], connected: ReadonlySet<string>): EntryToast[] {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const wait = nextEntryNoticeChange(notices, Date.now());
    if (wait === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), wait + 20);
    return () => window.clearTimeout(timer);
  }, [notices, now]);
  // A new notice arrives with its own time; read the clock again so it is not judged by
  // a stale `now`.
  const current = Math.max(now, ...notices.map((notice) => notice.receivedAt));
  return useMemo(
    () =>
      notices.flatMap((notice) => {
        const phase = entryNoticePhase(notice, current, connected);
        return phase ? [{ notice, phase }] : [];
      }),
    [connected, current, notices],
  );
}
