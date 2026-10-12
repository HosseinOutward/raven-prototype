import { useEffect, useRef, useState } from "react";
import type { VideoConnectionQuality } from "@/lib/video";
import {
  Check,
  Loader2,
  Maximize2,
  MicOff,
  MoreHorizontal,
  Minimize2,
  MonitorUp,
  Pin,
  PinOff,
  Video,
  VideoOff,
  WifiLow,
  WifiOff,
} from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { speakingGlowStyle } from "@/lib/speakingActivity";
import type { NativeMediaTile } from "./useNativeMediaTiles";
import type { ParticipantMediaPreference } from "./useParticipantMediaPreferences";

export type MediaFit = "fit" | "fill";

/**
 * One piece of video on the stage: a camera or a shared screen. The label says
 * who it is and only mentions state worth noticing (muted, a weak connection).
 */
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
  const [playbackWaiting, setPlaybackWaiting] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const canFullscreen = typeof document !== "undefined" && document.fullscreenEnabled;

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

  const isShare = tile.source === "screenshare";
  const fallback = reconnecting
    ? { title: "Reconnecting…", detail: "Holding this spot", loading: true }
    : tile.mediaError
      ? { title: isShare ? "Screen share stopped working" : "Camera stopped working", detail: tile.mediaError, loading: false }
      : tile.loading
        ? { title: isShare ? "Starting screen share…" : "Starting camera…", detail: "", loading: true }
        : tile.source === "camera" && !preference.cameraReceiving
          ? { title: "Video hidden for you", detail: "Show it again from the menu", loading: false }
          : { title: isShare ? "Waiting for the screen…" : "Waiting for video…", detail: "", loading: true };

  const label = isShare ? (tile.isLocal ? "Your screen" : `${tile.displayName}’s screen`) : tile.isLocal ? "You" : tile.displayName;
  const weak = tile.connectionQuality === "poor";
  const lost = tile.connectionQuality === "lost";

  return (
    <div
      ref={rootRef}
      role="button"
      tabIndex={0}
      aria-label={`${pinned ? "Unpin" : "Focus on"} ${label}`}
      aria-pressed={pinned}
      onClick={onTogglePin}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onTogglePin();
        }
      }}
      style={speakingGlowStyle(tile.speakingIntensity, "tile")}
      className={cn(
        "raven-media-tile group relative h-full min-h-0 w-full overflow-hidden rounded-card bg-background text-left",
        tile.speaking && !isShare && "raven-speaking-tile",
        fullscreen && "rounded-none",
      )}
    >
      {tile.streamUrl ? (
        <img
          src={tile.streamUrl}
          alt=""
          draggable={false}
          onLoad={() => setPlaybackWaiting(false)}
          onError={() => setPlaybackWaiting(true)}
          className={cn("absolute inset-0 h-full w-full", fit === "fill" ? "object-cover" : "object-contain")}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center px-5 text-center">
          <div>
            {fallback.loading ? (
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-subtle" />
            ) : (
              <Avatar name={tile.displayName} src={api.userAvatarUrl(tile.participantId)} className={cn("mx-auto", prominent ? "h-20 w-20 text-display" : "h-12 w-12 text-body")} />
            )}
            <div className="mt-3 text-small text-muted-foreground">{fallback.title}</div>
            {fallback.detail ? <div className="mt-0.5 text-caption text-subtle">{fallback.detail}</div> : null}
          </div>
        </div>
      )}
      {playbackWaiting && tile.streamUrl ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
          <span className="inline-flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-caption text-white">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Video paused
          </span>
        </div>
      ) : null}

      <div
        className="absolute right-2 top-2 flex items-center gap-0.5 rounded-control bg-black/65 p-0.5 opacity-0 backdrop-blur-md transition-opacity focus-within:opacity-100 group-hover:opacity-100 group-focus-visible:opacity-100"
        onClick={(event) => event.stopPropagation()}
      >
        <TileAction label={pinned ? "Unpin" : "Pin"} onClick={onTogglePin}>{pinned ? <PinOff /> : <Pin />}</TileAction>
        {canFullscreen ? <TileAction label={fullscreen ? "Exit full screen" : "Full screen"} onClick={toggleFullscreen}>{fullscreen ? <Minimize2 /> : <Maximize2 />}</TileAction> : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={TILE_ACTION_CLASS} aria-label={`More for ${label}`}>
              <MoreHorizontal />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56" onClick={(event) => event.stopPropagation()}>
            {!tile.isLocal && tile.cameraPublished ? (
              <>
                <DropdownMenuItem onSelect={() => onPreferenceChange({ cameraReceiving: !preference.cameraReceiving })}>
                  {preference.cameraReceiving ? <VideoOff /> : <Video />}
                  {preference.cameraReceiving ? "Hide their video for me" : "Show their video again"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuLabel>Fit</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => onFitChange("fit")}>
              <span className="flex-1">Show the whole picture</span>
              {fit === "fit" ? <Check /> : null}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onFitChange("fill")}>
              <span className="flex-1">Fill the tile</span>
              {fit === "fill" ? <Check /> : null}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="pointer-events-none absolute bottom-2 left-2 flex max-w-[calc(100%-16px)] items-center gap-1.5 rounded-chip bg-black/65 px-2 py-1 text-caption font-medium text-white backdrop-blur-md">
        {isShare ? <MonitorUp className="h-3.5 w-3.5 shrink-0" /> : null}
        <span className="min-w-0 truncate">{label}</span>
        {!isShare && tile.audioMuted ? <MicOff className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="Muted" /> : null}
        {pinned ? <Pin className="h-3 w-3 shrink-0 opacity-70" aria-label="Pinned" /> : null}
        <ConnectionNote quality={tile.connectionQuality} weak={weak} lost={lost} />
      </div>
    </div>
  );
}

const TILE_ACTION_CLASS =
  "flex h-7 w-7 items-center justify-center rounded-chip text-white/80 transition-colors hover:bg-white/15 hover:text-white [&>svg]:h-4 [&>svg]:w-4";

function TileAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactElement }) {
  return (
    <button type="button" className={TILE_ACTION_CLASS} aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

/** Connection quality is only worth a glyph when it is hurting the call. */
function ConnectionNote({ quality, weak, lost }: { quality: VideoConnectionQuality; weak: boolean; lost: boolean }) {
  if (!weak && !lost) return null;
  const label = lost ? "Connection lost" : `Weak connection (${quality})`;
  return (
    <span className="shrink-0 text-warning [&>svg]:h-3.5 [&>svg]:w-3.5" title={label} aria-label={label}>
      {lost ? <WifiOff /> : <WifiLow />}
    </span>
  );
}
