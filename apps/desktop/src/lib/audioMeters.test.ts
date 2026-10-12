import { describe, expect, test } from "bun:test";
import {
  applyAudioMeterUpdate,
  type AudioMeterUpdate,
  type AudioMixerState,
  type ChannelHealthState,
  type MeterState,
} from "./audio";

const meter = (peakDb: number, rmsDb: number): MeterState => ({
  peakDb,
  rmsDb,
  clipping: false,
});

const health = (peakDb: number): ChannelHealthState => ({
  clipping: false,
  clippingCount: 0,
  recentClipping: false,
  tooQuiet: false,
  tooLoud: false,
  nearClipping: false,
  silenceDetected: false,
  peakDb,
  rmsDb: peakDb - 6,
  shortTermLoudnessDb: null,
  latencySamples: 0,
  processorCpuEstimate: null,
  safetyLimiterActive: true,
  safetyLimiterCeilingDb: -1,
});

describe("applyAudioMeterUpdate", () => {
  test("updates one local strip without replacing unrelated state", () => {
    const originalMeter = meter(-90, -90);
    const originalHealth = health(-90);
    const source = {
      id: "source-1",
      channelStrip: { meter: originalMeter, health: originalHealth },
    };
    const otherSource = {
      id: "source-2",
      channelStrip: { meter: originalMeter, health: originalHealth },
    };
    const state = {
      localSources: [source, otherSource],
      remoteTracks: [],
      remoteParticipants: [],
      trackEvents: [],
      localParticipantId: null,
    } as unknown as AudioMixerState;
    const nextMeter = meter(-4, -12);
    const nextHealth = health(-4);
    const update: AudioMeterUpdate = {
      sourceId: "source-1",
      participantId: null,
      trackId: null,
      meter: nextMeter,
      health: nextHealth,
    };

    const next = applyAudioMeterUpdate(state, update);

    expect(next).not.toBe(state);
    expect(next.localSources[0]?.channelStrip.meter).toBe(nextMeter);
    expect(next.localSources[0]?.channelStrip.health).toBe(nextHealth);
    expect(next.localSources[1]).toBe(otherSource);
    expect(next.remoteTracks).toBe(state.remoteTracks);
  });

  test("ignores a meter update for a source that no longer exists", () => {
    const state = {
      localSources: [],
      remoteTracks: [],
      remoteParticipants: [],
      trackEvents: [],
      localParticipantId: null,
    } as AudioMixerState;

    const next = applyAudioMeterUpdate(state, {
      sourceId: "removed-source",
      participantId: null,
      trackId: null,
      meter: meter(-3, -9),
      health: health(-3),
    });

    expect(next).toBe(state);
  });
});
