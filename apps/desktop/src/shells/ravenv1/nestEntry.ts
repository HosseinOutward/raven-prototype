export type NestEntryResult = "joined" | "waiting" | "cancelled";

export interface NestEntryPending {
  nestId: string;
  secondsLeft: number;
}

export interface NestEntryDeps {
  joinNest: (nestId: string) => Promise<"joined" | "waiting">;
  /** Tell the people inside; resolves to null when the notice could not be sent. */
  announce: (nestId: string) => Promise<{ notified: number; delaySeconds: number } | null>;
  withdraw: (nestId: string) => Promise<unknown>;
  joinMedia: (nestId: string) => Promise<void>;
  now: () => number;
  /** Resolve after `ms`, or earlier when the function handed to `onWake` is called. */
  sleep: (ms: number, onWake: (wake: () => void) => void) => Promise<void>;
}

export interface NestEntryRun {
  cancelled: boolean;
  wake: (() => void) | null;
}

const COUNTDOWN_TICK_MS = 200;

/**
 * Enter a Nest the polite way: tell the people inside that you are coming, give them a
 * moment, then join. The wait only happens when someone is actually inside, and it can
 * be cancelled. If the notice cannot be sent, entering still works — a failed courtesy
 * must never keep someone out of a room they are allowed in.
 */
export async function runNestEntry(
  deps: NestEntryDeps,
  nestId: string,
  run: NestEntryRun,
  onCountdown: (secondsLeft: number | null) => void,
): Promise<NestEntryResult> {
  // Announce first so the heads-up overlaps the membership request.
  let announcedAt = deps.now();
  const announcement = deps.announce(nestId).then(
    (notice) => {
      announcedAt = deps.now();
      return notice;
    },
    () => null,
  );
  const status = await deps.joinNest(nestId);
  const notice = await announcement;
  const announced = Boolean(notice && notice.notified > 0);

  if (status !== "joined") {
    if (announced) void deps.withdraw(nestId).catch(() => undefined);
    return "waiting";
  }

  if (notice && announced && notice.delaySeconds > 0) {
    const enterAt = announcedAt + notice.delaySeconds * 1000;
    while (!run.cancelled) {
      const remainingMs = enterAt - deps.now();
      if (remainingMs <= 0) break;
      onCountdown(Math.ceil(remainingMs / 1000));
      await deps.sleep(Math.min(remainingMs, COUNTDOWN_TICK_MS), (wake) => {
        run.wake = wake;
      });
    }
    run.wake = null;
    onCountdown(null);
    if (run.cancelled) {
      void deps.withdraw(nestId).catch(() => undefined);
      return "cancelled";
    }
  }

  await deps.joinMedia(nestId);
  return "joined";
}
