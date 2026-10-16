import type { AudioMixerState, AudioSourceType, PublishedTrackMetadata } from "@/lib/audio";
import { stripSidecarIdentity } from "@/lib/mediaIdentity";
import { localSourceActivityKey, remoteTrackActivityKey, type SourceActivityMap } from "@/lib/speakingActivity";

/**
 * An audio source a person sends besides their microphone (system audio, one app, a
 * second input), drawn as a small satellite beside them on the stage.
 */
export type AudioSatellite = {
  /** Stable per track; also the key into `SourceActivityMap`. */
  key: string;
  isLocal: boolean;
  sourceType: AudioSourceType;
  /** What people call it: the app, "System audio", the device. Never a window title. */
  name: string;
  iconUrl: string | null;
  /** The sender muted it: nobody hears it. */
  muted: boolean;
  active: boolean;
  intensity: number;
  /** Remote only: this listener's own mute and volume for it. */
  mutedForMe: boolean;
  gainDb: number;
  remote?: { participantId: string; trackId: string };
  /** Local only: the Mixer source, and whether a screen share created it. */
  localSourceId?: string;
  shareLinked: boolean;
};

export type AudioSatellites = {
  local: AudioSatellite[];
  /** By user id (sidecar suffix stripped), as the stage's tiles use it. */
  remote: ReadonlyMap<string, AudioSatellite[]>;
};

export const EMPTY_SATELLITES: AudioSatellites = { local: [], remote: new Map() };

/** At most this many satellites per person; beyond it the last slot becomes "+N". */
export const SATELLITE_SLOTS = 3;

/**
 * Every published track that is not the person's microphone, grouped by person.
 *
 * A person's microphone is their first one: the first local microphone source, or the
 * remote microphone track published earliest. Any further microphone is an extra input
 * and gets a satellite too.
 */
export function groupAudioSatellites(
  state: AudioMixerState | null,
  activity: SourceActivityMap,
  linkedLocalSourceIds: ReadonlySet<string> = new Set(),
): AudioSatellites {
  if (!state) return EMPTY_SATELLITES;

  const local: AudioSatellite[] = [];
  const firstLocalMic = state.localSources.find((source) => source.sourceType === "microphone");
  for (const source of state.localSources) {
    if (source === firstLocalMic || !source.publishing || !source.publishedTrack) continue;
    const key = localSourceActivityKey(source.id);
    const shareLinked = linkedLocalSourceIds.has(source.id);
    local.push({
      key,
      isLocal: true,
      sourceType: source.sourceType,
      name: shareLinked ? "Your screen’s sound" : audioSourceName(source.publishedTrack),
      iconUrl: source.publishedTrack.appIconDataUrl,
      muted: source.channelStrip.mute.muted || source.publishedTrack.muted,
      active: activity[key]?.active ?? false,
      intensity: activity[key]?.intensity ?? 0,
      mutedForMe: false,
      gainDb: 0,
      localSourceId: source.id,
      shareLinked,
    });
  }

  const byPerson = new Map<string, typeof state.remoteTracks>();
  for (const track of state.remoteTracks) {
    const owner = stripSidecarIdentity(track.track.participantId);
    const list = byPerson.get(owner);
    if (list) list.push(track);
    else byPerson.set(owner, [track]);
  }

  const remote = new Map<string, AudioSatellite[]>();
  for (const [owner, tracks] of byPerson) {
    const primary = primaryMicrophone(tracks.map((track) => track.track));
    const satellites: AudioSatellite[] = [];
    for (const track of tracks) {
      if (track.track === primary) continue;
      const key = remoteTrackActivityKey(track.track.participantId, track.track.trackId);
      satellites.push({
        key,
        isLocal: false,
        sourceType: track.track.sourceType,
        name: audioSourceName(track.track),
        iconUrl: track.track.appIconDataUrl,
        muted: track.track.muted,
        active: activity[key]?.active ?? false,
        intensity: activity[key]?.intensity ?? 0,
        mutedForMe: track.receiverChannelStrip.mute.muted,
        gainDb: track.receiverChannelStrip.gainDb,
        remote: { participantId: track.track.participantId, trackId: track.track.trackId },
        shareLinked: false,
      });
    }
    if (satellites.length) remote.set(owner, satellites.sort(bySatelliteOrder));
  }
  return { local: local.sort(bySatelliteOrder), remote };
}

