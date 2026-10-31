import { audioCommands, type AudioMixerState } from "./audio";

/**
 * The one volume for everything Raven plays: people, shared audio and sound cues. It sets
 * how loud Raven is; the per-person faders set the balance, and deafen turns it all off.
 * The engine owns the saved value (`output-volume.json` in the app data folder) and has
 * it from the first state snapshot; the UI only sends changes.
 */
export const OUTPUT_VOLUME_MIN_DB = -40;
export const OUTPUT_VOLUME_MAX_DB = 6;
export const OUTPUT_VOLUME_STEP_DB = 1;
export const OUTPUT_VOLUME_PAGE_DB = 6;
/** Spacing of volume updates while the control is being dragged. */
export const OUTPUT_VOLUME_LIVE_INTERVAL_MS = 40;

/** Older versions kept the volume in the WebView's storage, inside the media settings. */
const LEGACY_SETTINGS_KEY = "raven.mediaSettings";

/** A saved or typed volume in whole range, or 0 dB (unchanged) when it is not a number. */
export function normalizeOutputVolumeDb(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(OUTPUT_VOLUME_MAX_DB, Math.max(OUTPUT_VOLUME_MIN_DB, value));
}

export function formatOutputVolume(volumeDb: number): string {
  const rounded = Math.round(volumeDb);
  if (rounded === 0) return "0 dB";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)} dB`;
}

/**
 * What a key does to the volume, or null when it is not one the control handles:
 * arrows move 1 dB, Page Up and Down 6 dB, Home is the quietest and End the loudest.
 */
export function volumeAfterKey(volumeDb: number, key: string): number | null {
  switch (key) {
    case "ArrowUp":
    case "ArrowRight":
      return normalizeOutputVolumeDb(volumeDb + OUTPUT_VOLUME_STEP_DB);
    case "ArrowDown":
    case "ArrowLeft":
      return normalizeOutputVolumeDb(volumeDb - OUTPUT_VOLUME_STEP_DB);
    case "PageUp":
      return normalizeOutputVolumeDb(volumeDb + OUTPUT_VOLUME_PAGE_DB);
    case "PageDown":
      return normalizeOutputVolumeDb(volumeDb - OUTPUT_VOLUME_PAGE_DB);
    case "Home":
      return OUTPUT_VOLUME_MIN_DB;
    case "End":
      return OUTPUT_VOLUME_MAX_DB;
    default:
      return null;
  }
}

/** A volume an older version saved in the WebView, or null when there is none. */
export function readLegacyOutputVolume(): number | null {
  try {
    const raw = window.localStorage.getItem(LEGACY_SETTINGS_KEY);
    if (!raw) return null;
    const value = (JSON.parse(raw) as { outputVolumeDb?: unknown }).outputVolumeDb;
    return typeof value === "number" ? normalizeOutputVolumeDb(value) : null;
  } catch {
    return null;
  }
}

function clearLegacyOutputVolume() {
  try {
    const raw = window.localStorage.getItem(LEGACY_SETTINGS_KEY);
    if (!raw) return;
    const settings = JSON.parse(raw) as Record<string, unknown>;
    if (!("outputVolumeDb" in settings)) return;
    delete settings.outputVolumeDb;
    window.localStorage.setItem(LEGACY_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Best-effort: a leftover value is ignored once the engine has its own.
  }
}

/**
 * One-time move of a volume kept in the WebView to the engine: when the engine has no saved
 * volume yet, send the old one, then drop the old key. Returns the new state, or null when
 * nothing was sent.
 */
export async function migrateLegacyOutputVolume(
  legacyDb: number | null,
  engineHasSaved: boolean,
  send: (volumeDb: number) => Promise<AudioMixerState> = commitOutputVolume,
): Promise<AudioMixerState | null> {
  if (legacyDb === null) return null;
  let state: AudioMixerState | null = null;
  if (!engineHasSaved && legacyDb !== 0) state = await send(legacyDb);
  clearLegacyOutputVolume();
  return state;
}

let liveTimer: number | null = null;
let livePending: number | null = null;

function stopLive() {
  if (liveTimer !== null) window.clearInterval(liveTimer);
  liveTimer = null;
  livePending = null;
}

/**
 * Move the volume while it is being dragged: the first change goes out at once and later
 * ones at a steady rate with the latest position, so it is heard as it moves. Nothing is
 * saved until `commitOutputVolume`.
 */
export function previewOutputVolume(volumeDb: number) {
  const next = normalizeOutputVolumeDb(volumeDb);
  if (liveTimer !== null) {
    livePending = next;
    return;
  }
  void audioCommands.setOutputVolume(next, false).catch(() => undefined);
  liveTimer = window.setInterval(() => {
    if (livePending === null) {
      stopLive();
      return;
    }
    const pending = livePending;
    livePending = null;
    void audioCommands.setOutputVolume(pending, false).catch(() => undefined);
  }, OUTPUT_VOLUME_LIVE_INTERVAL_MS);
}

/** Set the volume for good: send the final value, which the engine saves. */
export async function commitOutputVolume(volumeDb: number): Promise<AudioMixerState> {
  const next = normalizeOutputVolumeDb(volumeDb);
  stopLive();
  return audioCommands.setOutputVolume(next, true);
}
