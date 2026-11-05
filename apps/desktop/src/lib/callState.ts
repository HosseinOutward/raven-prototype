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

/** A server that sends these also has the route to change them. */
export function voiceModerationSupported(session: Pick<SessionSummary, "participants"> | null | undefined) {
  return (session?.participants ?? []).some((participant) => typeof participant.serverMuted === "boolean");
}

/** The markers a person sets for themselves. */
export interface CallMarkers {
  away: boolean;
  deafened: boolean;
}

export interface ParticipantCallState extends CallMarkers {
  serverMuted: boolean;
  serverDeafened: boolean;
}

function callStateOf(participant: ParticipantSummary | undefined): ParticipantCallState {
  return {
    away: participant?.away === true,
    deafened: participant?.deafened === true,
    serverMuted: participant?.serverMuted === true,
    serverDeafened: participant?.serverDeafened === true,
  };
}

export function participantCallState(
  participants: ParticipantSummary[] | undefined,
  userId: string,
): ParticipantCallState {
  return callStateOf((participants ?? []).find((candidate) => candidate.userId === userId));
}

/**
 * Everyone's markers, by user id, for the stage. Your own comes from what you just set
 * rather than from the server's echo, so your place in the room answers at once.
 */
export function callStatesByUser(
  participants: ParticipantSummary[] | undefined,
  local?: { userId: string } & CallMarkers,
): ReadonlyMap<string, ParticipantCallState> {
  const states = new Map<string, ParticipantCallState>();
  for (const participant of participants ?? []) {
    states.set(participant.userId, callStateOf(participant));
  }
  if (local) states.set(local.userId, { ...callStateOf(undefined), ...states.get(local.userId), away: local.away, deafened: local.deafened });
  return states;
}

/**
 * What to send after registering in a call so the server's copy matches ours. A fresh
 * participation starts clear, but someone who rejoins after a dropped connection is still
 * deafened or away. Null when they already agree.
 */
export function callStateCatchUp(server: CallMarkers, want: CallMarkers): CallStatePatch | null {
  const patch: CallStatePatch = {};
  if (want.deafened !== server.deafened) patch.deafened = want.deafened;
  if (want.away !== server.away) patch.away = want.away;
  return Object.keys(patch).length > 0 ? patch : null;
}
