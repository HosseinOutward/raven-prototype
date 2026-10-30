import { memo, useState } from "react";
import { AlertCircle, Check, CheckCheck, Clock, ChevronDown, Copy, CornerUpLeft, Download, EyeOff, MoreHorizontal, Pencil, SmilePlus, Trash2 } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { canShow, messageExcerpt, onlyPictures } from "@/lib/chat/attachments";
import type { ReactionLimits } from "@/lib/chat/attachments";
import { QUICK_REACTIONS } from "@/lib/chat/reactions";
import { failureText } from "@/lib/chat/errors";
import { saveAttachment } from "@/lib/chat/imageActions";
import { excerptOf, summarize } from "@/lib/chat/reducer";
import { emojiOnlyCount } from "@/lib/chat/format";
import { systemLine } from "@/lib/chat/text";
import { clockTime, fullTime } from "@/lib/chat/time";
import type { ChatAttachment, ChatMessage, ChatReplyRef, PendingMessage } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import { MessageAttachments, PendingAttachments } from "./Attachments";
import { EmojiPicker } from "./EmojiPicker";
import { Reactions } from "./Reactions";
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
  const text = reply.unavailable ? "Original message isn’t available" : reply.deleted ? "Message deleted" : messageExcerpt(reply.excerpt, reply.attachments);
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
  reactionLimits?: ReactionLimits | null;
  nameOf?: (id: string) => string;
  onReact?: (emoji: string) => Promise<void>;
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
  /** Opens the viewer on one of the message's images. */
  onOpenImage: (message: ChatMessage, attachment: ChatAttachment) => void;
}

/** The time, and for my own messages whether it has been read. */
function MessageMeta({ message, mine, deleted, status, overImage, alignStart }: { message: ChatMessage; mine: boolean; deleted: boolean; status?: DeliveryStatus; overImage?: boolean; alignStart?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-1 text-caption",
        alignStart && "justify-start",
        // Over a picture the colours behind are anyone's guess, so it gets a scrim.
        overImage ? "pointer-events-none absolute bottom-1.5 right-1.5 rounded-chip bg-black/55 px-1.5 py-0.5 text-white backdrop-blur-md" : "mt-0.5 text-subtle",
      )}
    >
      {message.editedAt && !deleted ? <span title={`Edited ${fullTime(message.editedAt)}`}>edited</span> : null}
      <time dateTime={message.createdAt} title={fullTime(message.createdAt)} className="tabular-nums">{clockTime(message.createdAt)}</time>
      {mine && !deleted ? (
        status === "read" ? (
          <CheckCheck className={cn("h-3.5 w-3.5", !overImage && "text-muted-foreground")} aria-label="Read" />
        ) : (
          <Check className="h-3.5 w-3.5" aria-label="Sent" />
        )
      ) : null}
    </div>
  );
}

