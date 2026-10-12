import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import {
  ScreenSharePickerDialog,
  VideoProfileFields,
  customDraftFromProfile,
  profileFromSelection,
} from "@/components/nest/VideoPickers";
import { buildVoiceOverlaySnapshot, EMPTY_VOICE_OVERLAY_SNAPSHOT, voiceOverlayCommands } from "@/lib/voiceOverlay";
import { mediaHotkeyCommands, subscribeMediaHotkeys, type MediaHotkeySettings } from "@/lib/mediaHotkeys";
import {
  manageEventSubscription,
  runGuardedThumbnailAction,
  subscribeThumbnailToolbarActions,
  thumbnailToolbarCommands,
  type ThumbnailToolbarAction,
} from "@/lib/thumbnailToolbar";
import { buildTraySnapshot, subscribeTrayActions, trayCommands } from "@/lib/tray";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { type VideoQualityProfileId } from "@/lib/video";
import { AlertTriangle, ArrowDown, ArrowUp, Check, ChevronUp, HeadphoneOff, Headphones, Loader2, Mic, MicOff, MonitorUp, PhoneOff, Settings, SlidersHorizontal, Video, VideoOff, LogOut } from "lucide-react";
import { ElapsedTime, InfoTooltip, LiveDot, PresenceDot } from "./atoms";
import { displayNameFor, PRESENCE, presenceFromApi, SELECTABLE_PRESENCES, type RavenShellData, type RavenView } from "./state";
import type { RavenMediaAdapterState } from "./useRavenMediaAdapter";
import type { LocalVideoStatus } from "./mediaState";
import type {
  MeasuredNetworkCategory,
  NetworkActivityCategory,
  NetworkActivitySnapshot,
  NetworkTransferRate,
} from "./networkActivity";
import { receivedScreenShareQualityNotice, screenShareQualityNotice } from "./networkActivity";
import { useNetworkActivity } from "./useNetworkActivity";

const SIGNED_OUT_CALL_SNAPSHOT = {
  signedIn: false,
  micEnabled: false,
  micSupported: false,
  deafened: false,
  deafenSupported: false,
  hasMediaSession: false,
  busy: false,
  micPending: false,
  deafenPending: false,
  leavePending: false,
};

const TRAY_PRESENCES = SELECTABLE_PRESENCES.map((id) => ({ id, label: PRESENCE[id].label }));

/**
 * The persistent bottom bar. Left: you and how you appear. Centre: your signal
 * (mic, camera, screen, hearing). Right: the call you are in and how to leave.
 * It never goes away, so readiness belongs to you rather than to a room.
 */
