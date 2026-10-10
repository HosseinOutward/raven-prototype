import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const VIDEO_STATE_CHANGED_EVENT = "video-state-changed";

export type VideoSourceId = string;
export type PublishedVideoTrackId = string;

export type VideoSourceKind = "camera" | "display" | "window";
export type VideoSourceRuntimeStatus = "inactive" | "starting" | "running" | "error";
export type VideoTrackSource = "camera" | "screenshare";
export type SelfPreviewMode = "local" | "rtc";
export type VideoPresentationProfile = "efficiency" | "balanced" | "quality";
export type VideoConnectionQuality = "excellent" | "good" | "poor" | "lost" | "unknown";
export type VideoQualityProfileId =
  | "presentation"
  | "high"
  | "highMotion"
  | "balanced"
  | "low"
  | "custom";

export interface VideoQualityProfile {
  profileId: VideoQualityProfileId;
  maxPixels: number;
  width: number;
  height: number;
  fps: number;
}

export const VIDEO_PROFILE_PRESETS = {
  presentation: {
    profileId: "presentation",
    maxPixels: 1920 * 1080,
    width: 1920,
    height: 1080,
    fps: 10,
  },
  high: {
    profileId: "high",
    maxPixels: 1920 * 1080,
    width: 1920,
    height: 1080,
    fps: 30,
  },
  highMotion: {
    profileId: "highMotion",
    maxPixels: 1280 * 720,
    width: 1280,
    height: 720,
    fps: 60,
  },
  balanced: {
    profileId: "balanced",
    maxPixels: 1280 * 720,
    width: 1280,
    height: 720,
    fps: 30,
  },
  low: {
    profileId: "low",
    maxPixels: 854 * 480,
    width: 854,
    height: 480,
    fps: 15,
  },
} satisfies Record<Exclude<VideoQualityProfileId, "custom">, VideoQualityProfile>;

export const DEFAULT_VIDEO_PROFILE: VideoQualityProfile = VIDEO_PROFILE_PRESETS.balanced;

export interface VideoSourceRuntimeState {
  status: VideoSourceRuntimeStatus;
  width: number | null;
  height: number | null;
  fps: number | null;
  error: string | null;
  updatedAt: string | null;
}

