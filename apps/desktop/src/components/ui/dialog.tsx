import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFullscreenContainer } from "./portal";

/**
 * Centered modal. Escape, backdrop click and the close button all dismiss it;
 * focus is trapped inside and returns to the trigger when it closes.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  widthClassName = "max-w-md",
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
        <div className="ravenv1-scope pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
          <DialogPrimitive.Content
            {...(description ? {} : { "aria-describedby": undefined })}
            onOpenAutoFocus={(event) => {
              // Start on a control marked data-autofocus, or else in the first thing to
              // fill in, when there is one, rather than on
              // the close button. A dialog opened from a menu loses React's autoFocus,
              // because the menu still holds focus while the dialog mounts.
              const field = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(
                "[data-autofocus], input:not([type=hidden]):not(:disabled), textarea:not(:disabled)",
              );
              if (!field) return;
              event.preventDefault();
              field.focus();
            }}
            className={cn(
              "pointer-events-auto flex max-h-full w-full animate-pop-in flex-col rounded-panel bg-popover text-popover-foreground shadow-raised outline-none",
              widthClassName,
            )}
          >
            <div className="flex shrink-0 items-start justify-between gap-4 px-5 pb-3 pt-5">
              <div className="min-w-0">
                <DialogPrimitive.Title className="text-title font-semibold">{title}</DialogPrimitive.Title>
                {description ? (
                  <DialogPrimitive.Description className="mt-1 text-small text-muted-foreground">
                    {description}
                  </DialogPrimitive.Description>
                ) : null}
              </div>
              <DialogPrimitive.Close
                aria-label="Close"
                className="-mr-1.5 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </DialogPrimitive.Close>
            </div>
            <div className="min-h-0 overflow-y-auto px-5 pb-5">{children}</div>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** A yes/no question before something that cannot be undone. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  focusCancel = false,
  destructive = false,
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Start on the way out, so a stray Enter does not confirm. */
  focusCancel?: boolean;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} widthClassName="max-w-sm">
      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          className="h-9 rounded-control px-3.5 text-body font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          data-autofocus={focusCancel || undefined}
          onClick={() => onOpenChange(false)}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          disabled={busy}
          className={cn(
            "h-9 rounded-control px-3.5 text-body font-medium transition-colors disabled:opacity-45",
            destructive
              ? "bg-destructive-fill text-destructive-foreground hover:bg-destructive-fill/90"
              : "bg-primary text-primary-foreground hover:bg-primary/90",
          )}
          onClick={() => void onConfirm()}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
