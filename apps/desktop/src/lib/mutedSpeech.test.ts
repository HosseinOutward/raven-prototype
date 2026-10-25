import { describe, expect, test } from "bun:test";
import type { AudioMeterUpdate, AudioMixerState, AudioSourceState } from "./audio";
import { MUTED_SPEECH_RELEASE_MS, MutedSpeechDetector } from "./mutedSpeech";

describe("talking while muted", () => {
  test("needs several loud readings within a second", () => {
    const detector = new MutedSpeechDetector();
    const state = mixerState();
    expect(detector.process(state, mutedMeter(-30), 0)).toBe(false);
    expect(detector.process(state, mutedMeter(-30), 120)).toBe(false);
    expect(detector.process(state, mutedMeter(-30), 240)).toBe(true);
  });

  test("ignores a single cough and quiet background", () => {
    const detector = new MutedSpeechDetector();
    const state = mixerState();
    expect(detector.process(state, mutedMeter(-20), 0)).toBe(false);
    for (let at = 120; at < 3000; at += 120) {
      expect(detector.process(state, mutedMeter(-55), at)).toBe(false);
    }
  });

  test("ends after a few quiet seconds", () => {
    const detector = new MutedSpeechDetector();
    const state = mixerState();
    for (const at of [0, 120, 240]) detector.process(state, mutedMeter(-30), at);
    expect(detector.process(state, mutedMeter(-60), 1500)).toBe(true);
    expect(detector.process(state, mutedMeter(-60), 240 + MUTED_SPEECH_RELEASE_MS)).toBe(false);
  });

  test("stops as soon as the microphone is unmuted", () => {
    const detector = new MutedSpeechDetector();
    const state = mixerState();
    for (const at of [0, 120, 240]) detector.process(state, mutedMeter(-30), at);
    const unmuted = { ...mutedMeter(-30), inputMeter: null };
    expect(detector.process(state, unmuted, 360)).toBe(false);
  });

  test("a loud keyboard is not speech, quiet speech is", () => {
    const detector = new MutedSpeechDetector();
    const state = mixerState();
    for (const at of [0, 120, 240, 360, 480]) {
      expect(detector.process(state, mutedMeter(-25, 0.1), at)).toBe(false);
    }
    expect(detector.process(state, mutedMeter(-46, 0.95), 600)).toBe(false);
    expect(detector.process(state, mutedMeter(-46, 0.95), 720)).toBe(false);
    expect(detector.process(state, mutedMeter(-46, 0.95), 840)).toBe(true);
  });

  test("falls back to a louder level when there is no voice probability", () => {
    const detector = new MutedSpeechDetector();
    const state = mixerState();
    for (const at of [0, 120, 240, 360]) {
      expect(detector.process(state, mutedMeter(-45), at)).toBe(false);
    }
    for (const at of [480, 600, 720]) detector.process(state, mutedMeter(-40), at);
    expect(detector.process(state, mutedMeter(-40), 840)).toBe(true);
  });

  test("only listens to microphones", () => {
    const detector = new MutedSpeechDetector();
    const state = mixerState("systemAudio");
    for (const at of [0, 120, 240, 360]) {
      expect(detector.process(state, mutedMeter(-20), at)).toBe(false);
    }
  });
});

function mixerState(sourceType: AudioSourceState["sourceType"] = "microphone"): AudioMixerState {
  return {
    localParticipantId: "person#audio",
    localSources: [{ id: "mic-1", sourceType } as AudioSourceState],
    remoteTracks: [],
    remoteParticipants: [],
    trackEvents: [],
  };
}

function mutedMeter(rmsDb: number, voiceProbability?: number): AudioMeterUpdate {
  return {
    voiceProbability,
    sourceId: "mic-1",
    participantId: null,
    trackId: null,
    meter: { peakDb: -90, rmsDb: -90, clipping: false },
    health: null,
    inputMeter: { peakDb: rmsDb + 3, rmsDb, clipping: false },
  };
}
