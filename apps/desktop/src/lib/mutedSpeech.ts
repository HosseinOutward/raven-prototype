import { useEffect, useRef, useState } from "react";
import { subscribeAudioMeterChanged, type AudioMeterUpdate, type AudioMixerState } from "@/lib/audio";

/**
 * "You're talking while muted". A muted microphone keeps capturing (hot-mic mute), and
 * while it is muted the engine reports its level from before the mute as `inputMeter`.
 * That level never leaves this machine; it is only compared with these thresholds.
 *
 * A reading counts as speech when the voice detector hears a voice in it, so a keyboard
 * or a cough does not set it off and quiet speech is not missed. Several such meter
 * windows within a second count as talking; a few quiet seconds end it. Without a
 * probability, only a louder level (-42 dB) counts, as it did before voice detection.
 */
export const MUTED_SPEECH_ENTER_RMS_DB = -48;
export const MUTED_SPEECH_MIN_VOICE_PROBABILITY = 0.6;
export const MUTED_SPEECH_ENTER_RMS_DB_WITHOUT_VOICE = -42;
export const MUTED_SPEECH_WINDOW_MS = 1000;
export const MUTED_SPEECH_MIN_LOUD_READINGS = 3;
export const MUTED_SPEECH_RELEASE_MS = 2500;

export class MutedSpeechDetector {
  private loudReadings: number[] = [];
  private talking = false;

  /** Feed one meter update; returns whether the user is talking into a muted mic. */
  process(state: AudioMixerState | null, update: AudioMeterUpdate, nowMs: number): boolean {
    if (!update.sourceId || !state) return this.talking;
    const source = state.localSources.find((candidate) => candidate.id === update.sourceId);
    if (!source || source.sourceType !== "microphone") return this.talking;
    if (!update.inputMeter) return this.reset();

    const voice = update.voiceProbability;
    const speech = voice == null
      ? update.inputMeter.rmsDb >= MUTED_SPEECH_ENTER_RMS_DB_WITHOUT_VOICE
      : update.inputMeter.rmsDb >= MUTED_SPEECH_ENTER_RMS_DB && voice >= MUTED_SPEECH_MIN_VOICE_PROBABILITY;
    if (speech) this.loudReadings.push(nowMs);
    this.loudReadings = this.loudReadings.filter(
      (at) => nowMs - at <= Math.max(MUTED_SPEECH_WINDOW_MS, MUTED_SPEECH_RELEASE_MS),
    );
    const recent = this.loudReadings.filter((at) => nowMs - at <= MUTED_SPEECH_WINDOW_MS).length;
    if (recent >= MUTED_SPEECH_MIN_LOUD_READINGS) {
      this.talking = true;
    } else if (this.talking) {
      const lastLoud = this.loudReadings[this.loudReadings.length - 1];
      if (lastLoud === undefined || nowMs - lastLoud >= MUTED_SPEECH_RELEASE_MS) this.talking = false;
    }
    return this.talking;
  }

  reset() {
    this.loudReadings = [];
    this.talking = false;
    return false;
  }
}

/** Whether the user is talking into a muted microphone right now. */
export function useTalkingWhileMuted(audioState: AudioMixerState | null, muted: boolean) {
  const detectorRef = useRef(new MutedSpeechDetector());
  const audioStateRef = useRef(audioState);
  const [talking, setTalking] = useState(false);
  audioStateRef.current = audioState;

  useEffect(() => {
    if (!muted) {
      detectorRef.current.reset();
      setTalking(false);
      return;
    }
    let mounted = true;
    let unsubscribe: (() => void) | null = null;
    void subscribeAudioMeterChanged((update) => {
      if (!mounted) return;
      setTalking(detectorRef.current.process(audioStateRef.current, update, Date.now()));
    })
      .then((unlisten) => {
        if (!mounted) unlisten();
        else unsubscribe = unlisten;
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
      unsubscribe?.();
      detectorRef.current.reset();
      setTalking(false);
    };
  }, [muted]);

  return talking;
}
