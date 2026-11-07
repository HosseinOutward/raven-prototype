import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Tooltip } from "@/components/ui/tooltip";
import { accountCaption, type SavedAccount } from "@/lib/accounts";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Info } from "lucide-react";
import { PRESENCE, type Presence } from "./state";

/** The raised content surface. The window canvas shows around it. */
export function Island({ className, children, style }: { className?: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={style} className={cn("rounded-panel bg-card", className)}>
      {children}
    </div>
  );
}

type SurfaceName = "canvas" | "card" | "popover";

const SURFACE_VAR: Record<SurfaceName, string> = {
  canvas: "var(--background)",
  card: "var(--card)",
  popover: "var(--popover)",
};

/**
 * Presence as a shape as well as a colour, so it reads without colour vision:
 * open = filled, around = filled periwinkle, focused = half, do not disturb = bar,
 * invisible and offline = hollow.
 */
export function PresenceDot({
  presence,
  className,
  avatarBadge = false,
  surface = "card",
}: {
  presence: Presence;
  className?: string;
  avatarBadge?: boolean;
  surface?: SurfaceName;
}) {
  const color = `hsl(${PRESENCE[presence].h})`;
  const hollow = presence === "offline" || presence === "invisible";
  const style: CSSProperties = hollow
    ? { boxShadow: `inset 0 0 0 1.5px ${color}`, background: `hsl(${SURFACE_VAR[surface]})` }
    : presence === "focused"
      ? { background: `linear-gradient(90deg, ${color} 50%, hsl(${SURFACE_VAR[surface]}) 50%)`, boxShadow: `inset 0 0 0 1.5px ${color}` }
      : { background: color };
  return (
    <span
      aria-label={PRESENCE[presence].label}
      role="img"
      title={PRESENCE[presence].label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full",
        avatarBadge ? "h-2.5 w-2.5" : "h-2 w-2",
        className,
      )}
      style={avatarBadge ? { ...style, outline: `2px solid hsl(${SURFACE_VAR[surface]})` } : style}
    >
      {presence === "dnd" ? <span aria-hidden className="h-[1.5px] w-1.5 rounded-full bg-white" /> : null}
    </span>
  );
}

/** A person's avatar with their presence on the corner. */
export function PersonAvatar({
  id,
  name,
  presence,
  version,
  surface = "card",
  className,
}: {
  id: string;
  name: string;
  presence?: Presence;
  version?: string;
  surface?: SurfaceName;
  className?: string;
}) {
  return (
    <span className="relative inline-flex shrink-0">
      <Avatar name={name} src={api.userAvatarUrl(id, version)} className={className} />
      {presence ? <PresenceDot presence={presence} avatarBadge surface={surface} className="absolute -bottom-px -right-px" /> : null}
    </span>
  );
}

/** Marks something as live. The only place the live colour appears as a dot. */
export function LiveDot({ className }: { className?: string }) {
  return <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full bg-live", className)} />;
}

/**
 * What kind of nest something is, drawn the same in messages, tree pages and the sidebar.
 * Voice is a quiet level meter whose bars breathe while people are inside; text is a
 * speech bubble. Sized and stroked like the lucide icons around it.
 */
export function NestGlyph({ kind, live = false, className }: { kind: "voice" | "text"; live?: boolean; className?: string }) {
  const svg = { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, className: cn("h-4 w-4 shrink-0", className) };
  if (kind === "text") {
    return (
      <svg {...svg}>
        <path d="M4 2.75h8A2.25 2.25 0 0 1 14.25 5v4.5A2.25 2.25 0 0 1 12 11.75H7.5l-3 2.25v-2.25H4A2.25 2.25 0 0 1 1.75 9.5V5A2.25 2.25 0 0 1 4 2.75z" />
        <path d="M5 6h6M5 8.5h3.5" />
      </svg>
    );
  }
  const bar = live ? "raven-nest-bar" : undefined;
  return (
    <svg {...svg}>
      <path className={bar} d="M4 6.25v3.5" />
      <path className={bar} style={live ? { animationDelay: "-0.55s" } : undefined} d="M8 3.25v9.5" />
      <path className={bar} style={live ? { animationDelay: "-1.1s" } : undefined} d="M12 5.25v5.5" />
    </svg>
  );
}

