import { useId, useState, type ReactNode } from "react";
import { AlarmClock, BellOff, ChevronLeft, ChevronRight, Footprints, MessageSquareText, Moon, Timer, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { Knock, KnockReply } from "@/lib/api";
import { KnockMessageDialog } from "./KnockMessageDialog";
import {
  answerHint,
  answerLabels,
  answerUntil,
  dismissHint,
  formatWhen,
  laterChoices,
  laterHeading,
  notTodayUntil,
  pickedTime,
} from "./knockReplies";

/**
 * Every answer to a knock on you, each with a line saying what the knocker will see and
 * until when. Ask me later… opens its own list of exact times in the same menu, and
 * Send a message… opens a dialog for the note.
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
  onAnswer: (reply: KnockReply, until?: Date, message?: string) => void;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"answers" | "later">("answers");
  const [now, setNow] = useState(() => new Date());
  const [time, setTime] = useState("");
  const [writing, setWriting] = useState(false);
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
    <>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild disabled={disabled}>
          {children}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          {panel === "answers" ? (
            <>
              <DropdownMenuLabel>Answer {name}</DropdownMenuLabel>
              <AnswerItem icon={Footprints} label={answerLabels.coming} hint={answerHint("coming", name, now)} onSelect={() => onAnswer("coming")} />
              <AnswerItem
                icon={Timer}
                label={answerLabels.soon}
                hint={answerHint("soon", name, now)}
                times={[formatWhen(answerUntil("soon", now), now)]}
                onSelect={() => onAnswer("soon")}
              />
              <AnswerItem
                icon={AlarmClock}
                label={answerLabels.later}
                hint={answerHint("later", name, now)}
                more
                onSelect={(event) => {
                  event.preventDefault();
                  setPanel("later");
                }}
              />
              <AnswerItem
                icon={Moon}
                label={answerLabels.not_today}
                hint={answerHint("not_today", name, now)}
                times={[formatWhen(notTodayUntil(now), now)]}
                onSelect={() => onAnswer("not_today")}
              />
              <AnswerItem
                icon={MessageSquareText}
                label={answerLabels.message}
                hint={answerHint("message", name, now)}
                onSelect={() => setWriting(true)}
              />
              <DropdownMenuSeparator />
              <AnswerItem
                icon={BellOff}
                label="Dismiss quietly"
                hint={dismissHint(name, knock.expiresAt, now)}
                times={[formatWhen(knock.expiresAt, now), "isn’t told"]}
                onSelect={onDismiss}
              />
            </>
          ) : (
            <>
              <DropdownMenuLabel>{laterHeading(name)}</DropdownMenuLabel>
              {laterChoices(now).map((choice) => {
                const [words, time] = choice.label.split(" · ");
                return (
                  <DropdownMenuItem key={choice.label} onSelect={() => onAnswer("later", choice.until)}>
                    <span className="text-muted-foreground">{words}</span>
                    <span className="ml-auto font-medium tabular-nums text-foreground">{time}</span>
                  </DropdownMenuItem>
                );
              })}
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
                <ChevronLeft className="text-muted-foreground" />
                Back
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <KnockMessageDialog open={writing} onOpenChange={setWriting} name={name} onSend={(message, until) => onAnswer("message", until, message)} />
    </>
  );
}

function AnswerItem({
  icon: Icon,
  label,
  hint,
  times = [],
  more,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  /** Parts of the hint to set in the foreground: the times, and what is decisive. */
  times?: string[];
  /** Opens another list instead of answering. */
  more?: boolean;
  onSelect: (event: Event) => void;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} className="items-start gap-3 py-2">
      <Icon className="mt-0.5 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium">{label}</span>
        <span className="text-caption text-muted-foreground">{emphasize(hint, times)}</span>
      </span>
      {more ? <ChevronRight className="mt-0.5 text-muted-foreground" aria-hidden /> : null}
    </DropdownMenuItem>
  );
}

/** The hint with each of `parts` set in the foreground, so the times stand out. */
function emphasize(text: string, parts: string[]): ReactNode {
  const pieces: ReactNode[] = [];
  let rest = text;
  for (;;) {
    let at = -1;
    let found = "";
    for (const part of parts) {
      const index = part ? rest.indexOf(part) : -1;
      if (index >= 0 && (at < 0 || index < at)) [at, found] = [index, part];
    }
    if (at < 0) break;
    if (at > 0) pieces.push(rest.slice(0, at));
    pieces.push(
      <span key={pieces.length} className="font-medium text-foreground">
        {found}
      </span>,
    );
    rest = rest.slice(at + found.length);
  }
  if (rest) pieces.push(rest);
  return pieces;
}
