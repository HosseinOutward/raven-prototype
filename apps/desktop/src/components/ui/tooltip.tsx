import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";
import { useFullscreenContainer } from "./portal";

/**
 * Names an icon-only control on hover or keyboard focus. `shortcut` shows the
 * key combination beside the label when there is one.
 */
export function Tooltip({
  label,
  shortcut,
  side = "top",
  align = "center",
  children,
}: {
  label: React.ReactNode;
  shortcut?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  children: React.ReactElement;
}) {
  const container = useFullscreenContainer();
  if (!label) return children;
  return (
    <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={200}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal container={container}>
          <TooltipPrimitive.Content
            side={side}
            align={align}
            sideOffset={8}
            collisionPadding={8}
            className={cn(
              "z-[90] flex max-w-[280px] animate-fade-in items-center gap-2 rounded-control bg-popover px-2.5 py-1.5 text-caption text-popover-foreground shadow-raised",
            )}
          >
            <span>{label}</span>
            {shortcut ? <kbd className="rv-mono text-subtle">{shortcut}</kbd> : null}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
