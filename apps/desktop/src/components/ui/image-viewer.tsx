import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Copy, Download, X } from "lucide-react";
import { useFullscreenContainer } from "@/components/ui/portal";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const iconButton = "flex h-9 w-9 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40";

/**
 * An image, large, over the whole window, with save and copy. Arrows move between images
 * when there are several; Escape closes and returns focus to whatever opened it.
 */
export function ImageViewerFrame({
  alt,
  position,
  onSave,
  onCopy,
  onClose,
  children,
}: {
  alt: string;
  /** Where this image is among several. Leave out for a single image. */
  position?: { index: number; count: number; go: (step: number) => void };
  /** False when the person cancels the save. */
  onSave: () => Promise<boolean>;
  onCopy: () => Promise<void>;
  onClose: () => void;
  children: ReactNode;
}) {
  const container = useFullscreenContainer();
  // Radix gives focus back only to a Dialog.Trigger, and the image that opened this isn't one.
  const opener = useRef<Element | null>(document.activeElement);

  useEffect(() => {
    if (!position) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") position.go(-1);
      else if (event.key === "ArrowRight") position.go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const save = () => {
    void onSave().then(
      (saved) => {
        if (saved) toast({ title: "Image saved" });
      },
      () => toast({ title: "Couldn’t save the image", description: "Try again in a moment.", tone: "error" }),
    );
  };
  const copy = () => {
    void onCopy().then(
      () => toast({ title: "Image copied" }),
      () => toast({ title: "Couldn’t copy the image", description: "Save it instead, then copy the file.", tone: "error" }),
    );
  };

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPrimitive.Portal container={container}>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-fade-in bg-black/90" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            // Start on the viewer itself: focusing a button would open its tooltip at once.
            // Tab reaches the buttons; Escape and the arrows work from here.
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
          }}
          className="ravenv1-scope fixed inset-0 z-50 flex animate-fade-in flex-col outline-none"
        >
          <DialogPrimitive.Title className="sr-only">{alt}</DialogPrimitive.Title>
          <div className="flex h-14 shrink-0 items-center justify-between gap-3 px-4">
            <p className="min-w-0 truncate text-small text-muted-foreground">
              {position ? <span className="tabular-nums">{position.index + 1} of {position.count}</span> : null}
            </p>
            <div className="flex items-center gap-1">
              <Tooltip label="Save image…">
                <button type="button" aria-label="Save image…" onClick={save} className={iconButton}>
                  <Download className="h-4 w-4" />
                </button>
              </Tooltip>
              <Tooltip label="Copy image">
                <button type="button" aria-label="Copy image" onClick={copy} className={iconButton}>
                  <Copy className="h-4 w-4" />
                </button>
              </Tooltip>
              <Tooltip label="Close" shortcut="Esc">
                <DialogPrimitive.Close aria-label="Close" className={iconButton}>
                  <X className="h-4 w-4" />
                </DialogPrimitive.Close>
              </Tooltip>
            </div>
          </div>
          <div
            className="relative flex min-h-0 flex-1 items-center justify-center px-16 pb-10"
            onClick={(event) => {
              // A click on the dark area around the image closes, as on the backdrop.
              if (event.target === event.currentTarget) onClose();
            }}
          >
            {children}
            {position ? (
              <>
                <button type="button" aria-label="Previous image" disabled={position.index === 0} onClick={() => position.go(-1)} className={cn(iconButton, "absolute left-4 top-1/2 h-11 w-11 -translate-y-1/2 rounded-full")}>
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <button type="button" aria-label="Next image" disabled={position.index === position.count - 1} onClick={() => position.go(1)} className={cn(iconButton, "absolute right-4 top-1/2 h-11 w-11 -translate-y-1/2 rounded-full")}>
                  <ChevronRight className="h-5 w-5" />
                </button>
              </>
            ) : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
