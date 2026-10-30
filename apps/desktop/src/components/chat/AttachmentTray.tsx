import { useId } from "react";
import { AlertCircle, Loader2, X } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { getLocalUrl, localKey } from "@/lib/chat/media";
import type { Tray, TrayItem } from "@/lib/chat/tray";
import { cn } from "@/lib/utils";
import { placeholderUrl, useCachedUrl } from "./attachmentHooks";

function Thumbnail({ item, index, total, onRemove }: { item: TrayItem; index: number; total: number; onRemove: () => void }) {
  const prepared = item.prepared;
  const preview = prepared?.variants.find((variant) => variant.variant === "preview") ?? prepared?.variants[0];
  const { url } = useCachedUrl(
    prepared && preview ? localKey(prepared.handle, preview.variant) : null,
    () => getLocalUrl(prepared!.handle, preview!.variant, preview!.contentType),
    true,
  );
  const blur = placeholderUrl(prepared?.placeholder);
  const label = total > 1 ? `Image ${index + 1} of ${total}` : "Image";
  return (
    <li className="relative h-16 w-16 shrink-0">
      <div
        className={cn("relative h-full w-full overflow-hidden rounded-control bg-secondary", item.status === "failed" && "outline outline-1 outline-destructive")}
        title={item.error}
      >
        {blur && !url ? <img src={blur} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover" /> : null}
        {url ? <img src={url} alt={label} draggable={false} className="absolute inset-0 h-full w-full object-cover" /> : null}
        {item.status === "preparing" ? (
          <div className="absolute inset-0 flex items-center justify-center" role="status" aria-label="Getting the image ready">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
          </div>
        ) : item.status === "failed" ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <AlertCircle className="h-4 w-4 text-destructive" aria-hidden />
          </div>
        ) : null}
      </div>
      <button
        type="button"
        aria-label={`Remove ${label.toLowerCase()}`}
        onClick={onRemove}
        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-popover text-muted-foreground shadow-raised transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </li>
  );
}

/** What will go with the next message, above the box where its caption is written. */
export function AttachmentTray({
  tray,
  onRemove,
  onFullQualityChange,
}: {
  tray: Tray;
  onRemove: (id: string) => void;
  onFullQualityChange: (fullQuality: boolean) => void;
}) {
  const switchId = useId();
  const hintId = useId();
  if (tray.items.length === 0) return null;
  const errors = [...new Set(tray.items.flatMap((item) => (item.error ? [item.error] : [])))];
  return (
    <div className="mb-1.5 rounded-control bg-secondary/60 px-2.5 pb-2 pt-2.5">
      <ul className="flex gap-2.5 overflow-x-auto pb-0.5 pr-1.5 pt-1.5" aria-label="Images to send">
        {tray.items.map((item, index) => (
          <Thumbnail key={item.id} item={item} index={index} total={tray.items.length} onRemove={() => onRemove(item.id)} />
        ))}
      </ul>
      {errors.length ? (
        <p className="mt-1.5 text-caption text-destructive" role="alert">
          {errors.join(" ")} Remove it to send the rest.
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-2.5">
        <Switch id={switchId} checked={tray.fullQuality} onCheckedChange={onFullQualityChange} aria-describedby={hintId} />
        <label htmlFor={switchId} className="text-caption font-medium">Full quality</label>
        <span id={hintId} className="min-w-0 truncate text-caption text-subtle">Larger files, not resized. Location is still removed.</span>
      </div>
    </div>
  );
}
