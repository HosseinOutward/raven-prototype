import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { NewMessageDialog } from "@/components/chat/ChatDialogs";
import { ConversationRowCompact } from "@/components/chat/ConversationRow";
import { Tooltip } from "@/components/ui/tooltip";
import { orderTextNests } from "@/lib/chat/layout";
import { listedConversations, textNestsOfTree } from "@/lib/chat/reducer";
import type { ChatStore } from "@/lib/chat/store";
import { cn } from "@/lib/utils";
import { SectionLabel } from "./atoms";
import type { RavenShellData, RavenView } from "./state";
import { useChatState } from "./useChat";

/** How many conversations the sidebar lists before it leaves the rest to "All messages". */
const SHOWN = 6;

/**
 * Recent direct messages and groups. The sidebar shows the few that were active last;
 * the rest, and the archive, are one click away.
 */
export function SidebarMessages({
  chat,
  data,
  view,
  onNavigate,
}: {
  chat: ChatStore;
  data: RavenShellData;
  view: RavenView;
  onNavigate: (view: RavenView) => void;
}) {
  const state = useChatState(chat);
  const [newMessageOpen, setNewMessageOpen] = useState(false);
  const conversations = useMemo(() => (state ? listedConversations(state) : []), [state]);
  const friends = useMemo(() => data.friends.map((friend) => ({ id: friend.userId, name: friend.displayName || friend.username })), [data.friends]);
  const open = (id: string) => onNavigate({ kind: "chat", id });
  const activeId = view.kind === "chat" ? view.id : "";

  // The open conversation stays visible even when it is not among the most recent.
  const shown = useMemo(() => {
    const top = conversations.slice(0, SHOWN);
    const active = conversations.find((conversation) => conversation.summary.id === activeId);
    return active && !top.includes(active) ? [...top.slice(0, SHOWN - 1), active] : top;
  }, [conversations, activeId]);

  return (
    <section>
      <SectionLabel
        className="px-2"
        action={
          <Tooltip label="New message" side="right">
            <button
              type="button"
              aria-label="New message"
              onClick={() => setNewMessageOpen(true)}
              className="flex h-6 w-6 items-center justify-center rounded-chip text-subtle transition-colors hover:bg-secondary hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        }
      >
        Messages
      </SectionLabel>
      {shown.length ? (
        <div className="space-y-px">
          {shown.map((conversation) => (
            <ConversationRowCompact key={conversation.summary.id} conversation={conversation.summary} active={conversation.summary.id === activeId} onOpen={open} />
          ))}
          <button
            type="button"
            onClick={() => onNavigate({ kind: "messages" })}
            aria-current={view.kind === "messages" ? "page" : undefined}
            className={cn(
              "flex h-8 w-full items-center rounded-control px-2 text-left text-caption font-medium transition-colors",
              view.kind === "messages" ? "bg-secondary text-foreground" : "text-subtle hover:bg-secondary/60 hover:text-foreground",
            )}
          >
            All messages
          </button>
        </div>
      ) : (
        <p className="px-2 py-1 text-small text-muted-foreground">Write to a friend, or start a group.</p>
      )}
      <NewMessageDialog
        open={newMessageOpen}
        onOpenChange={setNewMessageOpen}
        friends={friends}
        onPick={async (userId) => {
          const conversation = await chat.openDM(userId);
          setNewMessageOpen(false);
          open(conversation.id);
        }}
      />
    </section>
  );
}

/** A tree's text nests, in the order its owners arranged them. */
export function TreeTextNests({
  chat,
  treeId,
  view,
  onNavigate,
}: {
  chat: ChatStore;
  treeId: string;
  view: RavenView;
  onNavigate: (view: RavenView) => void;
}) {
  const state = useChatState(chat);
  const layout = state?.layouts[treeId];
  const hasLayout = Boolean(layout);

  // The order lives with the tree's layout, fetched the first time it is needed.
  useEffect(() => {
    if (!hasLayout) void chat.loadLayout(treeId).catch(() => undefined);
  }, [chat, treeId, hasLayout]);

  const nests = useMemo(() => (state ? orderTextNests(textNestsOfTree(state, treeId), layout) : []), [state, treeId, layout]);
  const activeId = view.kind === "chat" ? view.id : "";
  return (
    <>
      {nests.map((conversation) => (
        <ConversationRowCompact
          key={conversation.summary.id}
          conversation={conversation.summary}
          active={conversation.summary.id === activeId}
          nested
          onOpen={(id) => onNavigate({ kind: "chat", id })}
        />
      ))}
    </>
  );
}
