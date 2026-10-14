import { describe, expect, test } from "bun:test";
import type { AudioMixerState, AudioSourceState } from "./audio";
import { DeviceSwitchWatcher, devicesInUse, USER_DEVICE_PICK_GRACE_MS, type DevicesInUse } from "./deviceSwitch";

describe("device switch notices", () => {
  test("says nothing about the first device seen", () => {
    const watcher = new DeviceSwitchWatcher();
    expect(watcher.update(devices({ microphone: "Laptop mic", speaker: "Laptop speakers" }), 0)).toEqual([]);
  });

  test("reports a followed system default", () => {
    const watcher = new DeviceSwitchWatcher();
    watcher.update(devices({ microphone: "Laptop mic" }), 0);
    const [notice] = watcher.update(devices({ microphone: "Headset" }), 10_000);
    expect(notice.kind).toBe("microphone");
    expect(notice.title).toBe("Your microphone is now Headset");
    expect(notice.description).toContain("system’s default microphone");
  });

  test("explains a fallback and the return of the chosen device", () => {
    const watcher = new DeviceSwitchWatcher();
    watcher.update(devices({ speaker: "Headphones" }), 0);
    const [lost] = watcher.update(devices({ speaker: "Speakers", speakerFallback: true }), 10_000);
    expect(lost.title).toBe("Sound now plays through Speakers");
    expect(lost.description).toBe("Headphones isn’t available. Raven switches back when it returns.");
    const [back] = watcher.update(devices({ speaker: "Headphones" }), 20_000);
    expect(back.description).toBe("Your chosen speaker is back.");
  });

  test("ignores a moment with no device while it reopens", () => {
    const watcher = new DeviceSwitchWatcher();
    watcher.update(devices({ microphone: "Headset" }), 0);
    expect(watcher.update(devices({}), 1000)).toEqual([]);
    expect(watcher.update(devices({ microphone: "Headset" }), 2000)).toEqual([]);
  });

  test("stays quiet when the chosen device changed, wherever it was picked", () => {
    const watcher = new DeviceSwitchWatcher();
    watcher.update(devices({ microphone: "Laptop mic" }), 0);
    // The choice reaches the state before the capture has reopened on it.
    expect(watcher.update(devices({ microphone: "Laptop mic", microphoneChoice: "headset-id" }), 1000)).toEqual([]);
    expect(watcher.update(devices({ microphone: "Headset", microphoneChoice: "headset-id" }), 1400)).toEqual([]);
  });

  test("stays quiet about a device the user just picked", () => {
    const watcher = new DeviceSwitchWatcher();
    watcher.update(devices({ microphone: "Laptop mic" }), 0);
    watcher.notePick("microphone", 1000);
    expect(watcher.update(devices({ microphone: "Headset" }), 1500)).toEqual([]);
    const later = watcher.update(devices({ microphone: "Laptop mic" }), 1000 + USER_DEVICE_PICK_GRACE_MS);
    expect(later).toHaveLength(1);
  });
});

describe("devices in use", () => {
  test("reads the running microphone and the playing speaker", () => {
    const state = {
      localSources: [
        { sourceType: "microphone", enabled: true, runtime: { status: "running", deviceName: "Headset", fallbackDevice: true } },
      ] as AudioSourceState[],
      session: { playbackStatus: "running", outputDeviceName: "Speakers", outputFallback: false },
    } as AudioMixerState;
    expect(devicesInUse(state, "speakers-id")).toEqual({
      microphone: "Headset",
      microphoneFallback: true,
      microphoneChoice: null,
      speaker: "Speakers",
      speakerFallback: false,
      speakerChoice: "speakers-id",
    });
  });

  test("a stopped capture or speaker is not in use", () => {
    const state = {
      localSources: [
        { sourceType: "microphone", enabled: true, runtime: { status: "inactive", deviceName: "Headset" } },
      ] as AudioSourceState[],
      session: { playbackStatus: "stopped", outputDeviceName: "Speakers", outputFallback: false },
    } as AudioMixerState;
    expect(devicesInUse(state, null)).toMatchObject({ microphone: null, speaker: null });
  });
});

function devices(input: Partial<DevicesInUse>): DevicesInUse {
  return {
    microphone: null,
    microphoneFallback: false,
    microphoneChoice: null,
    speaker: null,
    speakerFallback: false,
    speakerChoice: null,
    ...input,
  };
}
