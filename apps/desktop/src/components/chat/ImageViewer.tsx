import { useState } from "react";
import { ImageViewerFrame } from "@/components/ui/image-viewer";
import { copyAttachment, listVariant, saveAttachment, viewVariant } from "@/lib/chat/imageActions";
import { getAttachmentUrl, mediaCache, serverKey } from "@/lib/chat/media";
import type { ChatAttachment } from "@/lib/chat/types";
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

/** A message's images in the full-window viewer. */
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
  const attachment = images[index];
  if (!attachment) return null;
  const many = images.length > 1;
  const alt = many ? `Image from ${senderName}, ${index + 1} of ${images.length}` : `Image from ${senderName}`;
  const go = (step: number) => {
    const next = index + step;
    if (next >= 0 && next < images.length) onIndexChange(next);
  };

  return (
    <ImageViewerFrame
      alt={alt}
      position={many ? { index, count: images.length, go } : undefined}
      onSave={() => saveAttachment(conversationId, attachment)}
      onCopy={() => copyAttachment(conversationId, attachment)}
      onClose={onClose}
    >
      <FullImage key={attachment.id} conversationId={conversationId} attachment={attachment} alt={alt} />
    </ImageViewerFrame>
  );
}
