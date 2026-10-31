import { audioCommands, type AudioMixerState } from "./audio";

/**
 * Whether the listener turned Auto-level on, kept on this machine. The engine starts with
 * it off; the media adapter turns it back on when the app starts.
 */
const AUTO_LEVEL_KEY = "raven.audio.autoLevel";

export function readAutoLevelPreference(): boolean {
  try {
    return window.localStorage.getItem(AUTO_LEVEL_KEY) === "on";
  } catch {
    return false;
  }
}

/** Turn Auto-level on or off and remember the choice. */
export async function setAutoLevel(enabled: boolean): Promise<AudioMixerState> {
  const state = await audioCommands.setAutoLevel(enabled);
  try {
    window.localStorage.setItem(AUTO_LEVEL_KEY, enabled ? "on" : "off");
  } catch {
    // Remembering is best-effort; the engine already has the new setting.
  }
  return state;
}
