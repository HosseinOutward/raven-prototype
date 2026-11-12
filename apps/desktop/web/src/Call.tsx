import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, MicOff, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RavenShellData } from "@/shells/ravenv1/state";
import { joinCall, type Call, type RemoteVideo } from "./room";
import { Header } from "./Lists";

type Phase = { kind: "joining" } | { kind: "waiting" } | { kind: "connected"; call: Call } | { kind: "disconnected"; reason: string };

/** A voice Nest: who is sharing video, Mute and Leave. Leaving this screen leaves the call. */
export function CallScreen({ nestId, data, onBack }: { nestId: string; data: RavenShellData; onBack: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "joining" });
  const [videos, setVideos] = useState<RemoteVideo[]>([]);
  const [muted, setMuted] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  // Rejoin starts the effect again.
  const [attempt, setAttempt] = useState(0);

  // Each attempt starts once the one before it has left, so its goodbye can't end the new call.
  const previousLeft = useRef(Promise.resolve());

  useEffect(() => {
    let live = true;
    let call: Call | undefined;
    setPhase({ kind: "joining" });
    setVideos([]);
    setMuted(false);
    setAudioBlocked(false);
    const joined = (async () => {
      await previousLeft.current;
      try {
        if (!live) return;
        if ((await data.joinNest(nestId)) === "waiting") {
          if (live) setPhase({ kind: "waiting" });
          return;
        }
        if (!live) return;
        call = await joinCall({
          nestId,
          userId: data.user?.id ?? "",
          rtcServerUrl: data.serverProperties.rtcServerUrl,
          presence: data.presence,
          onVideos: (next) => live && setVideos(next),
          onAudioBlocked: (blocked) => live && setAudioBlocked(blocked),
          onDropped: () => live && setPhase({ kind: "disconnected", reason: "Disconnected" }),
        });
        if (live) setPhase({ kind: "connected", call });
      } catch (error) {
        if (live) setPhase({ kind: "disconnected", reason: error instanceof Error && error.message ? error.message : "Couldn’t join" });
      }
    })();
    return () => {
      live = false;
      previousLeft.current = joined.then(() => call?.leave());
    };
    // Joins with what is known when it starts; a change of shell data is not a new call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nestId, attempt]);

  const toggleMute = () => {
    if (phase.kind !== "connected") return;
    void phase.call.setMuted(!muted).then(() => setMuted(!muted));
  };

  return (
    <>
      <Header title={data.getNest(nestId)?.name ?? data.labels.nestSingular} onBack={onBack} />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {videos.map((video) => (
          <VideoTile key={video.key} video={video} name={data.getPerson(video.userId)?.name ?? "Someone"} />
        ))}
        {phase.kind !== "connected" || videos.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-body text-muted-foreground" role="status">
            {phase.kind === "joining" ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
            {phase.kind === "joining" ? "Joining…" : phase.kind === "waiting" ? "Waiting to be let in" : phase.kind === "disconnected" ? phase.reason : "Connected"}
            {phase.kind === "waiting" || phase.kind === "disconnected" ? (
              <Button variant="secondary" onClick={() => setAttempt((count) => count + 1)}>Rejoin</Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap justify-center gap-3 border-t border-border/70 p-4">
        {phase.kind === "connected" && audioBlocked ? (
          <Button size="lg" className="w-full" onClick={() => void phase.call.startAudio()}>Tap to hear the call</Button>
        ) : null}
        <Button size="lg" variant="secondary" disabled={phase.kind !== "connected"} onClick={toggleMute}>
          {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          {muted ? "Unmute" : "Mute"}
        </Button>
        <Button size="lg" variant="destructive" onClick={onBack}>
          <PhoneOff className="h-5 w-5" />
          Leave
        </Button>
      </div>
    </>
  );
}

function VideoTile({ video, name }: { video: RemoteVideo; name: string }) {
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const target = element.current!;
    video.track.attach(target);
    return () => {
      video.track.detach(target);
    };
  }, [video.track]);
  return (
    <figure className="overflow-hidden rounded-card bg-black">
      <video ref={element} autoPlay playsInline muted className="aspect-video w-full object-contain" />
      <figcaption className="px-3 py-1.5 text-caption text-muted-foreground">{name}{video.source === "screen" ? " · screen" : ""}</figcaption>
    </figure>
  );
}
