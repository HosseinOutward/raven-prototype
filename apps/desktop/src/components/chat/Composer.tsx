import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type KeyboardEvent } from "react";
import { ArrowUp, CornerUpLeft, ImagePlus, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldClassName } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { messageExcerpt, type AttachmentLimits } from "@/lib/chat/attachments";
import { addToTray, chatTray } from "@/lib/chat/composerTray";
import { excerptOf, summarize } from "@/lib/chat/reducer";
import { trayReady, type TraySource } from "@/lib/chat/tray";
import type { ChatMessage, PreparedAttachment } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import { AttachmentTray } from "./AttachmentTray";

/** The server refuses anything longer. */
const MAX_LENGTH = 4096;
const COUNT_FROM = MAX_LENGTH - 300;
const MAX_HEIGHT = 188;

/** What was being written in each conversation, kept while the app is open. */
const drafts = new Map<string, string>();

export interface ComposerProps {
  conversationId: string;
  /** For the placeholder: who or where this goes. */
  name: string;
  replyingTo: ChatMessage | null;
  editing: ChatMessage | null;
  onCancelReply: () => void;
  onCancelEdit: () => void;
  onSend: (body: string, attachments: PreparedAttachment[]) => void;
  onSaveEdit: (body: string) => Promise<void>;
  onTyping: () => void;
  /** Up arrow in an empty box: start editing the last message I sent. */
  onEditLast: () => void;
  /** What images this server takes, or null when it takes none. */
  imageLimits: AttachmentLimits | null;
}

async function filesToSources(files: File[]): Promise<TraySource[]> {
  return Promise.all(files.map(async (file): Promise<TraySource> => ({ kind: "bytes", bytes: await file.arrayBuffer(), name: file.name || "image" })));
}

