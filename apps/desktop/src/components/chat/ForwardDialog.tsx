import { useMemo, useState } from "react";
import { Bookmark, Check, Users } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { failureText } from "@/lib/chat/errors";
import { forwardSections, sourceWouldShow, type ForwardDestination } from "@/lib/chat/forward";
import type { ChatStore } from "@/lib/chat/store";
import type { ChatKind, ChatMessage } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import { NestGlyph } from "@/shells/ravenv1/atoms";
import { useChatState } from "@/shells/ravenv1/useChat";

function DestinationIcon({ destination }: { destination: ForwardDestination }) {
  if (destination.kind === "saved") return <Bookmark className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />;
  if (destination.kind === "group") return <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />;
  if (destination.kind === "nest") return <NestGlyph kind="text" className="text-muted-foreground" />;
  return <Avatar name={destination.name} src={destination.peerId ? api.userAvatarUrl(destination.peerId) : undefined} className="h-6 w-6" />;
}

/** Picks one place to forward messages to, with an optional note and what to hide. */
export function ForwardDialog({
  chat,
  trees,
  messageIds,
  messages,
  from,
  onClose,
  onForwarded,
}: {
  chat: ChatStore;
  trees: Array<{ id: string; name: string }>;
  messageIds: string[];
  /** The same messages, where they are still loaded. */
  messages: Array<ChatMessage | undefined>;
  /** The kind of conversation they are in. */
  from: ChatKind;
  onClose: () => void;
  onForwarded: (conversationId: string, seq: number | undefined) => void;
}) {
  const state = useChatState(chat);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ForwardDestination | null>(null);
  const [note, setNote] = useState("");
  const [hideSender, setHideSender] = useState(false);
  const [hideSource, setHideSource] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const conversations = useMemo(() => Object.values(state?.conversations ?? {}), [state?.conversations]);
  const sections = useMemo(() => forwardSections(conversations, trees, query), [conversations, trees, query]);
  const sourceShows = useMemo(() => sourceWouldShow(messages, from), [messages, from]);
  const count = messageIds.length;

  const send = () => {
    if (!picked || working) return;
    setWorking(true);
    setError("");
    void chat
      .forward({ messageIds, to: picked.id || null, note: note.trim(), hideSender, hideSource: hideSource && sourceShows })
      .then(({ conversationId, messages: sent }) => onForwarded(conversationId, sent[0]?.seq))
      .catch((failure) => {
        setError(failureText(failure, "Couldn’t forward that."));
        setWorking(false);
      });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title="Forward" widthClassName="max-w-md">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <Input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Find a chat" aria-label="Find a chat" />
        <div className="max-h-64 space-y-2 overflow-y-auto" role="listbox" aria-label="Forward to">
          {sections.map((section) => (
            <div key={section.key} role="group" aria-label={section.title || undefined} className="space-y-px">
              {section.title ? <p className="truncate px-2 pb-0.5 pt-1 text-caption text-muted-foreground"><bdi>{section.title}</bdi></p> : null}
              {section.destinations.map((destination) => {
                const selected = picked?.id === destination.id && picked.kind === destination.kind;
                return (
                  <button
                    key={`${destination.kind}:${destination.id}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => setPicked(destination)}
                    className={cn("flex h-9 w-full items-center gap-2.5 rounded-control px-2 text-start transition-colors", selected ? "bg-secondary" : "hover:bg-secondary/60")}
                  >
                    <DestinationIcon destination={destination} />
                    <span className="min-w-0 flex-1 truncate text-body"><bdi>{destination.name}</bdi></span>
                    {selected ? <Check className="h-4 w-4 shrink-0" aria-hidden /> : null}
                  </button>
                );
              })}
            </div>
          ))}
          {sections.length === 0 ? <p className="px-2 py-3 text-small text-muted-foreground">Nothing by that name.</p> : null}
        </div>
        <Input value={note} onChange={(event) => setNote(event.currentTarget.value)} placeholder="Add a note" aria-label="Add a note" />
        <div className="space-y-2">
          <label className="flex items-center justify-between gap-3 text-small">
            Hide sender
            <Switch checked={hideSender} onCheckedChange={setHideSender} />
          </label>
          <label className={cn("flex items-center justify-between gap-3 text-small", !sourceShows && "text-subtle")}>
            Hide source
            <Switch checked={hideSource && sourceShows} disabled={!sourceShows} onCheckedChange={setHideSource} />
          </label>
        </div>
        {error ? <p className="text-small text-destructive" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!picked || working}>{working ? "Forwarding…" : `Forward ${count}`}</Button>
        </div>
      </form>
    </Dialog>
  );
}
