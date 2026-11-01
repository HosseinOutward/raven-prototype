import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { Knock, KnockReply } from "@/lib/api";
import { answerHint, answerLabels, dismissHint, formatWhen, laterChoices, laterHeading, pickedTime } from "./knockReplies";

/**
 * Every answer to a knock on you, each with a line saying what the knocker will see and
 * until when. Ask me later… opens its own list of exact times in the same menu.
 * `children` is the trigger, and must forward its ref.
 */
export function KnockAnswerMenu({
  knock,
  name,
  disabled,
  onAnswer,
  onDismiss,
  children,
}: {
  knock: Knock;
  name: string;
  disabled?: boolean;
  onAnswer: (reply: KnockReply, until?: Date) => void;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"answers" | "later">("answers");
  const [now, setNow] = useState(() => new Date());
  const [time, setTime] = useState("");
  const timeId = useId();
  const picked = time ? pickedTime(time, now) : null;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    // The hints name clock times, so they are worked out when the menu opens.
    setNow(new Date());
    setPanel("answers");
    setTime("");
  };

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        {panel === "answers" ? (
          <>
            {(["coming", "soon"] as const).map((reply) => (
              <AnswerItem key={reply} label={answerLabels[reply]} hint={answerHint(reply, name, now)} onSelect={() => onAnswer(reply)} />
            ))}
            <AnswerItem
              label={answerLabels.later}
              hint={answerHint("later", name, now)}
              onSelect={(event) => {
                event.preventDefault();
                setPanel("later");
              }}
            />
            <AnswerItem label={answerLabels.not_today} hint={answerHint("not_today", name, now)} onSelect={() => onAnswer("not_today")} />
            <DropdownMenuSeparator />
            <AnswerItem label="Dismiss quietly" hint={dismissHint(name, knock.expiresAt, now)} onSelect={onDismiss} />
          </>
        ) : (
          <>
            <DropdownMenuLabel>{laterHeading(name)}</DropdownMenuLabel>
            {laterChoices(now).map((choice) => (
              <DropdownMenuItem key={choice.label} onSelect={() => onAnswer("later", choice.until)}>
                {choice.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <div className="space-y-1.5 px-2.5 py-1.5">
              <label htmlFor={timeId} className="block text-caption text-muted-foreground">
                Pick a time…
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id={timeId}
                  type="time"
                  aria-label="Time to knock again"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                  // Keep typing in the field instead of the menu's type-to-find.
                  onKeyDown={(event) => event.stopPropagation()}
                  className="h-8 flex-1"
                />
                <Button
                  size="xs"
                  disabled={!picked}
                  onClick={() => {
                    if (!picked) return;
                    setOpen(false);
                    onAnswer("later", picked);
                  }}
                >
                  {picked ? `Ask at ${formatWhen(picked, now)}` : "Ask"}
                </Button>
              </div>
              {time && !picked ? <p className="text-caption text-muted-foreground">Pick a time at least 15 minutes from now.</p> : null}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setPanel("answers");
              }}
            >
              Back
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AnswerItem({ label, hint, onSelect }: { label: string; hint: string; onSelect: (event: Event) => void }) {
  return (
    <DropdownMenuItem onSelect={onSelect} className="flex-col items-start gap-0.5">
      <span>{label}</span>
      <span className="text-caption text-muted-foreground">{hint}</span>
    </DropdownMenuItem>
  );
}
