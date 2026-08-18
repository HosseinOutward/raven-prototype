import { useEffect, useRef, useState } from "react";
import { ImageUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export const MAX_UPLOADED_IMAGE_BYTES = 512 * 1024;
const PREVIEW_SIZE = 320;
const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export function SquareImageUpload({
  disabled = false,
  label = "Choose image",
  onUpload,
  onError,
}: {
  disabled?: boolean;
  label?: string;
  onUpload: (file: File) => Promise<void> | void;
  onError?: (message: string) => void;
}) {
  const [source, setSource] = useState<{ file: File; url: string } | null>(null);
  const [imageSize, setImageSize] = useState({ width: 1, height: 1 });
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [cropping, setCropping] = useState(false);
  const dragRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => () => {
    if (source) URL.revokeObjectURL(source.url);
  }, [source]);

  const close = () => {
    setSource(null);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    dragRef.current = null;
  };

  const choose = (file: File) => {
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      onError?.("Choose a JPEG, PNG, GIF, or WebP image.");
      return;
    }
    setSource({ file, url: URL.createObjectURL(file) });
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };

  const baseScale = Math.max(PREVIEW_SIZE / imageSize.width, PREVIEW_SIZE / imageSize.height);
  const clampOffset = (next: { x: number; y: number }, nextZoom = zoom) => {
    const maxX = Math.max(0, (imageSize.width * baseScale * nextZoom - PREVIEW_SIZE) / 2);
    const maxY = Math.max(0, (imageSize.height * baseScale * nextZoom - PREVIEW_SIZE) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, next.x)), y: Math.max(-maxY, Math.min(maxY, next.y)) };
  };

  const crop = async () => {
    if (!imageRef.current || !source) return;
    setCropping(true);
    try {
      const file = await cropSquareImage(imageRef.current, imageSize, baseScale, zoom, offset);
      await onUpload(file);
      close();
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "The image could not be cropped.");
    } finally {
      setCropping(false);
    }
  };

  return (
    <>
      <label className={cn("mt-3 inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg bg-secondary px-3 text-xs font-medium text-secondary-foreground transition-colors hover:bg-accent", disabled && "pointer-events-none opacity-50")}>
        <ImageUp className="h-3.5 w-3.5" />
        {label}
        <input type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="hidden" disabled={disabled} onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) choose(file);
        }} />
      </label>

      <Dialog
        open={source != null}
        onOpenChange={(open) => { if (!open && !cropping) close(); }}
        title="Crop profile picture"
        description="Move and zoom the image to choose a square crop. Raven will optimize the upload to 512 KB or less."
      >
        {source ? (
          <div className="space-y-4">
            <div
              className="relative mx-auto aspect-square w-full max-w-[320px] touch-none overflow-hidden rounded-2xl bg-black/45 shadow-inner cursor-grab active:cursor-grabbing"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                dragRef.current = { x: event.clientX, y: event.clientY, offsetX: offset.x, offsetY: offset.y };
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (!drag) return;
                setOffset(clampOffset({ x: drag.offsetX + event.clientX - drag.x, y: drag.offsetY + event.clientY - drag.y }));
              }}
              onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); dragRef.current = null; }}
              onPointerCancel={() => { dragRef.current = null; }}
            >
              <img
                ref={imageRef}
                src={source.url}
                alt="Crop preview"
                draggable={false}
                onLoad={(event) => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                className="pointer-events-none absolute left-1/2 top-1/2 max-w-none select-none"
                style={{
                  width: imageSize.width * baseScale,
                  height: imageSize.height * baseScale,
                  transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
                }}
              />
              <div className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/25" />
            </div>

            <label className="block text-xs font-medium text-muted-foreground">
              Zoom
              <input
                type="range"
                min="1"
                max="3"
                step="0.01"
                value={zoom}
                className="mt-2 w-full accent-[hsl(var(--primary))]"
                onChange={(event) => {
                  const nextZoom = Number(event.currentTarget.value);
                  setZoom(nextZoom);
                  setOffset((current) => clampOffset(current, nextZoom));
                }}
              />
            </label>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={close} disabled={cropping}>Cancel</Button>
              <Button type="button" onClick={() => void crop()} disabled={cropping}>
                {cropping ? <><Loader2 className="h-4 w-4 animate-spin" /> Preparing…</> : "Use square crop"}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

async function cropSquareImage(
  image: HTMLImageElement,
  imageSize: { width: number; height: number },
  baseScale: number,
  zoom: number,
  offset: { x: number; y: number },
) {
  const renderedScale = baseScale * zoom;
  const sourceSize = PREVIEW_SIZE / renderedScale;
  const centerX = imageSize.width / 2 - offset.x / renderedScale;
  const centerY = imageSize.height / 2 - offset.y / renderedScale;
  const sx = Math.max(0, Math.min(imageSize.width - sourceSize, centerX - sourceSize / 2));
  const sy = Math.max(0, Math.min(imageSize.height - sourceSize, centerY - sourceSize / 2));

  for (const size of [512, 448, 384]) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image cropping is unavailable on this device.");
    context.drawImage(image, sx, sy, sourceSize, sourceSize, 0, 0, size, size);
    for (const quality of [0.9, 0.8, 0.7, 0.6]) {
      const blob = await canvasBlob(canvas, "image/webp", quality);
      if (blob.size <= MAX_UPLOADED_IMAGE_BYTES) {
        return new File([blob], "profile-picture.webp", { type: blob.type || "image/webp" });
      }
    }
  }
  throw new Error("The cropped image could not be reduced to 512 KB. Try a simpler image.");
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The cropped image could not be encoded.")), type, quality);
  });
}
