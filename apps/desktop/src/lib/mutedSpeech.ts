import { useEffect, useRef, useState } from "react";
import { subscribeAudioMeterChanged, type AudioMeterUpdate, type AudioMixerState } from "@/lib/audio";

/**
 * "You're talking while muted". A muted microphone keeps capturing (hot-mic mute), and
 * while it is muted the engine reports its level from before the mute as `inputMeter`.
 * That level never leaves this machine; it is only compared with these thresholds.
 *
 * Louder than voice activity (-52 dB) on purpose: noise suppression has already run, and
 * a cough or a keyboard should not set it off. Several loud meter windows within a
 * second count as talking; a few quiet seconds end it.
 */
export const MUTED_SPEECH_ENTER_RMS_DB = -42;
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

    if (update.inputMeter.rmsDb >= MUTED_SPEECH_ENTER_RMS_DB) this.loudReadings.push(nowMs);
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
