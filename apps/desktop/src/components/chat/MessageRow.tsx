import { memo, useState } from "react";
import { AlertCircle, Check, CheckCheck, Clock, Copy, CornerUpLeft, EyeOff, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { excerptOf } from "@/lib/chat/reducer";
import { systemLine } from "@/lib/chat/text";
import { clockTime, fullTime } from "@/lib/chat/time";
import type { ChatMessage, ChatReplyRef, PendingMessage } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import { MessageText } from "./MessageText";

/** What stands above a message without being part of it. */
function Decorations({ dayHeading, newDivider }: { dayHeading?: string; newDivider?: boolean }) {
  return (
    <>
      {dayHeading ? (
        <div className="flex justify-center pb-2 pt-4">
          <span className="rounded-full bg-secondary px-2.5 py-0.5 text-caption text-muted-foreground">{dayHeading}</span>
        </div>
      ) : null}
      {newDivider ? (
        <div className="flex items-center gap-3 pb-2 pt-3" role="separator" aria-label="New messages">
          <span className="h-px flex-1 bg-border" />
          <span className="text-caption font-medium text-muted-foreground">New messages</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      ) : null}
    </>
  );
}

/** The quoted line above a reply. Clicking it goes to the original when there is one to go to. */
function ReplyQuote({ reply, onOpen }: { reply: ChatReplyRef; onOpen?: () => void }) {
  const text = reply.unavailable ? "Original message isn’t available" : reply.deleted ? "Message deleted" : reply.excerpt;
  const content = (
    <>
      {reply.senderName && !reply.unavailable ? <span className="block truncate text-caption font-medium"><bdi>{reply.senderName}</bdi></span> : null}
      <span dir="auto" className={cn("block truncate text-caption", reply.unavailable || reply.deleted ? "italic text-subtle" : "text-muted-foreground")}>{text}</span>
    </>
  );
  const className = "mb-1 block w-full min-w-0 border-s-2 border-subtle ps-2 text-start";
  if (!onOpen || reply.unavailable || !reply.seq) return <div className={className}>{content}</div>;
  return (
    <button type="button" onClick={onOpen} aria-label="Go to the original message" className={cn(className, "rounded-e-chip transition-colors hover:bg-foreground/5")}>
      {content}
    </button>
  );
}

export type DeliveryStatus = "sent" | "read";

export interface MessageRowProps {
  message: ChatMessage;
  mine: boolean;
  me: string;
  /** Leave room for avatars: true where more than two people talk. */
  withAvatars: boolean;
  /** Show who wrote it: on the first message of a run, where there are avatars. */
  showSender: boolean;
  continuation: boolean;
  status?: DeliveryStatus;
  /** The current copy of the message this replies to, when it is loaded. */
  parent?: ChatMessage;
  canReply: boolean;
  canEdit: boolean;
  canDeleteForEveryone: boolean;
  dayHeading?: string;
  newDivider?: boolean;
  highlighted?: boolean;
  onReply: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage) => void;
  onRemoveForMe: (message: ChatMessage) => void;
  onDeleteForEveryone: (message: ChatMessage) => void;
  onOpenReply: (seq: number) => void;
}

