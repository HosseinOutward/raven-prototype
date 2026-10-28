import type {
  VoiceOverlayNames,
  VoiceOverlayParticipant,
  VoiceOverlayQuietFade,
  VoiceOverlaySnapshot,
  VoiceOverlayView,
} from "@/lib/voiceOverlay";

/** What the card says about one person, in the order it matters. */
export type RowStatus = "lost" | "deafened" | "muted" | "weak";

/**
 * One trailing status per row: connection lost, deafened, muted, weak connection.
 * (Back in a bit comes from plan 05 and goes after these.) Other people's connection
 * problems follow the Show weak connections switch.
 */
export function rowStatus(participant: VoiceOverlayParticipant, showWeakConnections: boolean): RowStatus | null {
  if (showWeakConnections && participant.connectionQuality === "lost") return "lost";
  if (participant.deafened) return "deafened";
  if (participant.muted) return "muted";
  if (showWeakConnections && participant.connectionQuality === "poor") return "weak";
  return null;
}

/** Who has been talking, so a name can stay a moment after the voice stops. */
export interface TalkEntry {
  talking: boolean;
  /** When this run of talking began; the order Talkers first lists people in. */
  startedAt: number;
  /** The last moment they were talking (now, while they still are). */
  lastTalkingAt: number | null;
}
export type TalkState = Record<string, TalkEntry>;

export function advanceTalkState(
  previous: TalkState,
  participants: readonly VoiceOverlayParticipant[],
  now: number,
  lingerMs: number,
): TalkState {
  const next: TalkState = {};
  for (const participant of participants) {
    const before = previous[participant.userId];
    if (participant.speaking) {
      // Talking again inside the window carries on the same run: the fade is cancelled and
      // they keep their place.
      const continuing = before != null && (before.talking || isTalkActive(before, now, lingerMs));
      next[participant.userId] = {
        talking: true,
        startedAt: continuing ? before.startedAt : now,
        lastTalkingAt: now,
      };
    } else if (before?.talking) {
      next[participant.userId] = { talking: false, startedAt: before.startedAt, lastTalkingAt: now };
    } else if (before) {
      next[participant.userId] = before;
    }
  }
  return next;
}

/** Talking now, or stopped less than `lingerMs` ago. */
export function isTalkActive(entry: TalkEntry | undefined, now: number, lingerMs: number) {
  if (!entry) return false;
  if (entry.talking) return true;
  return entry.lastTalkingAt != null && now - entry.lastTalkingAt < lingerMs;
}

/** When the next lingering name runs out, to schedule one re-render; null when none is. */
export function nextTalkExpiry(state: TalkState, now: number, lingerMs: number): number | null {
  let soonest: number | null = null;
  for (const entry of Object.values(state)) {
    if (entry.talking || entry.lastTalkingAt == null) continue;
    const expiry = entry.lastTalkingAt + lingerMs;
    if (expiry > now && (soonest == null || expiry < soonest)) soonest = expiry;
  }
  return soonest;
}

/** By when they joined the call; people with no time keep their place after those with one. */
export function orderByJoin<T extends Pick<VoiceOverlayParticipant, "joinedAt">>(participants: readonly T[]): T[] {
  return participants
    .map((participant, index) => ({ participant, index, time: joinedTime(participant.joinedAt) }))
    .sort((a, b) => {
      if (a.time == null && b.time == null) return a.index - b.index;
      if (a.time == null) return 1;
      if (b.time == null) return -1;
      return a.time - b.time || a.index - b.index;
    })
    .map((entry) => entry.participant);
}

function joinedTime(value: string | null | undefined) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

export interface CardRows {
  /** Full rows, top to bottom (not you). */
  rows: VoiceOverlayParticipant[];
  /** Talkers first: everyone else, folded into a line of small avatars. */
  folded: VoiceOverlayParticipant[];
  /** Only talking: how many others are here but not listed ("4 others here"). */
  hiddenOthers: number;
  local: VoiceOverlayParticipant | null;
}

