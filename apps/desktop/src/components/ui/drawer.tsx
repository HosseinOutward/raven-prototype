import * as React from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Right-edge slide-in panel. Same dismissal model as `Dialog` (backdrop click +
 * close button), but anchored to the right and sized for deep tool surfaces such
 * as the per-channel processor chain in the Studio console.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  widthClassName = "w-full max-w-md",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  widthClassName?: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/45" onMouseDown={() => onOpenChange(false)}>
      <div
        className={cn("flex h-full flex-col border-l border-border bg-card shadow-2xl shadow-black/40", widthClassName)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border p-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{title}</h2>
            {description ? <p className="mt-1 truncate text-xs text-muted-foreground">{description}</p> : null}
          </div>
          <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)} aria-label="Close drawer">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
