import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ChevronDown, ChevronRight, Focus, LayoutGrid, Loader2, Maximize2, Minimize2, MonitorUp, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type SelfPreviewMode, type VideoMixerState, type VideoStreamEndpoint, videoCommands } from "@/lib/video";
import type { ParticipantVoiceActivityMap } from "@/lib/speakingActivity";
import { MediaTile, type MediaFit } from "./MediaTile";
import { bestGridColumns, newestScreenShareKey, resolveStageFocusKey } from "./stageState";
import { useNativeMediaTiles, type NativeMediaTile } from "./useNativeMediaTiles";
import { useParticipantMediaPreferences } from "./useParticipantMediaPreferences";

type StageView = "grid" | "focus";
type StagePhase = "idle" | "joining" | "connected" | "leaving" | "error";

export function LiveMediaStage({
  connected,
  phase = connected ? "connected" : "idle",
  error = "",
  errorAction = "",
  videoState,
  speakingActivity,
  videoStreamEndpoint,
  selfMediaPreviewMode,
  followScreenShares = true,
  onFollowScreenSharesChange,
  onConnect,
  roomLabel = "Nest",
  className,
}: {
  connected: boolean;
  phase?: StagePhase;
  error?: string;
  errorAction?: string;
  videoState: VideoMixerState | null;
  speakingActivity: ParticipantVoiceActivityMap;
  videoStreamEndpoint: VideoStreamEndpoint | null;
  selfMediaPreviewMode: SelfPreviewMode;
  followScreenShares?: boolean;
  onFollowScreenSharesChange?: (follow: boolean) => void;
  onConnect?: () => void;
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

  const focusCandidates = useMemo(
    () => tiles.filter((tile) => tile.source !== "screenshare" || (tile.shareStartedAt ?? 0) > automaticFocusAfter),
    [automaticFocusAfter, tiles],
  );
  const focusKey = resolveStageFocusKey({ tiles: focusCandidates, manualPinKey, followScreenShares, focusMode: view === "focus" });
  const focusTile = tiles.find((tile) => tile.key === focusKey) ?? null;
  const sideTiles = focusTile ? tiles.filter((tile) => tile.key !== focusTile.key) : tiles;
  const reconnecting = connected && !videoState?.viewerConnected;
  const participantCount = new Set(tiles.map((tile) => tile.participantId)).size;
  const gridColumns = bestGridColumns(tiles.length, size.width || 900, size.height || 460);
  const narrowFocus = size.width > 0 && size.width < 720;
  const canFullscreen = typeof document !== "undefined" && document.fullscreenEnabled;

  useEffect(() => {
    if (manualPinKey && !tiles.some((tile) => tile.key === manualPinKey)) setManualPinKey(null);
  }, [manualPinKey, tiles]);

  useEffect(() => {
    const autoKey = !manualPinKey && followScreenShares && focusTile?.source === "screenshare" ? focusTile.key : null;
    if (autoKey && autoKey !== previousAutomaticFocusRef.current) {
      if ((focusTile?.shareStartedAt ?? 0) > automaticFocusAfter && automaticFocusAfter > 0) setAutomaticFocusAfter(0);
      setNotice(`${focusTile?.displayName ?? "A participant"} started sharing`);
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
    const newestShareKey = newestScreenShareKey(tiles);
    const newestShare = tiles.find((tile) => tile.key === newestShareKey);
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

  const emptyState = stageEmptyState({ phase, connected, error, errorAction, roomLabel });

  return (
    <section
      ref={stageRef}
      className={cn("raven-media-stage relative flex min-h-[380px] flex-col text-foreground", stageFullscreen && "min-h-0 max-w-none bg-card p-3", className)}
    >
      <header className="flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-2 px-1 pb-1.5">
        <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
          <span className={cn("h-2 w-2 rounded-full", connected ? reconnecting ? "bg-amber-300" : "bg-primary" : phase === "error" ? "bg-destructive" : "bg-white/25")} />
          <span>{phase === "joining" ? "Connecting" : reconnecting ? "Reconnecting" : connected ? `${participantCount} ${participantCount === 1 ? "person" : "people"} here · You are visible` : phase === "error" ? "Media needs attention" : `${roomLabel} closed`}</span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("h-7 gap-1.5 rounded-lg px-2 text-[11px] text-muted-foreground hover:bg-white/8 hover:text-foreground", followScreenShares && "bg-primary/10 text-primary")}
            aria-pressed={followScreenShares}
            title="Automatically focus the newest screen share"
            onClick={() => setFollowScreenShares(!followScreenShares)}
          >
            <MonitorUp className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Follow screen shares</span>
          </Button>
          <div className="flex rounded-lg bg-black/25 p-0.5">
            <StageButton active={view === "grid" && !focusTile} label="Grid" onClick={returnToGrid}><LayoutGrid /></StageButton>
            <StageButton active={view === "focus" || Boolean(focusTile)} label="Focus" onClick={() => setView("focus")}><Focus /></StageButton>
          </div>
          {canFullscreen ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-lg text-muted-foreground hover:bg-white/8 hover:text-foreground"
              aria-label={stageFullscreen ? `Exit ${roomLabel} fullscreen` : `Fullscreen ${roomLabel}`}
              onClick={() => stageFullscreen ? void document.exitFullscreen() : void stageRef.current?.requestFullscreen?.()}
            >
              {stageFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
          ) : null}
        </div>
      </header>

      <div
        ref={contentRef}
        className="relative min-h-[320px] flex-1 overflow-hidden rounded-[20px] bg-[radial-gradient(circle_at_50%_25%,hsl(var(--muted)/0.45),hsl(var(--background)/0.58)_72%)]"
      >
        <div className="absolute inset-0 p-2.5">
        {emptyState ? (
          <EmptyStage {...emptyState} onAction={emptyState.action && onConnect ? onConnect : undefined} />
        ) : !tiles.length ? (
          <EmptyStage title={`${roomLabel} is ready`} text="Participant media will appear here when it becomes available." />
        ) : focusTile ? (
          <div className={cn("relative flex h-full min-h-0 gap-2.5", narrowFocus && "flex-col")}>
            <div className="relative min-h-0 min-w-0 flex-1">
              {renderTile(focusTile, true)}
              <Button type="button" variant="secondary" size="sm" className="absolute bottom-16 left-1/2 z-10 h-8 -translate-x-1/2 gap-1.5 rounded-full bg-black/70 px-3 text-[11px] text-white shadow-lg hover:bg-black/85" onClick={returnToGrid}>
                <LayoutGrid className="h-3.5 w-3.5" /> Return to grid
              </Button>
            </div>
            {sideTiles.length && !filmstripCollapsed ? (
              <aside className={cn("flex min-h-0 w-44 shrink-0 flex-col gap-2", narrowFocus && "h-28 w-full flex-row")} aria-label="Other participants">
                <Button type="button" variant="ghost" size="sm" className={cn("h-7 shrink-0 gap-1 px-2 text-[10px] text-muted-foreground", narrowFocus && "h-full w-7 px-0")} onClick={() => setFilmstripCollapsed(true)} title="Collapse filmstrip">
                  {narrowFocus ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  {!narrowFocus ? "Hide" : null}
                </Button>
                <div className={cn("grid min-h-0 flex-1 auto-rows-[104px] grid-cols-1 gap-2 overflow-y-auto", narrowFocus && "auto-cols-[154px] auto-rows-fr grid-flow-col grid-cols-none overflow-x-auto overflow-y-hidden")}>
                  {sideTiles.map((tile) => renderTile(tile))}
                </div>
              </aside>
            ) : sideTiles.length ? (
              <Button type="button" variant="secondary" size="sm" className="absolute right-3 top-1/2 z-10 h-8 -translate-y-1/2 rounded-full bg-black/70 px-3 text-[11px] text-white shadow-lg hover:bg-black/85" onClick={() => setFilmstripCollapsed(false)}>
                {sideTiles.length} more
              </Button>
            ) : null}
          </div>
        ) : (
          <div
            className="grid h-full min-h-0 gap-2.5"
            style={{ gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(tiles.length / gridColumns)}, minmax(0, 1fr))` }}
          >
              {tiles.map((tile) => renderTile(tile, tiles.length === 1))}
          </div>
        )}
        </div>
      </div>

      {reconnecting && tiles.length ? (
        <div className="pointer-events-none absolute left-1/2 top-14 z-20 -translate-x-1/2 rounded-full bg-amber-200/90 px-3 py-1.5 text-[11px] font-medium text-black shadow-lg">Reconnecting media…</div>
      ) : null}
      {notice ? (
        <div role="status" className="pointer-events-none absolute left-1/2 top-14 z-20 -translate-x-1/2 rounded-full bg-popover/95 px-3 py-1.5 text-[11px] text-foreground/80 shadow-lg backdrop-blur">{notice}</div>
      ) : null}

    </section>
  );
}

function StageButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactElement }) {
  return (
    <Button type="button" variant="ghost" size="sm" className={cn("h-7 gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-white/8 hover:text-foreground [&_svg]:h-3.5 [&_svg]:w-3.5", active && "bg-white/10 text-foreground")} aria-pressed={active} title={`${label} layout`} onClick={onClick}>
      {children}<span className="hidden sm:inline">{label}</span>
    </Button>
  );
}

function EmptyStage({ title, text, action, loading = false, onAction }: { title: string; text: string; action?: string; loading?: boolean; onAction?: () => void }) {
  return (
    <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center">
      <div>
        {loading ? <Loader2 className="mx-auto mb-3 h-7 w-7 animate-spin text-primary/65" /> : <Radio className="mx-auto mb-3 h-7 w-7 text-primary/55" />}
        <div className="text-sm font-semibold text-foreground/80">{title}</div>
        <p className="mx-auto mt-1 max-w-[340px] text-xs leading-5 text-muted-foreground">{text}</p>
        {action && onAction ? <Button type="button" variant="secondary" size="sm" className="mt-4 gap-1.5 rounded-lg" onClick={onAction}>{action}<ArrowRight className="h-3.5 w-3.5" /></Button> : null}
      </div>
    </div>
  );
}

function stageEmptyState({ phase, connected, error, errorAction, roomLabel }: { phase: StagePhase; connected: boolean; error: string; errorAction: string; roomLabel: string }) {
  if (phase === "joining") return { title: `Opening the ${roomLabel.toLowerCase()}`, text: "Connecting your media without changing your device choices.", loading: true };
  if (phase === "leaving") return { title: `Closing the ${roomLabel.toLowerCase()}`, text: "Finishing local media safely.", loading: true };
  if (phase === "error" || error) return { title: "Media could not start", text: [error || `Raven could not open the live ${roomLabel.toLowerCase()}.`, errorAction].filter(Boolean).join(" "), action: "Try again" };
  if (!connected) return { title: `Enter the ${roomLabel} to open media`, text: "Your camera, shared media, and other participants will appear here.", action: `Enter ${roomLabel}` };
  return null;
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