export function selectCardRows({
  view,
  participants,
  talk,
  now,
  lingerMs,
}: {
  view: VoiceOverlayView;
  participants: readonly VoiceOverlayParticipant[];
  talk: TalkState;
  now: number;
  lingerMs: number;
}): CardRows {
  const local = participants.find((participant) => participant.isLocal) ?? null;
  const others = orderByJoin(participants.filter((participant) => !participant.isLocal));
  if (view === "everyone") return { rows: others, folded: [], hiddenOthers: 0, local };

  const active = others.filter((participant) => isTalkActive(talk[participant.userId], now, lingerMs));
  active.sort((a, b) => (talk[a.userId]?.startedAt ?? 0) - (talk[b.userId]?.startedAt ?? 0));
  const rest = others.filter((participant) => !active.includes(participant));
  if (view === "talkersFirst") return { rows: active, folded: rest, hiddenOthers: 0, local };
  return { rows: active, folded: [], hiddenOthers: rest.length, local };
}

/** Whether a row shows its name. In a row, only people who are talking widen to show it. */
export function showsName({
  names,
  active,
  shape,
}: {
  names: VoiceOverlayNames;
  active: boolean;
  shape: "column" | "row";
}) {
  if (names === "never") return false;
  if (shape === "row") return active;
  return names === "always" || active;
}

/** What your own row says. Reconnecting always shows, whatever the switches are. */
export interface LocalSaying {
  /** A slashed icon or signal mark beside the words. */
  icon: "muted" | "deafened" | "weak" | null;
  words: string | null;
  caption: string | null;
  tone: "destructive" | "warning" | "muted";
}

export function localSaying({
  snapshot,
  local,
  mutedHint,
  showWeakConnections,
}: {
  snapshot: Pick<VoiceOverlaySnapshot, "reconnecting" | "localMutedHint">;
  local: VoiceOverlayParticipant;
  mutedHint: boolean;
  showWeakConnections: boolean;
}): LocalSaying | null {
  if (snapshot.reconnecting) {
    return { icon: null, words: "Reconnecting…", caption: "They can't hear you.", tone: "warning" };
  }
  if (local.deafened) return { icon: "deafened", words: "Deafened", caption: null, tone: "destructive" };
  if (local.muted) {
    const words = mutedHint && snapshot.localMutedHint ? "You're muted" : null;
    return { icon: "muted", words, caption: null, tone: "destructive" };
  }
  if (showWeakConnections && (local.connectionQuality === "poor" || local.connectionQuality === "lost")) {
    return { icon: "weak", words: "Weak connection", caption: null, tone: "warning" };
  }
  return null;
}

/** The quiet fade's resting opacity. */
export function quietOpacity(fade: VoiceOverlayQuietFade) {
  if (fade === "some") return 0.8;
  if (fade === "lots") return 0.45;
  return 1;
}

/** What the card remembers between snapshots to tell who arrived and who left. */
export interface RosterMemory {
  nestId: string;
  participants: VoiceOverlayParticipant[];
}

export interface RosterDiff {
  memory: RosterMemory | null;
  joined: VoiceOverlayParticipant[];
  left: VoiceOverlayParticipant[];
}

/**
 * Compare this snapshot with the last one of the same nest. The first snapshot of a call
 * (or of a different nest) is the baseline: nobody already there is announced, and neither
 * is your own arrival or departure. While you are reconnecting the room is not trusted, so
 * nothing is announced and the memory stays.
 */
export function diffRoster(previous: RosterMemory | null, snapshot: VoiceOverlaySnapshot): RosterDiff {
  if (!snapshot.connected || !snapshot.nestId) return { memory: null, joined: [], left: [] };
  if (snapshot.reconnecting && previous?.nestId === snapshot.nestId) return { memory: previous, joined: [], left: [] };
  const memory: RosterMemory = { nestId: snapshot.nestId, participants: snapshot.participants };
  if (!previous || previous.nestId !== snapshot.nestId) return { memory, joined: [], left: [] };
  const before = new Set(previous.participants.map((participant) => participant.userId));
  const now = new Set(snapshot.participants.map((participant) => participant.userId));
  return {
    memory,
    joined: snapshot.participants.filter((participant) => !participant.isLocal && !before.has(participant.userId)),
    left: previous.participants.filter((participant) => !participant.isLocal && !now.has(participant.userId)),
  };
}

export const QUIET_AFTER_MS = 4000;
export const JOINED_CAPTION_MS = 2500;
export const LEFT_ROW_MS = 2000;
