import { useEffect, useRef, useState } from "react";
import type { VideoConnectionQuality } from "@/lib/video";
import {
  Loader2,
  Maximize2,
  Mic,
  MicOff,
  MoreHorizontal,
  Minimize2,
  MonitorUp,
  Pin,
  PinOff,
  Video,
  VideoOff,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { speakingGlowStyle } from "@/lib/speakingActivity";
import type { NativeMediaTile } from "./useNativeMediaTiles";
import type { ParticipantMediaPreference } from "./useParticipantMediaPreferences";

export type MediaFit = "fit" | "fill";

export function MediaTile({
  tile,
  prominent = false,
  pinned = false,
  reconnecting = false,
  fit,
  preference,
  onTogglePin,
  onFitChange,
  onPreferenceChange,
}: {
  tile: NativeMediaTile;
  prominent?: boolean;
  pinned?: boolean;
  reconnecting?: boolean;
  fit: MediaFit;
  preference: ParticipantMediaPreference;
  onTogglePin: () => void;
  onFitChange: (fit: MediaFit) => void;
  onPreferenceChange: (patch: Partial<ParticipantMediaPreference>) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  const [playbackWaiting, setPlaybackWaiting] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const canFullscreen = typeof document !== "undefined" && document.fullscreenEnabled;

  useEffect(() => () => {
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
  }, []);

  useEffect(() => {
    const syncFullscreen = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement === rootRef.current) {
      void document.exitFullscreen();
      return;
    }
    void rootRef.current?.requestFullscreen?.();
  };
  const handleTileClick = (event: React.MouseEvent) => {
    if (event.detail > 1) {
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      onTogglePin();
      return;
    }
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      onTogglePin();
    }, 220);
  };

  const fallback = reconnecting
    ? { title: "Reconnecting", detail: "Keeping this media in place", loading: true }
    : tile.mediaError
      ? { title: tile.source === "screenshare" ? "Share unavailable" : "Camera unavailable", detail: tile.mediaError, loading: false }
      : tile.loading
      ? { title: "Starting media", detail: "Waiting for the local source", loading: true }
      : tile.source === "camera" && !preference.cameraReceiving
        ? { title: "Video hidden for you", detail: "Use the menu to show it again", loading: false }
        : tile.source === "camera" && !tile.cameraEnabled
          ? { title: tile.isLocal ? "Your camera is off" : "Camera off", detail: tile.isLocal ? "Turn it on from the controls below" : `${tile.displayName} is joining by voice`, loading: false }
          : { title: tile.source === "screenshare" ? "Share unavailable" : "Video unavailable", detail: "Waiting for media", loading: true };

  return (
    <div
      ref={rootRef}
      role="button"
      tabIndex={0}
      aria-label={`${pinned ? "Unpin" : "Focus"} ${tile.displayName}`}
      aria-pressed={pinned}
      onClick={handleTileClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onTogglePin();
        }
      }}
      style={speakingGlowStyle(tile.speakingIntensity, "tile")}
      className={cn(
        "raven-media-tile group relative h-full min-h-0 w-full overflow-hidden rounded-2xl bg-card/95 text-left shadow-[0_8px_24px_rgba(0,0,0,0.16)] outline-none transition-[box-shadow,transform] duration-200",
        tile.speaking && "raven-speaking-tile",
        pinned && "shadow-[0_0_0_1px_hsl(var(--primary)/0.48),0_16px_40px_rgba(0,0,0,0.32)]",
        fullscreen && "rounded-none",
        "focus-visible:shadow-[0_0_0_2px_hsl(var(--ring)/0.8),0_12px_32px_rgba(0,0,0,0.24)]",
      )}
    >
      {tile.streamUrl ? (
        <img
          src={tile.streamUrl}
          alt=""
          draggable={false}
          onLoad={() => setPlaybackWaiting(false)}
          onError={() => setPlaybackWaiting(true)}
          className={cn("absolute inset-0 h-full w-full bg-background/70", fit === "fill" ? "object-cover" : "object-contain")}
        />
      ) : null}
      {!tile.streamUrl ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[radial-gradient(circle_at_center,hsl(var(--muted)/0.3),transparent_68%)]">
          <div className="px-5 text-center">
            {fallback.loading ? <Loader2 className="mx-auto h-7 w-7 animate-spin text-primary/70" /> : <Avatar name={tile.displayName} src={api.userAvatarUrl(tile.participantId)} className={cn("mx-auto text-sm", prominent ? "h-20 w-20 text-lg" : "h-12 w-12")} />}
            <div className="mt-3 text-xs font-medium text-white/70">{fallback.title}</div>
            <div className="mt-1 text-[11px] text-white/35">{fallback.detail}</div>
          </div>
        </div>
      ) : null}
      {playbackWaiting && tile.streamUrl ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/35 backdrop-blur-[1px]">
          <span className="inline-flex items-center gap-2 rounded-full bg-black/65 px-3 py-1.5 text-[11px] text-white/70">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Video paused
          </span>
        </div>
      ) : null}

      <div className="absolute left-3 top-3 flex items-center gap-1.5">
        {/* {tile.speaking ? <span className="rounded-full bg-primary px-2 py-1 text-[10px] font-semibold text-primary-foreground">Speaking</span> : null} */}
        {tile.source === "screenshare" ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[10px] text-white/80 backdrop-blur-md">
            <MonitorUp className="h-3 w-3" /> Screen
          </span>
        ) : null}
      </div>

      <div
        className="absolute right-3 top-3 flex translate-y-[-2px] items-center gap-1 rounded-xl bg-black/65 p-1 opacity-0 shadow-lg backdrop-blur-md transition group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100"
        onClick={(event) => event.stopPropagation()}
      >
        <TileAction label={pinned ? "Unpin" : "Pin"} onClick={onTogglePin}>{pinned ? <PinOff /> : <Pin />}</TileAction>
        {canFullscreen ? <TileAction label={fullscreen ? "Exit fullscreen" : "Fullscreen media"} onClick={toggleFullscreen}>{fullscreen ? <Minimize2 /> : <Maximize2 />}</TileAction> : null}
        <ParticipantMenu
          tile={tile}
          pinned={pinned}
          fit={fit}
          preference={preference}
          canFullscreen={canFullscreen}
          onTogglePin={onTogglePin}
          fullscreen={fullscreen}
          onFullscreen={toggleFullscreen}
          onFitChange={onFitChange}
          onPreferenceChange={onPreferenceChange}
        />
      </div>

      <div className="absolute inset-x-0 bottom-0 flex min-w-0 items-center gap-2 bg-gradient-to-t from-black/80 via-black/45 to-transparent px-4 pb-3 pt-10 text-white/90">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{tile.displayName}</span>
        {tile.isLocal ? <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white/60">You</span> : null}
        <StatusIcon label={tile.audioMuted ? "Microphone muted" : "Microphone on"}>{tile.audioMuted ? <MicOff /> : <Mic />}</StatusIcon>
        <StatusIcon label={tile.cameraEnabled ? "Camera on" : "Camera off"}>{tile.cameraEnabled ? <Video /> : <VideoOff />}</StatusIcon>
        {tile.screenSharing && tile.source !== "screenshare" ? <StatusIcon label="Sharing screen"><MonitorUp /></StatusIcon> : null}
        <ConnectionQualityIcon quality={tile.connectionQuality} />
      </div>
    </div>
  );
}

