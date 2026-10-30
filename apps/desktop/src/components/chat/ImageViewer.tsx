import { useEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Copy, Download, X } from "lucide-react";
import { useFullscreenContainer } from "@/components/ui/portal";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { copyAttachment, listVariant, saveAttachment, viewVariant } from "@/lib/chat/imageActions";
import { getAttachmentUrl, mediaCache, serverKey } from "@/lib/chat/media";
import type { ChatAttachment } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import { placeholderUrl, useCachedUrl } from "./attachmentHooks";

/** One image at full size: the list's copy (or the blur) stays until the full one is here. */
function FullImage({ conversationId, attachment, alt }: { conversationId: string; attachment: ChatAttachment; alt: string }) {
  const full = viewVariant(attachment);
  const small = listVariant(attachment);
  const { url, failed, gone, retry } = useCachedUrl(serverKey(attachment.id, full), () => getAttachmentUrl(conversationId, attachment.id, full), true);
  const [loaded, setLoaded] = useState(false);
  const stand = mediaCache.peek(serverKey(attachment.id, small)) ?? placeholderUrl(attachment.placeholder);
  const aspect = attachment.width && attachment.height ? `${attachment.width} / ${attachment.height}` : undefined;
  if (gone) return <p className="text-small text-muted-foreground">This image is no longer available.</p>;
  return (
    // Sized like the image would be, fitted to the window, so the stand-in and the image line up.
    <div
      className="relative max-h-full max-w-full"
      style={{ aspectRatio: aspect, width: attachment.width ? `min(${attachment.width}px, 100%)` : undefined, maxHeight: "100%" }}
    >
      {stand && !loaded ? <img src={stand} alt="" aria-hidden className="absolute inset-0 h-full w-full object-contain" /> : null}
      {url ? <img src={url} alt={alt} draggable={false} onLoad={() => setLoaded(true)} className="relative h-full w-full object-contain" /> : null}
      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <button type="button" onClick={retry} className="rounded-control bg-popover px-3 py-1.5 text-small font-medium text-foreground transition-colors hover:bg-accent">
            Couldn’t load. Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

const iconButton = "flex h-9 w-9 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40";

/**
 * A message's images, large, over the whole window. Arrows move between them; Escape
 * closes and returns focus to the image that opened it.
 */
export function ImageViewer({
  conversationId,
  images,
  index,
  senderName,
  onIndexChange,
  onClose,
}: {
  conversationId: string;
  images: ChatAttachment[];
  index: number;
  senderName: string;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const container = useFullscreenContainer();
  // Radix gives focus back only to a Dialog.Trigger, and the image that opened this isn't one.
  const opener = useRef<Element | null>(document.activeElement);
  const attachment = images[index];
  const many = images.length > 1;
  const go = (step: number) => {
    const next = index + step;
    if (next >= 0 && next < images.length) onIndexChange(next);
  };

  useEffect(() => {
    if (!many) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") go(-1);
      else if (event.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!attachment) return null;
  const alt = many ? `Image from ${senderName}, ${index + 1} of ${images.length}` : `Image from ${senderName}`;

  const save = () => {
    void saveAttachment(conversationId, attachment).then(
      (saved) => {
        if (saved) toast({ title: "Image saved" });
      },
      () => toast({ title: "Couldn’t save the image", description: "Try again in a moment.", tone: "error" }),
    );
  };
  const copy = () => {
    void copyAttachment(conversationId, attachment).then(
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
              {many ? <span className="tabular-nums">{index + 1} of {images.length}</span> : null}
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
            <FullImage key={attachment.id} conversationId={conversationId} attachment={attachment} alt={alt} />
            {many ? (
              <>
                <button type="button" aria-label="Previous image" disabled={index === 0} onClick={() => go(-1)} className={cn(iconButton, "absolute left-4 top-1/2 h-11 w-11 -translate-y-1/2 rounded-full")}>
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <button type="button" aria-label="Next image" disabled={index === images.length - 1} onClick={() => go(1)} className={cn(iconButton, "absolute right-4 top-1/2 h-11 w-11 -translate-y-1/2 rounded-full")}>
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
