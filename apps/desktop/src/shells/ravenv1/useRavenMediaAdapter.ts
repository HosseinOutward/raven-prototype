import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type UserPresenceState, type UserReachability } from "@/lib/api";
import {
  AppAudioSource,
  audioCommands,
  AudioInputDevice,
  AudioMixerState,
  AudioOutputDevice,
  AudioSourceState,
  NativeAudioCapabilityReport,
  subscribeAudioStateChanged,
  WebRtcAudioProcessingSettings,
} from "@/lib/audio";
import {
  CameraDevice,
  DEFAULT_VIDEO_PROFILE,
  DisplayTarget,
  NativeVideoCapabilityReport,
  type SelfPreviewMode,
  subscribeVideoStateChanged,
  videoCommands,
  type VideoPresentationProfile,
  type VideoStreamEndpoint,
  VideoMixerState,
  VideoQualityProfile,
  VideoSourceState,
  WindowTarget,
} from "@/lib/video";
import {
  type ParticipantVoiceActivityMap,
  useParticipantVoiceActivity,
} from "@/lib/speakingActivity";
import type { NetworkActivityCategory, NetworkActivityDirection, NetworkActivitySettings } from "./networkActivity";
import {
  isConfirmedMicrophoneActive,
  isConfirmedVideoSourceActive,
  microphonesToMuteBeforeJoin,
} from "./mediaState";
import { presenceForActiveNest } from "./state";

export type SelfMediaPreviewMode = SelfPreviewMode;

export type {
  MeasuredNetworkCategory,
  NetworkActivityCategory,
  NetworkActivityDirection,
  NetworkActivitySettings,
  NetworkTransferRate,
} from "./networkActivity";

const NEST_HEARTBEAT_INTERVAL_MS = 5000;
const NEST_HEARTBEAT_TIMEOUT_MS = 8000;
const MEDIA_SETTINGS_KEY = "raven.mediaSettings";

export type MediaAdapterPhase = "idle" | "joining" | "connected" | "leaving" | "error";
export type DeafenMode = "instant" | "bandwidthSaver";
export type MediaErrorKind =
  | "permission_denied"
  | "missing_device"
  | "capture_failure"
  | "rtc_failure"
  | "publish_failure"
  | "unsupported";

export interface MediaAdapterError {
  message: string;
  kind: MediaErrorKind;
  action: string;
}

export interface ParticipantMediaState {
  participantId: string;
  displayName: string;
  isLocal: boolean;
  audioMuted: boolean;
  videoEnabled: boolean;
  screenSharing: boolean;
  speaking: boolean;
}

export interface RavenMediaAdapterState {
  phase: MediaAdapterPhase;
  activeNestId: string | null;
  error: string;
  lastError: MediaAdapterError | null;
  audioState: AudioMixerState | null;
  videoState: VideoMixerState | null;
  speakingActivity: ParticipantVoiceActivityMap;
  audioCapabilities: NativeAudioCapabilityReport | null;
  videoCapabilities: NativeVideoCapabilityReport | null;
  selfMediaPreviewMode: SelfMediaPreviewMode;
  videoPresentationProfile: VideoPresentationProfile;
  videoStreamEndpoint: VideoStreamEndpoint | null;
  localMicEnabled: boolean;
  localCameraEnabled: boolean;
  localDeafened: boolean;
  deafenMode: DeafenMode;
  deafenSupported: boolean;
  outputMuteSupported: boolean;
  screenSharing: boolean;
  windowSharing: boolean;
  appAudioCapturing: boolean;
  selectedMic: string | null;
  selectedCamera: string | null;
  selectedOutput: string | null;
  activeCameraProfile: VideoQualityProfile | null;
  preferredCameraProfile: VideoQualityProfile;
  activeShareProfile: VideoQualityProfile | null;
  localAudioProcessing: WebRtcAudioProcessingSettings | null;
  availableInputDevices: AudioInputDevice[];
  availableOutputDevices: AudioOutputDevice[];
  availableCameras: CameraDevice[];
  availableDisplays: DisplayTarget[];
  availableWindows: WindowTarget[];
  availableAppAudioSources: AppAudioSource[];
  participantMedia: ParticipantMediaState[];
  screenSharingUserIds: string[];
  networkActivity: NetworkActivitySettings;
  bitrateSupported: boolean;
  bitrateLabel: string;
  micLabel: string;
  cameraLabel: string;
  outputLabel: string;
  visibilityLabel: string;
  deviceReadiness: string;
  audioSupported: boolean;
  cameraSupported: boolean;
  screenShareSupported: boolean;
  busy: boolean;
  joinMediaSession: (nestId: string) => Promise<void>;
  leaveMediaSession: () => Promise<void>;
  toggleMic: () => Promise<void>;
  toggleCamera: () => Promise<void>;
  toggleDeafen: () => Promise<void>;
  startScreenShare: () => Promise<void>;
  stopScreenShare: () => Promise<void>;
  refreshMediaDevices: () => Promise<void>;
  setMicDevice: (deviceId: string | null) => Promise<void>;
  setOutputDevice: (deviceId: string | null) => Promise<void>;
  testOutputDevice: () => Promise<void>;
  setDeafenMode: (mode: DeafenMode) => Promise<void>;
  setCameraDevice: (deviceId: string | null) => Promise<void>;
  setCameraProfile: (profile: VideoQualityProfile) => Promise<void>;
  startCamera: (camera: CameraDevice, profile?: VideoQualityProfile) => Promise<void>;
  stopCamera: () => Promise<void>;
  startDisplayShare: (display: DisplayTarget, withAudio: boolean, profile?: VideoQualityProfile) => Promise<void>;
  startWindowShare: (windowTarget: WindowTarget, withAudio: boolean, profile?: VideoQualityProfile) => Promise<void>;
  publishMic: () => Promise<void>;
  unpublishMic: () => Promise<void>;
  setMicProcessing: (processing: WebRtcAudioProcessingSettings) => Promise<void>;
  setNetworkActivity: (patch: Partial<NetworkActivitySettings>) => void;
  setSelfMediaPreviewMode: (mode: SelfMediaPreviewMode) => Promise<void>;
  setVideoPresentationProfile: (profile: VideoPresentationProfile) => Promise<void>;
  setLocalPreviewSurfaceVisible: (visible: boolean) => Promise<void>;
  clearError: () => void;
}

