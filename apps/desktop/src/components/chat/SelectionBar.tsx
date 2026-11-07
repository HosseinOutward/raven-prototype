import { Button } from "@/components/ui/button";
import { MAX_SELECTED } from "@/lib/chat/selection";

/** Takes the composer's place while messages are being chosen. */
export function SelectionBar({ count, onForward, onSave, onCancel }: { count: number; onForward: () => void; onSave?: () => void; onCancel: () => void }) {
  const ready = count > 0 && count <= MAX_SELECTED;
  return (
    <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-wrap items-center gap-2 px-6 pb-5 pt-2" role="toolbar" aria-label="Selected messages">
      <span className="me-auto text-small text-muted-foreground" aria-live="polite">
        {count} selected{count > MAX_SELECTED ? ` · up to ${MAX_SELECTED} at a time` : ""}
      </span>
      <Button disabled={!ready} onClick={onForward}>Forward</Button>
      {onSave ? <Button variant="secondary" disabled={!ready} onClick={onSave}>Add to Saved messages</Button> : null}
      <Button variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  );
}
