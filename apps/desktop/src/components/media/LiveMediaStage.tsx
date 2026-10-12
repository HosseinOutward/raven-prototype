import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Focus, LayoutGrid, Loader2, Maximize2, MicOff, Minimize2, MoreHorizontal, WifiLow, WifiOff } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { type SelfPreviewMode, type VideoMixerState, type VideoStreamEndpoint, videoCommands } from "@/lib/video";
import { speakingGlowStyle, type ParticipantVoiceActivityMap } from "@/lib/speakingActivity";
import { MediaTile, type MediaFit } from "./MediaTile";
import { bestGridColumns, newestScreenShareKey, partitionStageTiles, resolveStageFocusKey } from "./stageState";
import { useNativeMediaTiles, type NativeMediaTile } from "./useNativeMediaTiles";
import { useParticipantMediaPreferences } from "./useParticipantMediaPreferences";

type StageView = "grid" | "focus";
type StagePhase = "idle" | "joining" | "connected" | "leaving" | "error";

/**
 * The room while you are in it. Raven is voice-first, so people who are only
 * talking are shown as people, not as empty video tiles. Tiles appear when
 * someone turns on a camera or shares a screen, and voice-only people move to
 * a strip underneath.
 */
export function LiveMediaStage({
  title,
  subtitle,
  connected,
  phase = connected ? "connected" : "idle",
  audioNotice = "",
  audioNoticeKind = null,
  videoState,
  speakingActivity,
  videoStreamEndpoint,
  selfMediaPreviewMode,
  followScreenShares = true,
  onFollowScreenSharesChange,
  onRetryAudio,
  roomLabel = "Nest",
  className,
}: {
  title: string;
  subtitle?: string;
  connected: boolean;
  phase?: StagePhase;
  audioNotice?: string;
  audioNoticeKind?: "recovering" | "error" | null;
  videoState: VideoMixerState | null;
  speakingActivity: ParticipantVoiceActivityMap;
  videoStreamEndpoint: VideoStreamEndpoint | null;
  selfMediaPreviewMode: SelfPreviewMode;
  followScreenShares?: boolean;
  onFollowScreenSharesChange?: (follow: boolean) => void;
  onRetryAudio?: () => void;
  roomLabel?: string;
  className?: string;
}) {
  const stageRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const previousManualViewRef = useRef<StageView>("grid");
  const previousAutomaticFocusRef = useRef<string | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const [view, setView] = useState<StageView>("grid");
  const [manualPinKey, setManualPinKey] = useState<string | null>(null);
  const [automaticFocusAfter, setAutomaticFocusAfter] = useState(0);
  const [filmstripCollapsed, setFilmstripCollapsed] = useState(false);
  const [fitModes, setFitModes] = useState<Record<string, MediaFit>>({});
  const [notice, setNotice] = useState("");
  const [stageFullscreen, setStageFullscreen] = useState(false);
  const size = useElementSize(contentRef);
  const { tiles } = useNativeMediaTiles(
    connected ? videoState : null,
    videoStreamEndpoint,
    selfMediaPreviewMode,
    speakingActivity,
  );
  const setCameraReceiving = useCallback(async (participantId: string, receiving: boolean) => {
    await videoCommands.setRemoteVideoReceiving(participantId, "camera", receiving);
  }, []);
  const { getPreference, updatePreference } = useParticipantMediaPreferences(connected, setCameraReceiving);

  const { visual, voice } = useMemo(() => partitionStageTiles(tiles), [tiles]);
  const focusCandidates = useMemo(
    () => visual.filter((tile) => tile.source !== "screenshare" || (tile.shareStartedAt ?? 0) > automaticFocusAfter),
    [automaticFocusAfter, visual],
  );
  const focusKey = resolveStageFocusKey({ tiles: focusCandidates, manualPinKey, followScreenShares, focusMode: view === "focus" });
  const focusTile = visual.find((tile) => tile.key === focusKey) ?? null;
  const sideTiles = focusTile ? visual.filter((tile) => tile.key !== focusTile.key) : visual;
  const reconnecting = connected && !videoState?.viewerConnected;
  const participantCount = new Set(tiles.map((tile) => tile.participantId)).size;
  const gridColumns = bestGridColumns(visual.length, size.width || 900, size.height || 460);
  const narrowFocus = size.width > 0 && size.width < 720;
  const canFullscreen = typeof document !== "undefined" && document.fullscreenEnabled;

  useEffect(() => {
    if (manualPinKey && !visual.some((tile) => tile.key === manualPinKey)) setManualPinKey(null);
  }, [manualPinKey, visual]);

  useEffect(() => {
    const autoKey = !manualPinKey && followScreenShares && focusTile?.source === "screenshare" ? focusTile.key : null;
    if (autoKey && autoKey !== previousAutomaticFocusRef.current) {
      if ((focusTile?.shareStartedAt ?? 0) > automaticFocusAfter && automaticFocusAfter > 0) setAutomaticFocusAfter(0);
      setNotice(`${focusTile?.isLocal ? "You" : focusTile?.displayName ?? "Someone"} started sharing`);
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = window.setTimeout(() => setNotice(""), 3200);
    }
    previousAutomaticFocusRef.current = autoKey;
  }, [automaticFocusAfter, focusTile, followScreenShares, manualPinKey]);

  useEffect(() => {
    const syncFullscreen = () => setStageFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const togglePin = (tile: NativeMediaTile) => {
    if (manualPinKey === tile.key) {
      setManualPinKey(null);
      setView(previousManualViewRef.current);
      return;
    }
    previousManualViewRef.current = view;
    setManualPinKey(tile.key);
    setView("focus");
  };
  const returnToGrid = () => {
    setManualPinKey(null);
    setView("grid");
    const newestShareKey = newestScreenShareKey(visual);
    const newestShare = visual.find((tile) => tile.key === newestShareKey);
    setAutomaticFocusAfter(newestShare?.shareStartedAt ?? 0);
  };
  const setFollowScreenShares = (follow: boolean) => {
    if (follow) setAutomaticFocusAfter(0);
    onFollowScreenSharesChange?.(follow);
  };

  const renderTile = (tile: NativeMediaTile, prominent = false) => {
    const preference = getPreference(tile.participantId);
    return (
      <MediaTile
        key={tile.key}
        tile={tile}
        prominent={prominent}
        pinned={manualPinKey === tile.key}
        reconnecting={reconnecting}
        fit={fitModes[tile.key] ?? (tile.source === "screenshare" ? "fit" : "fill")}
        preference={preference}
        onTogglePin={() => togglePin(tile)}
        onFitChange={(fit) => setFitModes((current) => ({ ...current, [tile.key]: fit }))}
        onPreferenceChange={(patch) => updatePreference(tile.participantId, patch)}
      />
    );
  };

  const status = phase === "leaving"
    ? "Leaving…"
    : reconnecting
      ? "Reconnecting…"
      : participantCount > 0
        ? `${participantCount} ${participantCount === 1 ? "person" : "people"} here`
        : "";

  return (
    <section
      ref={stageRef}
      aria-label={`${title}, live ${roomLabel.toLowerCase()}`}
      className={cn("raven-media-stage relative flex min-h-0 flex-1 flex-col bg-card text-foreground", className)}
    >
      <header className="flex h-12 shrink-0 items-center gap-3 pl-5 pr-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
          <h1 className="truncate text-title-sm font-semibold">{title}</h1>
          {subtitle ? <span className="hidden truncate text-small text-muted-foreground sm:inline">{subtitle}</span> : null}
          {status ? (
            <span className={cn("shrink-0 text-caption", reconnecting ? "text-warning" : "text-muted-foreground")} role="status">{status}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {visual.length > 1 ? (
            <div className="flex rounded-control bg-background/60 p-0.5" role="group" aria-label="Layout">
              <LayoutButton active={view === "grid" && !focusTile} label="Grid" onClick={returnToGrid}><LayoutGrid /></LayoutButton>
              <LayoutButton active={view === "focus" || Boolean(focusTile)} label="Focus on one" onClick={() => setView("focus")}><Focus /></LayoutButton>
            </div>
          ) : null}
          <DropdownMenu>
            <Tooltip label="View options" side="bottom">
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="View options">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onSelect={() => setFollowScreenShares(!followScreenShares)}>
                <span className="flex-1">
                  <span className="block">Follow screen shares</span>
                  <span className="block text-caption text-muted-foreground">Bring a new share to the front automatically.</span>
                </span>
                {followScreenShares ? <Check /> : null}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {canFullscreen ? (
            <Tooltip label={stageFullscreen ? "Exit full screen" : "Full screen"} side="bottom">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={stageFullscreen ? "Exit full screen" : "Full screen"}
                onClick={() => stageFullscreen ? void document.exitFullscreen() : void stageRef.current?.requestFullscreen?.()}
              >
                {stageFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
        <div ref={contentRef} className="relative min-h-0 flex-1">
          <div className="absolute inset-0">
            {!tiles.length ? (
              <div className="flex h-full items-center justify-center gap-2.5 text-small text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {phase === "leaving" ? "Leaving…" : "Getting the room ready…"}
              </div>
            ) : !visual.length ? (
              <VoiceRoom people={voice} />
            ) : focusTile ? (
              <div className={cn("relative flex h-full min-h-0 gap-2", narrowFocus && "flex-col")}>
                <div className="relative min-h-0 min-w-0 flex-1">{renderTile(focusTile, true)}</div>
                {sideTiles.length && !filmstripCollapsed ? (
                  <aside className={cn("flex min-h-0 w-44 shrink-0 flex-col gap-1.5", narrowFocus && "h-28 w-full flex-row")} aria-label="Other video">
                    <button
                      type="button"
                      className={cn("flex h-6 shrink-0 items-center justify-center gap-1 rounded-chip text-caption text-subtle transition-colors hover:bg-secondary hover:text-foreground", narrowFocus && "h-full w-6")}
                      onClick={() => setFilmstripCollapsed(true)}
                      aria-label="Hide other video"
                    >
                      {narrowFocus ? <ChevronDown className="h-3.5 w-3.5" /> : <><ChevronRight className="h-3.5 w-3.5" />Hide</>}
                    </button>
                    <div className={cn("grid min-h-0 flex-1 auto-rows-[100px] grid-cols-1 gap-2 overflow-y-auto", narrowFocus && "auto-cols-[154px] auto-rows-fr grid-flow-col grid-cols-none overflow-x-auto overflow-y-hidden")}>
                      {sideTiles.map((tile) => renderTile(tile))}
                    </div>
                  </aside>
                ) : sideTiles.length ? (
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 z-10 flex h-8 -translate-y-1/2 items-center rounded-full bg-black/65 px-3 text-caption font-medium text-white backdrop-blur-md transition-colors hover:bg-black/80"
                    onClick={() => setFilmstripCollapsed(false)}
                  >
                    {sideTiles.length} more
                  </button>
                ) : null}
              </div>
            ) : (
              <div
                className="grid h-full min-h-0 gap-2"
                style={{ gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(visual.length / gridColumns)}, minmax(0, 1fr))` }}
              >
                {visual.map((tile) => renderTile(tile, visual.length === 1))}
              </div>
            )}
          </div>
        </div>
        {visual.length && voice.length ? <VoiceStrip people={voice} /> : null}
      </div>

      {notice ? (
        <div role="status" className="pointer-events-none absolute left-1/2 top-14 z-20 -translate-x-1/2 animate-fade-in rounded-full bg-popover px-3 py-1.5 text-caption text-popover-foreground shadow-raised">{notice}</div>
      ) : null}
      {connected && audioNotice ? (
        <div
          role={audioNoticeKind === "error" ? "alert" : "status"}
          className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2.5 rounded-full bg-popover py-1.5 pl-3.5 pr-1.5 text-small text-popover-foreground shadow-raised"
        >
          {audioNoticeKind === "recovering" ? <Loader2 className="h-4 w-4 animate-spin text-warning" /> : <span className="h-1.5 w-1.5 rounded-full bg-destructive" aria-hidden />}
          <span className="pr-2">{audioNotice}</span>
          {audioNoticeKind === "error" && onRetryAudio ? (
            <Button variant="secondary" size="xs" className="rounded-full" onClick={onRetryAudio}>Retry sound</Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function LayoutButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactElement }) {
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        className={cn(
          "flex h-7 w-8 items-center justify-center rounded-chip text-muted-foreground transition-colors hover:text-foreground [&>svg]:h-4 [&>svg]:w-4",
          active && "bg-accent text-foreground",
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** Everyone is here by voice: show people, give them room, ring whoever speaks. */
function VoiceRoom({ people }: { people: NativeMediaTile[] }) {
  const size = people.length <= 4 ? "h-24 w-24 text-display" : people.length <= 9 ? "h-20 w-20 text-title" : "h-16 w-16 text-body";
  return (
    <div className="flex h-full flex-wrap content-center items-start justify-center gap-x-8 gap-y-8 overflow-y-auto p-6">
      {people.map((person) => (
        <div key={person.key} className="flex w-32 flex-col items-center text-center">
          <span className="relative">
            <span
              className={cn("block rounded-full", person.speaking && "raven-speaking-avatar")}
              style={speakingGlowStyle(person.speakingIntensity, "avatar")}
            >
              <Avatar name={person.displayName} src={api.userAvatarUrl(person.participantId)} className={size} />
            </span>
            {person.audioMuted ? (
              <span className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-card text-destructive" title="Muted" aria-label="Muted">
                <MicOff className="h-3.5 w-3.5" />
              </span>
            ) : null}
          </span>
          <span className="mt-3 max-w-full truncate text-small font-medium">{person.isLocal ? "You" : person.displayName}</span>
          <ConnectionCaption person={person} />
        </div>
      ))}
    </div>
  );
}

/** Voice-only people while video is on the stage. */
function VoiceStrip({ people }: { people: NativeMediaTile[] }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto" aria-label="Here by voice">
      {people.map((person) => (
        <span key={person.key} className="flex h-9 shrink-0 items-center gap-2 rounded-full bg-secondary pl-1 pr-3">
          <span
            className={cn("block rounded-full", person.speaking && "raven-speaking-ring")}
            style={speakingGlowStyle(person.speakingIntensity, "avatar")}
          >
            <Avatar name={person.displayName} src={api.userAvatarUrl(person.participantId)} className="h-7 w-7" />
          </span>
          <span className="max-w-[140px] truncate text-small">{person.isLocal ? "You" : person.displayName}</span>
          {person.audioMuted ? <MicOff className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="Muted" /> : null}
        </span>
      ))}
    </div>
  );
}

function ConnectionCaption({ person }: { person: NativeMediaTile }) {
  if (person.connectionQuality !== "poor" && person.connectionQuality !== "lost") return null;
  const lost = person.connectionQuality === "lost";
  return (
    <span className="mt-0.5 inline-flex items-center gap-1 text-caption text-warning">
      {lost ? <WifiOff className="h-3 w-3" /> : <WifiLow className="h-3 w-3" />}
      {lost ? "Connection lost" : "Weak connection"}
    </span>
  );
}

function useElementSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
