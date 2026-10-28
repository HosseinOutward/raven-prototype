import type { CallStatePatch, ParticipantSummary, SessionSummary } from "@/lib/api";

/**
 * The server shares two per-person markers with everyone in a call: "Back in a
 * bit" (`away`, a plain marker with no time or duration) and `deafened`. An
 * older server doesn't send them, so a participant carrying the `away` field is
 * how the client knows the call-state route exists.
 */
export function callStateSupported(session: Pick<SessionSummary, "participants"> | null | undefined) {
  return (session?.participants ?? []).some((participant) => typeof participant.away === "boolean");
}

export interface ParticipantCallState {
  away: boolean;
  deafened: boolean;
}

export function participantCallState(
  participants: ParticipantSummary[] | undefined,
  userId: string,
): ParticipantCallState {
  const participant = (participants ?? []).find((candidate) => candidate.userId === userId);
  return { away: participant?.away === true, deafened: participant?.deafened === true };
}

/**
 * Everyone's markers, by user id, for the stage. Your own comes from what you just set
 * rather than from the server's echo, so your place in the room answers at once.
 */
export function callStatesByUser(
  participants: ParticipantSummary[] | undefined,
  local?: { userId: string } & ParticipantCallState,
): ReadonlyMap<string, ParticipantCallState> {
  const states = new Map<string, ParticipantCallState>();
  for (const participant of participants ?? []) {
    states.set(participant.userId, { away: participant.away === true, deafened: participant.deafened === true });
  }
  if (local) states.set(local.userId, { away: local.away, deafened: local.deafened });
  return states;
}

/**
 * What to send after registering in a call so the server's copy matches ours. A fresh
 * participation starts clear, but someone who rejoins after a dropped connection is still
 * deafened or away. Null when they already agree.
 */
export function callStateCatchUp(server: ParticipantCallState, want: ParticipantCallState): CallStatePatch | null {
  const patch: CallStatePatch = {};
  if (want.deafened !== server.deafened) patch.deafened = want.deafened;
  if (want.away !== server.away) patch.away = want.away;
  return Object.keys(patch).length > 0 ? patch : null;
}