/** Quiet heading for a group of rows. Sentence case, never tracked capitals. */
export function SectionLabel({ children, className, action }: { children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <div className={cn("flex min-h-7 items-center justify-between gap-2", className)}>
      <h2 className="text-caption font-medium text-subtle">{children}</h2>
      {action}
    </div>
  );
}

/** Rows that belong together: one fill, hairlines between rows. */
export function GroupedList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("divide-y divide-border/70 overflow-hidden rounded-card bg-secondary/50", className)}>
      {children}
    </div>
  );
}

/** An empty area says what belongs here and offers the next step. */
export function EmptyState({
  icon,
  title,
  text,
  children,
  className,
}: {
  icon?: ReactNode;
  title: string;
  text?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-10 text-center", className)}>
      {icon ? <div className="mb-3 text-subtle [&>svg]:h-6 [&>svg]:w-6">{icon}</div> : null}
      <div className="text-title-sm font-medium">{title}</div>
      {text ? <p className="mt-1 max-w-sm text-small text-muted-foreground">{text}</p> : null}
      {children ? <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{children}</div> : null}
    </div>
  );
}

export function InfoTooltip({
  label,
  children,
  align = "start",
}: {
  label: string;
  children: ReactNode;
  align?: "start" | "center" | "end";
}) {
  return (
    <Tooltip label={children} side="bottom" align={align}>
      <button
        type="button"
        aria-label={label}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full align-middle text-subtle transition-colors hover:text-foreground"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
    </Tooltip>
  );
}

/** A saved sign-in as two lines: who, then which server. Only the active one has a picture. */
export function AccountSummary({ account, accounts, active }: { account: SavedAccount; accounts: SavedAccount[]; active: boolean }) {
  const name = account.displayName || account.username;
  const caption = accountCaption(account, accounts);
  return (
    <>
      <Avatar name={name} src={active ? api.userAvatarUrl(account.userId) : undefined} className="h-8 w-8" />
      <span className="min-w-0 flex-1" title={account.serverUrl}>
        <span className="block truncate text-small font-medium">{name}</span>
        <span className="block truncate text-caption text-muted-foreground">
          {caption.handle ? `${caption.handle} · ` : null}
          {caption.serverIsHost ? <span className="rv-mono">{caption.server}</span> : caption.server}
        </span>
      </span>
    </>
  );
}

export interface StackPerson {
  id: string;
  name: string;
}

export function AvatarStack({
  people,
  max = 3,
  size = "sm",
  surface = "card",
}: {
  people: StackPerson[];
  max?: number;
  size?: "sm" | "md";
  surface?: SurfaceName;
}) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  const box = size === "md" ? "h-7 w-7" : "h-5 w-5 text-[10px]";
  const ring = { outline: `2px solid hsl(${SURFACE_VAR[surface]})` };
  if (people.length === 0) return null;
  return (
    <div className="flex shrink-0 -space-x-1.5" title={people.map((person) => person.name).join(", ")}>
      {shown.map((person) => (
        <span key={person.id} className="rounded-full" style={ring}>
          <Avatar name={person.name} src={api.userAvatarUrl(person.id)} className={box} />
        </span>
      ))}
      {extra > 0 ? (
        <span className={cn("flex items-center justify-center rounded-full bg-accent text-caption font-medium text-muted-foreground", box)} style={ring}>
          +{extra}
        </span>
      ) : null}
    </div>
  );
}

/** A running call timer. Ticks in its own component so parents do not re-render. */
export function ElapsedTime({ since, className }: { since?: string | null; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  if (!since) return null;
  const started = new Date(since).getTime();
  if (!Number.isFinite(started)) return null;
  return <span className={cn("tabular-nums", className)}>{formatElapsed(Math.max(0, now - started))}</span>;
}

export function formatElapsed(ms: number) {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
