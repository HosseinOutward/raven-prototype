import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { GripHorizontal, MicOff, MonitorUp, Radio, VolumeX } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import {
  EMPTY_VOICE_OVERLAY_SNAPSHOT,
  VoiceOverlayParticipant,
  VoiceOverlaySnapshot,
  subscribeVoiceOverlaySnapshot,
  voiceOverlayCommands,
} from "@/lib/voiceOverlay";

export function VoiceOverlayWindow() {
  const [snapshot, setSnapshot] = useState<VoiceOverlaySnapshot>(EMPTY_VOICE_OVERLAY_SNAPSHOT);
  const saveTimerRef = useRef<number | null>(null);

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
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
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

  const participants = snapshot.participants;

  return (
    <div className="h-screen w-screen overflow-hidden bg-transparent p-2 text-foreground">
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-background/72 shadow-2xl shadow-black/45 backdrop-blur-xl">
        <div
          className="flex h-10 shrink-0 cursor-move items-center gap-2 border-b border-white/10 px-3"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            void getCurrentWindow().startDragging();
          }}
        >
          <GripHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              snapshot.connected ? "bg-primary shadow-sm shadow-primary/70" : "bg-muted-foreground/50",
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold">{snapshot.nestName ?? "Raven Voice"}</div>
            <div className="truncate text-[10px] text-muted-foreground">
              {participants.length ? `${participants.length} in voice` : "No active voice"}
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {participants.length ? (
            <div className="space-y-1.5">
              {participants.map((participant) => (
                <OverlayParticipantRow key={participant.userId} participant={participant} />
              ))}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
              <div>
                <Radio className="mx-auto mb-2 h-4 w-4 opacity-70" />
                No one in voice
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function OverlayParticipantRow({ participant }: { participant: VoiceOverlayParticipant }) {
  const icons = [
    participant.muted ? <MicOff key="muted" className="h-3.5 w-3.5" /> : null,
    participant.deafened ? <VolumeX key="deafened" className="h-3.5 w-3.5" /> : null,
    participant.screenSharing ? <MonitorUp key="screen" className="h-3.5 w-3.5" /> : null,
  ].filter(Boolean);

  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-white/5">
      <div className={cn("rounded-full p-0.5", participant.speaking ? "ring-2 ring-primary shadow-sm shadow-primary/60" : "ring-1 ring-white/10")}>
        {participant.avatarUrl ? (
          <img
            src={participant.avatarUrl}
            alt=""
            className="h-8 w-8 rounded-full object-cover"
            draggable={false}
          />
        ) : (
          <Avatar name={participant.displayName} className="h-8 w-8 text-[10px]" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium leading-4">
          {participant.displayName}
          {participant.isLocal ? <span className="ml-1 text-[10px] text-muted-foreground">(you)</span> : null}
        </div>
      </div>
      {icons.length ? (
        <div className="flex shrink-0 items-center gap-1 text-muted-foreground">{icons}</div>
      ) : null}
    </div>
  );
}
