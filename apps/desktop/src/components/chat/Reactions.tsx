import { useEffect, useRef } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { ReactionLimits } from "@/lib/chat/attachments";
import { reactorsLine, reactorsParts } from "@/lib/chat/reactions";
import type { ChatReaction } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

/** Up to this many people are shown as faces; more become a count. */
const FACES = 3;

/**
 * Reactions stay in the server's order, with each person's name isolated. Like the rest
 * of the chrome they are neutral: yours is the brighter fill and a hairline, not a colour.
 */
export function Reactions({ reactions, me, align, limits, canSend, nameOf, onReact }: {
  reactions: ChatReaction[];
  me: string;
  align: "start" | "end";
  limits: ReactionLimits | null;
  canSend: boolean;
  nameOf: (id: string) => string;
  onReact: (emoji: string) => void;
}) {
  // Only a reaction that appears while the message is on screen animates in.
  const seen = useRef(new Set(reactions.map((reaction) => reaction.emoji)));
  useEffect(() => { seen.current = new Set(reactions.map((reaction) => reaction.emoji)); }, [reactions]);
  if (!limits || reactions.length === 0) return null;
  return <div className={cn("flex flex-wrap gap-1", align === "end" && "justify-end")}>
    {reactions.map((reaction) => {
      const yours = reaction.userIds.includes(me);
      return <Tooltip key={reaction.emoji} label={<>{reactorsParts(reaction, me, nameOf).map((part, index) => part.name ? <bdi key={index}>{part.text}</bdi> : part.text)}</>}>
        <button
          type="button"
          disabled={!canSend}
          aria-pressed={yours}
          aria-label={`${reaction.emoji} ${reaction.count}, ${reactorsLine(reaction, me, nameOf)}`}
          onClick={() => onReact(reaction.emoji)}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-full pl-1.5 pr-2 transition-[background-color,color,transform] duration-150 disabled:cursor-default",
            yours ? "bg-foreground/[0.16] text-foreground ring-1 ring-inset ring-foreground/25" : "bg-foreground/[0.07] text-muted-foreground",
            canSend && "active:scale-95",
            canSend && !yours && "hover:bg-foreground/[0.12] hover:text-foreground",
            !seen.current.has(reaction.emoji) && "animate-pop-in motion-reduce:animate-none",
          )}
        >
          <span className="text-[18px] leading-none">{reaction.emoji}</span>
          {reaction.count <= FACES ? (
            // A few people read better as faces than as a number.
            <span className="flex -space-x-1.5" aria-hidden>
              {reaction.userIds.map((id) => (
                <Avatar key={id} name={nameOf(id).split(/\s+/)[0]} src={api.userAvatarUrl(id)} className="h-5 w-5 ring-1 ring-background/60" />
              ))}
            </span>
          ) : (
            <span className="text-caption font-medium tabular-nums">{reaction.count}</span>
          )}
        </button>
      </Tooltip>;
    })}
  </div>;
}
