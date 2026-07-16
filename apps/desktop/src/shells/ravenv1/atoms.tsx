import type { CSSProperties, ReactNode } from "react";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { Info } from "lucide-react";
import { PRESENCE, type Presence } from "./state";

/** A large rounded surface floating on the black canvas. Depth comes from the
 *  border + surface value alone — a shadow on near-black would be invisible. */
export function Island({ className, children, style }: { className?: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={style} className={cn("rounded-[24px] bg-card", className)}>
      {children}
    </div>
  );
}

/** Consentful presence indicator — a quiet colored dot, never raw "online". */
export function PresenceDot({ presence, className }: { presence: Presence; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", className)}
      style={{ background: `hsl(${PRESENCE[presence].h})` }}
    />
  );
}

export function MonoLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("rv-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground", className)}>{children}</span>;
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
    <span className="group/info relative inline-flex shrink-0 align-middle">
      <button
        type="button"
        aria-label={label}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none invisible absolute top-full z-[80] mt-2 w-[292px] rounded-xl bg-popover px-3 py-2.5 text-left text-xs font-normal leading-5 text-popover-foreground opacity-0 shadow-xl ring-1 ring-border transition-opacity group-hover/info:visible group-hover/info:opacity-100 group-focus-within/info:visible group-focus-within/info:opacity-100",
          align === "start" && "left-0",
          align === "center" && "left-1/2 -translate-x-1/2",
          align === "end" && "right-0",
        )}
      >
        {children}
      </span>
    </span>
  );
}

/** Static input-level indicator. Dim + still because, on the home surface, the
 *  mic is muted and nothing is being transmitted — no motion, no false signal. */
export function SignalMeter({ className }: { className?: string }) {
  const heights = [32, 52, 40, 60, 36];
  return (
    <div aria-hidden className={cn("flex h-6 items-end gap-[3px]", className)}>
      {heights.map((h, i) => (
        <span key={i} className="w-[3px] rounded-full bg-muted-foreground/40" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

export function AvatarStack({ names, max = 3 }: { names: string[]; max?: number }) {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return (
    <div className="flex -space-x-2">
      {shown.map((n) => (
        <Avatar key={n} name={n} className="h-6 w-6 border border-card text-[10px]" />
      ))}
      {extra > 0 ? (
        <div className="flex h-6 w-6 items-center justify-center rounded-full border border-card bg-secondary text-[10px] font-medium">
          +{extra}
        </div>
      ) : null}
    </div>
  );
}
