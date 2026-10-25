import { Eye } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { splitWatcherStack, watchersTooltip, watchingTooltip, type WatchPerson, type WatchTarget } from "./watchers";

/**
 * Who else is watching a share, as a small overlapping stack of faces; names on hover.
 * Nothing is drawn while nobody is. `onVideo` sits on a dark chip over a picture,
 * otherwise it blends into the card behind it.
 */
export function WatcherStack({ watchers, onVideo = false, className }: { watchers: readonly WatchPerson[]; onVideo?: boolean; className?: string }) {
  if (watchers.length === 0) return null;
  const { shown, extra } = splitWatcherStack(watchers);
  const label = watchersTooltip(watchers);
  return (
    <Tooltip label={label} side="top">
      <span
        role="img"
        aria-label={label}
        tabIndex={0}
        className={cn(
          "flex shrink-0 items-center rounded-chip",
          onVideo ? "bg-black/65 p-1 backdrop-blur-md" : "px-0.5",
          className,
        )}
      >
        <Eye className={cn("mr-1.5 h-3.5 w-3.5 shrink-0", onVideo ? "text-white/80" : "text-muted-foreground")} aria-hidden />
        <span className="flex items-center">
          {shown.map((watcher, index) => (
            <Avatar
              key={watcher.participantId}
              name={watcher.displayName}
              src={api.userAvatarUrl(watcher.participantId)}
              className={cn("h-6 w-6 text-caption ring-2", onVideo ? "ring-black/65" : "ring-secondary", index > 0 && "-ml-1.5")}
            />
          ))}
          {extra > 0 ? (
            <span className={cn("-ml-1.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-accent px-1 text-caption ring-2", onVideo ? "text-white ring-black/65" : "text-foreground ring-secondary")}>
              +{extra}
            </span>
          ) : null}
        </span>
      </span>
    </Tooltip>
  );
}

/** An eye beside someone's name when they are watching a share; the tooltip says whose. */
export function WatchingMark({ targets, onVideo = false, className }: { targets: readonly WatchTarget[]; onVideo?: boolean; className?: string }) {
  if (targets.length === 0) return null;
  const label = watchingTooltip(targets);
  return (
    <Tooltip label={label} side="top">
      <span
        role="img"
        aria-label={label}
        tabIndex={0}
        className={cn("pointer-events-auto flex shrink-0 items-center [&>svg]:h-3.5 [&>svg]:w-3.5", onVideo ? "text-white/80" : "text-muted-foreground", className)}
      >
        <Eye />
      </span>
    </Tooltip>
  );
}
