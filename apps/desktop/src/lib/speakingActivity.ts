import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  subscribeAudioMeterChanged,
  type AudioMeterUpdate,
  type AudioMixerState,
  type AudioSourceState,
  type RemoteAudioTrackState,
} from "@/lib/audio";
import { stripSidecarIdentity } from "@/lib/mediaIdentity";

export const SPEAKING_ENTER_RMS_DB = -52;
export const SPEAKING_EXIT_RMS_DB = -56;
export const SPEAKING_RELEASE_HOLD_MS = 240;
export const FALLBACK_SPEAKING_INTENSITY = 0.35;

const FULL_INTENSITY_RMS_DB = -18;

export interface ParticipantVoiceActivity {
  speaking: boolean;
  intensity: number;
  meterObserved: boolean;
}

export type ParticipantVoiceActivityMap = Readonly<Record<string, ParticipantVoiceActivity>>;

type TrackedMicrophone = {
  participantId: string;
  active: boolean;
  intensity: number;
  belowSinceMs: number | null;
};

type MeterTarget = {
  key: string;
  participantId: string;
};

/**
 * Convert the voice-activation range to a stable 0..1 visual value. RMS is
 * already averaged by the native 120 ms meter window, so CSS can interpolate
 * between these samples without adding another delayed smoothing layer.
 */
export function rmsDbToSpeakingIntensity(rmsDb: number) {
  if (!Number.isFinite(rmsDb)) return 0;
  const normalized = (rmsDb - SPEAKING_ENTER_RMS_DB)
    / (FULL_INTENSITY_RMS_DB - SPEAKING_ENTER_RMS_DB);
  return roundIntensity(Math.min(1, Math.max(0, normalized)));
}

export function speakingIntensityPercent(intensity: number) {
  if (!Number.isFinite(intensity)) return 0;
  return Math.round(Math.min(1, Math.max(0, intensity)) * 100);
}

export function speakingGlowStyle(intensity: number, variant: "tile" | "avatar") {
  const level = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0;
  const compact = variant === "avatar";
  return {
    "--raven-speaking-border-alpha": String(roundIntensity(0.62 + level * 0.36)),
    "--raven-speaking-glow-alpha": String(roundIntensity((compact ? 0.16 : 0.14) + level * 0.3)),
    "--raven-speaking-glow-radius": `${roundIntensity((compact ? 8 : 12) + level * (compact ? 12 : 22))}px`,
  } as CSSProperties;
}

export function resolveParticipantVoicePresentation(
  fallbackSpeaking: boolean,
  activity: ParticipantVoiceActivity | undefined,
) {
  if (activity?.meterObserved) {
    return { speaking: activity.speaking, intensity: activity.intensity };
  }
  return {
    speaking: fallbackSpeaking,
    intensity: fallbackSpeaking ? FALLBACK_SPEAKING_INTENSITY : 0,
  };
}

/**
 * Stateful threshold/hysteresis reducer. It stores activity per microphone so
 * participants with more than one mic publication remain active while any one
 * of their eligible tracks is speaking.
 */
export class ParticipantVoiceActivityTracker {
  private readonly microphones = new Map<string, TrackedMicrophone>();
  private readonly observedParticipants = new Set<string>();

  processMeter(
    state: AudioMixerState | null,
    update: AudioMeterUpdate,
    nowMs: number,
    localUserId?: string,
  ) {
    const target = state ? meterTargetForUpdate(state, update, localUserId) : null;
    if (!target) return this.reconcile(state, localUserId);

    this.observedParticipants.add(target.participantId);
    const current = this.microphones.get(target.key);
    // Remote tracks report the level as received. The strip meter is post-fader, so
    // using it would hide someone you turned down, muted locally, or deafened. A local
    // source's input meter is its level while muted, which nobody hears: never speaking.
    const rmsDb = (update.sourceId ? update.meter : update.inputMeter ?? update.meter).rmsDb;
    let active = current?.active ?? false;
    let belowSinceMs = current?.belowSinceMs ?? null;

    if (rmsDb >= SPEAKING_ENTER_RMS_DB) {
      active = true;
      belowSinceMs = null;
    } else if (rmsDb <= SPEAKING_EXIT_RMS_DB) {
      if (active) {
        belowSinceMs ??= nowMs;
        if (nowMs - belowSinceMs >= SPEAKING_RELEASE_HOLD_MS) active = false;
      } else {
        belowSinceMs ??= nowMs;
      }
    } else {
      // The hysteresis band preserves the current state and cancels a pending
      // release when speech rises again without crossing the entry threshold.
      belowSinceMs = null;
    }

    this.microphones.set(target.key, {
      participantId: target.participantId,
      active,
      intensity: rmsDbToSpeakingIntensity(rmsDb),
      belowSinceMs,
    });
    return this.reconcile(state, localUserId);
  }

