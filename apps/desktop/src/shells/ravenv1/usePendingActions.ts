import { useCallback, useRef, useState } from "react";

/**
 * Runs one-shot actions (accept, decline, cancel…) so that each can only be in flight
 * once. A second click while the first is still being answered would otherwise send the
 * action twice, and the second would fail after the first had worked.
 *
 * Actions that answer the same thing share a key, so Accept and Decline on one request
 * are both held while either is working. Failures are reported by whoever owns the
 * action (shell data shows a toast), so they are swallowed here.
 */
export function usePendingActions() {
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  const run = useCallback((key: string, action: () => Promise<unknown>) => {
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setPending(new Set(inFlight.current));
    const done = () => {
      inFlight.current.delete(key);
      setPending(new Set(inFlight.current));
    };
    let started: Promise<unknown>;
    try {
      started = action();
    } catch {
      done();
      return;
    }
    void started.catch(() => undefined).then(done);
  }, []);

  const isPending = useCallback((key: string) => pending.has(key), [pending]);

  return { run, isPending };
}