/** The satellites to draw, and the ones folded into "+N" (empty when they all fit). */
export function splitSatellites<T>(satellites: readonly T[], slots = SATELLITE_SLOTS) {
  if (satellites.length <= slots) return { shown: [...satellites], overflow: [] as T[] };
  const visible = Math.max(0, slots - 1);
  return { shown: satellites.slice(0, visible), overflow: satellites.slice(visible) };
}

/**
 * A short name for a source. App audio is named after the app; the engine names a window
 * share's sound after the app that owns the window, never the window's title.
 */
export function audioSourceName(track: Pick<PublishedTrackMetadata, "sourceType" | "displayName" | "deviceName" | "appName">) {
  switch (track.sourceType) {
    case "appAudio": {
      return track.appName?.trim() || "App audio";
    }
    case "systemAudio":
      return "System audio";
    case "screenAudio":
      return "Screen audio";
    case "microphone":
      return track.deviceName?.trim() || track.displayName.trim() || "Microphone";
    case "testTone":
      return "Test tone";
    default:
      return track.displayName.trim() || "Audio";
  }
}

/** −60 dB (the strip's floor) reads as 0 %, 0 dB as 100 %, +6 dB as 200 %. */
export function gainDbToVolumePercent(gainDb: number) {
  if (!Number.isFinite(gainDb) || gainDb <= MIN_GAIN_DB) return 0;
  return Math.round(Math.min(MAX_VOLUME_PERCENT, Math.pow(10, gainDb / 20) * 100));
}

export function volumePercentToGainDb(percent: number) {
  if (!Number.isFinite(percent) || percent <= 0) return MIN_GAIN_DB;
  const clamped = Math.min(MAX_VOLUME_PERCENT, percent);
  return Math.max(MIN_GAIN_DB, Math.round(20 * Math.log10(clamped / 100) * 10) / 10);
}

export const MAX_VOLUME_PERCENT = 200;
const MIN_GAIN_DB = -60;

const SOURCE_ORDER: Partial<Record<AudioSourceType, number>> = {
  screenAudio: 0,
  systemAudio: 1,
  appAudio: 2,
  microphone: 3,
};

function bySatelliteOrder(left: AudioSatellite, right: AudioSatellite) {
  return (SOURCE_ORDER[left.sourceType] ?? 9) - (SOURCE_ORDER[right.sourceType] ?? 9)
    || left.name.localeCompare(right.name)
    || left.key.localeCompare(right.key);
}

/**
 * The engine appends remote tracks as they register, which follows the sender's publish
 * order (their own microphone first). A creation time, when the sender shares one, wins.
 */
function primaryMicrophone(tracks: PublishedTrackMetadata[]) {
  let primary: PublishedTrackMetadata | null = null;
  for (const track of tracks) {
    if (track.sourceType !== "microphone") continue;
    if (!primary || createdEarlier(track, primary)) primary = track;
  }
  return primary;
}

function createdEarlier(left: PublishedTrackMetadata, right: PublishedTrackMetadata) {
  return Boolean(left.createdAt && right.createdAt && left.createdAt < right.createdAt);
}

/** What a satellite can do. Remote: this listener's own volume and mute. Yours: the Mixer, and Stop for a share's sound. */
export type SatelliteActions = {
  setVolume: (satellite: AudioSatellite, gainDb: number) => Promise<void>;
  setMutedForMe: (satellite: AudioSatellite, muted: boolean) => Promise<void>;
  openMixer?: () => void;
  stopShare?: () => void;
};
