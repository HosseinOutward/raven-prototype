import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import { ApiError, api } from "@/lib/api";
import { isVotedOut, mergeCallVote, type CallVote, type LocalCallVote } from "@/lib/callVote";
import { subscribeNestUpdates } from "@/lib/eventStream";

const RESULT_SHOWN_MS = 4000;

export interface CallVoteState {
  vote: LocalCallVote | null;
  start: (targetUserId: string) => Promise<void>;
  castBallot: (yes: boolean) => Promise<void>;
}

/** The vote in the call you are in, if you are part of it, for as long as you are in the call. */
export function useCallVote(nestId: string | null, userId: string | undefined, onVotedOut: () => void): CallVoteState {
  const [vote, setVote] = useState<LocalCallVote | null>(null);
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const onVotedOutRef = useRef(onVotedOut);
  onVotedOutRef.current = onVotedOut;
  const voteRef = useRef(vote);
  voteRef.current = vote;

  const take = useCallback((incoming: CallVote) => {
    setVote((current) => mergeCallVote(current, incoming, Date.now()));
  }, []);

  useEffect(() => {
    setVote(null);
    if (!nestId) return;
    const catchUp = () => {
      void api.currentCallVote(nestId).then(({ vote: current }) => {
        if (current) take(current);
        else setVote((held) => (held?.outcome === "open" ? null : held));
      }).catch(() => undefined);
    };
    catchUp();
    return subscribeNestUpdates((update) => {
      if (update.type === "stream.reconnected") catchUp();
      if (update.type !== "call.vote" || update.vote?.nestId !== nestId) return;
      take(update.vote);
      if (isVotedOut(update.vote, userIdRef.current)) onVotedOutRef.current();
    });
  }, [nestId, take]);

  const finished = vote !== null && vote.outcome !== "open";
  const voteId = vote?.id;
  useEffect(() => {
    if (!finished) return;
    const timer = window.setTimeout(() => setVote((held) => (held?.id === voteId ? null : held)), RESULT_SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [finished, voteId]);

  const start = useCallback(async (targetUserId: string) => {
    if (!nestId) return;
    try {
      take((await api.startCallVote(nestId, targetUserId)).vote);
    } catch (error) {
      const title = error instanceof ApiError && error.status === 404
        ? "This server doesn’t support votes yet."
        : error instanceof Error ? error.message : "The vote didn’t start.";
      toast({ title, tone: "error" });
    }
  }, [nestId, take]);

  const castBallot = useCallback(async (yes: boolean) => {
    const current = voteRef.current;
    if (!current) return;
    try {
      take((await api.castCallVoteBallot(current.nestId, current.id, yes)).vote);
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : "Your vote didn’t count.", tone: "error" });
    }
  }, [take]);

  return { vote, start, castBallot };
}