/** One message in a conversation. */
export const MessageRow = memo(function MessageRow(props: MessageRowProps) {
  const { message, mine, showSender, continuation, status, parent } = props;
  const [menuOpen, setMenuOpen] = useState(false);

  if (message.kind === "system") {
    return (
      <div>
        <Decorations dayHeading={props.dayHeading} newDivider={props.newDivider} />
        <p className="py-1.5 text-center text-caption text-muted-foreground"><bdi>{systemLine(message.system, message.senderId, message.senderName, props.me)}</bdi></p>
      </div>
    );
  }

  const deleted = Boolean(message.deletedAt);
  // A reply shows the original as it is now when that is on screen, and otherwise as it
  // was when this message was fetched.
  const reply: ChatReplyRef | undefined = message.replyTo && parent
    ? { id: parent.id, seq: parent.seq, senderId: parent.senderId, senderName: parent.senderName, deleted: Boolean(parent.deletedAt), excerpt: parent.deletedAt ? undefined : excerptOf(parent.body) }
    : message.replyTo;

  const copy = () => {
    void navigator.clipboard.writeText(message.body).then(
      () => toast({ title: "Copied" }),
      () => toast({ title: "Couldn’t copy", description: "Select the text and copy it instead.", tone: "error" }),
    );
  };

  const actions = (
    <div className={cn("flex shrink-0 items-center self-center", menuOpen ? "visible" : "invisible group-focus-within:visible group-hover:visible")}>
      {props.canReply && !deleted ? (
        <Tooltip label="Reply">
          <button type="button" aria-label="Reply" onClick={() => props.onReply(message)} className="flex h-7 w-7 items-center justify-center rounded-control text-subtle transition-colors hover:bg-secondary hover:text-foreground">
            <CornerUpLeft className="h-4 w-4" />
          </button>
        </Tooltip>
      ) : null}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="More for this message" className="flex h-7 w-7 items-center justify-center rounded-control text-subtle transition-colors hover:bg-secondary hover:text-foreground">
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={mine ? "end" : "start"}>
          {props.canReply && !deleted ? (
            <DropdownMenuItem onSelect={() => props.onReply(message)}>
              <CornerUpLeft className="text-muted-foreground" />
              Reply
            </DropdownMenuItem>
          ) : null}
          {!deleted ? (
            <DropdownMenuItem onSelect={copy}>
              <Copy className="text-muted-foreground" />
              Copy text
            </DropdownMenuItem>
          ) : null}
          {props.canEdit && !deleted ? (
            <DropdownMenuItem onSelect={() => props.onEdit(message)}>
              <Pencil className="text-muted-foreground" />
              Edit
            </DropdownMenuItem>
          ) : null}
          {!deleted ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={() => props.onRemoveForMe(message)}>
            <EyeOff className="text-muted-foreground" />
            Remove for me
          </DropdownMenuItem>
          {props.canDeleteForEveryone && !deleted ? (
            <DropdownMenuItem destructive onSelect={() => props.onDeleteForEveryone(message)}>
              <Trash2 />
              Delete for everyone
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <div>
      <Decorations dayHeading={props.dayHeading} newDivider={props.newDivider} />
      <div
        className={cn("group flex items-end gap-2", continuation ? "pt-0.5" : "pt-2.5", mine && "flex-row-reverse")}
        onContextMenu={(event) => {
          // Right-click opens the same menu as the button, unless text is being selected.
          if (window.getSelection()?.toString()) return;
          event.preventDefault();
          setMenuOpen(true);
        }}
      >
        {!mine && props.withAvatars ? (
          <span className="w-7 shrink-0 self-start">
            {showSender ? <Avatar name={message.senderName} src={api.userAvatarUrl(message.senderId)} className="h-7 w-7" /> : null}
          </span>
        ) : null}
        <div
          className={cn(
            "min-w-0 max-w-[min(100%,34rem)] rounded-card px-3 py-1.5 transition-colors",
            mine ? "bg-accent" : "bg-secondary",
            props.highlighted && "outline outline-2 outline-ring",
          )}
        >
          {showSender && !mine ? <div className="truncate text-caption font-medium text-muted-foreground"><bdi>{message.senderName}</bdi></div> : null}
          {reply && !deleted ? <ReplyQuote reply={reply} onOpen={reply.seq ? () => props.onOpenReply(reply.seq!) : undefined} /> : null}
          {deleted ? (
            <p className="text-body italic text-subtle">Message deleted</p>
          ) : (
            <MessageText body={message.body} />
          )}
          <div className="mt-0.5 flex items-center justify-end gap-1 text-caption text-subtle">
            {message.editedAt && !deleted ? <span title={`Edited ${fullTime(message.editedAt)}`}>edited</span> : null}
            <time dateTime={message.createdAt} title={fullTime(message.createdAt)} className="tabular-nums">{clockTime(message.createdAt)}</time>
            {mine && !deleted ? (
              status === "read" ? (
                <CheckCheck className="h-3.5 w-3.5 text-muted-foreground" aria-label="Read" />
              ) : (
                <Check className="h-3.5 w-3.5" aria-label="Sent" />
              )
            ) : null}
          </div>
        </div>
        {actions}
      </div>
    </div>
  );
});

/** A message that has been written but not yet acknowledged by the server. */
export const PendingRow = memo(function PendingRow({
  pending,
  onRetry,
  onDiscard,
}: {
  pending: PendingMessage;
  onRetry: (pending: PendingMessage) => void;
  onDiscard: (pending: PendingMessage) => void;
}) {
  const failed = pending.state === "failed";
  return (
    <div className="flex flex-col items-end pt-2.5">
      <div className="min-w-0 max-w-[min(100%,34rem)] rounded-card bg-accent px-3 py-1.5">
        {pending.replyTo ? <ReplyQuote reply={pending.replyTo} /> : null}
        <MessageText body={pending.body} />
        <div className="mt-0.5 flex items-center justify-end gap-1 text-caption text-subtle">
          {failed ? (
            <AlertCircle className="h-3.5 w-3.5 text-destructive" aria-hidden />
          ) : (
            <>
              <span>Sending…</span>
              <Clock className="h-3.5 w-3.5" aria-hidden />
            </>
          )}
        </div>
      </div>
      {failed ? (
        <div className="mt-1 flex max-w-[34rem] flex-wrap items-center justify-end gap-x-2 gap-y-1 text-caption" role="alert">
          <span className="text-destructive">Not sent. {pending.error && pending.error !== "Not sent." ? pending.error : "Nobody has seen this."}</span>
          <button type="button" onClick={() => onRetry(pending)} className="rounded-chip px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-secondary">Send again</button>
          <button type="button" onClick={() => onDiscard(pending)} className="rounded-chip px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">Discard</button>
        </div>
      ) : null}
    </div>
  );
});
