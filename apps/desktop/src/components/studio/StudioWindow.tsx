import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AudioLines, ExternalLink, X } from "lucide-react";
import { api } from "@/lib/api";
import { AudioMixerPanel } from "@/components/AudioMixerPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Standalone window that hosts the audio Studio (Sources & Mixer console) for a
 * single nest. Opened via `openStudioInWindow` at `/#/studio/<nestId>`.
 *
 * The mixer drives global Rust audio state, so this window controls the same audio
 * engine as the main window. Publishing only reaches LiveKit while the main window
 * stays open and RTC-connected — this view never holds the `Room` itself.
 */
export function StudioWindow({ nestId }: { nestId: string }) {
  const [nestName, setNestName] = useState<string>("");
  const [live, setLive] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "unauthenticated" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!api.getSessionId()) {
      setState("unauthenticated");
      return;
    }
    let mounted = true;
    api
      .getNest(nestId)
      .then((details) => {
        if (!mounted) return;
        setNestName(details.nest.name);
        setState("ready");
        return api.activeSession(nestId).then((result) => {
          if (mounted) setLive(Boolean(result.session));
        });
      })
      .catch((err) => {
        if (!mounted) return;
        const message = err instanceof Error ? err.message : "Could not load nest";
        if (/401|unauth/i.test(message)) {
          setState("unauthenticated");
        } else {
          setError(message);
          setState("error");
        }
      });
    return () => {
      mounted = false;
    };
  }, [nestId]);

  const close = () => {
    void getCurrentWindow().close();
  };

  if (state === "unauthenticated") {
    return (
      <StudioShell onClose={close}>
        <div className="flex h-full items-center justify-center p-8 text-center">
          <div>
            <ExternalLink className="mx-auto mb-3 h-7 w-7 text-muted-foreground/40" />
            <div className="text-sm font-semibold">Sign in from the main Raven window</div>
            <p className="mx-auto mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
              The Studio shares its session with the main window. Sign in there, then reopen the Studio.
            </p>
          </div>
        </div>
      </StudioShell>
    );
  }

  if (state === "error") {
    return (
      <StudioShell onClose={close}>
        <div className="flex h-full items-center justify-center p-8 text-center text-sm text-destructive">{error}</div>
      </StudioShell>
    );
  }

  return (
    <StudioShell onClose={close} title={nestName || "Studio"} live={live} loading={state === "loading"}>
      <AudioMixerPanel />
    </StudioShell>
  );
}

function StudioShell({
  children,
  onClose,
  title = "Studio",
  live = false,
  loading = false,
}: {
  children: React.ReactNode;
  onClose: () => void;
  title?: string;
  live?: boolean;
  loading?: boolean;
}) {
  return (
    <div className="flex h-screen flex-col gap-2.5 overflow-hidden bg-background p-2.5">
      <header className="flex h-14 shrink-0 items-center gap-3 rounded-xl bg-card px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
          <AudioLines className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{title}</span>
            <Badge variant={live ? "default" : "outline"} className="text-[10px]">
              {live ? "Live" : "Idle"}
            </Badge>
          </div>
          <div className="text-[11px] text-muted-foreground">Audio Studio · Sources &amp; Mixer</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className={cn("h-2 w-2 rounded-full", loading ? "animate-pulse bg-amber-400" : "bg-primary")} />
          <Button variant="ghost" size="sm" className="h-8 text-muted-foreground hover:text-foreground" onClick={onClose}>
            <X className="h-4 w-4" />
            Close
          </Button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-hidden rounded-xl bg-card p-4">{children}</main>
    </div>
  );
}