  reconcile(state: AudioMixerState | null, localUserId?: string): ParticipantVoiceActivityMap {
    if (!state) {
      this.microphones.clear();
      this.observedParticipants.clear();
      return {};
    }

    const eligible = eligibleMicrophones(state);
    const knownParticipants = knownMicrophoneParticipants(state, localUserId);
    for (const key of this.microphones.keys()) {
      if (!eligible.has(key)) this.microphones.delete(key);
    }
    for (const participantId of this.observedParticipants) {
      if (!knownParticipants.has(participantId)) this.observedParticipants.delete(participantId);
    }

    const activity: Record<string, ParticipantVoiceActivity> = {};
    for (const participantId of this.observedParticipants) {
      activity[participantId] = { speaking: false, intensity: 0, meterObserved: true };
    }
    for (const microphone of this.microphones.values()) {
      const participant = activity[microphone.participantId];
      if (!participant || !microphone.active) continue;
      participant.speaking = true;
      participant.intensity = Math.max(participant.intensity, microphone.intensity);
    }
    return activity;
  }
}

export function useParticipantVoiceActivity(audioState: AudioMixerState | null, localUserId?: string) {
  const trackerRef = useRef(new ParticipantVoiceActivityTracker());
  const audioStateRef = useRef(audioState);
  const [activity, setActivity] = useState<ParticipantVoiceActivityMap>({});
  audioStateRef.current = audioState;

  useEffect(() => {
    setActivityIfChanged(setActivity, trackerRef.current.reconcile(audioState, localUserId));
  }, [audioState, localUserId]);

  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | null = null;
    void subscribeAudioMeterChanged((update) => {
      if (!mounted) return;
      const next = trackerRef.current.processMeter(
        audioStateRef.current,
        update,
        Date.now(),
        localUserId,
      );
      setActivityIfChanged(setActivity, next);
    })
      .then((unlisten) => {
        if (!mounted) unlisten();
        else unsubscribe = unlisten;
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [localUserId]);

  return activity;
}

function meterTargetForUpdate(
  state: AudioMixerState,
  update: AudioMeterUpdate,
  localUserId?: string,
): MeterTarget | null {
  if (update.sourceId) {
    const source = state.localSources.find((candidate) => candidate.id === update.sourceId);
    if (!source || !localMicrophoneEligible(source)) return null;
    return {
      key: localMicrophoneKey(source.id),
      participantId: localMicrophoneParticipantId(state, source, localUserId),
    };
  }

  if (!update.participantId || !update.trackId) return null;
  const track = state.remoteTracks.find(
    (candidate) => candidate.track.participantId === update.participantId
      && candidate.track.trackId === update.trackId,
  );
  if (!track || !remoteMicrophoneEligible(track)) return null;
  return {
    key: remoteMicrophoneKey(track),
    participantId: stripSidecarIdentity(track.track.participantId),
  };
}

function eligibleMicrophones(state: AudioMixerState) {
  const eligible = new Set<string>();
  for (const source of state.localSources) {
    if (localMicrophoneEligible(source)) eligible.add(localMicrophoneKey(source.id));
  }
  for (const track of state.remoteTracks) {
    if (remoteMicrophoneEligible(track)) eligible.add(remoteMicrophoneKey(track));
  }
  return eligible;
}

function knownMicrophoneParticipants(state: AudioMixerState, localUserId?: string) {
  const participants = new Set<string>();
  for (const source of state.localSources) {
    if (source.sourceType !== "microphone") continue;
    participants.add(localMicrophoneParticipantId(state, source, localUserId));
  }
  for (const track of state.remoteTracks) {
    if (track.track.sourceType !== "microphone") continue;
    participants.add(stripSidecarIdentity(track.track.participantId));
  }
  return participants;
}

function localMicrophoneParticipantId(
  state: AudioMixerState,
  source: AudioSourceState,
  localUserId?: string,
) {
  return stripSidecarIdentity(localUserId || source.ownerId || state.localParticipantId || "local");
}

function localMicrophoneEligible(source: AudioSourceState) {
  return source.sourceType === "microphone"
    && source.enabled
    && source.publishing
    && source.publishedTrack != null
    && !source.publishedTrack.muted
    && !source.channelStrip.mute.muted;
}

function remoteMicrophoneEligible(track: RemoteAudioTrackState) {
  // Whether *this* listener muted the track is deliberately not considered: speaking is
  // a fact about the other person, not about what you chose to hear.
  return track.track.sourceType === "microphone"
    && track.subscribed
    && !track.track.muted;
}

function localMicrophoneKey(sourceId: string) {
  return `local:${sourceId}`;
}

function remoteMicrophoneKey(track: RemoteAudioTrackState) {
  return `remote:${track.track.participantId}:${track.track.trackId}`;
}

function roundIntensity(value: number) {
  return Math.round(value * 100) / 100;
}

function setActivityIfChanged(
  setActivity: React.Dispatch<React.SetStateAction<ParticipantVoiceActivityMap>>,
  next: ParticipantVoiceActivityMap,
) {
  setActivity((current) => activityMapsEqual(current, next) ? current : next);
}

function activityMapsEqual(left: ParticipantVoiceActivityMap, right: ParticipantVoiceActivityMap) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => {
    const a = left[key];
    const b = right[key];
    return b != null
      && a.speaking === b.speaking
      && a.intensity === b.intensity
      && a.meterObserved === b.meterObserved;
  });
}
