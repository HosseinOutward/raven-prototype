import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  formatPushToTalkEvent,
  formatPushToTalkModifier,
  formatPushToTalkMouseButton,
  pushToTalkKeyLabel,
} from "@/lib/pushToTalk";

/**
 * Shows the push to talk key and picks a new one. Picking listens to the next key or mouse
 * button anywhere in the window; Escape or leaving the button cancels, so it never traps
 * the keyboard.
 */
export function PushToTalkKeyField({
  value,
  disabled,
  listening,
  onListeningChange,
  onPick,
}: {
  value: string;
  disabled?: boolean;
  listening: boolean;
  onListeningChange: (listening: boolean) => void;
  onPick: (key: string) => void;
}) {
  const [heldModifier, setHeldModifier] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!listening) return;
    setHeldModifier(null);
    buttonRef.current?.focus({ preventScroll: true });
    let modifier: string | null = null;
    const pick = (key: string) => {
      onPick(key);
      onListeningChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (event.code === "Escape") {
        onListeningChange(false);
        return;
      }
      const held = formatPushToTalkModifier(event.code);
      if (held) {
        modifier = held;
        setHeldModifier(held);
        return;
      }
      modifier = null;
      const key = formatPushToTalkEvent(event);
      if (key) pick(key);
    };
    // A modifier let go with nothing else pressed is the key itself.
    const onKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (modifier && formatPushToTalkModifier(event.code) === modifier) pick(modifier);
    };
    const onMouseDown = (event: MouseEvent) => {
      const key = formatPushToTalkMouseButton(event.button);
      if (!key) return;
      event.preventDefault();
      event.stopPropagation();
      pick(key);
    };
    const stopNavigation = (event: MouseEvent) => {
      if (event.button === 3 || event.button === 4) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mouseup", stopNavigation, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("mouseup", stopNavigation, true);
    };
  }, [listening, onListeningChange, onPick]);

  const shown = listening
    ? heldModifier ? `${pushToTalkKeyLabel(heldModifier)} + …` : "Press a key or mouse button…"
    : value ? pushToTalkKeyLabel(value) : "No key yet";

  return (
    <div className="flex items-center justify-between gap-3">
      <span className={listening ? "min-w-0 truncate text-small text-muted-foreground" : "rv-mono min-w-0 truncate text-small"} role={listening ? "status" : undefined}>{shown}</span>
      <Button
        ref={buttonRef}
        type="button"
        variant="secondary"
        size="xs"
        className="shrink-0"
        disabled={disabled}
        onClick={() => onListeningChange(!listening)}
        onBlur={() => onListeningChange(false)}
      >
        {listening ? "Cancel" : value ? "Change" : "Pick a key"}
      </Button>
    </div>
  );
}