export function DeviceDock({
  data,
  media,
  view,
  onNavigate,
  onToggleMixer,
}: {
  data: RavenShellData;
  media: RavenMediaAdapterState;
  view: RavenView;
  onNavigate: (view: RavenView) => void;
  onToggleMixer: () => void;
}) {
  const [screenPickerOpen, setScreenPickerOpen] = useState(false);
  const mediaRef = useRef(media);
  const hotkeyActionRef = useRef<Set<string>>(new Set());
  const callActionRef = useRef<Set<ThumbnailToolbarAction>>(new Set());
  const [pendingCallActions, setPendingCallActions] = useState<ReadonlySet<ThumbnailToolbarAction>>(() => new Set());
  const [thumbnailToolbarReady, setThumbnailToolbarReady] = useState(false);
  const [trayReady, setTrayReady] = useState(false);
  const setPresenceRef = useRef(data.setPresence);
  setPresenceRef.current = data.setPresence;
  mediaRef.current = media;
  const [fullscreenHost, setFullscreenHost] = useState<HTMLElement | null>(null);
  const [hotkeys, setHotkeys] = useState<MediaHotkeySettings | null>(null);
  const [connectedSince, setConnectedSince] = useState<string | null>(null);
  const lastOverlaySnapshotRef = useRef("");
  const presence = presenceFromApi(data.presence);
  const activeDetails = media.activeNestId ? data.getNestDetails(media.activeNestId) : undefined;
  const activeSession = media.activeNestId ? data.getActiveSession(media.activeNestId) ?? null : null;
  const activeNest = media.activeNestId ? data.getNest(media.activeNestId) : undefined;
  const selfName = data.user ? displayNameFor(data.user) : "You";
  const networkActivity = useNetworkActivity(media.activeNestId != null, media.networkActivity);
  const connected = media.phase === "connected" && media.activeNestId != null;
  const signedIn = Boolean(data.user);
  const mixerOpen = view.kind === "mixer";

  const runCallAction = useCallback((action: ThumbnailToolbarAction) => {
    const current = mediaRef.current;
    const allowed = action === "mic"
      ? current.audioSupported && !current.busy
      : action === "deafen"
        ? current.deafenSupported && !current.busy
        : Boolean(current.activeNestId) && current.phase !== "leaving";
    if (!allowed) return;
    void runGuardedThumbnailAction(callActionRef.current, action, () => {
      if (action === "mic") return current.toggleMic();
      if (action === "deafen") return current.toggleDeafen();
      return current.leaveMediaSession();
    }, setPendingCallActions);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    subscribeMediaHotkeys((action) => {
      const current = mediaRef.current;
      if (current.busy || hotkeyActionRef.current.has(action)) return;
      if (action === "mic" || action === "deafen") {
        runCallAction(action);
        return;
      }
      let operation: Promise<void> | null = null;
      if (action === "camera" && current.cameraSupported) {
        operation = current.localCameraEnabled ? current.stopCamera() : current.toggleCamera();
      }
      if (action === "screenShare" && current.screenShareSupported) {
        if (current.screenSharing) operation = current.stopScreenShare();
        else {
          setScreenPickerOpen(true);
          const appWindow = getCurrentWindow();
          void appWindow.show().then(() => appWindow.setFocus()).catch(() => undefined);
        }
      }
      if (!operation) return;
      hotkeyActionRef.current.add(action);
      void operation.catch(() => undefined).finally(() => hotkeyActionRef.current.delete(action));
    }).then((nextUnlisten) => { unlisten = nextUnlisten; }).catch(() => undefined);
    return () => unlisten?.();
  }, [runCallAction]);

  // Keep the native listener ready before exposing its buttons. The dock unmounts
  // on sign-out, so publishing the hidden snapshot here also clears stale taskbar UI.
  useEffect(() => {
    let active = true;
    const disposeSubscription = manageEventSubscription(
      () => subscribeThumbnailToolbarActions((action) => {
        if (active) runCallAction(action);
      }),
      () => setThumbnailToolbarReady(true),
    );

    return () => {
      active = false;
      disposeSubscription();
      void thumbnailToolbarCommands.update(SIGNED_OUT_CALL_SNAPSHOT).catch(() => undefined);
    };
  }, [runCallAction]);

  const thumbnailSnapshot = useMemo(() => ({
    signedIn: signedIn && thumbnailToolbarReady,
    micEnabled: media.localMicEnabled,
    micSupported: media.audioSupported,
    deafened: media.localDeafened,
    deafenSupported: media.deafenSupported,
    hasMediaSession: media.activeNestId != null,
    busy: media.busy,
    micPending: pendingCallActions.has("mic"),
    deafenPending: pendingCallActions.has("deafen"),
    leavePending: media.phase === "leaving" || pendingCallActions.has("leave"),
  }), [
    media.activeNestId,
    media.audioSupported,
    media.busy,
    media.deafenSupported,
    media.localDeafened,
    media.localMicEnabled,
    media.phase,
    pendingCallActions,
    signedIn,
    thumbnailToolbarReady,
  ]);

  useEffect(() => {
    void thumbnailToolbarCommands.update(thumbnailSnapshot).catch(() => undefined);
  }, [thumbnailSnapshot]);

  // The tray menu's call controls and presence choices. Settings and updates are pages,
  // so the shell handles those. As with the taskbar buttons, the menu is only offered
  // once this listener is ready, and unmounting on sign-out clears it.
  useEffect(() => {
    let active = true;
    const disposeSubscription = manageEventSubscription(
      () => subscribeTrayActions((event) => {
        if (!active) return;
        if (event.action === "mic" || event.action === "deafen" || event.action === "leave") {
          runCallAction(event.action);
        } else if (event.action === "presence") {
          const presence = SELECTABLE_PRESENCES.find((value) => value === event.presence);
          if (presence) void setPresenceRef.current(presence).catch(() => undefined);
        }
      }),
      () => setTrayReady(true),
    );

    return () => {
      active = false;
      disposeSubscription();
      void trayCommands.update(buildTraySnapshot({
        call: SIGNED_OUT_CALL_SNAPSHOT,
        callName: null,
        phase: "idle",
        reconnecting: false,
        presence: "",
        presences: [],
      })).catch(() => undefined);
    };
  }, [runCallAction]);

  const activeNestName = activeNest?.name;
  const traySnapshot = useMemo(() => buildTraySnapshot({
    call: { ...thumbnailSnapshot, signedIn: signedIn && trayReady },
    callName: activeNestName,
    phase: media.phase,
    reconnecting: media.reconnecting,
    presence,
    presences: TRAY_PRESENCES,
  }), [activeNestName, media.phase, media.reconnecting, presence, signedIn, thumbnailSnapshot, trayReady]);

  useEffect(() => {
    void trayCommands.update(traySnapshot).catch(() => undefined);
  }, [traySnapshot]);

  // Shortcut hints in the tooltips. Re-read when leaving Settings, where they change.
  const inSettings = view.kind === "settings";
  useEffect(() => {
    if (inSettings) return;
    let active = true;
    mediaHotkeyCommands
      .getSettings()
      .then((settings) => {
        if (active) setHotkeys(settings.supported ? settings : null);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [inSettings]);

  useEffect(() => {
    setConnectedSince(connected ? new Date().toISOString() : null);
  }, [connected, media.activeNestId]);

  useEffect(() => {
    const syncFullscreenHost = () => {
      const element = document.fullscreenElement;
      setFullscreenHost(
        element instanceof HTMLElement && element.matches(".raven-media-stage, .raven-media-tile")
          ? element
          : null,
      );
    };
    syncFullscreenHost();
    document.addEventListener("fullscreenchange", syncFullscreenHost);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenHost);
  }, []);

  // The local preview is only worth producing while the stage can be seen.
  useEffect(() => {
    const visible = !mixerOpen && !screenPickerOpen;
    void media.setLocalPreviewSurfaceVisible(visible).catch(() => undefined);
    return () => {
      if (!visible) void media.setLocalPreviewSurfaceVisible(true).catch(() => undefined);
    };
  }, [mixerOpen, media.setLocalPreviewSurfaceVisible, screenPickerOpen]);

  useEffect(() => {
    if (!data.user || !activeDetails) {
      const serialized = JSON.stringify(EMPTY_VOICE_OVERLAY_SNAPSHOT);
      if (lastOverlaySnapshotRef.current === serialized) return;
      lastOverlaySnapshotRef.current = serialized;
      void voiceOverlayCommands.updateSnapshot(EMPTY_VOICE_OVERLAY_SNAPSHOT).catch(() => undefined);
      return;
    }
    const snapshot = buildVoiceOverlaySnapshot({
      user: data.user,
      details: activeDetails,
      activeSession,
      connected: media.phase === "connected",
      mixerState: media.audioState,
      videoMixer: media.videoState,
      speakingActivity: media.speakingActivity,
      screenSharingUserIds: media.screenSharingUserIds,
      locationLabel: data.labels.nestSingular,
    });
    const serialized = JSON.stringify(snapshot);
    if (lastOverlaySnapshotRef.current === serialized) return;
    const timer = window.setTimeout(() => {
      lastOverlaySnapshotRef.current = serialized;
      void voiceOverlayCommands.updateSnapshot(snapshot).catch(() => undefined);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [
    activeDetails,
    activeSession,
    data.user,
    data.labels.nestSingular,
    media.audioState,
    media.phase,
    media.screenSharingUserIds,
    media.speakingActivity,
    media.videoState,
  ]);

  const micLevel = connected && media.localMicEnabled && data.user ? media.speakingActivity[data.user.id]?.intensity ?? 0 : null;
  const controls = (
    <DockDeviceControls
      data={data}
      media={media}
      hotkeys={hotkeys}
      micLevel={micLevel}
      onScreenPicker={() => setScreenPickerOpen(true)}
      pendingActions={pendingCallActions}
      onCallAction={runCallAction}
    />
  );

  return (
    <>
      <footer className="grid h-16 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 px-3">
        <div className="flex min-w-0 items-center justify-self-start">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`${selfName}, ${PRESENCE[presence].label}. Change how you appear`}
                className="flex h-11 min-w-0 max-w-[240px] items-center gap-2.5 rounded-card pl-1.5 pr-3 text-left transition-colors hover:bg-secondary data-[state=open]:bg-secondary"
              >
                <span className="relative shrink-0">
                  <Avatar name={selfName} src={data.user ? api.userAvatarUrl(data.user.id, data.user.updatedAt) : undefined} className="h-8 w-8" />
                  <PresenceDot presence={presence} avatarBadge surface="canvas" className="absolute -bottom-px -right-px" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-small font-medium">{selfName}</span>
                  <span className="block truncate text-caption text-muted-foreground">{PRESENCE[presence].label}</span>
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="min-w-[220px]">
              <DropdownMenuLabel>How you appear</DropdownMenuLabel>
              {SELECTABLE_PRESENCES.map((value) => (
                <DropdownMenuItem key={value} onSelect={() => void data.setPresence(value).catch(() => undefined)}>
                  <span className="flex w-4 justify-center"><PresenceDot presence={value} surface="popover" /></span>
                  <span className="flex-1">{PRESENCE[value].label}</span>
                  {value === presence ? <Check className="text-foreground" /> : null}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onNavigate({ kind: "settings" })}>
                <Settings className="text-muted-foreground" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={data.logout}>
                <LogOut className="text-muted-foreground" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-2 justify-self-center">{controls}</div>

        <div className="flex min-w-0 items-center justify-end gap-2 justify-self-end">
          {media.lastError ? <MediaErrorChip media={media} /> : null}
          {media.activeNestId ? (
            <>
              <Tooltip label={`Return to ${activeNest?.name ?? data.labels.nestSingular}`}>
                <button
                  type="button"
                  onClick={() => onNavigate({ kind: "nest", id: media.activeNestId! })}
                  className="flex h-9 min-w-0 items-center gap-2 rounded-control px-2.5 text-left transition-colors hover:bg-secondary"
                >
                  {media.reconnecting || media.phase !== "connected" ? (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
                  ) : (
                    <LiveDot />
                  )}
                  <span className="min-w-0 max-w-[160px] truncate text-small font-medium">{activeNest?.name ?? data.labels.nestSingular}</span>
                  <span className="shrink-0 text-caption text-muted-foreground">
                    {media.reconnecting ? "Reconnecting…" : media.phase === "joining" ? "Connecting…" : media.phase === "leaving" ? "Leaving…" : <ElapsedTime since={connectedSince} />}
                  </span>
                </button>
              </Tooltip>
              <Button
                variant="destructive"
                size="sm"
                className="gap-1.5"
                disabled={media.phase === "leaving" || pendingCallActions.has("leave")}
                onClick={() => runCallAction("leave")}
              >
                <PhoneOff className="h-4 w-4" />
                Leave
              </Button>
            </>
          ) : null}
          <NetworkActivityIndicator activity={networkActivity} />
          <Tooltip label={mixerOpen ? "Close mixer" : "Mixer"}>
            <button
              type="button"
              aria-label="Mixer"
              aria-pressed={mixerOpen}
              onClick={onToggleMixer}
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-control transition-colors",
                mixerOpen ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              <SlidersHorizontal className="h-[18px] w-[18px]" />
            </button>
          </Tooltip>
        </div>
      </footer>

      {fullscreenHost
        ? createPortal(
            <FullscreenDeviceOverlay networkActivity={networkActivity}>{controls}</FullscreenDeviceOverlay>,
            fullscreenHost,
          )
        : null}

      <ScreenSharePickerDialog
        open={screenPickerOpen}
        onOpenChange={setScreenPickerOpen}
        supportsDisplayAudio={Boolean(media.videoCapabilities?.supportsDisplayAudio)}
        supportsWindowAudio={Boolean(media.videoCapabilities?.supportsWindowAudio)}
        onPickDisplay={(display, withAudio, profile) => {
          setScreenPickerOpen(false);
          void media.startDisplayShare(display, withAudio, profile);
        }}
        onPickWindow={(windowTarget, withAudio, profile) => {
          setScreenPickerOpen(false);
          void media.startWindowShare(windowTarget, withAudio, profile);
        }}
      />
    </>
  );
}

function hotkeyLabel(value?: string) {
  if (!value) return undefined;
  return value.replace(/Control/g, "Ctrl").replace(/Command/g, "⌘").replace(/\+/g, " ");
}

/**
 * The four signal controls. What stands out is the departure from a calm call:
 * a cut channel (muted, deafened) is red and slashed; revealing more (camera,
 * screen) is the bright fill. Shape changes with state, so colour is never the
 * only cue.
 *
 * Camera and screen have three looks, because "I turned it on" and "people can
 * see it" are different facts: off, ready (an outline: chosen, nothing sent, which
 * is always the case outside a call) and live (the fill: confirmed as sent).
 */
function DockDeviceControls({
  data,
  media,
  hotkeys,
  micLevel,
  onScreenPicker,
  pendingActions,
  onCallAction,
}: {
  data: RavenShellData;
  media: RavenMediaAdapterState;
  hotkeys: MediaHotkeySettings | null;
  micLevel: number | null;
  onScreenPicker: () => void;
  pendingActions: ReadonlySet<ThumbnailToolbarAction>;
  onCallAction: (action: ThumbnailToolbarAction) => void;
}) {
  const inCall = media.phase === "connected" && media.activeNestId != null;
  const nest = data.labels.nestSingular.toLowerCase();
  return (
    <>
      <DockControl
        label={!media.audioSupported ? "No microphone available" : media.localMicEnabled ? "Mute" : "Unmute"}
        description={
          !media.audioSupported
            ? undefined
            : media.localMicEnabled
              ? inCall ? "People here can hear you." : `Your mic is on. You will be heard when you join a ${nest}.`
              : inCall ? "Nobody can hear you." : `You will join muted.`
        }
        shortcut={hotkeyLabel(hotkeys?.mic)}
        tone={media.localMicEnabled ? "neutral" : "cut"}
        pressed={media.localMicEnabled}
        disabled={!media.audioSupported || media.busy || pendingActions.has("mic")}
        onClick={() => onCallAction("mic")}
        menuLabel="Microphone settings"
        menu={<MicMenu media={media} />}
      >
        {media.localMicEnabled ? <Mic /> : <MicOff />}
        {micLevel !== null ? <LevelBars level={micLevel} /> : null}
      </DockControl>
      <DockControl
        label={!media.cameraSupported ? "No camera available" : media.localCameraEnabled ? "Turn camera off" : "Turn camera on"}
        description={videoDescription(media.cameraStatus, inCall, {
          live: "People here can see you.",
          starting: "Starting. People cannot see you yet.",
          ready: `Ready. It turns on when you join a ${nest}, and people will see you.`,
          error: "The camera could not start. Click to try again.",
        })}
        shortcut={hotkeyLabel(hotkeys?.camera)}
        tone={videoTone(media.cameraStatus)}
        pressed={media.localCameraEnabled}
        disabled={!media.cameraSupported || media.busy}
        onClick={() => void media.toggleCamera().catch(() => undefined)}
        menuLabel="Camera settings"
        menu={<CameraMenu media={media} />}
      >
        {media.localCameraEnabled ? <Video /> : <VideoOff />}
        {inCall && media.localCameraEnabled && media.cameraStatus !== "live" ? <Loader2 className="animate-spin" /> : null}
      </DockControl>
      <DockControl
        label={!media.screenShareSupported ? "Screen sharing is not available" : media.screenSharing ? "Stop sharing" : "Share your screen"}
        description={videoDescription(media.screenShareStatus, inCall, {
          live: media.windowSharing ? "People here can see the window you picked." : "People here can see your screen.",
          starting: "Starting. People cannot see it yet.",
          ready: `Ready. Sharing starts when you join a ${nest}.`,
          error: "Sharing could not start. Click to pick again.",
        })}
        shortcut={hotkeyLabel(hotkeys?.screenShare)}
        tone={videoTone(media.screenShareStatus)}
        pressed={media.screenSharing}
        disabled={!media.screenShareSupported || media.busy}
        onClick={() => void (media.screenSharing ? media.stopScreenShare().catch(() => undefined) : onScreenPicker())}
      >
        <MonitorUp />
        {inCall && media.screenSharing && media.screenShareStatus !== "live" ? <Loader2 className="animate-spin" /> : null}
      </DockControl>
      <DockControl
        label={media.localDeafened ? "Hear people again" : "Stop hearing people"}
        description={media.localDeafened ? "Incoming sound is off. You cannot hear anyone." : undefined}
        shortcut={hotkeyLabel(hotkeys?.deafen)}
        tone={media.localDeafened ? "cut" : "neutral"}
        pressed={!media.localDeafened}
        disabled={media.busy || !media.deafenSupported || pendingActions.has("deafen")}
        onClick={() => onCallAction("deafen")}
        menuLabel="Speaker settings"
        menu={<OutputMenu media={media} />}
      >
        {media.localDeafened ? <HeadphoneOff /> : <Headphones />}
      </DockControl>
    </>
  );
}

/** Only a confirmed source gets the fill. A chosen one that is not sent is an outline. */
function videoTone(status: LocalVideoStatus): "off" | "ready" | "on" {
  if (status === "live") return "on";
  return status === "ready" || status === "starting" ? "ready" : "off";
}

function videoDescription(
  status: LocalVideoStatus,
  inCall: boolean,
  copy: { live: string; starting: string; ready: string; error: string },
) {
  if (status === "off") return undefined;
  if (status === "error") return copy.error;
  if (status === "live") return copy.live;
  // In a call a chosen source is on its way to being sent; outside one it waits.
  return inCall ? copy.starting : copy.ready;
}

function DockControl({
  children,
  label,
  description,
  shortcut,
  tone,
  pressed,
  disabled,
  onClick,
  menu,
  menuLabel,
}: {
  children: ReactNode;
  label: string;
  description?: string;
  shortcut?: string;
  tone: "neutral" | "off" | "ready" | "on" | "cut";
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  menu?: ReactNode;
  menuLabel?: string;
}) {
  return (
    <div className={cn("flex h-11 items-stretch rounded-card bg-secondary", disabled && "opacity-45")}>
      <Tooltip
        label={description ? <span><span className="block font-medium">{label}</span><span className="block text-muted-foreground">{description}</span></span> : label}
        shortcut={shortcut}
      >
        <button
          type="button"
          aria-label={description ? `${label}. ${description}` : label}
          aria-pressed={pressed}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            "flex min-w-11 items-center justify-center gap-2 px-3 transition-colors focus-visible:-outline-offset-2 disabled:cursor-not-allowed [&>svg]:h-[18px] [&>svg]:w-[18px] [&>svg]:shrink-0",
            menu ? "rounded-l-card" : "rounded-card",
            tone === "neutral" && "text-foreground hover:bg-accent",
            tone === "off" && "text-muted-foreground hover:bg-accent hover:text-foreground",
            tone === "ready" && "text-foreground shadow-[inset_0_0_0_1.5px_hsl(var(--foreground)/0.7)] hover:bg-accent",
            tone === "cut" && "text-destructive hover:bg-accent",
            tone === "on" && "bg-foreground text-background hover:bg-foreground/90",
          )}
        >
          {children}
        </button>
      </Tooltip>
      {menu ? (
        <Popover>
          <Tooltip label={menuLabel ?? "Settings"}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={menuLabel}
                className="flex w-6 items-center justify-center rounded-r-card border-l border-background/60 text-subtle transition-colors hover:bg-accent hover:text-foreground focus-visible:-outline-offset-2 data-[state=open]:bg-accent data-[state=open]:text-foreground"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
            </PopoverTrigger>
          </Tooltip>
          <PopoverContent side="top" align="center" className="w-[360px] p-2">
            {menu}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

/** Your own voice, live. Only drawn while you are in a call with the mic on. */
function LevelBars({ level }: { level: number }) {
  const clamped = Math.min(1, Math.max(0, level));
  const heights = [0.45, 1, 0.7].map((weight) => 3 + Math.round(clamped * weight * 11));
  return (
    <span aria-hidden className="flex h-3.5 items-center gap-[2px]">
      {heights.map((height, index) => (
        <span
          key={index}
          className={cn("w-[2px] rounded-full transition-[height,background-color] duration-100", clamped > 0.02 ? "bg-live" : "bg-subtle")}
          style={{ height }}
        />
      ))}
    </span>
  );
}

function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="px-2 pb-1 pt-1 text-caption text-subtle">{children}</div>;
}

function DeviceOption({ selected, disabled, onSelect, children }: { selected: boolean; disabled?: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      title={typeof children === "string" ? children : undefined}
      className="flex min-h-8 w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-small transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected ? <Check className="h-4 w-4 shrink-0" /> : null}
    </button>
  );
}

function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={cn("flex items-center justify-between gap-3 rounded-control px-2 py-1.5", disabled && "opacity-45")}>
      <span className="min-w-0">
        <span className="block text-small">{label}</span>
        {hint ? <span className="block text-caption text-muted-foreground">{hint}</span> : null}
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  );
}

function MicMenu({ media }: { media: RavenMediaAdapterState }) {
  const processing = media.localAudioProcessing;
  const updateProcessing = (patch: Partial<NonNullable<typeof processing>>) => {
    if (!processing) return;
    void media.setMicProcessing({ ...processing, ...patch }).catch(() => undefined);
  };
  const selected = media.selectedMic ?? "";
  return (
    <div role="menu" aria-label="Microphone">
      <MenuHeading>Microphone</MenuHeading>
      <div className="max-h-44 overflow-y-auto">
        <DeviceOption selected={selected === ""} disabled={!media.audioSupported} onSelect={() => void media.setMicDevice(null).catch(() => undefined)}>
          System default
        </DeviceOption>
        {media.availableInputDevices.map((device) => (
          <DeviceOption
            key={device.deviceId}
            selected={selected === device.deviceId}
            disabled={!media.audioSupported}
            onSelect={() => void media.setMicDevice(device.deviceId).catch(() => undefined)}
          >
            {device.name || "Microphone"}
          </DeviceOption>
        ))}
      </div>
      <div className="mx-2 my-1.5 h-px bg-border" />
      <SwitchRow label="Noise suppression" hint="Reduces background noise." checked={Boolean(processing?.noiseSuppression)} disabled={!processing} onChange={(checked) => updateProcessing({ noiseSuppression: checked })} />
      <SwitchRow label="Echo cancellation" hint="Keeps speaker sound out of your mic." checked={Boolean(processing?.echoCancellation)} disabled={!processing} onChange={(checked) => updateProcessing({ echoCancellation: checked })} />
      <SwitchRow label="Automatic gain" hint="Evens out how loud you are." checked={Boolean(processing?.autoGainControl)} disabled={!processing} onChange={(checked) => updateProcessing({ autoGainControl: checked })} />
      {processing ? null : <p className="px-2 pb-1 pt-1.5 text-caption text-subtle">These unlock once your microphone has been turned on.</p>}
    </div>
  );
}

function CameraMenu({ media }: { media: RavenMediaAdapterState }) {
  const currentCameraProfile = media.activeCameraProfile ?? media.preferredCameraProfile;
  const [cameraQuality, setCameraQuality] = useState<VideoQualityProfileId>(currentCameraProfile.profileId);
  const [customVideoDraft, setCustomVideoDraft] = useState(() => customDraftFromProfile(currentCameraProfile));
  const selectedProfile = profileFromSelection(cameraQuality, customVideoDraft, currentCameraProfile);
  const selected = media.selectedCamera ?? "";
  return (
    <div role="menu" aria-label="Camera">
      <MenuHeading>Camera</MenuHeading>
      {media.availableCameras.length ? (
        <div className="max-h-44 overflow-y-auto">
          {media.availableCameras.map((camera) => (
            <DeviceOption
              key={camera.id}
              selected={selected === camera.id}
              disabled={!media.cameraSupported}
              onSelect={() => void media.setCameraDevice(camera.id).catch(() => undefined)}
            >
              {camera.name || "Camera"}
            </DeviceOption>
          ))}
        </div>
      ) : (
        <p className="px-2 py-1.5 text-small text-muted-foreground">No camera found. Connect one and it will appear here.</p>
      )}
      <div className="mx-2 my-1.5 h-px bg-border" />
      <VideoProfileFields
        className="px-2 pb-1"
        profileId={cameraQuality}
        customDraft={customVideoDraft}
        summary={`Up to ${selectedProfile.width}×${selectedProfile.height} at ${Math.round(selectedProfile.fps)} fps`}
        onProfileIdChange={(profileId) => {
          setCameraQuality(profileId);
          void media.setCameraProfile(profileFromSelection(profileId, customVideoDraft, currentCameraProfile)).catch(() => undefined);
        }}
        onCustomDraftChange={(draft) => {
          setCustomVideoDraft(draft);
          if (cameraQuality === "custom") void media.setCameraProfile(profileFromSelection("custom", draft, currentCameraProfile)).catch(() => undefined);
        }}
      />
    </div>
  );
}

function OutputMenu({ media }: { media: RavenMediaAdapterState }) {
  const supported = Boolean(media.audioCapabilities?.supportsOutputDevices);
  const selected = media.selectedOutput ?? "";
  return (
    <div role="menu" aria-label="Speakers">
      <MenuHeading>Speakers</MenuHeading>
      <div className="max-h-44 overflow-y-auto">
        <DeviceOption selected={selected === ""} disabled={!supported} onSelect={() => void media.setOutputDevice(null).catch(() => undefined)}>
          System default
        </DeviceOption>
        {media.availableOutputDevices.map((device) => (
          <DeviceOption
            key={device.deviceId}
            selected={selected === device.deviceId}
            disabled={!supported}
            onSelect={() => void media.setOutputDevice(device.deviceId).catch(() => undefined)}
          >
            {device.name || "Speaker"}
          </DeviceOption>
        ))}
      </div>
      <div className="mx-2 my-1.5 h-px bg-border" />
      <div className="px-2 pb-1">
        <Button variant="secondary" size="sm" className="w-full" disabled={!supported} onClick={() => void media.testOutputDevice().catch(() => undefined)}>
          Play a test sound
        </Button>
      </div>
    </div>
  );
}

function MediaErrorChip({ media }: { media: RavenMediaAdapterState }) {
  const error = media.lastError;
  if (!error) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-9 shrink-0 items-center gap-2 rounded-control bg-destructive/10 px-2.5 text-small font-medium text-destructive transition-colors hover:bg-destructive/15"
        >
          <AlertTriangle className="h-4 w-4" />
          Device problem
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[340px] p-3.5">
        <div className="text-small font-medium">{error.message}</div>
        {error.action ? <p className="mt-1 text-small text-muted-foreground">{error.action}</p> : null}
        <div className="mt-3 flex justify-end">
          <Button variant="secondary" size="sm" onClick={media.clearError}>Dismiss</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FullscreenDeviceOverlay({
  children,
  networkActivity,
}: {
  children: ReactNode;
  networkActivity: NetworkActivitySnapshot;
}) {
  const [visible, setVisible] = useState(true);
  const hideTimerRef = useRef<number | null>(null);
  const pointerInsideRef = useRef(false);
  const networkMenuOpenRef = useRef(false);

  const clearHideTimer = () => {
    if (hideTimerRef.current === null) return;
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  };
  const reveal = () => {
    clearHideTimer();
    setVisible(true);
  };
  const scheduleHide = () => {
    clearHideTimer();
    if (networkMenuOpenRef.current) return;
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setVisible(false);
    }, 1400);
  };

  useEffect(() => {
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setVisible(false);
    }, 2800);
    return () => clearHideTimer();
  }, []);

  return (
    <div
      className={cn(
        "absolute inset-x-0 bottom-0 z-[60] flex items-end justify-center px-4 transition-[height] duration-200",
        visible ? "h-24 pb-4" : "h-5",
      )}
      onMouseEnter={() => {
        pointerInsideRef.current = true;
        reveal();
      }}
      onMouseLeave={() => {
        pointerInsideRef.current = false;
        scheduleHide();
      }}
      onFocusCapture={reveal}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleHide();
      }}
      aria-label="Fullscreen media controls"
    >
      <div
        inert={!visible}
        aria-hidden={!visible}
        className={cn(
          "flex items-center gap-2 rounded-panel bg-popover/95 p-2 shadow-raised backdrop-blur-xl transition-[opacity,transform] duration-200",
          visible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0",
        )}
      >
        {children}
        <NetworkActivityIndicator
          activity={networkActivity}
          onOpenChange={(open) => {
            networkMenuOpenRef.current = open;
            if (open) reveal();
            else if (!pointerInsideRef.current) scheduleHide();
          }}
        />
      </div>
    </div>
  );
}