export interface PublishedVideoTrack {
  trackId: PublishedVideoTrackId;
  webrtcTrackId: string;
  source: VideoTrackSource;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface VideoSourceState {
  id: VideoSourceId;
  kind: VideoSourceKind;
  displayName: string;
  targetId: string;
  processId: number | null;
  enabled: boolean;
  publishing: boolean;
  profile: VideoQualityProfile;
  runtime: VideoSourceRuntimeState;
  linkedAudioSourceId: string | null;
  publishedTrack: PublishedVideoTrack | null;
}

export interface VideoMixerState {
  connected: boolean;
  localSources: VideoSourceState[];
  viewerConnected: boolean;
  selfPreviewMode: SelfPreviewMode;
  presentation: VideoPresentationSettings;
  participants: VideoParticipantState[];
  remoteTracks: RemoteVideoTrackState[];
}

export interface VideoPresentationSettings {
  profile: VideoPresentationProfile;
}

export interface VideoParticipantState {
  participantId: string;
  displayName: string;
  isLocal: boolean;
  audioMuted: boolean;
  speaking: boolean;
  connectionQuality: VideoConnectionQuality;
}

export interface RemoteVideoTrackState {
  streamId: string;
  participantId: string;
  displayName: string;
  source: VideoTrackSource;
  muted: boolean;
  subscribed: boolean;
  desired: boolean;
  isSelf: boolean;
}

export interface VideoStreamEndpoint {
  baseUrl: string;
}

export interface CameraDevice {
  id: string;
  name: string;
}

export interface DisplayTarget {
  id: string;
  name: string;
  width: number;
  height: number;
  isPrimary: boolean;
  thumbnailDataUrl: string | null;
}

export interface WindowTarget {
  id: string;
  title: string;
  appName: string;
  processId: number;
  width: number;
  height: number;
  iconDataUrl: string | null;
  thumbnailDataUrl: string | null;
}

export interface NativeVideoCapabilityReport {
  os: string;
  issues: string[];
  supportedSourceKinds: VideoSourceKind[];
  supportsCamera: boolean;
  supportsDisplayCapture: boolean;
  supportsWindowCapture: boolean;
  supportsDisplayAudio: boolean;
  supportsWindowAudio: boolean;
}

export interface VideoNetworkTotals {
  cameraSentBytes: number;
  screenShareSentBytes: number;
  cameraReceivedBytes: number;
  screenShareReceivedBytes: number;
}

export interface VideoQualityDimensions {
  width: number;
  height: number;
  fps: number;
}

export interface VideoScreenShareTransmitQuality {
  configured: VideoQualityDimensions;
  maxBitrateBps: number;
  outbound: (VideoQualityDimensions & { targetBitrateBps: number; limitation: string }) | null;
  remoteLossFraction: number | null;
  roundTripTimeMs: number | null;
}

export interface VideoScreenShareReceiveQuality {
  inbound: VideoQualityDimensions | null;
  lossFraction: number | null;
}

/**
 * Native WebRTC quality measurements. These describe the actual encoded and decoded
 * screen-share streams, not the local JPEG preview used by the Raven interface.
 */
export interface VideoQualityReport {
  screenShareTransmit: VideoScreenShareTransmitQuality | null;
  screenShareReceive: VideoScreenShareReceiveQuality | null;
}

export type VideoStateUnsubscribe = () => void;

export const videoCommands = {
  getState: () => invoke<VideoMixerState>("video_get_state"),

  getCapabilities: () => invoke<NativeVideoCapabilityReport>("video_get_capabilities"),

  getNetworkTotals: () => invoke<VideoNetworkTotals>("video_get_network_totals"),

  getQualityReport: () => invoke<VideoQualityReport>("video_get_quality_report"),

  getStreamEndpoint: () => invoke<VideoStreamEndpoint>("video_get_stream_endpoint"),

  setLocalPreviewEnabled: (enabled: boolean) =>
    invoke<void>("video_set_local_preview_enabled", { enabled }),

  setSelfPreviewMode: (mode: SelfPreviewMode) =>
    invoke<VideoMixerState>("video_set_self_preview_mode", { mode }),

  setPresentationProfile: (profile: VideoPresentationProfile) =>
    invoke<VideoMixerState>("video_set_presentation_profile", { profile }),

  setRemoteVideoReceiving: (participantId: string, source: VideoTrackSource, receiving: boolean) =>
    invoke<VideoMixerState>("video_set_remote_video_receiving", { participantId, source, receiving }),

  /** Connect Rust's video publisher and selective viewer roles. */
  connectRoom: (url: string, token: string, viewerToken: string) =>
    invoke<VideoMixerState>("video_connect_room", { url, token, viewerToken }),

  /** Disconnect the native video sidecar (on leaving the nest). */
  disconnectRoom: () => invoke<VideoMixerState>("video_disconnect_room"),

  // Picker enumeration.
  listCameras: () => invoke<CameraDevice[]>("video_list_cameras"),
  listDisplays: () => invoke<DisplayTarget[]>("video_list_displays"),
  listWindows: () => invoke<WindowTarget[]>("video_list_windows"),

  /** Start (and publish) a camera capture. */
  startCamera: (cameraId: string, displayName: string, profile: VideoQualityProfile = DEFAULT_VIDEO_PROFILE) =>
    invoke<VideoMixerState>("video_start_camera", { cameraId, displayName, profile }),

  /**
   * Share a whole display/monitor. When `withSystemAudio` is true, the system audio is
   * captured natively and appears as a channel in the audio mixer.
   */
  startDisplayShare: (
    displayId: string,
    displayName: string,
    withSystemAudio: boolean,
    profile: VideoQualityProfile = DEFAULT_VIDEO_PROFILE,
    sourceWidth: number = 0,
    sourceHeight: number = 0,
  ) =>
    invoke<VideoMixerState>("video_start_display_share", {
      displayId,
      displayName,
      withSystemAudio,
      profile,
      sourceWidth,
      sourceHeight,
    }),

  /**
   * Share a single application window. When `withAppAudio` is true, that app's audio is
   * captured (by process id) and appears as a channel in the audio mixer.
   */
  startWindowShare: (
    windowId: string,
    processId: number,
    displayName: string,
    withAppAudio: boolean,
    profile: VideoQualityProfile = DEFAULT_VIDEO_PROFILE,
    sourceWidth: number = 0,
    sourceHeight: number = 0,
  ) =>
    invoke<VideoMixerState>("video_start_window_share", {
      windowId,
      processId,
      displayName,
      withAppAudio,
      profile,
      sourceWidth,
      sourceHeight,
    }),

  /** Change the capture profile for an active source; native capture reconciles/restarts. */
  setSourceProfile: (sourceId: VideoSourceId, profile: VideoQualityProfile) =>
    invoke<VideoMixerState>("video_set_source_profile", { sourceId, profile }),

  /** Stop a local video source (and tear down any linked audio source). */
  stopSource: (sourceId: VideoSourceId) =>
    invoke<VideoMixerState>("video_stop_source", { sourceId }),
};

export async function subscribeVideoStateChanged(
  onState: (state: VideoMixerState) => void,
): Promise<VideoStateUnsubscribe> {
  return listen<VideoMixerState>(VIDEO_STATE_CHANGED_EVENT, (event) => onState(event.payload));
}

export function videoStreamUrl(endpoint: VideoStreamEndpoint | null, streamId: string | null | undefined) {
  return endpoint && streamId ? `${endpoint.baseUrl}/${streamId}.mjpg` : undefined;
}
