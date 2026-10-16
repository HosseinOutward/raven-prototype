import { describe, expect, test } from "bun:test";
import type { AudioMixerState, AudioSourceState, AudioSourceType, RemoteAudioTrackState } from "@/lib/audio";
import {
  audioSourceName,
  gainDbToVolumePercent,
  groupAudioSatellites,
  splitSatellites,
  volumePercentToGainDb,
} from "./audioSatellites";

const SARA = "0f3c9a1b-2d4e-4f6a-8b7c-9d0e1f2a3b4c";
const SARA_USER = "0f3c9a1b2d4e4f6a8b7c9d0e1f2a3b4c";

describe("groupAudioSatellites", () => {
  test("gives everything but a person's microphone a satellite, keyed by user id", () => {
    const state = mixerState([], [
      remote("mic-a", "microphone", { createdAt: "2026-10-16T10:00:00Z" }),
      remote("spotify", "appAudio", { appName: "Spotify", appIconDataUrl: "data:image/png;base64,x" }),
      remote("mic-b", "microphone", { createdAt: "2026-10-16T10:05:00Z", deviceName: "Interface 2" }),
    ]);

    const { remote: byPerson } = groupAudioSatellites(state, { [`remote:${SARA}#audio:spotify`]: { active: true, intensity: 0.5 } });
    const satellites = byPerson.get(SARA_USER) ?? [];
    expect(satellites.map((satellite) => satellite.name)).toEqual(["Spotify", "Interface 2"]);
    expect(satellites[0]).toMatchObject({ active: true, intensity: 0.5, iconUrl: "data:image/png;base64,x", remote: { trackId: "spotify" } });
  });

  test("without creation times, the microphone that registered first is the person's own", () => {
    const state = mixerState([], [
      remote("ffff-main", "microphone", { displayName: "Microphone" }),
      remote("0000-extra", "microphone", { displayName: "Second mic" }),
    ]);
    const satellites = groupAudioSatellites(state, {}).remote.get(SARA_USER) ?? [];
    expect(satellites.map((satellite) => satellite.name)).toEqual(["Second mic"]);
  });

  test("a person with only a microphone has no satellites", () => {
    const state = mixerState([], [remote("mic-a", "microphone")]);
    expect(groupAudioSatellites(state, {}).remote.size).toBe(0);
  });

  test("shows your own published extra sources, naming a share's sound safely", () => {
    const state = mixerState([
      local("mic", "microphone"),
      local("system", "systemAudio"),
      local("unsent", "appAudio", { publishing: false }),
      local("window", "appAudio", { appName: "Excel" }),
    ]);

    const { local: own } = groupAudioSatellites(state, {}, new Set(["window"]));
    expect(own.map((satellite) => [satellite.localSourceId, satellite.name, satellite.shareLinked])).toEqual([
      ["system", "System audio", false],
      ["window", "Your screen’s sound", true],
    ]);
  });

  test("carries the sender's mute and this listener's own settings", () => {
    const track = remote("spotify", "appAudio", { appName: "Spotify", muted: true });
    track.receiverChannelStrip.mute.muted = true;
    track.receiverChannelStrip.gainDb = -6;
    const [satellite] = groupAudioSatellites(mixerState([], [track]), {}).remote.get(SARA_USER) ?? [];
    expect(satellite).toMatchObject({ muted: true, mutedForMe: true, gainDb: -6 });
  });
});

describe("audioSourceName", () => {
  test("names app audio after the app", () => {
    expect(audioSourceName({ sourceType: "appAudio", displayName: "x", deviceName: null, appName: "Spotify" })).toBe("Spotify");
    expect(audioSourceName({ sourceType: "appAudio", displayName: "x", deviceName: null, appName: " " })).toBe("App audio");
    expect(audioSourceName({ sourceType: "systemAudio", displayName: "Display 1 audio", deviceName: null, appName: null })).toBe("System audio");
  });
});

describe("splitSatellites", () => {
  test("shows up to three, then two and +N", () => {
    expect(splitSatellites([1, 2, 3])).toEqual({ shown: [1, 2, 3], overflow: [] });
    expect(splitSatellites([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2], overflow: [3, 4, 5] });
  });
});

describe("volume", () => {
  test("maps the strip gain to a percentage and back", () => {
    expect(gainDbToVolumePercent(0)).toBe(100);
    expect(gainDbToVolumePercent(-60)).toBe(0);
    expect(gainDbToVolumePercent(12)).toBe(200);
    expect(volumePercentToGainDb(100)).toBe(0);
    expect(volumePercentToGainDb(0)).toBe(-60);
    expect(gainDbToVolumePercent(volumePercentToGainDb(50))).toBe(50);
  });
});

function mixerState(localSources: AudioSourceState[] = [], remoteTracks: RemoteAudioTrackState[] = []): AudioMixerState {
  return { localParticipantId: "me#audio", localSources, remoteTracks, remoteParticipants: [], trackEvents: [] } as unknown as AudioMixerState;
}

function remote(trackId: string, sourceType: AudioSourceType, extra: Record<string, unknown> = {}): RemoteAudioTrackState {
  return {
    track: {
      trackId,
      participantId: `${SARA}#audio`,
      sourceType,
      displayName: trackId,
      deviceName: null,
      appName: null,
      appIconDataUrl: null,
      muted: false,
      createdAt: null,
      ...extra,
    },
    receiverChannelStrip: { gainDb: 0, mute: { muted: false, mutedByUser: false } },
    subscribed: true,
  } as unknown as RemoteAudioTrackState;
}

function local(id: string, sourceType: AudioSourceType, extra: { publishing?: boolean; appName?: string } = {}): AudioSourceState {
  return {
    id,
    ownerId: "me#audio",
    sourceType,
    displayName: id,
    enabled: true,
    publishing: extra.publishing ?? true,
    channelStrip: { mute: { muted: false, mutedByUser: false } },
    publishedTrack: { trackId: `t-${id}`, sourceType, displayName: id, deviceName: null, appName: extra.appName ?? null, appIconDataUrl: null, muted: false },
  } as unknown as AudioSourceState;
}
