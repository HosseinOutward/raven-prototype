import type { AudioMixerState } from "@/lib/audio";

/**
 * Raven follows audio devices on its own: a chosen device that disappears is replaced by
 * the system default, it returns when it comes back, and the system default is followed
 * when it moves. These turn such a switch into one short sentence, so a new headset or a
 * dead Bluetooth battery is never a silent change in who hears you or what you hear.
 */

export type SwitchedDeviceKind = "microphone" | "speaker";

export interface DevicesInUse {
  microphone: string | null;
  microphoneFallback: boolean;
  /** The device the user chose (null: the system default). A change is the user's doing. */
  microphoneChoice: string | null;
  speaker: string | null;
  speakerFallback: boolean;
  speakerChoice: string | null;
}

export interface DeviceSwitchNotice {
  kind: SwitchedDeviceKind;
  title: string;
  description: string;
}

/** A switch the user just made in a picker is theirs; it needs no notice. */
export const USER_DEVICE_PICK_GRACE_MS = 5000;

/** The microphone and speaker actually open right now, by name, and what the user chose. */
export function devicesInUse(state: AudioMixerState | null, speakerChoice: string | null): DevicesInUse {
  const microphone = state?.localSources.find(
    (source) => source.sourceType === "microphone"
      && source.enabled
      && source.runtime?.status === "running"
      && Boolean(source.runtime.deviceName),
  );
  const session = state?.session;
  const speakerRunning = session?.playbackStatus === "running" && Boolean(session.outputDeviceName);
  return {
    microphone: microphone?.runtime.deviceName ?? null,
    microphoneFallback: microphone?.runtime.fallbackDevice ?? false,
    microphoneChoice: microphone?.captureDeviceId ?? null,
    speaker: speakerRunning ? session?.outputDeviceName ?? null : null,
    speakerFallback: speakerRunning ? session?.outputFallback ?? false : false,
    speakerChoice,
  };
}

/**
 * Remembers the last device seen for each kind and reports a change to another one. A
 * moment with no device (the capture reopening) is not a change.
 */
export class DeviceSwitchWatcher {
  private last: Record<SwitchedDeviceKind, { name: string; fallback: boolean } | null> = {
    microphone: null,
    speaker: null,
  };
  private choice: Record<SwitchedDeviceKind, string | null | undefined> = {
    microphone: undefined,
    speaker: undefined,
  };
  private pickedAt: Record<SwitchedDeviceKind, number> = { microphone: -Infinity, speaker: -Infinity };

  /** The user picked a device themselves. */
  notePick(kind: SwitchedDeviceKind, nowMs: number) {
    this.pickedAt[kind] = nowMs;
  }

  update(devices: DevicesInUse, nowMs: number): DeviceSwitchNotice[] {
    const notices: DeviceSwitchNotice[] = [];
    for (const kind of ["microphone", "speaker"] as const) {
      const name = kind === "microphone" ? devices.microphone : devices.speaker;
      const fallback = kind === "microphone" ? devices.microphoneFallback : devices.speakerFallback;
      const choice = kind === "microphone" ? devices.microphoneChoice : devices.speakerChoice;
      // A different choice was made somewhere (the dock, the Mixer, a restored preference).
      if (this.choice[kind] !== undefined && this.choice[kind] !== choice) this.notePick(kind, nowMs);
      this.choice[kind] = choice;
      if (!name) continue;
      const previous = this.last[kind];
      this.last[kind] = { name, fallback };
      if (!previous || previous.name === name) continue;
      if (nowMs - this.pickedAt[kind] < USER_DEVICE_PICK_GRACE_MS) continue;
      notices.push(switchNotice(kind, previous, { name, fallback }));
    }
    return notices;
  }
}

function switchNotice(
  kind: SwitchedDeviceKind,
  previous: { name: string; fallback: boolean },
  next: { name: string; fallback: boolean },
): DeviceSwitchNotice {
  const noun = kind === "microphone" ? "microphone" : "speaker";
  const title = kind === "microphone"
    ? `Your microphone is now ${next.name}`
    : `Sound now plays through ${next.name}`;
  let description: string;
  if (next.fallback) {
    description = `${previous.name} isn’t available. Raven switches back when it returns.`;
  } else if (previous.fallback) {
    description = `Your chosen ${noun} is back.`;
  } else {
    description = `Raven follows your system’s default ${noun}. You can pick another from the dock.`;
  }
  return { kind, title, description };
}
