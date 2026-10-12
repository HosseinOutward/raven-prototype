import { useCallback, useEffect, useState } from "react";
import { Camera, Loader2, Monitor, AppWindow, RefreshCw } from "lucide-react";
import {
  CameraDevice,
  DEFAULT_VIDEO_PROFILE,
  DisplayTarget,
  VIDEO_PROFILE_PRESETS,
  VideoQualityProfile,
  VideoQualityProfileId,
  WindowTarget,
  videoCommands,
} from "@/lib/video";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { fieldClassName } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

// The pickers share the app dialog; the screen picker asks for a wider one.
function ModalShell({
  title,
  description,
  onClose,
  widthClassName = "max-w-md",
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  widthClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title={title} description={description} widthClassName={widthClassName}>
      {children}
    </Dialog>
  );
}

function LoadingRow({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-small text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

// ─── Camera picker ──────────────────────────────────────────────────────────────

export function CameraPickerDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (camera: CameraDevice, profile: VideoQualityProfile) => void;
}) {
  const [cameras, setCameras] = useState<CameraDevice[] | null>(null);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<VideoQualityProfileId>("balanced");
  const [customDraft, setCustomDraft] = useState(customDraftFromProfile(DEFAULT_VIDEO_PROFILE));
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setCameras(null);
    setError("");
    videoCommands
      .listCameras()
      .then(setCameras)
      .catch((err) => {
        setCameras([]);
        setError(err instanceof Error ? err.message : "Could not list cameras");
      });
  }, []);

  useEffect(() => {
    if (open) {
      setSelectedCameraId(null);
      load();
    }
  }, [open, load]);

  if (!open) return null;
  const selectedCamera = (cameras ?? []).find((camera) => camera.id === selectedCameraId);
  const profile = profileFromSelection(profileId, customDraft, DEFAULT_VIDEO_PROFILE);

  return (
    <ModalShell
      title="Choose a camera"
      description="Pick a camera and video quality."
      onClose={() => onOpenChange(false)}
    >
      {cameras === null ? (
        <LoadingRow label="Finding cameras…" />
      ) : cameras.length === 0 ? (
        <div className="py-10 text-center text-small text-muted-foreground">
          {error || "No camera found. Connect one, then refresh."}
        </div>
      ) : (
        <div className="grid max-h-80 grid-cols-2 gap-2 overflow-y-auto">
          {cameras.map((camera) => (
            <button
              key={camera.id}
              type="button"
              onClick={() => setSelectedCameraId(camera.id)}
              className={cn(
                "flex flex-col items-center gap-2 rounded-card bg-secondary p-4 text-center transition-colors hover:bg-accent",
                selectedCameraId === camera.id && "outline outline-2 outline-foreground",
              )}
            >
              <Camera className="h-6 w-6" />
              <span className="line-clamp-2 text-small">{camera.name || "Camera"}</span>
            </button>
          ))}
        </div>
      )}

      <VideoProfileFields
        className="mt-4"
        profileId={profileId}
        customDraft={customDraft}
        onProfileIdChange={setProfileId}
        onCustomDraftChange={setCustomDraft}
        summary={`Up to ${profile.width}×${profile.height} at ${Math.round(profile.fps)} fps`}
      />

      <div className="mt-5 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={load}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!selectedCamera} onClick={() => selectedCamera && onPick(selectedCamera, profile)}>
            Turn camera on
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

// ─── Screen-share picker ─────────────────────────────────────────────────────────

type ScreenTab = "apps" | "screens";

export function ScreenSharePickerDialog({
  open,
  onOpenChange,
  onPickDisplay,
  onPickWindow,
  supportsDisplayAudio = true,
  supportsWindowAudio = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPickDisplay: (display: DisplayTarget, withAudio: boolean, profile: VideoQualityProfile) => void;
  onPickWindow: (window: WindowTarget, withAudio: boolean, profile: VideoQualityProfile) => void;
  supportsDisplayAudio?: boolean;
  supportsWindowAudio?: boolean;
}) {
  const [tab, setTab] = useState<ScreenTab>("apps");
  const [windows, setWindows] = useState<WindowTarget[] | null>(null);
  const [displays, setDisplays] = useState<DisplayTarget[] | null>(null);
  const [selected, setSelected] = useState<{ kind: ScreenTab; id: string } | null>(null);
  const [withAudio, setWithAudio] = useState(true);
  const [profileId, setProfileId] = useState<VideoQualityProfileId>("balanced");
  const [customDraft, setCustomDraft] = useState(customDraftFromProfile(DEFAULT_VIDEO_PROFILE));
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setWindows(null);
    setDisplays(null);
    setSelected(null);
    setError("");
    videoCommands
      .listWindows()
      .then(setWindows)
      .catch((err) => {
        setWindows([]);
        setError(err instanceof Error ? err.message : "Could not list windows");
      });
    videoCommands
      .listDisplays()
      .then(setDisplays)
      .catch(() => setDisplays([]));
  }, []);

  useEffect(() => {
    if (open) {
      setTab("apps");
      setWithAudio(true);
      load();
    }
  }, [open, load]);

  const selectedAudioSupported = tab === "apps" ? supportsWindowAudio : supportsDisplayAudio;

  useEffect(() => {
    if (!selectedAudioSupported) setWithAudio(false);
  }, [selectedAudioSupported]);

  const confirm = useCallback(() => {
    if (!selected) return;
    const profile = profileFromSelection(profileId, customDraft, DEFAULT_VIDEO_PROFILE);
    if (selected.kind === "apps") {
      const window = (windows ?? []).find((w) => w.id === selected.id);
      if (window) onPickWindow(window, withAudio && supportsWindowAudio, profile);
    } else {
      const display = (displays ?? []).find((d) => d.id === selected.id);
      if (display) onPickDisplay(display, withAudio && supportsDisplayAudio, profile);
    }
  }, [selected, profileId, customDraft, windows, displays, withAudio, supportsWindowAudio, supportsDisplayAudio, onPickWindow, onPickDisplay]);

  if (!open) return null;

  const list = tab === "apps" ? windows : displays;
  const selectedSource = selected
    ? selected.kind === "apps"
      ? (windows ?? []).find((window) => window.id === selected.id)
      : (displays ?? []).find((display) => display.id === selected.id)
    : undefined;
  const profile = profileFromSelection(profileId, customDraft, DEFAULT_VIDEO_PROFILE);
  const output = selectedSource
    ? outputForBudget(selectedSource.width, selectedSource.height, profile.maxPixels)
    : null;

  return (
    <ModalShell
      title="Share your screen"
      description="People in the call see only what you pick here."
      onClose={() => onOpenChange(false)}
      widthClassName="max-w-3xl"
    >
      <div className="mb-3 inline-flex rounded-control bg-background/60 p-0.5" role="tablist">
        <TabButton active={tab === "apps"} onClick={() => setTab("apps")} icon={<AppWindow className="h-4 w-4" />}>
          A window
        </TabButton>
        <TabButton active={tab === "screens"} onClick={() => setTab("screens")} icon={<Monitor className="h-4 w-4" />}>
          A whole screen
        </TabButton>
      </div>

      {list === null ? (
        <LoadingRow label="Finding sources…" />
      ) : list.length === 0 ? (
        <div className="py-10 text-center text-small text-muted-foreground">
          {error || (tab === "apps" ? "No open windows to share. Open the app first, then refresh." : "No screen found.")}
        </div>
      ) : (
        <div className="-mx-1 grid max-h-[340px] grid-cols-3 gap-2 overflow-y-auto p-1">
          {tab === "apps"
            ? (windows ?? []).map((window) => (
                <SourceTile
                  key={window.id}
                  selected={selected?.kind === "apps" && selected.id === window.id}
                  onClick={() => setSelected({ kind: "apps", id: window.id })}
                  thumbnail={window.thumbnailDataUrl}
                  icon={window.iconDataUrl}
                  fallback={<AppWindow className="h-6 w-6" />}
                  title={window.title || window.appName || "Window"}
                  subtitle={
                    window.width && window.height
                      ? `${window.appName} · ${window.width}×${window.height}`
                      : window.appName
                  }
                />
              ))
            : (displays ?? []).map((display) => (
                <SourceTile
                  key={display.id}
                  selected={selected?.kind === "screens" && selected.id === display.id}
                  onClick={() => setSelected({ kind: "screens", id: display.id })}
                  thumbnail={display.thumbnailDataUrl}
                  fallback={<Monitor className="h-6 w-6" />}
                  title={display.name || "Display"}
                  subtitle={
                    display.width && display.height
                      ? `${display.width}×${display.height}${display.isPrimary ? " · primary" : ""}`
                      : undefined
                  }
                />
              ))}
        </div>
      )}

      <label className={cn("mt-4 flex items-center justify-between gap-4 rounded-card bg-secondary/50 px-4 py-2.5", !selectedAudioSupported && "opacity-55")}>
        <span className="min-w-0">
          <span className="block text-body">{tab === "apps" ? "Share this app’s sound" : "Share this computer’s sound"}</span>
          <span className="block text-caption text-muted-foreground">
            {selectedAudioSupported
              ? tab === "apps" ? "People hear what the app plays." : "People hear everything this computer plays."
              : "Not available on this system."}
          </span>
        </span>
        <Switch checked={selectedAudioSupported && withAudio} disabled={!selectedAudioSupported} onCheckedChange={setWithAudio} />
      </label>

      <VideoProfileFields
        className="mt-4"
        profileId={profileId}
        customDraft={customDraft}
        onProfileIdChange={setProfileId}
        onCustomDraftChange={setCustomDraft}
        summary={
          output
            ? `Sent at ${output.width}×${output.height}, ${Math.round(profile.fps)} fps`
            : `Up to ${profile.width}×${profile.height} at ${Math.round(profile.fps)} fps`
        }
      />

      <div className="mt-5 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={load}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!selected} onClick={confirm}>
            Start sharing
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

export type CustomVideoDraft = {
  width: string;
  height: string;
  fps: string;
};

function videoProfileLabel(profileId: VideoQualityProfileId) {
  switch (profileId) {
    case "presentation":
      return "Presentation";
    case "high":
      return "High quality";
    case "highMotion":
      return "Smooth motion";
    case "balanced":
      return "Balanced";
    case "low":
      return "Data saver";
    case "custom":
      return "Custom";
  }
}

export function VideoProfileFields({
  className,
  profileId,
  customDraft,
  summary,
  onProfileIdChange,
  onCustomDraftChange,
}: {
  className?: string;
  profileId: VideoQualityProfileId;
  customDraft: CustomVideoDraft;
  summary: string;
  onProfileIdChange: (profileId: VideoQualityProfileId) => void;
  onCustomDraftChange: (draft: CustomVideoDraft) => void;
}) {
  return (
    <div className={className}>
      <div className="space-y-1.5 text-small text-muted-foreground">
        Quality
        <Select
          value={profileId}
          onValueChange={(value) => onProfileIdChange(value as VideoQualityProfileId)}
        >
          <SelectTrigger size="sm">
            <SelectValue>{videoProfileLabel(profileId)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="presentation">Presentation</SelectItem>
              <SelectItem value="high">High quality</SelectItem>
              <SelectItem value="highMotion">Smooth motion</SelectItem>
              <SelectItem value="balanced">Balanced</SelectItem>
              <SelectItem value="low">Data saver</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      {profileId === "custom" ? (
        <div className="mt-2 grid grid-cols-3 gap-2">
          <NumberField
            label="Width"
            value={customDraft.width}
            min={2}
            max={7680}
            step={2}
            onChange={(width) => onCustomDraftChange({ ...customDraft, width })}
          />
          <NumberField
            label="Height"
            value={customDraft.height}
            min={2}
            max={4320}
            step={2}
            onChange={(height) => onCustomDraftChange({ ...customDraft, height })}
          />
          <NumberField
            label="FPS"
            value={customDraft.fps}
            min={1}
            max={120}
            step={1}
            onChange={(fps) => onCustomDraftChange({ ...customDraft, fps })}
          />
        </div>
      ) : null}
      <p className="mt-1.5 text-caption text-muted-foreground">{summary}</p>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block space-y-1.5 text-caption text-muted-foreground">
      {label}
      <input
        type="number"
        className={cn(fieldClassName, "h-8 px-2 text-small tabular-nums")}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function customDraftFromProfile(profile: VideoQualityProfile): CustomVideoDraft {
  return {
    width: String(profile.width),
    height: String(profile.height),
    fps: String(Math.round(profile.fps)),
  };
}

export function profileFromSelection(
  profileId: VideoQualityProfileId,
  customDraft: CustomVideoDraft,
  fallback: VideoQualityProfile,
): VideoQualityProfile {
  if (profileId !== "custom") return VIDEO_PROFILE_PRESETS[profileId];
  const width = evenNumber(clampNumber(customDraft.width, fallback.width, 2, 7680));
  const height = evenNumber(clampNumber(customDraft.height, fallback.height, 2, 4320));
  const fps = clampNumber(customDraft.fps, fallback.fps, 1, 120);
  return {
    profileId: "custom",
    maxPixels: Math.max(4, width * height),
    width,
    height,
    fps,
  };
}

function outputForBudget(sourceWidth: number, sourceHeight: number, maxPixels: number) {
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;
  const pixels = Math.max(1, sourceWidth * sourceHeight);
  const scale = Math.min(1, Math.sqrt(Math.max(4, maxPixels) / pixels));
  let width = evenNumber(Math.round(sourceWidth * scale));
  let height = evenNumber(Math.round(sourceHeight * scale));
  while (width * height > Math.max(4, maxPixels)) {
    if (width >= height && width > 2) width -= 2;
    else if (height > 2) height -= 2;
    else break;
  }
  return { width, height };
}

function clampNumber(value: string, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function evenNumber(value: number) {
  return Math.max(2, value - (value % 2));
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex h-8 items-center gap-2 rounded-chip px-3 text-small font-medium transition-colors",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function SourceTile({
  selected,
  onClick,
  thumbnail,
  icon,
  fallback,
  title,
  subtitle,
}: {
  selected: boolean;
  onClick: () => void;
  thumbnail?: string | null;
  icon?: string | null;
  fallback: React.ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "flex flex-col gap-2 rounded-card bg-secondary/60 p-2 text-left transition-colors hover:bg-accent",
        selected && "bg-accent outline outline-2 outline-foreground",
      )}
    >
      <div className="flex aspect-video items-center justify-center overflow-hidden rounded-control bg-background text-subtle">
        {thumbnail ? (
          <img src={thumbnail} alt="" className="h-full w-full object-contain" />
        ) : (
          fallback
        )}
      </div>
      <div className="flex items-center gap-2 px-1 pb-0.5">
        {icon ? <img src={icon} alt="" className="h-4 w-4 shrink-0" /> : null}
        <div className="min-w-0">
          <div className="truncate text-small">{title}</div>
          {subtitle ? <div className="truncate text-caption text-muted-foreground">{subtitle}</div> : null}
        </div>
      </div>
    </button>
  );
}
