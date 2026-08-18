import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AudioMixerPanel } from "@/components/AudioMixerPanel";
import {
  ScreenSharePickerDialog,
  VideoProfileFields,
  customDraftFromProfile,
  profileFromSelection,
} from "@/components/nest/VideoPickers";
import { buildVoiceOverlaySnapshot, EMPTY_VOICE_OVERLAY_SNAPSHOT, voiceOverlayCommands } from "@/lib/voiceOverlay";
import { subscribeMediaHotkeys } from "@/lib/mediaHotkeys";
import { cn } from "@/lib/utils";
import { type VideoQualityProfileId } from "@/lib/video";
import { Headphones, Mic, MicOff, MonitorUp, Network, Settings2, SlidersHorizontal, Video, VideoOff, VolumeX } from "lucide-react";
import { InfoTooltip, Island, PresenceDot, SignalMeter } from "./atoms";
import { displayNameFor, PRESENCE, presenceFromApi, type RavenShellData } from "./state";
import type {
  RavenMediaAdapterState,
} from "./useRavenMediaAdapter";
import type {
  MeasuredNetworkCategory,
  NetworkActivityCategory,
  NetworkActivitySnapshot,
  NetworkTransferRate,
} from "./networkActivity";
import { useNetworkActivity } from "./useNetworkActivity";