function NetworkActivityIndicator({
  activity,
  onOpenChange,
}: {
  activity: NetworkActivitySnapshot;
  onOpenChange?: (open: boolean) => void;
}) {
  const visibleCategories = activity.categories.filter((category) => category !== "other");
  // Outside a call there is nothing to measure, so there is nothing to show.
  if (!activity.enabled || !activity.active || visibleCategories.length === 0 || activity.directions.length === 0) return null;

  const summary = selectedNetworkSummary(activity);
  const summaryText = networkSummaryText(activity, summary);
  const sendingShareQuality = screenShareQualityNotice(activity.screenShareQuality);
  const receivingShareQuality = receivedScreenShareQualityNotice(activity.screenShareQuality);
  const measuring = !activity.active || !summary || activity.updatedAt == null;
  return (
    <Popover onOpenChange={onOpenChange}>
      <Tooltip label="Network activity">
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Network activity: ${summaryText}`}
            className="hidden h-9 shrink-0 items-center gap-2 rounded-control px-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground data-[state=open]:bg-secondary min-[1100px]:flex"
          >
            {measuring ? (
              <span className="text-caption">{summaryText}</span>
            ) : (
              <span className="rv-mono flex flex-col items-start text-caption leading-[14px] tabular-nums">
                {activity.directions.includes("incoming") ? <span className="flex items-center gap-1"><ArrowDown className="h-3 w-3" />{formatBitrate(summary.incoming)}</span> : null}
                {activity.directions.includes("outgoing") ? <span className="flex items-center gap-1"><ArrowUp className="h-3 w-3" />{formatBitrate(summary.outgoing)}</span> : null}
              </span>
            )}
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent side="top" align="end" className="w-[340px] p-3.5">
        <div className="flex items-center gap-1.5">
          <div className="text-small font-medium">Network activity</div>
          <InfoTooltip label="About network activity" align="end">
            Media only. Total is what Raven measures for audio, video and screen sharing; sign-in, signalling and other system traffic are not included.
          </InfoTooltip>
        </div>
        <div className="mt-2 divide-y divide-border/70">
          {visibleCategories.map((category) => (
            <NetworkActivityRow key={category} category={category} activity={activity} />
          ))}
        </div>
        {sendingShareQuality || receivingShareQuality ? (
          <div className="mt-3 rounded-control bg-warning/10 px-3 py-2 text-caption text-muted-foreground">
            <span className="font-medium text-warning">Screen share quality</span>
            {sendingShareQuality ? <p className="mt-0.5">{sendingShareQuality}</p> : null}
            {receivingShareQuality ? <p className="mt-0.5">{receivingShareQuality}</p> : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function NetworkActivityRow({
  category,
  activity,
}: {
  category: NetworkActivityCategory;
  activity: NetworkActivitySnapshot;
}) {
  const label = NETWORK_CATEGORY_LABELS[category];
  const rate = activity.rates[category];
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className={cn("text-small", category === "total" && "font-medium")}>{label}</span>
      <span className="rv-mono flex items-center gap-3 text-caption tabular-nums text-muted-foreground">
        {activity.directions.includes("incoming") ? <span className="flex items-center gap-1"><ArrowDown className="h-3 w-3" />{formatBitrate(rate.incoming)}</span> : null}
        {activity.directions.includes("outgoing") ? <span className="flex items-center gap-1"><ArrowUp className="h-3 w-3" />{formatBitrate(rate.outgoing)}</span> : null}
      </span>
    </div>
  );
}

const NETWORK_CATEGORY_LABELS: Record<NetworkActivityCategory, string> = {
  audio: "Audio",
  video: "Video",
  screenShare: "Screen share",
  other: "Other",
  total: "Total",
};

function selectedNetworkSummary(activity: NetworkActivitySnapshot): NetworkTransferRate | null {
  const measurable = activity.categories.filter(
    (category): category is MeasuredNetworkCategory => category !== "total" && category !== "other",
  );
  if (activity.categories.includes("total")) return activity.rates.total;
  if (measurable.length === 0) return null;
  return measurable.reduce<NetworkTransferRate>(
    (sum, category) => ({
      incoming: sum.incoming + activity.rates[category].incoming,
      outgoing: sum.outgoing + activity.rates[category].outgoing,
    }),
    { incoming: 0, outgoing: 0 },
  );
}

function networkSummaryText(activity: NetworkActivitySnapshot, rate: NetworkTransferRate | null) {
  if (!activity.active) return "No media";
  if (!rate) return "Not measured";
  if (activity.updatedAt == null) return "Measuring…";
  return [
    activity.directions.includes("incoming") ? `down ${formatBitrate(rate.incoming)}` : null,
    activity.directions.includes("outgoing") ? `up ${formatBitrate(rate.outgoing)}` : null,
  ].filter(Boolean).join(", ");
}

function formatBitrate(bitsPerSecond: number) {
  if (bitsPerSecond >= 1_000_000) {
    const value = bitsPerSecond / 1_000_000;
    return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} Mbit/s`;
  }
  const value = bitsPerSecond / 1_000;
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} Kbit/s`;
}