export function useRavenMediaAdapter(
  onStateChanged?: () => Promise<void> | void,
  options: {
    alwaysJoinMuted?: boolean;
    joinWithCameraOff?: boolean;
    joinWithoutScreenSharing?: boolean;
    nestLabel?: string;
    rtcServerUrl?: string;
    presenceState?: UserPresenceState;
    presenceReachability?: UserReachability;
    localUserId?: string;
  } = {},
): RavenMediaAdapterState {
  const [phase, setPhase] = useState<MediaAdapterPhase>("idle");
  const [activeNestId, setActiveNestId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [audioState, setAudioState] = useState<AudioMixerState | null>(null);
  const [videoState, setVideoState] = useState<VideoMixerState | null>(null);
  const speakingActivity = useParticipantVoiceActivity(audioState, options.localUserId);
  const [audioCapabilities, setAudioCapabilities] = useState<NativeAudioCapabilityReport | null>(null);
  const [videoCapabilities, setVideoCapabilities] = useState<NativeVideoCapabilityReport | null>(null);
  const [inputDevices, setInputDevices] = useState<AudioInputDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioOutputDevice[]>([]);
  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [displays, setDisplays] = useState<DisplayTarget[]>([]);
  const [windows, setWindows] = useState<WindowTarget[]>([]);
  const [appAudioSources, setAppAudioSources] = useState<AppAudioSource[]>([]);
  const [lastError, setLastError] = useState<MediaAdapterError | null>(null);
  const [preferredCameraId, setPreferredCameraId] = useState<string | null>(null);
  const [preferredCameraProfile, setPreferredCameraProfile] = useState<VideoQualityProfile>(DEFAULT_VIDEO_PROFILE);
  const initialSettings = useMemo(readMediaSettings, []);
  const [selfMediaPreviewMode, setSelfMediaPreviewModeState] = useState<SelfMediaPreviewMode>(initialSettings.selfMediaPreviewMode ?? "local");
  const [videoPresentationProfile, setVideoPresentationProfileState] = useState<VideoPresentationProfile>(initialSettings.videoPresentationProfile ?? "balanced");
  const [videoStreamEndpoint, setVideoStreamEndpoint] = useState<VideoStreamEndpoint | null>(null);
  const [selectedOutputPreference, setSelectedOutputPreference] = useState<string | null>(initialSettings.selectedOutput ?? null);
  const [deafenMode, setDeafenModeState] = useState<DeafenMode>(initialSettings.deafenMode ?? "instant");
  const [networkActivitySettings, setNetworkActivitySettings] = useState<NetworkActivitySettings>(
    initialSettings.networkActivity ?? DEFAULT_NETWORK_ACTIVITY_SETTINGS,
  );
  const [deafened, setDeafened] = useState(false);
  const joiningRef = useRef<Promise<void> | null>(null);
  const leavingRef = useRef<Promise<void> | null>(null);
  const activeNestRef = useRef<string | null>(null);
  const alwaysJoinMutedRef = useRef(Boolean(options.alwaysJoinMuted));
  const joinWithCameraOffRef = useRef(Boolean(options.joinWithCameraOff));
  const joinWithoutScreenSharingRef = useRef(Boolean(options.joinWithoutScreenSharing));
  const presenceRef = useRef({ state: options.presenceState, reachability: options.presenceReachability });
  const selfMediaPreviewModeRef = useRef<SelfMediaPreviewMode>(initialSettings.selfMediaPreviewMode ?? "local");
  const localPreviewSurfaceVisibleRef = useRef(true);
  const deafenRestoreRef = useRef<Map<string, boolean>>(new Map());
  const nestLabel = options.nestLabel ?? "Nest";
  const rtcServerUrl = options.rtcServerUrl?.trim() || null;

  useEffect(() => {
    alwaysJoinMutedRef.current = Boolean(options.alwaysJoinMuted);
  }, [options.alwaysJoinMuted]);

  useEffect(() => {
    joinWithCameraOffRef.current = Boolean(options.joinWithCameraOff);
  }, [options.joinWithCameraOff]);

  useEffect(() => {
    joinWithoutScreenSharingRef.current = Boolean(options.joinWithoutScreenSharing);
  }, [options.joinWithoutScreenSharing]);

  useEffect(() => {
    presenceRef.current = { state: options.presenceState, reachability: options.presenceReachability };
  }, [options.presenceReachability, options.presenceState]);

  const refreshNativeState = useCallback(async () => {
    const [audio, video] = await Promise.allSettled([audioCommands.getState(), videoCommands.getState()]);
    if (audio.status === "fulfilled") setAudioState(audio.value);
    if (video.status === "fulfilled") setVideoState(video.value);
  }, []);

  const refreshMediaDevices = useCallback(async () => {
    const [inputs, outputs, apps, cameraList, displayList, windowList] = await Promise.allSettled([
      audioCommands.listInputDevices(),
      audioCommands.listOutputDevices(),
      audioCommands.listAppAudioSources(),
      videoCommands.listCameras(),
      videoCommands.listDisplays(),
      videoCommands.listWindows(),
    ]);
    if (inputs.status === "fulfilled") setInputDevices(inputs.value);
    if (outputs.status === "fulfilled") setOutputDevices(outputs.value);
    if (apps.status === "fulfilled") setAppAudioSources(apps.value);
    if (cameraList.status === "fulfilled") setCameras(cameraList.value);
    if (displayList.status === "fulfilled") setDisplays(displayList.value);
    if (windowList.status === "fulfilled") setWindows(windowList.value);
  }, []);

  const saveMediaSettings = useCallback((patch: Partial<MediaSettings>) => {
    const next = { ...readMediaSettings(), ...patch };
    writeMediaSettings(next);
  }, []);

  const syncLocalPreviewEnabled = useCallback(() => {
    const enabled = selfMediaPreviewModeRef.current === "local"
      && localPreviewSurfaceVisibleRef.current
      && document.visibilityState !== "hidden";
    return videoCommands.setLocalPreviewEnabled(enabled);
  }, []);

  const setLocalPreviewSurfaceVisible = useCallback(async (visible: boolean) => {
    localPreviewSurfaceVisibleRef.current = visible;
    await syncLocalPreviewEnabled();
  }, [syncLocalPreviewEnabled]);

  const setNetworkActivity = useCallback((patch: Partial<NetworkActivitySettings>) => {
    setNetworkActivitySettings((current) => {
      const next = { ...current, ...patch };
      saveMediaSettings({ networkActivity: next });
      return next;
    });
  }, [saveMediaSettings]);

  const setSelfMediaPreviewMode = useCallback(async (mode: SelfMediaPreviewMode) => {
    const previousMode = selfMediaPreviewModeRef.current;
    selfMediaPreviewModeRef.current = mode;
    try {
      await syncLocalPreviewEnabled();
      setVideoState(await videoCommands.setSelfPreviewMode(mode));
    } catch (error) {
      selfMediaPreviewModeRef.current = previousMode;
      throw error;
    }
    setSelfMediaPreviewModeState(mode);
    saveMediaSettings({ selfMediaPreviewMode: mode });
  }, [saveMediaSettings, syncLocalPreviewEnabled]);

  const setVideoPresentationProfile = useCallback(async (profile: VideoPresentationProfile) => {
    setVideoState(await videoCommands.setPresentationProfile(profile));
    setVideoPresentationProfileState(profile);
    saveMediaSettings({ videoPresentationProfile: profile });
  }, [saveMediaSettings]);

  useEffect(() => {
    let mounted = true;
    let cleanupAudio: (() => void) | null = null;
    let cleanupVideo: (() => void) | null = null;
    void Promise.allSettled([
      audioCommands.getCapabilities().then((report) => mounted && setAudioCapabilities(report)),
      videoCommands.getCapabilities().then((report) => mounted && setVideoCapabilities(report)),
      videoCommands.getStreamEndpoint().then((endpoint) => mounted && setVideoStreamEndpoint(endpoint)),
      videoCommands.setSelfPreviewMode(selfMediaPreviewModeRef.current).then((state) => mounted && setVideoState(state)),
      videoCommands.setPresentationProfile(initialSettings.videoPresentationProfile ?? "balanced").then((state) => mounted && setVideoState(state)),
      refreshNativeState(),
      refreshMediaDevices(),
    ]).catch(() => undefined);
    void subscribeAudioStateChanged((state) => {
      if (mounted) setAudioState(state);
    })
      .then((unsubscribe) => {
        if (!mounted) unsubscribe();
        else cleanupAudio = unsubscribe;
      })
      .catch(() => undefined);
    void subscribeVideoStateChanged((state) => {
      if (mounted) setVideoState(state);
    })
      .then((unsubscribe) => {
        if (!mounted) unsubscribe();
        else cleanupVideo = unsubscribe;
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
      cleanupAudio?.();
      cleanupVideo?.();
    };
  }, [initialSettings.videoPresentationProfile, refreshMediaDevices, refreshNativeState]);

  useEffect(() => {
    const sync = () => {
      void syncLocalPreviewEnabled().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => document.removeEventListener("visibilitychange", sync);
  }, [syncLocalPreviewEnabled]);

  const micSources = useMemo(
    () => (audioState?.localSources ?? []).filter((source) => source.sourceType === "microphone"),
    [audioState],
  );
  const cameraSource = useMemo(
    () => (videoState?.localSources ?? []).find((source) => source.kind === "camera") ?? null,
    [videoState],
  );
  const screenSource = useMemo(
    () => (videoState?.localSources ?? []).find((source) => source.kind === "display" || source.kind === "window") ?? null,
    [videoState],
  );

  const localMicEnabled = micSources.some(isConfirmedMicrophoneActive);
  const localCameraEnabled = isConfirmedVideoSourceActive(cameraSource);
  const screenSharing = isConfirmedVideoSourceActive(screenSource);
  const windowSharing = screenSource?.kind === "window";
  const appAudioCapturing = (audioState?.localSources ?? []).some(
    (source) => source.sourceType === "appAudio" && source.enabled && source.runtime.status !== "error",
  );
  const localAudioProcessing = micSources[0]?.channelStrip.webrtcProcessing ?? null;
  const participantMedia = useMemo<ParticipantMediaState[]>(() => {
    const tracks = videoState?.remoteTracks ?? [];
    return (videoState?.participants ?? []).map((participant) => ({
      participantId: participant.participantId,
      displayName: participant.displayName,
      isLocal: participant.isLocal,
      audioMuted: participant.audioMuted,
      videoEnabled: tracks.some((track) => track.participantId === participant.participantId && track.source === "camera" && !track.muted),
      screenSharing: tracks.some((track) => track.participantId === participant.participantId && track.source === "screenshare" && !track.muted),
      speaking: participant.speaking,
    }));
  }, [videoState]);
  const screenSharingUserIds = useMemo(
    () => participantMedia.filter((participant) => participant.screenSharing).map((participant) => participant.participantId).sort(),
    [participantMedia],
  );

  const setSafeError = useCallback((message: string, kind: MediaErrorKind = "capture_failure", action = "Check the selected source and try again.") => {
    setError(message);
    setLastError({ message, kind, action });
    setPhase("error");
  }, []);

  const setNonFatalError = useCallback((message: string, kind: MediaErrorKind = "capture_failure", action = "Check the selected source and try again.") => {
    setError(message);
    setLastError({ message, kind, action });
  }, []);

  const clearError = useCallback(() => {
    setError("");
    setLastError(null);
    if (phase === "error") setPhase(activeNestRef.current ? "connected" : "idle");
  }, [phase]);

  const cleanupMediaOnly = useCallback(async () => {
    deafenRestoreRef.current.clear();
    const [audioResult, videoResult] = await Promise.allSettled([
      audioCommands.disconnectRoom(),
      videoCommands.disconnectRoom(),
    ]);
    if (audioResult.status === "fulfilled") setAudioState(audioResult.value);
    if (videoResult.status === "fulfilled") setVideoState(videoResult.value);
  }, []);

  const muteLocalMicrophones = useCallback(async () => {
    let state = await audioCommands.getState();
    const microphones = microphonesToMuteBeforeJoin(state.localSources);
    for (const source of microphones) {
      if (source.publishedTrack) state = await audioCommands.unpublishAudioSource(source.id);
      if (!source.channelStrip.mute.muted) state = await audioCommands.setLocalChannelMute(source.id, true);
    }
    setAudioState(state);
  }, []);

  const stopLocalVideoSources = useCallback(async (shouldStop: (source: VideoSourceState) => boolean) => {
    let state = await videoCommands.getState();
    for (const source of state.localSources.filter(shouldStop)) {
      state = await videoCommands.stopSource(source.id);
    }
    setVideoState(state);
  }, []);

  const applyVideoJoinDefaults = useCallback(async () => {
    if (!joinWithCameraOffRef.current && !joinWithoutScreenSharingRef.current) return;
    await stopLocalVideoSources((source) =>
      (joinWithCameraOffRef.current && source.kind === "camera") ||
      (joinWithoutScreenSharingRef.current && (source.kind === "display" || source.kind === "window")),
    );
  }, [stopLocalVideoSources]);

  const leaveMediaSession = useCallback(() => {
    if (leavingRef.current) return leavingRef.current;
    const nestId = activeNestRef.current;
    if (!nestId) return Promise.resolve();

    const operation = (async () => {
      setPhase("leaving");
      setError("");
      activeNestRef.current = null;
      setActiveNestId(null);
      try {
        await cleanupMediaOnly();
        if (nestId) await api.disconnectFromNest(nestId);
        setPhase("idle");
        await refreshNativeState();
        await onStateChanged?.();
      } catch (err) {
        setSafeError(messageFromError(err, `Could not leave the ${nestLabel} cleanly`));
      }
    })();
    leavingRef.current = operation;
    const clearLeave = () => {
      if (leavingRef.current === operation) leavingRef.current = null;
    };
    void operation.then(clearLeave, clearLeave);
    return operation;
  }, [cleanupMediaOnly, nestLabel, onStateChanged, refreshNativeState, setSafeError]);

  useEffect(() => {
    const disconnectActiveNest = () => {
      const nestId = activeNestRef.current;
      if (!nestId) return;
      void api.disconnectFromNest(nestId).catch(() => undefined);
    };

    window.addEventListener("pagehide", disconnectActiveNest);
    window.addEventListener("beforeunload", disconnectActiveNest);

    return () => {
      window.removeEventListener("pagehide", disconnectActiveNest);
      window.removeEventListener("beforeunload", disconnectActiveNest);
    };
  }, []);

  useEffect(() => () => {
    const nestId = activeNestRef.current;
    activeNestRef.current = null;
    if (nestId) void api.disconnectFromNest(nestId).catch(() => undefined);
    void Promise.allSettled([
      audioCommands.disconnectRoom(),
      videoCommands.disconnectRoom(),
    ]);
  }, []);

  useEffect(() => {
    if (!activeNestId) return;
    let cancelled = false;
    let timer: number | null = null;
    let requestController: AbortController | null = null;

    const heartbeat = async () => {
      requestController = new AbortController();
      const controller = requestController;
      const timeout = window.setTimeout(() => controller.abort(), NEST_HEARTBEAT_TIMEOUT_MS);
      try {
        await api.presenceHeartbeat(controller.signal);
      } catch {
        // Presence expiry is server-owned; retry after the normal interval.
      } finally {
        window.clearTimeout(timeout);
        if (requestController === controller) requestController = null;
        if (!cancelled) timer = window.setTimeout(() => void heartbeat(), NEST_HEARTBEAT_INTERVAL_MS);
      }
    };
    void heartbeat();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      requestController?.abort();
      requestController = null;
    };
  }, [activeNestId]);

  const joinMediaSession = useCallback(
    async (nestId: string) => {
      if (joiningRef.current) return joiningRef.current;
      joiningRef.current = (async () => {
        setPhase("joining");
        setError("");
        try {
          if (activeNestRef.current && activeNestRef.current !== nestId) {
            await leaveMediaSession();
            setPhase("joining");
          }

          const viewerToken = await api.liveKitToken(nestId);

          // Native sidecars reconcile and publish existing sources as soon as they
          // connect, so join defaults must be enforced before either sidecar joins.
          await applyVideoJoinDefaults();
          if (alwaysJoinMutedRef.current) await muteLocalMicrophones();

          const audioToken = await api.liveKitToken(nestId, "audio");
          let nextAudioState = await audioCommands.connectRoom(rtcServerUrl || audioToken.url, audioToken.token);
          if (deafened && deafenMode === "bandwidthSaver") {
            nextAudioState = await audioCommands.setRemoteAudioReceiving(false);
          } else {
            nextAudioState = await audioCommands.setRemoteAudioReceiving(true);
          }
          setAudioState(nextAudioState);

          const videoToken = await api.liveKitToken(nestId, "video");
          let nextVideoState = await videoCommands.connectRoom(
            rtcServerUrl || videoToken.url || viewerToken.url,
            videoToken.token,
            viewerToken.token,
          );
          nextVideoState = await videoCommands.setSelfPreviewMode(selfMediaPreviewModeRef.current);
          setVideoState(nextVideoState);

          await api.joinSession(nestId);
          await api.joinNestPresence(nestId);
          const nextPresence = presenceForActiveNest(presenceRef.current);
          await api.updatePresence(nextPresence.state, nextPresence.reachability, nestId);

          activeNestRef.current = nestId;
          setActiveNestId(nestId);
          setPhase("connected");
          await refreshNativeState();
          await refreshMediaDevices();
          await onStateChanged?.();
        } catch (err) {
          await cleanupMediaOnly();
          activeNestRef.current = null;
          setActiveNestId(null);
          await Promise.allSettled([api.leaveSession(nestId), api.leaveNestPresence(nestId)]);
          setSafeError(
            messageFromError(err, `Could not join media for this ${nestLabel}`),
            "rtc_failure",
            "Check the realtime server connection, then try joining media again.",
          );
          await onStateChanged?.();
          throw err;
        } finally {
          joiningRef.current = null;
        }
      })();
      return joiningRef.current;
    },
    [applyVideoJoinDefaults, cleanupMediaOnly, deafenMode, deafened, leaveMediaSession, muteLocalMicrophones, nestLabel, onStateChanged, refreshMediaDevices, refreshNativeState, rtcServerUrl, setSafeError],
  );

  const ensureDefaultMic = useCallback(async (): Promise<AudioSourceState> => {
    let state = await audioCommands.getState();
    let mic = state.localSources.find((source) => source.sourceType === "microphone");
    if (!mic) {
      state = await audioCommands.addLocalSource("microphone", "Microphone");
      const mics = state.localSources.filter((source) => source.sourceType === "microphone");
      mic = mics[mics.length - 1];
    }
    if (!mic) throw new Error("No microphone source is available.");
    setAudioState(state);
    return mic;
  }, []);

  const publishMic = useCallback(async () => {
    setError("");
    if (!audioCapabilities?.supportsMicrophone) {
      setSafeError("Microphone capture is not supported on this system.", "unsupported", "Use a supported OS/audio backend or add another audio source in the mixer.");
      return;
    }
    try {
      const sources = micSources.length ? micSources : [await ensureDefaultMic()];
      let state: AudioMixerState | null = null;
      for (const source of sources) {
        if (source.channelStrip.mute.muted) state = await audioCommands.setLocalChannelMute(source.id, false);
        if (!source.publishedTrack) state = await audioCommands.publishAudioSource(source.id);
      }
      if (state) setAudioState(state);
    } catch (err) {
      setSafeError(classifyMediaError(err, "Microphone could not be published").message, classifyMediaError(err).kind, "Check microphone permission or pick another input device.");
    }
  }, [audioCapabilities?.supportsMicrophone, ensureDefaultMic, micSources, setSafeError]);

  const unpublishMic = useCallback(async () => {
    setError("");
    try {
      let state: AudioMixerState | null = null;
      for (const source of micSources) {
        state = source.publishedTrack
          ? await audioCommands.unpublishAudioSource(source.id)
          : await audioCommands.setLocalChannelMute(source.id, true);
      }
      if (state) setAudioState(state);
    } catch (err) {
      setSafeError(messageFromError(err, "Microphone could not be unpublished"), "publish_failure", "Try muting again or leave the media session.");
    }
  }, [micSources, setSafeError]);

  const toggleMic = useCallback(async () => {
    if (localMicEnabled) {
      await unpublishMic();
    } else {
      await publishMic();
    }
  }, [localMicEnabled, publishMic, unpublishMic]);

  const setMicDevice = useCallback(async (deviceId: string | null) => {
    setError("");
    try {
      const mic = await ensureDefaultMic();
      setAudioState(await audioCommands.setLocalSourceCaptureDevice(mic.id, deviceId));
    } catch (err) {
      setSafeError(messageFromError(err, "Microphone input could not be changed"), "capture_failure", "Pick another input device or check OS microphone access.");
    }
  }, [ensureDefaultMic, setSafeError]);

  const startCamera = useCallback(async (camera: CameraDevice, profile: VideoQualityProfile = DEFAULT_VIDEO_PROFILE) => {
    setError("");
    setPreferredCameraId(camera.id);
    setPreferredCameraProfile(profile);
    if (!videoCapabilities?.supportsCamera) {
      setSafeError("Camera capture is not supported on this system.", "unsupported", "Use a supported camera backend or continue audio-only.");
      return;
    }
    try {
      if (cameraSource) await videoCommands.stopSource(cameraSource.id);
      setVideoState(await videoCommands.startCamera(camera.id, camera.name || "Camera", profile));
    } catch (err) {
      const classified = classifyMediaError(err, "Camera could not be started");
      setSafeError(classified.message, classified.kind, "Check camera permission or choose another camera.");
    }
  }, [cameraSource, setSafeError, videoCapabilities?.supportsCamera]);

  const setCameraDevice = useCallback(async (deviceId: string | null) => {
    setError("");
    setPreferredCameraId(deviceId);
    if (!deviceId || !cameraSource) return;
    const camera = cameras.find((candidate) => candidate.id === deviceId) ?? (await videoCommands.listCameras()).find((candidate) => candidate.id === deviceId);
    if (!camera) {
      setSafeError("Camera device is not available.", "missing_device", "Pick another camera or reconnect the device.");
      return;
    }
    await startCamera(camera, cameraSource.profile ?? preferredCameraProfile);
  }, [cameraSource, cameras, preferredCameraProfile, setSafeError, startCamera]);

  const setCameraProfile = useCallback(async (profile: VideoQualityProfile) => {
    setError("");
    setPreferredCameraProfile(profile);
    if (!cameraSource) return;
    try {
      setVideoState(await videoCommands.setSourceProfile(cameraSource.id, profile));
    } catch (err) {
      setSafeError(messageFromError(err, "Camera quality could not be changed"), "capture_failure", "Try another quality setting or restart the camera.");
    }
  }, [cameraSource, setSafeError]);

  const stopCamera = useCallback(async () => {
    setError("");
    setLastError(null);
    try {
      if (cameraSource) setVideoState(await videoCommands.stopSource(cameraSource.id));
    } catch (err) {
      // A native stop can finish before its state event/invoke response fails. Re-read
      // the engine so a completed stop is reflected immediately instead of requiring
      // a second hotkey press.
      const refreshed = await videoCommands.getState().catch(() => null);
      if (refreshed) {
        setVideoState(refreshed);
        if (!refreshed.localSources.some((source) => source.kind === "camera")) return;
      }
      setSafeError(messageFromError(err, "Camera could not be stopped"), "capture_failure", "Try stopping camera again or leave the media session.");
    }
  }, [cameraSource, setSafeError]);

  const toggleCamera = useCallback(async () => {
    if (localCameraEnabled) {
      await stopCamera();
      return;
    }
    const listedCameras = cameras.length ? cameras : await videoCommands.listCameras();
    const camera = listedCameras.find((candidate) => candidate.id === preferredCameraId) ?? listedCameras[0];
    if (!camera) {
      setSafeError("No camera device is available.", "missing_device", "Connect a camera or continue audio-only.");
      return;
    }
    await startCamera(camera, preferredCameraProfile);
  }, [cameras, localCameraEnabled, preferredCameraId, preferredCameraProfile, setSafeError, startCamera, stopCamera]);

  const applyRemotePlaybackMute = useCallback(
    async (muted: boolean, state: AudioMixerState | null = audioState) => {
      const tracks = state?.remoteTracks ?? [];
      if (!tracks.length) {
        if (!muted) deafenRestoreRef.current.clear();
        return;
      }
      const updates = tracks.flatMap((remoteTrack) => {
        const key = `${remoteTrack.track.participantId}:${remoteTrack.track.trackId}`;
        if (muted && !deafenRestoreRef.current.has(key)) {
          deafenRestoreRef.current.set(key, remoteTrack.receiverChannelStrip.mute.muted);
        }
        const nextMuted = muted ? true : deafenRestoreRef.current.get(key) ?? false;
        if (remoteTrack.receiverChannelStrip.mute.muted === nextMuted) return [];
        return [audioCommands.setRemoteTrackMute(remoteTrack.track.participantId, remoteTrack.track.trackId, nextMuted)];
      });
      if (!updates.length) {
        if (!muted) deafenRestoreRef.current.clear();
        return;
      }
      const results = await Promise.allSettled(updates);
      const fulfilled = results.filter((result): result is PromiseFulfilledResult<AudioMixerState> => result.status === "fulfilled");
      const lastState = fulfilled[fulfilled.length - 1]?.value;
      if (lastState) setAudioState(lastState);
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (rejected) throw rejected.reason;
      if (!muted) deafenRestoreRef.current.clear();
    },
    [audioState],
  );

  const setRemoteAudioReceiving = useCallback(async (enabled: boolean) => {
    try {
      setAudioState(await audioCommands.setRemoteAudioReceiving(enabled));
    } catch (err) {
      setNonFatalError(
        messageFromError(err, enabled ? "Incoming audio could not be restored" : "Incoming audio could not be paused"),
        "unsupported",
        enabled ? "Try leaving and rejoining media." : "Use Instant deafen mode if this keeps happening.",
      );
    }
  }, [setNonFatalError]);

  const applyDeafenStrategy = useCallback(async (nextDeafened: boolean, mode: DeafenMode, state: AudioMixerState | null = audioState) => {
    if (mode === "bandwidthSaver") {
      if (nextDeafened) {
        await applyRemotePlaybackMute(false, state).catch(() => undefined);
        await setRemoteAudioReceiving(false);
      } else {
        await setRemoteAudioReceiving(true);
        await applyRemotePlaybackMute(false, state);
      }
      return;
    }
    await setRemoteAudioReceiving(true);
    await applyRemotePlaybackMute(nextDeafened, state);
  }, [applyRemotePlaybackMute, audioState, setRemoteAudioReceiving]);

  const toggleDeafen = useCallback(async () => {
    const nextDeafened = !deafened;
    setError("");
    setLastError(null);
    setDeafened(nextDeafened);
    try {
      await applyDeafenStrategy(nextDeafened, deafenMode);
    } catch (err) {
      setNonFatalError(
        messageFromError(err, "Incoming audio could not be fully muted"),
        "unsupported",
        nextDeafened
          ? `Raven muted incoming audio in the ${nestLabel}, but the audio engine did not accept the full deafen state.`
          : `Raven restored incoming audio in the ${nestLabel}, but the audio engine did not accept the full restore.`,
      );
    }
  }, [applyDeafenStrategy, deafenMode, deafened, nestLabel, setNonFatalError]);

  useEffect(() => {
    if (!deafened || !audioState?.remoteTracks.length) return;
    if (deafenMode === "bandwidthSaver") {
      void setRemoteAudioReceiving(false);
      return;
    }
    void applyRemotePlaybackMute(true, audioState).catch((err) => {
      setNonFatalError(
        messageFromError(err, "New incoming audio could not be muted"),
        "unsupported",
        `Raven muted incoming audio in the ${nestLabel}, but the audio engine did not accept the full deafen state for new audio.`,
      );
    });
  }, [applyRemotePlaybackMute, audioState, deafenMode, deafened, nestLabel, setNonFatalError, setRemoteAudioReceiving]);

  const setOutputDevice = useCallback(async (deviceId: string | null) => {
    setError("");
    try {
      const selected = await audioCommands.setOutputDevice(deviceId);
      const next = deviceId ? selected?.deviceId ?? deviceId : null;
      setSelectedOutputPreference(next);
      saveMediaSettings({ selectedOutput: next });
      await refreshMediaDevices();
    } catch (err) {
      setSafeError(messageFromError(err, "Speaker could not be changed"), "unsupported", "Pick another speaker or use the system default.");
    }
  }, [refreshMediaDevices, saveMediaSettings, setSafeError]);

  const testOutputDevice = useCallback(async () => {
    setError("");
    try {
      await audioCommands.testOutputDevice(selectedOutputPreference);
    } catch (err) {
      setSafeError(messageFromError(err, "Test sound could not play"), "unsupported", "Pick another speaker or check the device connection.");
    }
  }, [selectedOutputPreference, setSafeError]);

  const setDeafenMode = useCallback(async (mode: DeafenMode) => {
    setError("");
    setDeafenModeState(mode);
    saveMediaSettings({ deafenMode: mode });
    if (deafened) {
      await applyDeafenStrategy(true, mode);
    }
  }, [applyDeafenStrategy, deafened, saveMediaSettings]);

  useEffect(() => {
    if (!audioCapabilities?.supportsOutputDevices || outputDevices.length === 0) return;
    const selectedStillExists = selectedOutputPreference
      ? outputDevices.some((device) => device.deviceId === selectedOutputPreference)
      : true;
    const next = selectedStillExists ? selectedOutputPreference : null;
    if (!selectedStillExists) {
      setSelectedOutputPreference(null);
      saveMediaSettings({ selectedOutput: null });
    }
    void audioCommands.setOutputDevice(next).catch((err) => {
      setNonFatalError(
        messageFromError(err, "Saved speaker could not be restored"),
        "unsupported",
        "Raven is using the system default speaker.",
      );
    });
  }, [audioCapabilities?.supportsOutputDevices, outputDevices, saveMediaSettings, selectedOutputPreference, setNonFatalError]);


  const startDisplayShare = useCallback(async (
    display: DisplayTarget,
    withAudio: boolean,
    profile: VideoQualityProfile = DEFAULT_VIDEO_PROFILE,
  ) => {
    setError("");
    if (!videoCapabilities || (!videoCapabilities.supportsDisplayCapture && !videoCapabilities.supportsWindowCapture)) {
      setSafeError("Screen sharing is not supported on this system.", "unsupported", "Use a supported OS screen capture backend.");
      return;
    }
    try {
      if (screenSource) await videoCommands.stopSource(screenSource.id);
      setVideoState(await videoCommands.startDisplayShare(
        display.id,
        display.name || "Display",
        withAudio && Boolean(videoCapabilities.supportsDisplayAudio),
        profile,
        display.width,
        display.height,
      ));
    } catch (err) {
      const classified = classifyMediaError(err, "Display sharing could not be started");
      setSafeError(classified.message, classified.kind, "Check screen recording permission or choose another source.");
    }
  }, [screenSource, setSafeError, videoCapabilities]);

  const startWindowShare = useCallback(async (
    windowTarget: WindowTarget,
    withAudio: boolean,
    profile: VideoQualityProfile = DEFAULT_VIDEO_PROFILE,
  ) => {
    setError("");
    if (!videoCapabilities?.supportsWindowCapture) {
      setSafeError("Window capture is not supported on this system.", "unsupported", "Use display sharing if available.");
      return;
    }
    try {
      if (screenSource) await videoCommands.stopSource(screenSource.id);
      setVideoState(await videoCommands.startWindowShare(
        windowTarget.id,
        windowTarget.processId,
        windowTarget.title || windowTarget.appName || "Window",
        withAudio && Boolean(videoCapabilities.supportsWindowAudio),
        profile,
        windowTarget.width,
        windowTarget.height,
      ));
    } catch (err) {
      const classified = classifyMediaError(err, "Window sharing could not be started");
      setSafeError(classified.message, classified.kind, "Check capture permission or choose another window.");
    }
  }, [screenSource, setSafeError, videoCapabilities]);

  const startScreenShare = useCallback(async () => {
    const display = displays[0] ?? (await videoCommands.listDisplays())[0];
    if (!display) {
      setSafeError("No shareable display is available.", "missing_device", "Open the source picker or check OS screen capture permission.");
      return;
    }
    await startDisplayShare(display, false);
  }, [displays, setSafeError, startDisplayShare]);

  const stopScreenShare = useCallback(async () => {
    setError("");
    try {
      if (screenSource) setVideoState(await videoCommands.stopSource(screenSource.id));
    } catch (err) {
      setSafeError(messageFromError(err, "Screen sharing could not be stopped"), "capture_failure", "Try stopping share again or leave the media session.");
    }
  }, [screenSource, setSafeError]);

  const setMicProcessing = useCallback(async (processing: WebRtcAudioProcessingSettings) => {
    setError("");
    try {
      const mic = await ensureDefaultMic();
      setAudioState(await audioCommands.setLocalWebRtcProcessing(mic.id, processing));
    } catch (err) {
      setSafeError(messageFromError(err, "Microphone processing could not be changed"), "publish_failure", "Try again from the mixer or leave and rejoin media.");
    }
  }, [ensureDefaultMic, setSafeError]);

  const selectedOutput = useMemo(
    () => outputDevices.find((device) => device.deviceId === selectedOutputPreference)?.deviceId
      ?? outputDevices.find((device) => device.isDefault)?.deviceId
      ?? outputDevices[0]?.deviceId
      ?? null,
    [outputDevices, selectedOutputPreference],
  );

  return {
    phase,
    activeNestId,
    error,
    lastError,
    audioState,
    videoState,
    speakingActivity,
    audioCapabilities,
    videoCapabilities,
    selfMediaPreviewMode,
    videoPresentationProfile,
    videoStreamEndpoint,
    localMicEnabled,
    localCameraEnabled,
    localDeafened: deafened,
    deafenMode,
    deafenSupported: true,
    outputMuteSupported: false,
    screenSharing,
    windowSharing,
    appAudioCapturing,
    selectedMic: micSources[0]?.captureDeviceId ?? null,
    selectedCamera: cameraSource?.targetId ?? preferredCameraId,
    selectedOutput,
    activeCameraProfile: cameraSource?.profile ?? null,
    preferredCameraProfile,
    activeShareProfile: screenSource?.profile ?? null,
    localAudioProcessing,
    availableInputDevices: inputDevices,
    availableOutputDevices: outputDevices,
    availableCameras: cameras,
    availableDisplays: displays,
    availableWindows: windows,
    availableAppAudioSources: appAudioSources,
    participantMedia,
    screenSharingUserIds,
    networkActivity: networkActivitySettings,
    bitrateSupported: false,
    bitrateLabel: "Managed by the native video profile",
    micLabel: micStateLabel(micSources, localMicEnabled),
    cameraLabel: localCameraEnabled ? cameraSource?.displayName ?? "Camera on" : "Camera off",
    outputLabel: deafened ? "Deafened" : "Sound on",
    visibilityLabel: activeNestId ? `Visible in ${nestLabel}` : `Not in a ${nestLabel}`,
    deviceReadiness: readinessLabel(audioCapabilities, videoCapabilities, phase, nestLabel),
    audioSupported: audioCapabilities?.supportsMicrophone ?? false,
    cameraSupported: videoCapabilities?.supportsCamera ?? false,
    screenShareSupported: Boolean(videoCapabilities?.supportsDisplayCapture || videoCapabilities?.supportsWindowCapture),
    busy: phase === "joining" || phase === "leaving",
    joinMediaSession,
    leaveMediaSession,
    toggleMic,
    toggleCamera,
    toggleDeafen,
    startScreenShare,
    stopScreenShare,
    refreshMediaDevices,
    setMicDevice,
    setOutputDevice,
    testOutputDevice,
    setDeafenMode,
    setCameraDevice,
    setCameraProfile,
    startCamera,
    stopCamera,
    startDisplayShare,
    startWindowShare,
    publishMic,
    unpublishMic,
    setMicProcessing,
    setNetworkActivity,
    setSelfMediaPreviewMode,
    setVideoPresentationProfile,
    setLocalPreviewSurfaceVisible,
    clearError,
  };
}

function micStateLabel(sources: AudioSourceState[], enabled: boolean) {
  if (!sources.length) return "Mic not selected";
  if (!enabled) return "Muted";
  return sources[0].displayName || "Microphone";
}

function readinessLabel(
  audio: NativeAudioCapabilityReport | null,
  video: NativeVideoCapabilityReport | null,
  phase: MediaAdapterPhase,
  nestLabel: string,
) {
  if (phase === "joining") return `Joining ${nestLabel}`;
  if (phase === "leaving") return `Leaving ${nestLabel}`;
  if (!audio && !video) return "Checking devices";
  const issue = [...(audio?.issues ?? []), ...(video?.issues ?? [])][0];
  if (issue) return issue;
  const parts = [
    audio?.supportsMicrophone ? "Mic ready" : "Mic unavailable",
    video?.supportsCamera ? "Camera ready" : "Camera unavailable",
  ];
  return parts.join(" · ");
}

function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function classifyMediaError(error: unknown, fallback = "Media action failed"): MediaAdapterError {
  const message = messageFromError(error, fallback);
  const lower = message.toLowerCase();
  if (lower.includes("permission") || lower.includes("denied") || lower.includes("notallowed")) {
    return { message, kind: "permission_denied", action: "Allow the device permission in the OS or browser prompt, then retry." };
  }
  if (lower.includes("not found") || lower.includes("no ") || lower.includes("missing") || lower.includes("notreadable")) {
    return { message, kind: "missing_device", action: "Connect or select another device, then retry." };
  }
  if (lower.includes("publish") || lower.includes("track")) {
    return { message, kind: "publish_failure", action: "Leave and rejoin media if retrying does not recover." };
  }
  return { message, kind: "capture_failure", action: "Check the selected source and try again." };
}

type MediaSettings = {
  selectedOutput?: string | null;
  deafenMode?: DeafenMode;
  networkActivity?: NetworkActivitySettings;
  selfMediaPreviewMode?: SelfMediaPreviewMode;
  videoPresentationProfile?: VideoPresentationProfile;
};

const DEFAULT_NETWORK_ACTIVITY_SETTINGS: NetworkActivitySettings = {
  enabled: false,
  directions: ["incoming", "outgoing"],
  categories: ["total"],
};

function readMediaSettings(): MediaSettings {
  try {
    const raw = window.localStorage.getItem(MEDIA_SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as MediaSettings;
    return {
      selectedOutput: typeof parsed.selectedOutput === "string" ? parsed.selectedOutput : null,
      deafenMode: isDeafenMode(parsed.deafenMode) ? parsed.deafenMode : "instant",
      networkActivity: normalizeNetworkActivitySettings(parsed.networkActivity),
      selfMediaPreviewMode: isSelfMediaPreviewMode(parsed.selfMediaPreviewMode) ? parsed.selfMediaPreviewMode : "local",
      videoPresentationProfile: isVideoPresentationProfile(parsed.videoPresentationProfile) ? parsed.videoPresentationProfile : "balanced",
    };
  } catch {
    return {};
  }
}

function writeMediaSettings(settings: MediaSettings) {
  try {
    window.localStorage.setItem(MEDIA_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Settings persistence is best-effort; the active media state still updates.
  }
}

function isDeafenMode(value: unknown): value is DeafenMode {
  return value === "instant" || value === "bandwidthSaver";
}

function isSelfMediaPreviewMode(value: unknown): value is SelfMediaPreviewMode {
  return value === "local" || value === "rtc";
}

function isVideoPresentationProfile(value: unknown): value is VideoPresentationProfile {
  return value === "efficiency" || value === "balanced" || value === "quality";
}

function normalizeNetworkActivitySettings(value: NetworkActivitySettings | undefined): NetworkActivitySettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_NETWORK_ACTIVITY_SETTINGS };
  return {
    enabled: value.enabled === true,
    directions: Array.isArray(value.directions)
      ? value.directions.filter(isNetworkActivityDirection)
      : [...DEFAULT_NETWORK_ACTIVITY_SETTINGS.directions],
    categories: Array.isArray(value.categories)
      ? value.categories.filter((category): category is NetworkActivityCategory => isNetworkActivityCategory(category) && category !== "other")
      : [...DEFAULT_NETWORK_ACTIVITY_SETTINGS.categories],
  };
}

function isNetworkActivityDirection(value: unknown): value is NetworkActivityDirection {
  return value === "incoming" || value === "outgoing";
}

function isNetworkActivityCategory(value: unknown): value is NetworkActivityCategory {
  return value === "audio" || value === "video" || value === "screenShare" || value === "other" || value === "total";
}