export function DeviceDock({ data, media }: { data: RavenShellData; media: RavenMediaAdapterState }) {
  const [drawer, setDrawer] = useState<"media" | "mixer" | null>(null);
  const [screenPickerOpen, setScreenPickerOpen] = useState(false);
  const mediaRef = useRef(media);
  const hotkeyActionRef = useRef<Set<string>>(new Set());
  mediaRef.current = media;
  const [fullscreenHost, setFullscreenHost] = useState<HTMLElement | null>(null);
  const lastOverlaySnapshotRef = useRef("");
  const presence = presenceFromApi(data.presence);
  const adapterError = media.error;
  const activeDetails = media.activeNestId ? data.getNestDetails(media.activeNestId) : undefined;
  const activeSession = media.activeNestId ? data.getActiveSession(media.activeNestId) ?? null : null;
  const selfName = data.user ? displayNameFor(data.user) : "You";
  const networkActivity = useNetworkActivity(media.activeNestId != null, media.networkActivity);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    subscribeMediaHotkeys((action) => {
      const current = mediaRef.current;
      if (current.busy || hotkeyActionRef.current.has(action)) return;
      let operation: Promise<void> | null = null;
      if (action === "mic" && current.audioSupported) operation = current.toggleMic();
      if (action === "camera" && current.cameraSupported) {
        operation = current.localCameraEnabled ? current.stopCamera() : current.toggleCamera();
      }
      if (action === "deafen" && current.deafenSupported) operation = current.toggleDeafen();
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
  }, []);

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

  useEffect(() => {
    const visible = drawer === null && !screenPickerOpen;
    void media.setLocalPreviewSurfaceVisible(visible).catch(() => undefined);
    return () => {
      if (!visible) void media.setLocalPreviewSurfaceVisible(true).catch(() => undefined);
    };
  }, [drawer, media.setLocalPreviewSurfaceVisible, screenPickerOpen]);

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

  return (
    <>
      <Island className={cn("grid h-[64px] shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 bg-transparent px-3", adapterError && "ring-1 ring-destructive/50")}>
        <div className="flex min-w-0 items-center gap-3 justify-self-start">
          <Avatar name={selfName} src={data.user ? `${data.apiServerUrl}/v1/media/users/${data.user.id}/avatar?v=${encodeURIComponent(data.user.updatedAt)}` : undefined} className="h-8 w-8" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium leading-none">{selfName}</div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild disabled={data.busy}>
                <button
                  type="button"
                  className="mt-1.5 flex max-w-full items-center gap-1.5 rounded-sm rv-mono text-[11px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Change availability"
                  title={adapterError ?? "Change availability"}
                >
                  <PresenceDot presence={presence} />
                  <span className="truncate">{PRESENCE[presence].label}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="min-w-[180px]">
                {Object.entries(PRESENCE).map(([value, config]) => (
                  <DropdownMenuItem
                    key={value}
                    className={cn(value === presence && "bg-accent/60 text-accent-foreground")}
                    onSelect={() => void data.setPresence(value as typeof presence)}
                  >
                    <PresenceDot presence={value as typeof presence} />
                    {config.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <SignalMeter className={cn("ml-1", media.localMicEnabled ? "opacity-80" : "opacity-35")} />
        </div>

        <div className="flex items-center gap-2 justify-self-center">
          <DockDeviceControls data={data} media={media} onScreenPicker={() => setScreenPickerOpen(true)} />
        </div>

        <div className="flex min-w-0 items-center justify-end gap-2 justify-self-end">
          <NetworkActivityIndicator activity={networkActivity} />
          <Button variant="secondary" size="sm" className="h-10 rounded-xl px-3 gap-2" onClick={() => setDrawer("mixer")} title="Open mixer">
            <SlidersHorizontal className="h-4 w-4" />
            Mixer
          </Button>
          <Button variant="secondary" size="sm" className="h-10 rounded-xl px-3 gap-2" onClick={() => setDrawer("media")} title={media.deviceReadiness}>
            <Settings2 className="h-4 w-4" />
            Media Setup
          </Button>
        </div>
      </Island>

      {fullscreenHost
        ? createPortal(
            <FullscreenDeviceOverlay
              data={data}
              media={media}
              networkActivity={networkActivity}
              onScreenPicker={() => setScreenPickerOpen(true)}
            />,
            fullscreenHost,
          )
        : null}

      <Drawer
        open={drawer === "media"}
        onOpenChange={(open) => setDrawer(open ? "media" : null)}
        title="Media Setup"
        description="Check your microphone, camera, sharing, and speaker settings."
        widthClassName="w-full max-w-[520px]"
      >
        <MediaControls media={media} onScreenPicker={() => setScreenPickerOpen(true)} />
      </Drawer>

      <Drawer
        open={drawer === "mixer"}
        onOpenChange={(open) => setDrawer(open ? "mixer" : null)}
        title="Mixer"
        description="Sources, DSP, presets, meters and safety controls"
        widthClassName="w-full max-w-[1040px]"
      >
        <div className="h-[calc(100vh-120px)] min-h-[560px]">
          <AudioMixerPanel />
        </div>
      </Drawer>

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

function DockDeviceControls({
  data,
  media,
  onScreenPicker,
}: {
  data: RavenShellData;
  media: RavenMediaAdapterState;
  onScreenPicker: () => void;
}) {
  return (
    <>
      <DeviceControl
        label={media.localMicEnabled ? "Mic on" : media.audioSupported ? "Mic off" : "No mic"}
        tone={media.localMicEnabled ? "active" : "muted"}
        disabled={!media.audioSupported || media.busy}
        onClick={() => void media.toggleMic()}
      >
        {media.localMicEnabled ? <Mic className="h-[18px] w-[18px]" /> : <MicOff className="h-[18px] w-[18px]" />}
      </DeviceControl>
      <DeviceControl
        label={media.localCameraEnabled ? "Camera on" : media.cameraSupported ? "Camera off" : "No camera"}
        tone={media.localCameraEnabled ? "active" : "idle"}
        disabled={!media.cameraSupported || media.busy}
        onClick={() => void media.toggleCamera()}
      >
        {media.localCameraEnabled ? <Video className="h-[18px] w-[18px]" /> : <VideoOff className="h-[18px] w-[18px]" />}
      </DeviceControl>
      <DeviceControl
        label={media.deafenSupported ? media.outputLabel : "Output N/A"}
        tone={media.localDeafened ? "danger" : "idle"}
        disabled={media.busy}
        title={
          media.outputMuteSupported
            ? "Toggle output mute"
            : `Toggle app-level deafen. Raven mutes remote playback without leaving the ${data.labels.nestSingular}.`
        }
        onClick={() => void media.toggleDeafen()}
      >
        {media.localDeafened ? <VolumeX className="h-[18px] w-[18px]" /> : <Headphones className="h-[18px] w-[18px]" />}
      </DeviceControl>
      <DeviceControl
        label={media.screenSharing ? (media.windowSharing ? "Window" : "Sharing") : "Share off"}
        tone={media.screenSharing ? "active" : "idle"}
        disabled={!media.screenShareSupported || media.busy}
        onClick={() => void (media.screenSharing ? media.stopScreenShare() : onScreenPicker())}
      >
        <MonitorUp className="h-[18px] w-[18px]" />
      </DeviceControl>
    </>
  );
}

function FullscreenDeviceOverlay({
  data,
  media,
  networkActivity,
  onScreenPicker,
}: {
  data: RavenShellData;
  media: RavenMediaAdapterState;
  networkActivity: NetworkActivitySnapshot;
  onScreenPicker: () => void;
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
          "flex items-center gap-2 rounded-2xl border border-white/10 bg-background/85 p-2 shadow-2xl shadow-black/55 backdrop-blur-xl transition-[opacity,transform] duration-200",
          visible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0",
        )}
      >
        <DockDeviceControls data={data} media={media} onScreenPicker={onScreenPicker} />
        <div className="ml-1 border-l border-white/10 pl-3">
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
  if (!activity.enabled || visibleCategories.length === 0 || activity.directions.length === 0) return null;

  const summary = selectedNetworkSummary(activity);
  const summaryText = networkSummaryText(activity, summary);
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Network activity: ${summaryText}`}
          title="Measured network activity"
          className="flex h-10 shrink-0 items-center gap-2 rounded-xl bg-background/40 px-3 text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Network className="h-3.5 w-3.5 shrink-0 text-primary/80" />
          <CompactNetworkSummary activity={activity} rate={summary} summaryText={summaryText} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        className="w-[360px] !overflow-visible rounded-2xl bg-popover p-4 text-popover-foreground shadow-xl ring-1 ring-border/70"
      >
        <div className="flex items-center gap-2.5">
          <Network className="h-[18px] w-[18px] text-primary" />
          <div className="text-[15px] font-semibold text-foreground">Network activity</div>
          <InfoTooltip label="About measured network activity" align="end">
            Media payload transfer rates. Total is measured traffic, not process-wide traffic. API requests, realtime control, signaling, and OS-level traffic are excluded.
          </InfoTooltip>
        </div>
        <div className="mt-3 space-y-1.5">
          {visibleCategories.map((category) => (
            <NetworkActivityRow key={category} category={category} activity={activity} />
          ))}
        </div>
        {/* <div className="mt-3 rv-mono text-[11px] text-muted-foreground">
          {!activity.active ? "No active media session" : activity.updatedAt == null ? "Collecting the first interval..." : "Updates about once per second"}
        </div> */}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CompactNetworkSummary({
  activity,
  rate,
  summaryText,
}: {
  activity: NetworkActivitySnapshot;
  rate: NetworkTransferRate | null;
  summaryText: string;
}) {
  if (!activity.active || !rate || activity.updatedAt == null) {
    return <span className="truncate rv-mono text-[10px] font-medium text-foreground/85">{summaryText}</span>;
  }
  return (
    <span className="flex flex-col items-start rv-mono text-[10px] font-medium leading-[15px] text-foreground/85">
      {activity.directions.includes("incoming") ? <span>↓ {formatBitrate(rate.incoming)}</span> : null}
      {activity.directions.includes("outgoing") ? <span>↑ {formatBitrate(rate.outgoing)}</span> : null}
    </span>
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
    <div className="flex items-center justify-between gap-4 rounded-xl bg-secondary/55 px-3 py-2.5">
      <span className="text-[13px] font-medium text-foreground/90">{label}</span>
      <span className="flex items-center gap-3 rv-mono text-[11px] font-medium text-foreground/75">
        {activity.directions.includes("incoming") ? <span>↓ {formatBitrate(rate.incoming)}</span> : null}
        {activity.directions.includes("outgoing") ? <span>↑ {formatBitrate(rate.outgoing)}</span> : null}
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
  if (activity.updatedAt == null) return "Measuring...";
  return [
    activity.directions.includes("incoming") ? `↓ ${formatBitrate(rate.incoming)}` : null,
    activity.directions.includes("outgoing") ? `↑ ${formatBitrate(rate.outgoing)}` : null,
  ].filter(Boolean).join("  ");
}

function formatBitrate(bitsPerSecond: number) {
  if (bitsPerSecond >= 1_000_000) {
    const value = bitsPerSecond / 1_000_000;
    return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} Mbit/s`;
  }
  const value = bitsPerSecond / 1_000;
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} Kbit/s`;
}

function MediaControls({
  media,
  onScreenPicker,
}: {
  media: RavenMediaAdapterState;
  onScreenPicker: () => void;
}) {
  const processing = media.localAudioProcessing;
  const selectedCamera = selectedDeviceName(media.selectedCamera, media.availableCameras, "Camera");
  const selectedShare = media.videoState?.localSources.find((source) => source.kind === "display" || source.kind === "window");
  const currentCameraProfile = media.activeCameraProfile ?? media.preferredCameraProfile;
  const [cameraQuality, setCameraQuality] = useState<VideoQualityProfileId>(currentCameraProfile.profileId);
  const [customVideoDraft, setCustomVideoDraft] = useState(() => customDraftFromProfile(currentCameraProfile));
  const selectedCameraProfile = profileFromSelection(cameraQuality, customVideoDraft, currentCameraProfile);
  const updateProcessing = (patch: Partial<NonNullable<typeof processing>>) => {
    if (!processing) return;
    void media.setMicProcessing({ ...processing, ...patch });
  };

  return (
    <div className="space-y-5">
      {media.lastError ? (
        <section className="rounded-lg border border-destructive/35 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-medium">{media.lastError.message}</div>
          <div className="mt-1 text-xs opacity-85">{media.lastError.action}</div>
          <Button variant="ghost" size="sm" className="mt-3 h-8 text-destructive hover:text-destructive" onClick={media.clearError}>
            Clear
          </Button>
        </section>
      ) : null}

      <SettingSection>
        <PanelTitle icon={<Mic />} title="Microphone" />
        <label className="block space-y-1.5 text-xs text-muted-foreground">
          Microphone
          <Select
            value={media.selectedMic ?? ""}
            disabled={!media.audioSupported}
            onValueChange={(value) => void media.setMicDevice(value || null)}
          >
            <SelectTrigger className="mt-1.5 rounded-xl border-border">
              <SelectValue>
                {media.selectedMic
                  ? media.availableInputDevices.find((device) => device.deviceId === media.selectedMic)?.name || "Microphone"
                  : "Default microphone"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="">Default microphone</SelectItem>
                {media.availableInputDevices.map((device) => (
                  <SelectItem key={device.deviceId} value={device.deviceId}>
                    {device.name || "Microphone"}{device.isDefault ? " (default)" : ""}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>
        <Button className="w-full justify-center" variant={media.localMicEnabled ? "secondary" : "default"} onClick={() => void media.toggleMic()} disabled={media.busy || !media.audioSupported}>
          {media.localMicEnabled ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
          {!media.audioSupported ? "Microphone unavailable" : media.localMicEnabled ? "Mute microphone" : "Unmute microphone"}
        </Button>
        <p className="text-xs leading-5 text-muted-foreground">
          {media.localMicEnabled ? "Your microphone is on. Other people can hear you." : "Your microphone is muted. Other people cannot hear you."}
        </p>

        <div className="space-y-3 border-t border-border/70 pt-4">
          <PanelTitle icon={<SlidersHorizontal />} title="Audio processing" />
          <ToggleRow
            label="Noise suppression"
            helper="Reduces background noise."
            checked={Boolean(processing?.noiseSuppression)}
            disabled={!processing}
            onChange={(checked) => updateProcessing({ noiseSuppression: checked })}
          />
          <ToggleRow
            label="Echo cancellation"
            helper="Prevents speaker audio from feeding back into your mic."
            checked={Boolean(processing?.echoCancellation)}
            disabled={!processing}
            onChange={(checked) => updateProcessing({ echoCancellation: checked })}
          />
          <ToggleRow
            label="Auto gain"
            helper="Automatically balances microphone volume."
            checked={Boolean(processing?.autoGainControl)}
            disabled={!processing}
            onChange={(checked) => updateProcessing({ autoGainControl: checked })}
          />
        </div>
      </SettingSection>

      <SettingSection>
        <PanelTitle icon={<Video />} title="Camera" />
        <label className="block space-y-1.5 text-xs text-muted-foreground">
          Camera
          <Select
            value={media.selectedCamera ?? ""}
            disabled={!media.cameraSupported}
            onValueChange={(value) => void media.setCameraDevice(value || null)}
          >
            <SelectTrigger className="mt-1.5 rounded-xl border-border">
              <SelectValue>{media.selectedCamera ? selectedCamera : "Select camera"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="">No camera selected</SelectItem>
                {media.availableCameras.map((camera) => (
                  <SelectItem key={camera.id} value={camera.id}>
                    {camera.name || "Camera"}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>
        <div>
          <Button className="w-full justify-center" variant={media.localCameraEnabled ? "secondary" : "default"} onClick={() => void media.toggleCamera()} disabled={media.busy || !media.cameraSupported}>
            {media.localCameraEnabled ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
            {!media.cameraSupported ? "Camera unavailable" : media.localCameraEnabled ? "Turn camera off" : "Turn camera on"}
          </Button>
          {/* Camera selection is handled by the Select above; no separate picker action. */}
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          {media.localCameraEnabled ? "Your camera is on. Other people can see you." : "Your camera is off. Other people cannot see you."}
        </p>
        <VideoProfileFields
          profileId={cameraQuality}
          customDraft={customVideoDraft}
          summary={`Max ${selectedCameraProfile.width}x${selectedCameraProfile.height} @ ${Math.round(selectedCameraProfile.fps)} FPS`}
          onProfileIdChange={(profileId) => {
            setCameraQuality(profileId);
            void media.setCameraProfile(profileFromSelection(profileId, customVideoDraft, currentCameraProfile));
          }}
          onCustomDraftChange={(draft) => {
            setCustomVideoDraft(draft);
            if (cameraQuality === "custom") void media.setCameraProfile(profileFromSelection("custom", draft, currentCameraProfile));
          }}
        />
        <div className="flex aspect-video items-center justify-center rounded-lg border border-border bg-background/35 text-center">
          {media.localCameraEnabled ? (
            <div className="space-y-1 px-4">
              <Video className="mx-auto h-6 w-6 text-primary" />
              <div className="text-sm font-medium">Camera is on</div>
              <div className="line-clamp-1 text-xs text-muted-foreground">{selectedCamera}</div>
            </div>
          ) : (
            <div className="space-y-1 px-4">
              <VideoOff className="mx-auto h-6 w-6 text-muted-foreground" />
              <div className="text-sm font-medium">Camera is off</div>
              <div className="text-xs text-muted-foreground">Turn it on to check your video.</div>
            </div>
          )}
        </div>
      </SettingSection>

      <SettingSection>
        <PanelTitle icon={<MonitorUp />} title="Screen sharing" />
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={onScreenPicker} disabled={media.busy || !media.screenShareSupported}>
            <MonitorUp className="h-4 w-4" />
            Choose source
          </Button>
          <Button variant="outline" onClick={() => void media.stopScreenShare()} disabled={!media.screenSharing || media.busy}>
            Stop sharing
          </Button>
        </div>
        {media.screenSharing && selectedShare ? (
          <div className="rounded-lg bg-background/35 px-3 py-2 text-sm">
            <div className="text-xs text-muted-foreground">Selected source</div>
            <div className="mt-0.5 truncate font-medium">{selectedShare.displayName || (media.windowSharing ? "Application window" : "Screen")}</div>
          </div>
        ) : (
          <p className="text-xs leading-5 text-muted-foreground">Choose a screen or application window when you want to share.</p>
        )}
      </SettingSection>

      <SettingSection>
        <PanelTitle icon={<Headphones />} title="Output" />
        <label className="block space-y-1.5 text-xs text-muted-foreground">
          Speaker
          <Select
            value={media.selectedOutput ?? ""}
            disabled={!media.audioCapabilities?.supportsOutputDevices}
            onValueChange={(value) => void media.setOutputDevice(value || null)}
          >
            <SelectTrigger className="mt-1.5 rounded-xl border-border">
              <SelectValue>
                {media.selectedOutput
                  ? media.availableOutputDevices.find((device) => device.deviceId === media.selectedOutput)?.name || "Speaker"
                  : "System default"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="">System default</SelectItem>
                {media.availableOutputDevices.map((device) => (
                  <SelectItem key={device.deviceId} value={device.deviceId}>
                    {device.name || "Speaker"}{device.isDefault ? " (default)" : ""}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>
        <Button variant="outline" className="w-full justify-center" onClick={() => void media.testOutputDevice()} disabled={!media.audioCapabilities?.supportsOutputDevices}>
          Test sound
        </Button>
        <Button variant={media.localDeafened ? "secondary" : "outline"} className="w-full justify-center" onClick={() => void media.toggleDeafen()} disabled={media.busy || !media.deafenSupported}>
          {media.localDeafened ? <VolumeX className="h-4 w-4" /> : <Headphones className="h-4 w-4" />}
          {!media.deafenSupported ? "Incoming audio control unavailable" : media.localDeafened ? "Resume incoming audio" : "Mute incoming audio"}
        </Button>
        <p className="text-xs leading-5 text-muted-foreground">
          {media.localDeafened ? "Incoming audio is muted. You cannot hear other people." : "Incoming audio is playing. You can hear other people."}
        </p>
      </SettingSection>
    </div>
  );
}

function SettingSection({ children }: { children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card/35 p-4">
      {children}
    </section>
  );
}

function PanelTitle({ icon, title, meta }: { icon: ReactNode; title: string; meta?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <span className="text-primary [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
        {title}
      </h3>
      {meta ? <span className="text-xs text-muted-foreground">{meta}</span> : null}
    </div>
  );
}

function ToggleRow({
  label,
  helper,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  helper?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={cn("flex items-center justify-between gap-3 rounded-xl bg-background/35 px-3 py-2 text-sm", disabled && "opacity-50")}>
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        {helper ? <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{helper}</span> : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="h-4 w-4 rounded border-border"
      />
    </label>
  );
}

function selectedDeviceName<T extends { id?: string; deviceId?: string; name?: string }>(selectedId: string | null, devices: T[], fallback: string) {
  if (!selectedId) return fallback;
  return devices.find((device) => (device.id ?? device.deviceId) === selectedId)?.name || fallback;
}

function DeviceControl({
  children,
  label,
  tone,
  disabled,
  title,
  onClick,
}: {
  children: ReactNode;
  label: string;
  tone: "muted" | "idle" | "active" | "danger";
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title ?? label}
      className={cn(
        "flex h-10 min-w-[70px] flex-col items-center justify-center gap-0.5 rounded-xl px-2.5 transition-colors",
        tone === "active" && "bg-primary/10 text-primary ring-1 ring-primary/30",
        tone === "danger" && "bg-destructive/15 text-destructive ring-1 ring-destructive/45 hover:bg-destructive/20",
        tone === "muted" && "bg-secondary/60 text-foreground",
        tone === "idle" && "bg-background/40 text-muted-foreground hover:bg-accent/40 hover:text-foreground",
        disabled && "cursor-not-allowed opacity-45 hover:bg-background/40 hover:text-muted-foreground",
      )}
    >
      {children}
      <span className="max-w-[72px] truncate rv-mono text-[10px] uppercase tracking-wide">{label}</span>
    </button>
  );
}
