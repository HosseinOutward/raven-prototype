import { useMemo, useRef } from "react";
import {
  type SelfPreviewMode,
  type VideoConnectionQuality,
  type VideoMixerState,
  type VideoStreamEndpoint,
  type VideoTrackSource,
  videoStreamUrl,
} from "@/lib/video";

export type NativeMediaTile = {
  key: string;
  participantId: string;
  displayName: string;
  isLocal: boolean;
  source: VideoTrackSource;
  streamUrl?: string;
  mediaError?: string;
  audioMuted: boolean;
  cameraEnabled: boolean;
  cameraPublished: boolean;
  screenSharing: boolean;
  speaking: boolean;
  connectionQuality: VideoConnectionQuality;
  videoAvailable: boolean;
  shareStartedAt?: number;
  loading?: boolean;
};

export function useNativeMediaTiles(
  state: VideoMixerState | null,
  endpoint: VideoStreamEndpoint | null,
  selfPreviewMode: SelfPreviewMode,
) {
  const shareStartOrderRef = useRef(new Map<string, number>());
  const shareSequenceRef = useRef(0);

  const tiles = useMemo(() => {
    if (!state) return [];
    const localParticipant = state.participants.find((participant) => participant.isLocal);
    const participants = localParticipant
      ? state.participants
      : [{
          participantId: "local",
          displayName: "You",
          isLocal: true,
          audioMuted: true,
          speaking: false,
          connectionQuality: "unknown" as const,
        }, ...state.participants];
    const localCamera = state.localSources.find((source) => source.kind === "camera" && source.publishing);
    const localScreen = state.localSources.find(
      (source) => (source.kind === "display" || source.kind === "window") && source.publishing,
    );
    const activeShareKeys = new Set<string>();
    const next: NativeMediaTile[] = [];

    for (const participant of participants) {
      const cameraTrack = state.remoteTracks.find(
        (track) => track.participantId === participant.participantId && track.source === "camera",
      );
      const screenTrack = state.remoteTracks.find(
        (track) => track.participantId === participant.participantId && track.source === "screenshare",
      );
      const cameraEnabled = participant.isLocal ? Boolean(localCamera) : Boolean(cameraTrack && !cameraTrack.muted);
      const screenSharing = participant.isLocal ? Boolean(localScreen) : Boolean(screenTrack && !screenTrack.muted);
      const cameraStreamId = selectPresentationStreamId(
        participant.isLocal,
        selfPreviewMode,
        localCamera?.id,
        cameraTrack,
      );
      const screenStreamId = selectPresentationStreamId(
        participant.isLocal,
        selfPreviewMode,
        localScreen?.id,
        screenTrack,
      );
      const cameraStreamUrl = endpoint && cameraStreamId ? videoStreamUrl(endpoint, cameraStreamId) : undefined;
      const screenStreamUrl = endpoint && screenStreamId ? videoStreamUrl(endpoint, screenStreamId) : undefined;

      if (cameraTrack || (participant.isLocal && localCamera) || !screenSharing) {
        next.push({
          key: `${participant.participantId}:camera`,
          participantId: participant.participantId,
          displayName: participant.isLocal ? "You" : participant.displayName,
          isLocal: participant.isLocal,
          source: "camera",
          streamUrl: cameraStreamUrl,
          mediaError: participant.isLocal && localCamera?.runtime.status === "error"
            ? localCamera.runtime.error ?? "Camera capture could not start"
            : undefined,
          audioMuted: participant.audioMuted,
          cameraEnabled,
          cameraPublished: participant.isLocal ? Boolean(localCamera?.publishedTrack) : Boolean(cameraTrack),
          screenSharing,
          speaking: participant.speaking,
          connectionQuality: participant.connectionQuality,
          videoAvailable: Boolean(cameraStreamUrl),
          loading: cameraEnabled && !cameraStreamUrl,
        });
      }

      if (screenSharing) {
        const key = `${participant.participantId}:screen`;
        activeShareKeys.add(key);
        if (!shareStartOrderRef.current.has(key)) {
          shareStartOrderRef.current.set(key, ++shareSequenceRef.current);
        }
        next.push({
          key,
          participantId: participant.participantId,
          displayName: participant.isLocal ? "You" : participant.displayName,
          isLocal: participant.isLocal,
          source: "screenshare",
          streamUrl: screenStreamUrl,
          mediaError: participant.isLocal && localScreen?.runtime.status === "error"
            ? localScreen.runtime.error ?? "Screen capture could not start"
            : undefined,
          audioMuted: participant.audioMuted,
          cameraEnabled,
          cameraPublished: participant.isLocal ? Boolean(localCamera?.publishedTrack) : Boolean(cameraTrack),
          screenSharing: true,
          speaking: participant.speaking,
          connectionQuality: participant.connectionQuality,
          videoAvailable: Boolean(screenStreamUrl),
          loading: !screenStreamUrl,
          shareStartedAt: shareStartOrderRef.current.get(key),
        });
      }
    }

    for (const key of shareStartOrderRef.current.keys()) {
      if (!activeShareKeys.has(key)) shareStartOrderRef.current.delete(key);
    }
    return next;
  }, [endpoint, selfPreviewMode, state]);

  return { tiles };
}

export function selectPresentationStreamId(
  isLocal: boolean,
  selfPreviewMode: SelfPreviewMode,
  localSourceId: string | undefined,
  track: VideoMixerState["remoteTracks"][number] | undefined,
) {
  if (isLocal && selfPreviewMode === "local") {
    return localSourceId ? `local-${localSourceId}` : undefined;
  }
  return track && track.subscribed && track.desired && !track.muted ? track.streamId : undefined;
}