/** Where a message is written. Enter sends it; Shift+Enter starts a new line. */
export function Composer({ conversationId, name, replyingTo, editing, onCancelReply, onCancelEdit, onSend, onSaveEdit, onTyping, onEditLast, imageLimits }: ComposerProps) {
  const [text, setText] = useState(() => drafts.get(conversationId) ?? "");
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const tray = useSyncExternalStore(chatTray.subscribe, () => chatTray.get(conversationId));
  // Edits change the text only, so the tray waits, hidden, until editing ends.
  const images = imageLimits && !editing ? tray : null;
  const hasImages = Boolean(images && images.items.length > 0);
  const beforeEdit = useRef("");

  // Editing borrows the box: what was being written is put aside and comes back after.
  useEffect(() => {
    if (editing) {
      beforeEdit.current = text;
      setText(editing.body);
    } else {
      setText(beforeEdit.current || (drafts.get(conversationId) ?? ""));
      beforeEdit.current = "";
    }
    field.current?.focus();
    // Runs when editing starts or stops, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  useEffect(() => {
    field.current?.focus();
  }, [conversationId, replyingTo?.id]);

  useEffect(() => {
    if (!editing) drafts.set(conversationId, text);
  }, [conversationId, text, editing]);

  // The box grows with what is written, up to a few lines, then scrolls.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    // scrollHeight leaves out the border, and the box is sized border and all.
    const wanted = element.scrollHeight + (element.offsetHeight - element.clientHeight);
    element.style.height = `${Math.min(wanted, MAX_HEIGHT)}px`;
    element.style.overflowY = wanted > MAX_HEIGHT ? "auto" : "hidden";
  }, [text]);

  const length = Array.from(text).length;
  const tooLong = length > MAX_LENGTH;
  const empty = text.trim() === "";
  const imagesReady = !images || trayReady(images);
  const blocked = (editing ? empty : empty && !hasImages) || tooLong || saving || !imagesReady;

  const submit = () => {
    if (blocked) return;
    if (editing) {
      setSaving(true);
      void onSaveEdit(text)
        .then(onCancelEdit, () => undefined)
        .finally(() => setSaving(false));
      return;
    }
    onSend(text, hasImages ? chatTray.take(conversationId) : []);
    setText("");
    drafts.delete(conversationId);
  };

  const addFiles = (files: File[]) => {
    if (!imageLimits) return;
    void filesToSources(files).then((sources) => addToTray(conversationId, sources, imageLimits));
  };

  // A pasted image goes to the tray; anything else is pasted as text, as always.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!imageLimits || editing) return;
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // While an input method is composing a character, Enter belongs to it.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape" && (editing || replyingTo)) {
      event.preventDefault();
      if (editing) onCancelEdit();
      else onCancelReply();
    } else if (event.key === "Escape" && hasImages && text === "") {
      event.preventDefault();
      chatTray.clear(conversationId);
    } else if (event.key === "ArrowUp" && text === "" && !editing) {
      event.preventDefault();
      onEditLast();
    }
  };

  const context = editing
    ? { icon: <Pencil className="h-4 w-4" />, title: "Editing message", text: excerptOf(editing.body), cancel: onCancelEdit, label: "Stop editing" }
    : replyingTo
      ? { icon: <CornerUpLeft className="h-4 w-4" />, title: `Replying to ${replyingTo.senderName}`, text: messageExcerpt(excerptOf(replyingTo.body), summarize(replyingTo.attachments)), cancel: onCancelReply, label: "Cancel reply" }
      : null;

  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-6 pb-4">
      {context ? (
        <div className="mb-1.5 flex items-center gap-2.5 rounded-control bg-secondary/60 py-1.5 pl-3 pr-1.5 text-small">
          <span className="shrink-0 text-subtle">{context.icon}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-caption font-medium"><bdi>{context.title}</bdi></div>
            <div dir="auto" className="truncate text-caption text-muted-foreground">{context.text}</div>
          </div>
          <button type="button" aria-label={context.label} onClick={context.cancel} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-subtle transition-colors hover:bg-accent hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}
      {images ? (
        <AttachmentTray
          tray={images}
          onRemove={(id) => chatTray.remove(conversationId, id)}
          onFullQualityChange={(fullQuality) => chatTray.setFullQuality(conversationId, fullQuality)}
        />
      ) : null}
      <div className="flex items-end gap-2">
        {imageLimits && !editing ? (
          <>
            <Tooltip label="Add images">
              <Button size="icon" variant="ghost" title="" aria-label="Add images" onClick={() => picker.current?.click()}>
                <ImagePlus className="h-4 w-4" />
              </Button>
            </Tooltip>
            <input
              ref={picker}
              type="file"
              accept="image/*"
              multiple
              hidden
              tabIndex={-1}
              onChange={(event) => {
                addFiles(Array.from(event.currentTarget.files ?? []));
                // The same file can be picked again after being removed.
                event.currentTarget.value = "";
                field.current?.focus();
              }}
            />
          </>
        ) : null}
        <textarea
          ref={field}
          dir="auto"
          rows={1}
          value={text}
          aria-label={hasImages ? "Caption" : `Message ${name}`}
          placeholder={hasImages ? "Add a caption" : `Message ${name}`}
          aria-invalid={tooLong}
          onChange={(event) => {
            setText(event.currentTarget.value);
            if (event.currentTarget.value.trim() && !editing) onTyping();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className={cn(fieldClassName, "raven-chat-text min-h-9 flex-1 resize-none px-3 py-2 leading-5")}
        />
        <Tooltip label={editing ? "Save" : "Send"} shortcut="Enter">
          <Button size="icon" title="" aria-label={editing ? "Save changes" : "Send message"} disabled={blocked} onClick={submit}>
            <ArrowUp className="h-4 w-4" />
          </Button>
        </Tooltip>
      </div>
      {length > COUNT_FROM ? (
        <p className={cn("mt-1 text-right text-caption tabular-nums", tooLong ? "text-destructive" : "text-subtle")} role={tooLong ? "alert" : undefined}>
          {tooLong ? `${length - MAX_LENGTH} too many. Messages can be up to ${MAX_LENGTH} characters.` : `${MAX_LENGTH - length} left`}
        </p>
      ) : null}
    </div>
  );
}
