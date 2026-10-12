import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFullscreenContainer } from "./portal";

/**
 * Right-edge slide-in panel. Same dismissal model as `Dialog` (Escape, backdrop
 * click, close button), but anchored to the right and sized for deep tool
 * surfaces such as the per-channel processor chain in the mixer.
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
  const container = useFullscreenContainer();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal container={container}>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-fade-in bg-black/55" />
        <div className="ravenv1-scope pointer-events-none fixed inset-0 z-50 flex justify-end">
          <DialogPrimitive.Content
            {...(description ? {} : { "aria-describedby": undefined })}
            className={cn(
              "pointer-events-auto flex h-full animate-sheet-in flex-col bg-popover text-popover-foreground shadow-raised outline-none",
              widthClassName,
            )}
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <DialogPrimitive.Title className="truncate text-title-sm font-semibold">{title}</DialogPrimitive.Title>
                {description ? (
                  <DialogPrimitive.Description className="mt-0.5 truncate text-small text-muted-foreground">
                    {description}
                  </DialogPrimitive.Description>
                ) : null}
              </div>
              <DialogPrimitive.Close
                aria-label="Close"
                className="-mr-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </DialogPrimitive.Close>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
