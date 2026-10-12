import { describe, expect, test } from "bun:test";
import type {
  AudioMeterUpdate,
  AudioMixerState,
  AudioSourceState,
  RemoteAudioTrackState,
} from "./audio";
import {
  ParticipantVoiceActivityTracker,
  resolveParticipantVoicePresentation,
  rmsDbToSpeakingIntensity,
  speakingIntensityPercent,
} from "./speakingActivity";

describe("speaking intensity", () => {
  test("maps the activation range to a clamped visual level", () => {
    expect(rmsDbToSpeakingIntensity(-60)).toBe(0);
    expect(rmsDbToSpeakingIntensity(-52)).toBe(0);
    expect(rmsDbToSpeakingIntensity(-35)).toBe(0.5);
    expect(rmsDbToSpeakingIntensity(-18)).toBe(1);
    expect(rmsDbToSpeakingIntensity(-4)).toBe(1);
    expect(speakingIntensityPercent(0.356)).toBe(36);
    expect(speakingIntensityPercent(3)).toBe(100);
  });

  test("uses LiveKit only before a native meter has been observed", () => {
    expect(resolveParticipantVoicePresentation(true, undefined)).toEqual({
      speaking: true,
      intensity: 0.35,
    });
    expect(resolveParticipantVoicePresentation(true, {
      speaking: false,
      intensity: 0,
      meterObserved: true,
    })).toEqual({ speaking: false, intensity: 0 });
  });
});

describe("participant voice activity", () => {
  test("activates at the threshold and releases after the hysteresis hold", () => {
    const tracker = new ParticipantVoiceActivityTracker();
    const state = mixerState([localMicrophone()]);

    expect(tracker.processMeter(state, localMeter(-52), 0, "person")["person"]?.speaking).toBe(true);
    expect(tracker.processMeter(state, localMeter(-57), 100, "person")["person"]?.speaking).toBe(true);
    expect(tracker.processMeter(state, localMeter(-57), 339, "person")["person"]?.speaking).toBe(true);
    expect(tracker.processMeter(state, localMeter(-57), 340, "person")["person"]).toEqual({
      speaking: false,
      intensity: 0,
      meterObserved: true,
    });
  });

  test("cancels a pending release inside the hysteresis band", () => {
    const tracker = new ParticipantVoiceActivityTracker();
    const state = mixerState([localMicrophone()]);

    tracker.processMeter(state, localMeter(-30), 0);
    tracker.processMeter(state, localMeter(-60), 100);
    tracker.processMeter(state, localMeter(-54), 220);

    expect(tracker.processMeter(state, localMeter(-60), 400)["person"]?.speaking).toBe(true);
  });

  test("aggregates normalized remote sidecars by their loudest active microphone", () => {
    const tracker = new ParticipantVoiceActivityTracker();
    const first = remoteMicrophone("track-1");
    const second = remoteMicrophone("track-2");
    const state = mixerState([], [first, second]);

    tracker.processMeter(state, remoteMeter("track-1", -35), 0);
    const activity = tracker.processMeter(state, remoteMeter("track-2", -18), 0);

    expect(activity["remote-person"]).toEqual({
      speaking: true,
      intensity: 1,
      meterObserved: true,
    });
  });

  test("starts tracking a remote voice after its owner unmutes", () => {
    const tracker = new ParticipantVoiceActivityTracker();
    const muted = remoteMicrophone("track-1");
    muted.track.muted = true;

    expect(tracker.processMeter(mixerState([], [muted]), remoteMeter("track-1", -20), 0)).toEqual({});

    const unmuted = {
      ...muted,
      track: { ...muted.track, muted: false },
    };
    expect(
      tracker.processMeter(mixerState([], [unmuted]), remoteMeter("track-1", -20), 1)["remote-person"],
    ).toEqual({
      speaking: true,
      intensity: 0.94,
      meterObserved: true,
    });
  });

  test("keeps showing a remote speaker the listener muted locally", () => {
    const tracker = new ParticipantVoiceActivityTracker();
    const locallyMuted = remoteMicrophone("track-1");
    locallyMuted.receiverChannelStrip.mute.muted = true;

    // The strip meter is post-fader (silent), the received level is not.
    const update = { ...remoteMeter("track-1", -90), inputMeter: { peakDb: -17, rmsDb: -20, clipping: false } };

    expect(tracker.processMeter(mixerState([], [locallyMuted]), update, 0)["remote-person"]).toEqual({
      speaking: true,
      intensity: 0.94,
      meterObserved: true,
    });
  });

  test("ignores the listener's own fader when deciding a remote voice is active", () => {
    const tracker = new ParticipantVoiceActivityTracker();
    const state = mixerState([], [remoteMicrophone("track-1")]);

    // Turned down by 40 dB locally: quiet on the strip, clearly speech as received.
    const turnedDown = { ...remoteMeter("track-1", -64), inputMeter: { peakDb: -21, rmsDb: -24, clipping: false } };
    expect(tracker.processMeter(state, turnedDown, 0)["remote-person"]?.speaking).toBe(true);

    // Older engines send no received level; the strip meter is still honoured.
    expect(tracker.processMeter(state, remoteMeter("track-1", -20), 10)["remote-person"]?.speaking).toBe(true);
  });

  test("clears speaking immediately when a microphone becomes muted", () => {
    const tracker = new ParticipantVoiceActivityTracker();
    const source = localMicrophone();
    const state = mixerState([source]);
    tracker.processMeter(state, localMeter(-20), 0);

    const muted = mixerState([{
      ...source,
      channelStrip: {
        ...source.channelStrip,
        mute: { ...source.channelStrip.mute, muted: true },
      },
    }]);

    expect(tracker.reconcile(muted)["person"]).toEqual({
      speaking: false,
      intensity: 0,
      meterObserved: true,
    });
    expect(tracker.reconcile(mixerState([]))).toEqual({});
  });

  test("maps the local native source owner to the signed-in user", () => {
    const tracker = new ParticipantVoiceActivityTracker();
    const source = { ...localMicrophone(), ownerId: "native-random-owner" };

    expect(
      tracker.processMeter(mixerState([source]), localMeter(-20), 0, "signed-in-user")
        ["signed-in-user"]?.speaking,
    ).toBe(true);
  });
});