function ParticipantMenu({
  tile,
  pinned,
  fit,
  preference,
  canFullscreen,
  fullscreen,
  onTogglePin,
  onFullscreen,
  onFitChange,
  onPreferenceChange,
}: {
  tile: NativeMediaTile;
  pinned: boolean;
  fit: MediaFit;
  preference: ParticipantMediaPreference;
  canFullscreen: boolean;
  fullscreen: boolean;
  onTogglePin: () => void;
  onFullscreen: () => void;
  onFitChange: (fit: MediaFit) => void;
  onPreferenceChange: (patch: Partial<ParticipantMediaPreference>) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-white/70 hover:bg-white/10 hover:text-white" aria-label={`More controls for ${tile.displayName}`}>
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 rounded-xl border-white/10 p-2" onClick={(event) => event.stopPropagation()}>
        {!tile.isLocal ? (
          <>
            {tile.cameraPublished ? (
              <DropdownMenuItem onSelect={() => onPreferenceChange({ cameraReceiving: !preference.cameraReceiving })}>
                {preference.cameraReceiving ? <VideoOff className="h-4 w-4" /> : <Video className="h-4 w-4" />}
                {preference.cameraReceiving ? "Hide video for me" : "Show video again"}
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
        <DropdownMenuItem onSelect={onTogglePin}>{pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}{pinned ? "Unpin" : "Pin"}</DropdownMenuItem>
        {canFullscreen ? <DropdownMenuItem onSelect={onFullscreen}>{fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}{fullscreen ? "Exit fullscreen" : "Fullscreen"}</DropdownMenuItem> : null}
        <div className="my-1 h-px bg-white/8" />
        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Media sizing</div>
        <DropdownMenuItem onSelect={() => onFitChange("fit")} className={cn(fit === "fit" && "bg-accent")}>Fit whole frame</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onFitChange("fill")} className={cn(fit === "fill" && "bg-accent")}>Fill tile</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TileAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactElement }) {
  return <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-white/70 hover:bg-white/10 hover:text-white [&_svg]:h-3.5 [&_svg]:w-3.5" aria-label={label} title={label} onClick={onClick}>{children}</Button>;
}

function StatusIcon({ label, children }: { label: string; children: React.ReactElement }) {
  return <span className="text-white/50 [&_svg]:h-3.5 [&_svg]:w-3.5" title={label} aria-label={label}>{children}</span>;
}

function ConnectionQualityIcon({ quality }: { quality: VideoConnectionQuality }) {
  const lost = quality === "lost";
  const label = quality === "unknown" ? "Connection quality unavailable" : `Connection quality: ${quality}`;
  return <StatusIcon label={label}>{lost ? <WifiOff /> : <Wifi className={cn(quality === "poor" ? "text-amber-300/70" : quality === "excellent" ? "text-primary/70" : "text-white/50")} />}</StatusIcon>;
}
