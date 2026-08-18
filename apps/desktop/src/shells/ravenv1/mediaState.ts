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
    && source.runtime.status === "running";
}
