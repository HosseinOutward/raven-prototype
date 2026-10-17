import type { AudioSourceState } from "@/lib/audio";
import type { VideoSourceState } from "@/lib/video";

export function isConfirmedMicrophoneActive(source: AudioSourceState) {
  return source.sourceType === "microphone"
    && source.enabled
    && source.publishing
    && source.publishedTrack != null
    && source.runtime.status === "running"
    && !source.channelStrip.mute.muted;
}

export function microphonesToMuteBeforeJoin(sources: AudioSourceState[]) {
  return sources.filter((source) => source.sourceType === "microphone");
}

export function isConfirmedVideoSourceActive(source: VideoSourceState | null) {
  return source != null
    && source.enabled
    && source.publishing
    && source.publishedTrack != null
    // Paused (a shared window is minimized) is still sent: people keep the last picture.
    && (source.runtime.status === "running" || source.runtime.status === "paused");
}

/** Why the user's own share is paused, if it is. A paused share still counts as live. */
export function localSharePause(source: VideoSourceState | null) {
  return source != null && source.runtime.status === "paused"
    ? source.runtime.pausedReason ?? "minimized"
    : null;
}

/**
 * What a local camera or screen source is doing, from the user's side.
 *
 * - `off`: nothing chosen.
 * - `ready`: chosen, but nothing is captured or sent. This is every chosen source
 *   outside a call: the engine only opens the device once there is a call to send to.
 * - `starting`: the device is opening, or it is open and not confirmed as sent yet.
 * - `live`: confirmed capturing and published. Only this means other people see it.
 *   It includes a paused share (minimized window), which goes on sending its last picture.
 * - `error`: chosen, but capture failed. Shown as off, with the reason elsewhere.
 */
export type LocalVideoStatus = "off" | "ready" | "starting" | "live" | "error";

export function localVideoStatus(source: VideoSourceState | null): LocalVideoStatus {
  if (!source || !source.enabled) return "off";
  if (source.runtime.status === "error") return "error";
  if (isConfirmedVideoSourceActive(source)) return "live";
  if (source.runtime.status === "starting" || source.runtime.status === "running") return "starting";
  return "ready";
}

/** The user has turned this source on, whether or not it is being sent yet. */
export function isLocalVideoChosen(status: LocalVideoStatus) {
  return status === "ready" || status === "starting" || status === "live";
}
