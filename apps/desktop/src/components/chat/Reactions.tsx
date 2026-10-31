import { useEffect, useRef } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import type { ReactionLimits } from "@/lib/chat/attachments";
import { reactorsLine, reactorsParts } from "@/lib/chat/reactions";
import type { ChatReaction } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

/** Reactions stay in the server's order, with each person's name isolated. */
export function Reactions({ reactions, me, mine, limits, canSend, nameOf, onReact }: {
  reactions: ChatReaction[];
  me: string;
  mine: boolean;
  limits: ReactionLimits | null;
  canSend: boolean;
  nameOf: (id: string) => string;
  onReact: (emoji: string) => void;
}) {
  const seen = useRef(new Set(reactions.map((reaction) => reaction.emoji)));
  useEffect(() => { seen.current = new Set(reactions.map((reaction) => reaction.emoji)); }, [reactions]);
  if (!limits || reactions.length === 0) return null;
  return <div className={cn("mt-1 flex flex-wrap gap-1", mine && "justify-end")}>
    {reactions.map((reaction) => {
      const yours = reaction.userIds.includes(me);
      return <Tooltip key={reaction.emoji} label={<>{reactorsParts(reaction, me, nameOf).map((part, index) => part.name ? <bdi key={index}>{part.text}</bdi> : part.text)}</>}>
        <button type="button" disabled={!canSend} aria-pressed={yours} aria-label={`${reaction.emoji} ${reaction.count}, ${reactorsLine(reaction, me, nameOf)}`} onClick={() => onReact(reaction.emoji)} className={cn(
          "inline-flex h-6 items-center gap-1 rounded-full px-2",
          yours ? "bg-primary/15 text-foreground ring-1 ring-inset ring-primary/40" : "bg-foreground/5 text-muted-foreground",
          canSend && !yours && "hover:bg-foreground/10",
          !seen.current.has(reaction.emoji) && "animate-pop-in [animation-duration:150ms] motion-reduce:animate-none",
        )}>
          <span className="text-[16px] leading-none">{reaction.emoji}</span>
          <span className="text-caption tabular-nums">{reaction.count}</span>
        </button>
      </Tooltip>;
    })}
  </div>;
}
