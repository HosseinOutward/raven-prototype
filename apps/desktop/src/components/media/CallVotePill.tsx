import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { callVoteHeadline, canCastBallot, type LocalCallVote } from "@/lib/callVote";

/**
 * A vote in progress, shown to the people voting and the person it is about. Only the
 * headline is announced to screen readers: reading out every tick would talk over the call.
 */
export function CallVotePill({ vote, localUserId, onBallot }: { vote: LocalCallVote; localUserId?: string; onBallot: (yes: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const open = vote.outcome === "open";
  const ballot = (yes: boolean) => {
    setBusy(true);
    void onBallot(yes).finally(() => setBusy(false));
  };
  return (
    <div className="absolute left-1/2 top-14 z-30 flex w-max max-w-[min(30rem,calc(100%-2rem))] -translate-x-1/2 animate-fade-in flex-col gap-1.5 rounded-card bg-popover px-3.5 py-2.5 text-popover-foreground shadow-raised">
      <span role="status" className="text-small">{callVoteHeadline(vote, localUserId)}</span>
      {open ? (
        <div className="flex items-center gap-3">
          <span className="flex-1 text-caption text-muted-foreground">
            {vote.yes} of {vote.needed} needed · <Countdown deadline={vote.deadline} />
          </span>
          {canCastBallot(vote, localUserId) ? (
            <div className="flex gap-1.5">
              <Button variant="secondary" size="xs" disabled={busy} aria-label={`Yes, remove ${vote.targetName}`} onClick={() => ballot(true)}>Yes</Button>
              <Button variant="secondary" size="xs" disabled={busy} aria-label={`No, keep ${vote.targetName}`} onClick={() => ballot(false)}>No</Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Countdown({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="tabular-nums">{Math.max(0, Math.ceil((deadline - now) / 1000))} s</span>;
}
