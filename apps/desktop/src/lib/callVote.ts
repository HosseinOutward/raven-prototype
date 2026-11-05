/** A vote to remove someone from a call. The server never sends who voted how. */
export type CallVoteOutcome = "open" | "passed" | "failed";

export interface CallVote {
  id: string;
  nestId: string;
  targetId: string;
  targetName: string;
  starterId: string;
  starterName: string;
  yes: number;
  needed: number;
  total: number;
  remainingMs: number;
  outcome: CallVoteOutcome;
  /** The viewer's own ballot. Only present on replies to the viewer. */
  voted?: boolean;
}

/** A vote as this client holds it: the deadline is on the local clock, so clock skew cannot move it. */
export type LocalCallVote = CallVote & { voted: boolean; deadline: number };

const OUTCOMES: readonly string[] = ["open", "passed", "failed"];

export function parseCallVote(value: unknown): CallVote | undefined {
  if (!value || typeof value !== "object") return undefined;
  const vote = value as Record<string, unknown>;
  const strings = [vote.id, vote.nestId, vote.targetId, vote.targetName, vote.starterId, vote.starterName];
  const numbers = [vote.yes, vote.needed, vote.total, vote.remainingMs];
  if (!strings.every((item) => typeof item === "string") || !numbers.every((item) => typeof item === "number")) return undefined;
  if (!OUTCOMES.includes(vote.outcome as string)) return undefined;
  return value as CallVote;
}

/**
 * Takes in what the server just said. Updates can arrive out of order (a reply to your own
 * ballot, and the event about it), but a tally only grows and a finished vote stays finished.
 */
export function mergeCallVote(current: LocalCallVote | null, incoming: CallVote, now: number): LocalCallVote {
  if (!current || current.id !== incoming.id) {
    return { ...incoming, voted: Boolean(incoming.voted), deadline: now + incoming.remainingMs };
  }
  return {
    ...current,
    yes: Math.max(current.yes, incoming.yes),
    outcome: current.outcome === "open" ? incoming.outcome : current.outcome,
    voted: current.voted || Boolean(incoming.voted),
  };
}

export function isVotedOut(vote: CallVote, userId: string | undefined) {
  return vote.outcome === "passed" && vote.targetId === userId;
}

export function callVoteHeadline(vote: CallVote, userId: string | undefined) {
  const aboutYou = vote.targetId === userId;
  if (vote.outcome === "passed") return aboutYou ? "You were voted out of this call." : `${vote.targetName} was voted out of this call.`;
  if (vote.outcome === "failed") return aboutYou ? "The vote to remove you didn’t pass." : `The vote to remove ${vote.targetName} didn’t pass.`;
  const starter = vote.starterId === userId ? "You" : vote.starterName;
  if (aboutYou) return `People are voting on removing you from this call. ${starter} started it.`;
  return `${starter} started a vote to remove ${vote.targetName} from this call`;
}

/** Only the people voting get buttons, and only until they have voted. */
export function canCastBallot(vote: LocalCallVote, userId: string | undefined) {
  return vote.outcome === "open" && vote.targetId !== userId && !vote.voted;
}
