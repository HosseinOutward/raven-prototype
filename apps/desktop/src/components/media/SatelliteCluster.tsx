import { useEffect, useRef, useState } from "react";
import { AudioLines, AudioWaveform, Mic, MonitorSpeaker, SlidersHorizontal, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import type { AudioSourceType } from "@/lib/audio";
import { speakingGlowStyle } from "@/lib/speakingActivity";
import { cn } from "@/lib/utils";
import {
  gainDbToVolumePercent,
  MAX_VOLUME_PERCENT,
  splitSatellites,
  volumePercentToGainDb,
  type AudioSatellite,
  type SatelliteActions,
} from "./audioSatellites";
import { motionClass, useStageMotion, type MotionEntry } from "./stageMotion";

type Variant = "room" | "strip" | "tile";

const VOLUME_LIVE_INTERVAL_MS = 60;

/**
 * The extra audio sources one person sends, drawn beside them: at the avatar in the
 * voice room, inside the pill in the strip, as chips in a tile's corner. Each one
 * rings with its own level, never the person's. Beyond three, the last becomes "+N".
 */
export function SatelliteCluster({
  satellites,
  ownerName,
  variant,
  armed,
  actions,
  className,
}: {
  satellites: AudioSatellite[];
  /** "You" for your own. */
  ownerName: string;
  variant: Variant;
  /** Whether arrivals and departures animate (the stage has settled). */
  armed: boolean;
  actions: SatelliteActions;
  className?: string;
}) {
  const { sources } = useStageMotion({ sources: satellites }, satelliteKey, armed);
  if (!sources.length) return null;
  const { shown, overflow } = splitSatellites(sources);
  const live = overflow.filter((entry) => entry.phase !== "leave");
  return (
    <span
      className={cn(
        "flex",
        variant === "room" ? "flex-col gap-1" : "items-center gap-0.5",
        className,
      )}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {shown.map((entry) => (
        <SatelliteButton key={entry.key} entry={entry} ownerName={ownerName} variant={variant} actions={actions} />
      ))}
      {live.length ? <OverflowButton entries={live} ownerName={ownerName} variant={variant} actions={actions} /> : null}
    </span>
  );
}

function satelliteKey(satellite: AudioSatellite) {
  return satellite.key;
}

function satelliteLabel(satellite: AudioSatellite, ownerName: string) {
  const state = satellite.muted ? ", muted" : satellite.mutedForMe ? ", muted for you" : "";
  return `${ownerName} · ${satellite.name}${state}`;
}

function dotClass(variant: Variant) {
  return cn(
    "relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors",
    variant === "tile"
      ? "bg-black/65 text-white backdrop-blur-md hover:bg-black/80"
      : variant === "room"
        ? "bg-accent text-muted-foreground shadow-[0_0_0_2px_hsl(var(--card))] hover:text-foreground"
        : "bg-accent text-muted-foreground hover:text-foreground",
  );
}

function SatelliteButton({
  entry,
  ownerName,
  variant,
  actions,
}: {
  entry: MotionEntry<AudioSatellite>;
  ownerName: string;
  variant: Variant;
  actions: SatelliteActions;
}) {
  const satellite = entry.item;
  const label = satelliteLabel(satellite, ownerName);
  const leaving = entry.phase === "leave";
  const silenced = satellite.muted || satellite.mutedForMe;
  const button = (
    <button
      type="button"
      aria-label={label}
      tabIndex={leaving ? -1 : undefined}
      aria-hidden={leaving || undefined}
      className={cn(dotClass(variant), satellite.active && !silenced && "raven-speaking-ring", motionClass(entry.phase, "animate-pop-in"))}
      style={speakingGlowStyle(satellite.intensity, "avatar")}
    >
      <SourceIcon sourceType={satellite.sourceType} iconUrl={satellite.iconUrl} />
      {silenced ? (
        <span
          className={cn(
            "absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full text-destructive",
            variant === "tile" ? "bg-black/80" : "bg-card",
          )}
          aria-hidden
        >
          <VolumeX className="h-2.5 w-2.5" />
        </span>
      ) : null}
    </button>
  );
  if (leaving) return button;
  return (
    <Popover>
      <Tooltip label={label}>
        <PopoverTrigger asChild>{button}</PopoverTrigger>
      </Tooltip>
      <PopoverContent align="start" aria-label={label} onClick={(event) => event.stopPropagation()}>
        <SatelliteDetails satellite={satellite} ownerName={ownerName} actions={actions} />
      </PopoverContent>
    </Popover>
  );
}

function OverflowButton({
  entries,
  ownerName,
  variant,
  actions,
}: {
  entries: MotionEntry<AudioSatellite>[];
  ownerName: string;
  variant: Variant;
  actions: SatelliteActions;
}) {
  const label = `${entries.length} more ${entries.length === 1 ? "source" : "sources"} from ${ownerName === "You" ? "you" : ownerName}`;
  const active = entries.some((entry) => entry.item.active && !entry.item.muted && !entry.item.mutedForMe);
  return (
    <Popover>
      <Tooltip label={label}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className={cn(dotClass(variant), "text-caption font-medium tabular-nums", active && "raven-speaking-ring")}
            style={speakingGlowStyle(Math.max(...entries.map((entry) => entry.item.intensity)), "avatar")}
          >
            +{entries.length}
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent className="p-0" align="start" aria-label={label} onClick={(event) => event.stopPropagation()}>
        <div className="max-h-96 divide-y divide-border overflow-y-auto">
          {entries.map((entry) => (
            <div key={entry.key} className="p-3">
              <SatelliteDetails satellite={entry.item} ownerName={ownerName} actions={actions} />
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Name, whose it is and what it is doing, then what you can do about it. */
function SatelliteDetails({ satellite, ownerName, actions }: { satellite: AudioSatellite; ownerName: string; actions: SatelliteActions }) {
  const status = satellite.isLocal
    ? satellite.muted
      ? "Muted. Nobody here hears it."
      : "Everyone here can hear this."
    : satellite.muted
      ? `${ownerName} muted this.`
      : `From ${ownerName}`;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-muted-foreground">
          <SourceIcon sourceType={satellite.sourceType} iconUrl={satellite.iconUrl} large />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-body font-medium">{satellite.name}</span>
          <span className="block truncate text-caption text-muted-foreground">{status}</span>
        </span>
      </div>
      {satellite.isLocal ? (
        <div className="flex flex-wrap gap-2">
          {actions.openMixer ? (
            <Button variant="secondary" size="xs" onClick={actions.openMixer}>
              <SlidersHorizontal />
              Open in Mixer
            </Button>
          ) : null}
          {satellite.shareLinked && actions.stopShare ? (
            <Button variant="ghost" size="xs" onClick={actions.stopShare}>Stop sharing</Button>
          ) : null}
        </div>
      ) : (
        <RemoteControls satellite={satellite} actions={actions} />
      )}
    </div>
  );
}

function RemoteControls({ satellite, actions }: { satellite: AudioSatellite; actions: SatelliteActions }) {
  const percent = gainDbToVolumePercent(satellite.gainDb);
  const [draft, setDraft] = useState(percent);
  const draggingRef = useRef(false);
  const sendRef = useRef<{ timer: number | null; last: number; value: number }>({ timer: null, last: 0, value: percent });

  useEffect(() => {
    if (!draggingRef.current && sendRef.current.timer === null) setDraft(percent);
  }, [percent]);
  useEffect(() => () => {
    if (sendRef.current.timer !== null) window.clearTimeout(sendRef.current.timer);
  }, []);

  const fail = (title: string) => (error: unknown) => {
    toast({ title, description: error instanceof Error ? error.message : typeof error === "string" ? error : undefined, tone: "error" });
  };

  // Live while dragging, throttled like the Mixer's faders, with the last value always sent.
  const send = (value: number) => {
    const pending = sendRef.current;
    pending.value = value;
    if (pending.timer !== null) return;
    const wait = Math.max(0, VOLUME_LIVE_INTERVAL_MS - (Date.now() - pending.last));
    pending.timer = window.setTimeout(() => {
      pending.timer = null;
      pending.last = Date.now();
      void actions.setVolume(satellite, volumePercentToGainDb(pending.value)).catch(fail("Couldn’t change the volume"));
    }, wait);
  };

  const release = () => {
    draggingRef.current = false;
  };

  return (
    <div className="space-y-3">
      <label className="block space-y-1.5">
        <span className="flex items-baseline justify-between gap-3 text-caption">
          <span className="text-muted-foreground">Volume for you</span>
          <span className="tabular-nums text-muted-foreground">{draft}%</span>
        </span>
        <input
          className="raven-fader"
          type="range"
          min={0}
          max={MAX_VOLUME_PERCENT}
          step={5}
          value={draft}
          aria-valuetext={`${draft}%`}
          onPointerDown={() => {
            draggingRef.current = true;
          }}
          onPointerUp={release}
          onPointerCancel={release}
          onBlur={release}
          onChange={(event) => {
            const next = Number(event.target.value);
            setDraft(next);
            send(next);
          }}
        />
      </label>
      <div className="flex items-center justify-between gap-3">
        <span className="text-caption text-subtle">Only you hear this change.</span>
        <Button
          variant="secondary"
          size="xs"
          onClick={() => void actions.setMutedForMe(satellite, !satellite.mutedForMe).catch(fail(satellite.mutedForMe ? "Couldn’t unmute it" : "Couldn’t mute it"))}
        >
          {satellite.mutedForMe ? <Volume2 /> : <VolumeX />}
          {satellite.mutedForMe ? "Unmute for me" : "Mute for me"}
        </Button>
      </div>
    </div>
  );
}

function SourceIcon({ sourceType, iconUrl, large = false }: { sourceType: AudioSourceType; iconUrl: string | null; large?: boolean }) {
  if (iconUrl) {
    return <img src={iconUrl} alt="" aria-hidden className={cn("shrink-0 rounded-[3px] object-contain", large ? "h-5 w-5" : "h-3.5 w-3.5")} />;
  }
  const className = large ? "h-4 w-4" : "h-3.5 w-3.5";
  switch (sourceType) {
    case "microphone":
      return <Mic className={className} aria-hidden />;
    case "systemAudio":
    case "screenAudio":
      return <MonitorSpeaker className={className} aria-hidden />;
    case "testTone":
      return <AudioWaveform className={className} aria-hidden />;
    default:
      return <AudioLines className={className} aria-hidden />;
  }
}
