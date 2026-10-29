import type { ReactNode } from "react";
import { Check, Hand, Mail, UserPlus, Users, X } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { PendingItem, RavenShellData, RavenView } from "./state";
import { usePendingActions } from "./usePendingActions";

/** What a pending item is, said the way a person would say it. */
export function pendingSummary(item: PendingItem) {
  if (item.kind === "knock") return item.knock.nestName ? `Knocked on ${item.knock.nestName}` : "Knocked";
  if (item.kind === "friend") return "Wants to be friends";
  if (item.kind === "invite") return capitalize(item.context);
  return `Asked to join ${item.request.nestName}`;
}

function capitalize(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

export function pendingTarget(item: PendingItem): RavenView {
  if (item.kind === "knock" || item.kind === "friend") return { kind: "user", id: item.fromId };
  return { kind: "waiting", id: item.nestId };
}

/**
 * People reaching you: knocks, invitations, join requests and friend requests,
 * each with the actions that answer it. Shared by the sidebar, inbox and Home.
 * `compact` fits the sidebar: the row opens the context, icons answer it.
 */
export function PendingList({
  data,
  onNavigate,
  onAfterAction,
  surface = "card",
  compact = false,
}: {
  data: RavenShellData;
  onNavigate: (view: RavenView) => void;
  onAfterAction?: () => void;
  surface?: "canvas" | "card" | "popover";
  compact?: boolean;
}) {
  const open = (view: RavenView) => {
    onNavigate(view);
    onAfterAction?.();
  };
  // Shell data reports failures through its own error state; nothing to do here.
  const actions = usePendingActions();
  const badgeSurface = surface === "popover" ? "bg-popover" : surface === "canvas" ? "bg-background" : "bg-card";

  return (
    <ul className="space-y-px">
      {data.pending.map((item) => {
        const fromId = "fromId" in item ? item.fromId : undefined;
        const key = `${item.kind}:${item.id}`;
        const busy = actions.isPending(key);
        return (
          <li
            key={`${item.kind}:${item.id}`}
            className={cn(
              "flex items-center rounded-control transition-colors",
              compact ? "gap-1 pr-1" : "gap-3 px-2 py-2",
              surface === "popover" ? "hover:bg-accent/60" : "hover:bg-secondary/60",
            )}
          >
            <button
              type="button"
              onClick={() => open(pendingTarget(item))}
              className={cn("flex min-w-0 flex-1 items-center text-left", compact ? "gap-2.5 py-1.5 pl-2" : "gap-3")}
            >
              <span className="relative shrink-0">
                <Avatar name={item.from} src={fromId ? api.userAvatarUrl(fromId) : undefined} className={compact ? "h-6 w-6" : "h-8 w-8"} />
                <span className={cn("absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground", badgeSurface)}>
                  {item.kind === "knock" ? <Hand className="h-2.5 w-2.5" /> : item.kind === "friend" ? <UserPlus className="h-2.5 w-2.5" /> : item.kind === "invite" ? <Mail className="h-2.5 w-2.5" /> : <Users className="h-2.5 w-2.5" />}
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-small font-medium text-foreground">{item.from}</span>
                <span className="block truncate text-caption text-muted-foreground">{pendingSummary(item)}</span>
              </span>
            </button>
            <div className="flex shrink-0 items-center gap-0.5">
              {item.kind === "friend" ? (
                compact ? (
                  <>
                    <IconAnswer label={`Accept ${item.from}`} disabled={busy} onClick={() => actions.run(key, () => data.acceptFriendRequest(item.request.id))}><Check /></IconAnswer>
                    <IconAnswer label={`Decline ${item.from}`} disabled={busy} onClick={() => actions.run(key, () => data.declineFriendRequest(item.request.id))}><X /></IconAnswer>
                  </>
                ) : (
                  <>
                    <Button size="xs" disabled={busy} onClick={() => actions.run(key, () => data.acceptFriendRequest(item.request.id))}>Accept</Button>
                    <Button size="xs" variant="ghost" disabled={busy} onClick={() => actions.run(key, () => data.declineFriendRequest(item.request.id))}>Decline</Button>
                  </>
                )
              ) : item.kind === "knock" ? (
                compact ? (
                  <IconAnswer label={`Dismiss knock from ${item.from}`} disabled={busy} onClick={() => actions.run(key, () => data.dismissKnock(item.knock.id))}><X /></IconAnswer>
                ) : (
                  <>
                    <Button size="xs" variant="secondary" onClick={() => open(pendingTarget(item))}>Open</Button>
                    <Button size="xs" variant="ghost" disabled={busy} onClick={() => actions.run(key, () => data.dismissKnock(item.knock.id))}>Dismiss</Button>
                  </>
                )
              ) : compact ? null : (
                <Button size="xs" variant="secondary" onClick={() => open(pendingTarget(item))}>
                  {item.kind === "invite" ? "Open" : "Review"}
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function IconAnswer({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded-chip text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-45 [&>svg]:h-3.5 [&>svg]:w-3.5"
    >
      {children}
    </button>
  );
}