/** One message in a conversation. */
export const MessageRow = memo(function MessageRow(props: MessageRowProps) {
  const { message, mine, showSender, continuation, status, parent } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [reactionOpen, setReactionOpen] = useState(false);
  const [fullPicker, setFullPicker] = useState(false);

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
    ? { id: parent.id, seq: parent.seq, senderId: parent.senderId, senderName: parent.senderName, deleted: Boolean(parent.deletedAt), excerpt: parent.deletedAt ? undefined : excerptOf(parent.body), attachments: parent.deletedAt ? undefined : summarize(parent.attachments) }
    : message.replyTo;
  const attachments = !deleted ? message.attachments ?? [] : [];
  const hasText = message.body.trim() !== "";
  // Pictures with nothing to say about them stand on their own, without a bubble.
  const bareEmoji = !deleted && attachments.length === 0 && !reply && emojiOnlyCount(message.body) > 0;
  const bare = bareEmoji || (attachments.length > 0 && !hasText && !reply && onlyPictures(attachments));
  const shown = attachments.filter(canShow);
  const savable = shown.length === 1 && shown[0].kind === "image" ? shown[0] : null;

  const save = () => {
    if (!savable) return;
    void saveAttachment(message.conversationId, savable).then(
      (saved) => {
        if (saved) toast({ title: "Image saved" });
      },
      () => toast({ title: "Couldn’t save the image", description: "Try again in a moment.", tone: "error" }),
    );
  };

  const copy = () => {
    void navigator.clipboard.writeText(message.body).then(
      () => toast({ title: "Copied" }),
      () => toast({ title: "Couldn’t copy", description: "Select the text and copy it instead.", tone: "error" }),
    );
  };

  const canReact = Boolean(props.reactionLimits && props.canReply && !deleted && props.onReact);
  const react = (emoji: string) => {
    setReactionOpen(false);
    setMenuOpen(false);
    void props.onReact?.(emoji).catch((failure: unknown) => toast({ title: failureText(failure, "Couldn’t react to that."), tone: "error" }));
  };
  const yours = (emoji: string) => message.reactions?.some((reaction) => reaction.emoji === emoji && reaction.userIds.includes(props.me));
  const chips = !deleted && props.reactionLimits && message.reactions?.length ? <Reactions
    reactions={message.reactions} me={props.me} mine={mine} limits={props.reactionLimits}
    canSend={props.canReply} nameOf={props.nameOf ?? (() => "Someone")} onReact={react}
  /> : null;

  const actions = (
    <div className={cn("flex shrink-0 items-center self-center", menuOpen || reactionOpen ? "opacity-100" : "pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100")}>
      {canReact ? <Popover open={reactionOpen} onOpenChange={(open) => { setReactionOpen(open); if (open) setFullPicker(false); }}>
        <Tooltip label="React"><PopoverTrigger asChild>
          <button type="button" aria-label="React" className="flex h-7 w-7 items-center justify-center rounded-control text-subtle transition-colors hover:bg-secondary hover:text-foreground"><SmilePlus className="h-4 w-4" /></button>
        </PopoverTrigger></Tooltip>
        <PopoverContent side="top" align={mine ? "end" : "start"} className="w-auto p-0">
          {fullPicker ? <EmojiPicker autoFocus onPick={react} /> : <div className="flex p-1" onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault();
            const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
            buttons[(index + step + buttons.length) % buttons.length]?.focus();
          }}>
            {QUICK_REACTIONS.map((emoji) => <button key={emoji} type="button" aria-label={`React with ${emoji}`} aria-pressed={Boolean(yours(emoji))} onClick={() => react(emoji)} className={cn("flex h-9 w-9 items-center justify-center rounded-control text-[22px] leading-none hover:bg-secondary", yours(emoji) && "bg-primary/15 text-foreground ring-1 ring-inset ring-primary/40")}>{emoji}</button>)}
            <button type="button" aria-label="More emoji" onClick={() => setFullPicker(true)} className="flex h-9 w-9 items-center justify-center rounded-control text-muted-foreground hover:bg-secondary"><ChevronDown className="h-4 w-4" /></button>
          </div>}
        </PopoverContent>
      </Popover> : null}
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
          {canReact ? <>
            <div className="flex" onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              event.stopPropagation();
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
              const index = items.indexOf(document.activeElement as HTMLElement);
              items[(index + (event.key === "ArrowLeft" ? -1 : 1) + items.length) % items.length]?.focus();
            }}>
              {QUICK_REACTIONS.map((emoji) => <DropdownMenuItem key={emoji} aria-label={`React with ${emoji}`} onSelect={() => react(emoji)} className={cn("h-8 w-8 justify-center p-0 text-[22px] leading-none", yours(emoji) && "bg-primary/15 text-foreground ring-1 ring-inset ring-primary/40")}>{emoji}</DropdownMenuItem>)}
            </div>
            <DropdownMenuSeparator />
          </> : null}
          {props.canReply && !deleted ? (
            <DropdownMenuItem onSelect={() => props.onReply(message)}>
              <CornerUpLeft className="text-muted-foreground" />
              Reply
            </DropdownMenuItem>
          ) : null}
          {!deleted && savable ? (
            <DropdownMenuItem onSelect={save}>
              <Download className="text-muted-foreground" />
              Save image…
            </DropdownMenuItem>
          ) : null}
          {!deleted && hasText ? (
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
        {bare ? (
          <div className={cn("min-w-0 max-w-[min(100%,34rem)] rounded-control transition-colors", props.highlighted && "outline outline-2 outline-ring")}>
            {showSender && !mine ? <div className="truncate pb-0.5 text-caption font-medium text-muted-foreground"><bdi>{message.senderName}</bdi></div> : null}
            {bareEmoji ? <>
              <MessageText body={message.body} />
              {chips}
              <MessageMeta message={message} mine={mine} deleted={deleted} status={status} alignStart={!mine} />
            </> : <MessageAttachments
              conversationId={message.conversationId}
              attachments={attachments}
              senderName={mine ? "you" : message.senderName}
              onOpen={(attachment) => props.onOpenImage(message, attachment)}
              footer={<MessageMeta message={message} mine={mine} deleted={deleted} status={status} overImage />}
            />}
            {!bareEmoji ? chips : null}
          </div>
        ) : (
          <div
            className={cn(
              "min-w-0 max-w-[min(100%,34rem)] rounded-card px-3 py-1.5 transition-colors",
              mine ? "bg-accent" : "bg-secondary",
              props.highlighted && "outline outline-2 outline-ring",
            )}
          >
            {showSender && !mine ? <div className="truncate text-caption font-medium text-muted-foreground"><bdi>{message.senderName}</bdi></div> : null}
            {reply && !deleted ? <ReplyQuote reply={reply} onOpen={reply.seq ? () => props.onOpenReply(reply.seq!) : undefined} /> : null}
            {attachments.length > 0 ? (
              <div className="-mx-1.5 mb-1 mt-0.5">
                <MessageAttachments
                  conversationId={message.conversationId}
                  attachments={attachments}
                  senderName={mine ? "you" : message.senderName}
                  onOpen={(attachment) => props.onOpenImage(message, attachment)}
                />
              </div>
            ) : null}
            {deleted ? (
              <p className="text-body italic text-subtle">Message deleted</p>
            ) : hasText ? (
              <MessageText body={message.body} />
            ) : null}
            {chips}
            <MessageMeta message={message} mine={mine} deleted={deleted} status={status} />
          </div>
        )}
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
  const attachments = pending.attachments ?? [];
  const hasText = pending.body.trim() !== "";
  const bareEmoji = attachments.length === 0 && !pending.replyTo && emojiOnlyCount(pending.body) > 0;
  const bare = bareEmoji || (attachments.length > 0 && !hasText && !pending.replyTo);
  const meta = (overImage: boolean) => (
    <div
      className={cn(
        "flex items-center justify-end gap-1 text-caption",
        overImage ? "pointer-events-none absolute bottom-1.5 right-1.5 rounded-chip bg-black/55 px-1.5 py-0.5 text-white backdrop-blur-md" : "mt-0.5 text-subtle",
      )}
    >
      {failed ? (
        <AlertCircle className={cn("h-3.5 w-3.5", !overImage && "text-destructive")} aria-label="Not sent" />
      ) : (
        <>
          <span>Sending…</span>
          <Clock className="h-3.5 w-3.5" aria-hidden />
        </>
      )}
    </div>
  );
  return (
    <div className="flex flex-col items-end pt-2.5">
      {bare ? (
        <div className="min-w-0 max-w-[min(100%,34rem)]">
          {bareEmoji ? <><MessageText body={pending.body} />{meta(false)}</> : <PendingAttachments attachments={attachments} footer={meta(true)} />}
        </div>
      ) : (
        <div className="min-w-0 max-w-[min(100%,34rem)] rounded-card bg-accent px-3 py-1.5">
          {pending.replyTo ? <ReplyQuote reply={pending.replyTo} /> : null}
          {attachments.length > 0 ? (
            <div className="-mx-1.5 mb-1 mt-0.5">
              <PendingAttachments attachments={attachments} />
            </div>
          ) : null}
          {hasText ? <MessageText body={pending.body} /> : null}
          {meta(false)}
        </div>
      )}
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
