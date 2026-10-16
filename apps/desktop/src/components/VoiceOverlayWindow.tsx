import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { GripHorizontal, MicOff, MonitorUp, Radio, Video, VolumeX } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { speakingGlowStyle } from "@/lib/speakingActivity";
import {
  EMPTY_VOICE_OVERLAY_SNAPSHOT,
  type VoiceOverlayLayout,
  type VoiceOverlayParticipant,
  type VoiceOverlaySnapshot,
  subscribeVoiceOverlaySettings,
  subscribeVoiceOverlaySnapshot,
  visibleHorizontalVoiceOverlayParticipants,
  voiceOverlayCommands,
} from "@/lib/voiceOverlay";

const CHROME_HIDE_DELAY_MS = 1500;

export function VoiceOverlayWindow() {
  const [snapshot, setSnapshot] = useState<VoiceOverlaySnapshot>(EMPTY_VOICE_OVERLAY_SNAPSHOT);
  const [layout, setLayout] = useState<VoiceOverlayLayout>("vertical");
  const [showNames, setShowNames] = useState(true);
  const [chromeVisible, setChromeVisible] = useState(false);
  const saveTimerRef = useRef<number | null>(null);
  const chromeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const previousWindow = document.body.dataset.ravenWindow;
    document.body.dataset.ravenWindow = "overlay";
    return () => {
      if (previousWindow) {
        document.body.dataset.ravenWindow = previousWindow;
      } else {
        delete document.body.dataset.ravenWindow;
      }
    };
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    voiceOverlayCommands
      .getSnapshot()
      .then((nextSnapshot) => {
        if (active) setSnapshot(nextSnapshot);
      })
      .catch(() => undefined);
    subscribeVoiceOverlaySnapshot((nextSnapshot) => {
      if (active) setSnapshot(nextSnapshot);
    })
      .then((nextUnlisten) => {
        unlisten = nextUnlisten;
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    const applySettings = (settings: { layout: VoiceOverlayLayout; showNames: boolean }) => {
      if (!active) return;
      setLayout(settings.layout);
      setShowNames(settings.showNames);
    };
    voiceOverlayCommands.getSettings().then(applySettings).catch(() => undefined);
    subscribeVoiceOverlaySettings(applySettings)
      .then((nextUnlisten) => {
        unlisten = nextUnlisten;
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const currentWindow = tryGetCurrentWindow();
    if (!currentWindow) return;
    currentWindow
      .onMoved((event) => {
        const position = event.payload as { x: number; y: number };
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => {
          void voiceOverlayCommands
            .savePosition({ x: Math.round(position.x), y: Math.round(position.y) })
            .catch(() => undefined);
        }, 180);
      })
      .then((nextUnlisten) => {
        unlisten = nextUnlisten;
      })
      .catch(() => undefined);

    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      unlisten?.();
    };
  }, []);

  const clearChromeTimer = () => {
    if (chromeTimerRef.current === null) return;
    window.clearTimeout(chromeTimerRef.current);
    chromeTimerRef.current = null;
  };
  const revealChrome = () => {
    clearChromeTimer();
    setChromeVisible(true);
  };
  const scheduleChromeHide = () => {
    clearChromeTimer();
    chromeTimerRef.current = window.setTimeout(() => {
      chromeTimerRef.current = null;
      setChromeVisible(false);
    }, CHROME_HIDE_DELAY_MS);
  };

  useEffect(() => () => clearChromeTimer(), []);

  const participants = snapshot.participants;
  const locationLabel = snapshot.locationLabel || "nest";
  const horizontalParticipants = visibleHorizontalVoiceOverlayParticipants(participants);

  return (
    <div
      className="h-screen w-screen overflow-hidden bg-transparent p-2 text-foreground"
      onMouseEnter={revealChrome}
      onMouseLeave={scheduleChromeHide}
      onFocusCapture={revealChrome}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleChromeHide();
      }}
    >
      <div
        className={cn(
          "relative h-full min-h-0 overflow-hidden rounded-lg border transition-[background-color,border-color,box-shadow] duration-200",
          chromeVisible
            ? "border-white/10 bg-black/45 shadow-2xl shadow-black/45 backdrop-blur-xl"
            : "border-transparent bg-transparent shadow-none",
        )}
      >
        <div
          className={cn(
            "absolute inset-x-0 top-0 z-20 flex h-10 cursor-move items-center gap-2 border-b border-white/10 bg-background/88 px-3 backdrop-blur-xl transition-opacity duration-200",
            chromeVisible ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            revealChrome();
            void tryGetCurrentWindow()?.startDragging();
          }}
        >
          <GripHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              snapshot.connected ? "bg-live" : "bg-muted-foreground/50",
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold">{snapshot.nestName ?? "Raven Voice"}</div>
            <div className="truncate text-[10px] text-muted-foreground">
              {participants.length ? `${participants.length} in ${locationLabel}` : `No active ${locationLabel}`}
            </div>
          </div>
        </div>

        <div
          className={cn(
            "h-full min-h-0 pt-12",
            layout === "horizontal" ? "flex items-end overflow-hidden px-2 pb-2" : "overflow-y-auto p-2 pt-12",
          )}
        >
          {participants.length ? (
            <div className={cn(layout === "horizontal" ? "flex items-end gap-1.5" : "space-y-1.5")}>
              {(layout === "horizontal" ? horizontalParticipants.participants : participants).map((participant) => (
                <OverlayParticipantRow
                  key={participant.userId}
                  participant={participant}
                  layout={layout}
                  showName={layout === "vertical" && showNames}
                />
              ))}
              {layout === "horizontal" && horizontalParticipants.hiddenCount > 0 ? (
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
                  aria-label={`${horizontalParticipants.hiddenCount} more participants`}
                >
                  +{horizontalParticipants.hiddenCount}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex h-full flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">
              <div>
                <Radio className="mx-auto mb-2 h-4 w-4 opacity-70" />
                No one in {locationLabel}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function OverlayParticipantRow({
  participant,
  layout,
  showName,
}: {
  participant: VoiceOverlayParticipant;
  layout: VoiceOverlayLayout;
  showName: boolean;
}) {
  const icons = [
    participant.muted ? <MicOff key="muted" className="h-3.5 w-3.5" /> : null,
    participant.deafened ? <VolumeX key="deafened" className="h-3.5 w-3.5" /> : null,
    participant.cameraOn ? <Video key="camera" className="h-3.5 w-3.5 text-primary" /> : null,
    participant.screenSharing ? <MonitorUp key="screen" className="h-3.5 w-3.5" /> : null,
  ].filter(Boolean);

  if (layout === "horizontal") {
    return (
      <div
        className="relative flex h-12 w-10 shrink-0 items-start justify-center pt-1"
        aria-label={`${participant.displayName}${participant.isLocal ? ", you" : ""}${participant.speaking ? ", speaking" : ""}`}
      >
        <ParticipantAvatar participant={participant} />
        {icons.length ? (
          <div className="absolute -bottom-0.5 left-1/2 flex max-w-[42px] -translate-x-1/2 items-center gap-0.5 px-1 py-0.5 text-muted-foreground">
            {icons}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 px-2 py-1.5 text-sm",
        !showName && "w-fit",
      )}
      aria-label={!showName ? `${participant.displayName}${participant.isLocal ? ", you" : ""}` : undefined}
    >
      <ParticipantAvatar participant={participant} />
      {showName ? (
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium leading-4">
            {participant.displayName}
            {participant.isLocal ? <span className="ml-1 text-[10px] text-muted-foreground">(you)</span> : null}
          </div>
        </div>
      ) : null}
      {icons.length ? (
        <div className="flex shrink-0 items-center gap-1 text-muted-foreground">{icons}</div>
      ) : null}
    </div>
  );
}

function ParticipantAvatar({ participant }: { participant: VoiceOverlayParticipant }) {
  return (
    <div
      className={cn(
        "rounded-full p-0.5",
        participant.speaking ? "raven-overlay-speaking" : "ring-1 ring-white/10",
      )}
      style={speakingGlowStyle(participant.speakingLevel / 100, "avatar")}
    >
      <Avatar name={participant.displayName} src={participant.avatarUrl ?? undefined} className="h-8 w-8 text-[10px]" />
    </div>
  );
}

function tryGetCurrentWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}
