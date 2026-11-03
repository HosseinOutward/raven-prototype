import { useEffect, useRef, useState } from "react";
import { Copy, Download, X } from "lucide-react";

const iconButton = "flex h-9 w-9 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

/** PNG bytes of an image, converting through a canvas when it is another format. */
async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("no png"))), "image/png"));
}

/**
 * One image, large, over the whole window, like the desktop app's chat viewer.
 * Escape or a click around the image closes and returns focus to what opened it.
 */
export function ImageViewer({ src, alt, saveName, onClose }: { src: string; alt: string; saveName: string; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Start on the viewer itself; Tab reaches the buttons.
    root.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !root.current) return;
      // Keep Tab inside the viewer.
      const focusable = Array.from(root.current.querySelectorAll<HTMLElement>("a[href], button"));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === root.current)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);

  const copy = async () => {
    try {
      const blob = await (await fetch(src)).blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": asPng(blob) })]);
      setStatus("Image copied");
    } catch {
      setStatus("Couldn’t copy the image. Save it instead, then copy the file.");
    }
  };

  return (
    <div ref={root} role="dialog" aria-modal="true" aria-label={alt} tabIndex={-1} className="fixed inset-0 z-50 flex flex-col bg-black/90 outline-none">
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 px-4">
        <p role="status" className="min-w-0 truncate text-small text-muted-foreground">
          {status}
        </p>
        <div className="flex items-center gap-1">
          <a href={src} download={saveName} aria-label="Save image" title="Save image" className={iconButton}>
            <Download size={16} aria-hidden />
          </a>
          <button type="button" aria-label="Copy image" title="Copy image" onClick={() => void copy()} className={iconButton}>
            <Copy size={16} aria-hidden />
          </button>
          <button type="button" aria-label="Close" title="Close (Esc)" onClick={onClose} className={iconButton}>
            <X size={16} aria-hidden />
          </button>
        </div>
      </div>
      <div
        className="flex min-h-0 flex-1 items-center justify-center px-16 pb-10"
        onClick={(event) => {
          // A click on the dark area around the image closes.
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <img src={src} alt={alt} draggable={false} className="max-h-full max-w-full object-contain" />
      </div>
    </div>
  );
}
