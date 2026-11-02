import { useEffect, useId, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { KNOCK_MESSAGE_MAX, formatWhen, laterChoices, messageHoldQuestion, messageSummary, pickedTime } from "./knockReplies";

type Hold = { kind: "none" } | { kind: "until"; until: Date } | { kind: "pick" };

/**
 * A note in answer to a knock, and whether the knocker may knock again. Holding them back
 * is capped at 24 hours, like Ask me later; it never lasts indefinitely.
 */
export function KnockMessageDialog({
  open,
  onOpenChange,
  name,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onSend: (message: string, until?: Date) => void;
}) {
  const [text, setText] = useState("");
  const [hold, setHold] = useState<Hold>({ kind: "none" });
  const [time, setTime] = useState("");
  const [now, setNow] = useState(() => new Date());
  const textId = useId();
  const questionId = useId();
  const timeId = useId();

  useEffect(() => {
    if (!open) return;
    // The choices name clock times, so they are worked out when the dialog opens.
    setNow(new Date());
    setText("");
    setHold({ kind: "none" });
    setTime("");
  }, [open]);

  const message = text.split(/\s+/).filter(Boolean).join(" ");
  const length = Array.from(message).length;
  const until = hold.kind === "until" ? hold.until : hold.kind === "pick" ? (time ? pickedTime(time, now) : null) : null;
  const ready = length > 0 && length <= KNOCK_MESSAGE_MAX && (hold.kind !== "pick" || until !== null);

  const send = () => {
    if (!ready) return;
    onOpenChange(false);
    onSend(message, until ?? undefined);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Send ${name} a message`}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <div className="space-y-1.5">
          <label htmlFor={textId} className="sr-only">
            Message to {name}
          </label>
          <Textarea
            id={textId}
            value={text}
            maxLength={KNOCK_MESSAGE_MAX + 20}
            placeholder="In a meeting. Call me after?"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // One line: Enter sends.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
          <p className={cn("text-right text-caption tabular-nums", length > KNOCK_MESSAGE_MAX ? "text-destructive" : "text-subtle")}>
            {length} / {KNOCK_MESSAGE_MAX}
          </p>
        </div>

        <div className="space-y-1.5">
          <p id={questionId} className="text-small font-medium">
            {messageHoldQuestion(name)}
          </p>
          <div role="radiogroup" aria-labelledby={questionId} className="space-y-0.5">
            <HoldChoice selected={hold.kind === "none"} onSelect={() => setHold({ kind: "none" })} label="Yes, any time" />
            {laterChoices(now).map((choice) => {
              const [words, at] = choice.label.split(" · ");
              return (
                <HoldChoice
                  key={choice.label}
                  selected={hold.kind === "until" && hold.until.getTime() === choice.until.getTime()}
                  onSelect={() => setHold({ kind: "until", until: choice.until })}
                  label={`Not before ${at}`}
                  detail={words}
                />
              );
            })}
            <HoldChoice selected={hold.kind === "pick"} onSelect={() => setHold({ kind: "pick" })} label="Not before a time I pick…" />
          </div>
          {hold.kind === "pick" ? (
            <div className="space-y-1 pl-9 pt-1">
              <label htmlFor={timeId} className="sr-only">
                Time {name} can knock again
              </label>
              <Input id={timeId} type="time" value={time} onChange={(event) => setTime(event.target.value)} className="h-8 w-40" />
              {time && !until ? (
                <p role="alert" className="text-caption text-muted-foreground">
                  Pick a time at least 15 minutes from now, within the next 24 hours.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <p className="text-small text-muted-foreground">
          {hold.kind === "pick" && !until ? `Pick a time, and ${name} can’t knock before it.` : messageSummary(name, until, now)}
        </p>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={!ready}>
            {until ? `Send · no knocks before ${formatWhen(until, now)}` : "Send"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function HoldChoice({ selected, onSelect, label, detail }: { selected: boolean; onSelect: () => void; label: string; detail?: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 rounded-control px-2.5 py-1.5 text-left text-body transition-colors hover:bg-accent",
        selected && "bg-accent",
      )}
    >
      <Check className={cn("h-4 w-4 shrink-0", selected ? "text-foreground" : "invisible")} aria-hidden />
      <span className={cn("flex-1", selected ? "font-medium text-foreground" : "text-muted-foreground")}>{label}</span>
      {detail ? <span className="text-caption text-subtle">{detail}</span> : null}
    </button>
  );
}
