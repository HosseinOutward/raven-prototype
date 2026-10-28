import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { claimAutoReload } from "@/lib/crashRecovery";
import { BareTopBar } from "./TopBar";

/**
 * What a part of the window shows when it failed to draw. The rest of the window, and
 * the call, keep running; Try again draws the part afresh.
 */
export function RegionFallback({
  onRetry,
  compact = false,
  onLeave,
}: {
  onRetry: () => void;
  compact?: boolean;
  /** Offered when the part that failed held the call's own controls. */
  onLeave?: () => void;
}) {
  if (compact) {
    return (
      <div className="flex min-h-0 items-center gap-2 px-3 py-2 text-small text-muted-foreground" role="alert">
        <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
        <span className="min-w-0 truncate">This part of Raven could not be shown.</span>
        <Button variant="ghost" size="xs" onClick={onRetry}>Try again</Button>
        {onLeave ? <Button variant="ghost" size="xs" onClick={onLeave}>Leave</Button> : null}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6" role="alert">
      <div className="max-w-[380px] text-center">
        <AlertTriangle className="mx-auto h-6 w-6 text-warning" />
        <h2 className="mt-3 text-title-sm font-semibold">This view could not be shown</h2>
        <p className="mt-1.5 text-body text-muted-foreground">
          Something went wrong while drawing it. Your call and the rest of Raven are still running.
        </p>
        <Button className="mt-5" variant="secondary" onClick={onRetry}>Try again</Button>
      </div>
    </div>
  );
}

/**
 * The whole window failed to draw. The page is reloaded once on its own, which returns
 * to the call it was in; a second failure within a minute waits for the user instead of
 * looping.
 */
export function AppCrashFallback() {
  const [autoReload] = useState(claimAutoReload);
  useEffect(() => {
    if (!autoReload) return;
    const timer = window.setTimeout(() => window.location.reload(), 800);
    return () => window.clearTimeout(timer);
  }, [autoReload]);

  return (
    <div className="ravenv1-scope flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <BareTopBar />
      <div className="flex min-h-0 flex-1 items-center justify-center p-6" role="alert">
        <div className="max-w-[380px] text-center">
          {autoReload ? (
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
          ) : (
            <AlertTriangle className="mx-auto h-6 w-6 text-warning" />
          )}
          <h1 className="mt-4 text-title font-semibold">Raven ran into a problem</h1>
          <p className="mt-1.5 text-body text-muted-foreground">
            {autoReload
              ? "Reopening the window. If you were in a call, Raven will join it again."
              : "Reopen the window to continue. If you were in a call, Raven will join it again."}
          </p>
          {autoReload ? null : (
            <Button className="mt-6" onClick={() => window.location.reload()}>Reopen</Button>
          )}
        </div>
      </div>
    </div>
  );
}