function mixerState(
  localSources: AudioSourceState[] = [],
  remoteTracks: RemoteAudioTrackState[] = [],
): AudioMixerState {
  return {
    localParticipantId: "person#audio",
    localSources,
    remoteTracks,
    remoteParticipants: [],
    trackEvents: [],
  };
}

function localMicrophone(): AudioSourceState {
  return {
    id: "mic-1",
    ownerId: "person#audio",
    sourceType: "microphone",
    displayName: "Microphone",
    captureDeviceId: null,
    enabled: true,
    publishing: true,
    runtime: {} as AudioSourceState["runtime"],
    channelStrip: {
      mute: { muted: false, mutedByUser: false },
    } as AudioSourceState["channelStrip"],
    publishedTrack: {
      trackId: "local-track",
      participantId: "person#audio",
      sourceType: "microphone",
      muted: false,
    } as AudioSourceState["publishedTrack"],
  };
}

function remoteMicrophone(trackId: string): RemoteAudioTrackState {
  return {
    track: {
      trackId,
      participantId: "remote-person#audio",
      sourceType: "microphone",
      muted: false,
    },
    receiverChannelStrip: {
      mute: { muted: false, mutedByUser: false },
    },
    subscribed: true,
  } as RemoteAudioTrackState;
}

function localMeter(rmsDb: number): AudioMeterUpdate {
  return {
    sourceId: "mic-1",
    participantId: null,
    trackId: null,
    meter: { peakDb: rmsDb + 3, rmsDb, clipping: false },
    health: null,
  };
}

function remoteMeter(trackId: string, rmsDb: number): AudioMeterUpdate {
  return {
    sourceId: null,
    participantId: "remote-person#audio",
    trackId,
    meter: { peakDb: rmsDb + 3, rmsDb, clipping: false },
    health: null,
  };
}
