import type { SessionSummary } from "@/lib/api";
import type { AudioMixerState } from "@/lib/audio";
import { stripSidecarIdentity } from "@/lib/mediaIdentity";
import type { VideoMixerState } from "@/lib/video";

/**
 * Who is really in the call, as this client can tell.
 *
 * LiveKit lists a person as soon as their app opens its signalling connection, seconds
 * before any sound or picture can flow on a slow network. So being listed there is
 * "connecting". A person counts as connected once either is true:
 * - the call's session lists them: their app registers it only after both of its media
 *   rooms connected, and the server tells everyone who can see the room;
 * - this client receives one of their tracks (a microphone, even muted, a camera, a
 *   share): media is flowing, whatever the session refresh says.
 *
 * Every view that shows who is here (the room, the voice overlay, the join toast) reads
 * this one set, so they agree on the moment someone arrives.
 */
export function connectedPeerIds({
  session,
  audioState,
  videoState,
}: {
  session: SessionSummary | null | undefined;
  audioState: AudioMixerState | null | undefined;
  videoState: VideoMixerState | null | undefined;
}): Set<string> {
  const ids = new Set<string>();
  for (const participant of session?.participants ?? []) ids.add(participant.userId);
  for (const participant of audioState?.remoteParticipants ?? []) {
    const id = stripSidecarIdentity(participant.participantId);
    if (id) ids.add(id);
  }
  for (const track of videoState?.remoteTracks ?? []) {
    const id = stripSidecarIdentity(track.participantId);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * The set the room view marks people against, or null while it is not known yet: until
 * the session was fetched once, everyone already inside would wrongly read as connecting.
 */
export function knownConnectedPeerIds(input: Parameters<typeof connectedPeerIds>[0]): Set<string> | null {
  if (input.session === undefined) return null;
  return connectedPeerIds(input);
}

/** Whether a person the room lists is still connecting. You are never "connecting" to yourself. */
export function isConnecting(participantId: string, isLocal: boolean, connected: ReadonlySet<string> | null) {
  if (isLocal || !connected) return false;
  return !connected.has(stripSidecarIdentity(participantId));
}

/** The heads-up a joiner gives before entering (`nestEntryDelaySeconds` in the API). */
export const ENTRY_HEADS_UP_MS = 3000;
/**
 * A normal join completes within about a second of the heads-up. Saying "connecting"
 * before that would flash on every arrival.
 */
export const ENTRY_CONNECT_GRACE_MS = 1500;
/**
 * Longest a "connecting" toast stays without news. A joiner whose connect fails says so
 * (the notice is withdrawn); this covers an app that closed or lost the network.
 */
export const ENTRY_CONNECTING_TTL_MS = 45_000;

export type EntryNoticePhase = "announced" | "connecting";

export interface EntryNoticeLike {
  actorId: string;
  receivedAt: number;
}

/**
 * What the toast for one entry says right now, or null when it should be gone.
 *
 * "announced" for the heads-up (and its short grace); then, once the person is connected,
 * nothing; until then "connecting", for at most `ENTRY_CONNECTING_TTL_MS`. During the
 * heads-up the toast stays even if they already read as connected: a session row left
 * behind by an earlier visit must not swallow the heads-up.
 */
export function entryNoticePhase(
  notice: EntryNoticeLike,
  now: number,
  connected: ReadonlySet<string>,
): EntryNoticePhase | null {
  const age = now - notice.receivedAt;
  if (age < ENTRY_HEADS_UP_MS + ENTRY_CONNECT_GRACE_MS) return "announced";
  if (connected.has(notice.actorId)) return null;
  if (age < ENTRY_CONNECTING_TTL_MS) return "connecting";
  return null;
}

/** Milliseconds until some notice's phase changes by time alone, or null if none will. */
export function nextEntryNoticeChange(notices: readonly EntryNoticeLike[], now: number): number | null {
  let next: number | null = null;
  for (const notice of notices) {
    for (const boundary of [ENTRY_HEADS_UP_MS + ENTRY_CONNECT_GRACE_MS, ENTRY_CONNECTING_TTL_MS]) {
      const wait = notice.receivedAt + boundary - now;
      if (wait > 0 && (next === null || wait < next)) next = wait;
    }
  }
  return next;
}
