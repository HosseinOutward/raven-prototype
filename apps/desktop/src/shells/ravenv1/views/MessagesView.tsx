import { useMemo, useState } from "react";
import { capabilitiesOf } from "@/lib/permissions";
import { ChevronDown, ChevronRight, MessageSquarePlus, Users } from "lucide-react";
import { NewGroupDialog, NewMessageDialog } from "@/components/chat/ChatDialogs";
import { ConversationRow } from "@/components/chat/ConversationRow";
import { Button } from "@/components/ui/button";
import { listedConversations } from "@/lib/chat/reducer";
import type { ChatStore } from "@/lib/chat/store";
import { EmptyState, GroupedList } from "../atoms";
import type { RavenShellData, RavenView } from "../state";
import { useChatState } from "../useChat";
import { ViewBody, ViewHeader } from "./shared";

/** Every direct message and group, most recent first, with the archive below. */
export function MessagesView({
  chat,
  data,
  onNavigate,
}: {
  chat: ChatStore | null;
  data: RavenShellData;
  onNavigate: (view: RavenView) => void;
}) {
  const state = useChatState(chat);
  const [newMessageOpen, setNewMessageOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const me = data.user?.id ?? "";

  const current = useMemo(() => (state ? listedConversations(state) : []), [state]);
  const archived = useMemo(() => (state ? listedConversations(state, true) : []), [state]);
  const friends = useMemo(() => data.friends.map((friend) => ({ id: friend.userId, name: friend.displayName || friend.username })), [data.friends]);
  const open = (id: string) => onNavigate({ kind: "chat", id });

  if (!chat || !state) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState title="Messages aren’t available here" text="The server you are connected to does not have text chat." />
      </div>
    );
  }

  return (
    <>
      <ViewHeader
        title="Messages"
        actions={
          <>
            {capabilitiesOf(data.user).createGroups ? (
              <Button size="sm" variant="secondary" onClick={() => setNewGroupOpen(true)}>
                <Users className="h-4 w-4" />
                New group
              </Button>
            ) : null}
            <Button size="sm" onClick={() => setNewMessageOpen(true)}>
              <MessageSquarePlus className="h-4 w-4" />
              New message
            </Button>
          </>
        }
      />
      <ViewBody>
        <div className="mx-auto max-w-3xl space-y-6">
          {current.length ? (
            <GroupedList>
              {current.map((conversation) => (
                <ConversationRow key={conversation.summary.id} conversation={conversation.summary} me={me} onOpen={open} />
              ))}
            </GroupedList>
          ) : state.listLoaded ? (
            <EmptyState title="No conversations yet" text="Write to a friend, or bring a few together in a group. Only the people in a conversation can read it.">
              <Button onClick={() => setNewMessageOpen(true)}>
                <MessageSquarePlus className="h-4 w-4" />
                New message
              </Button>
            </EmptyState>
          ) : (
            <p className="py-10 text-center text-small text-muted-foreground" role="status">Loading…</p>
          )}

          {archived.length ? (
            <section>
              <button
                type="button"
                aria-expanded={showArchived}
                onClick={() => setShowArchived(!showArchived)}
                className="flex h-7 items-center gap-1 rounded-control px-1 text-caption font-medium text-subtle transition-colors hover:text-foreground"
              >
                {showArchived ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                Archived · {archived.length}
              </button>
              {showArchived ? (
                <GroupedList className="mt-1">
                  {archived.map((conversation) => (
                    <ConversationRow key={conversation.summary.id} conversation={conversation.summary} me={me} onOpen={open} />
                  ))}
                </GroupedList>
              ) : null}
            </section>
          ) : null}
        </div>
      </ViewBody>

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
      <NewGroupDialog
        open={newGroupOpen}
        onOpenChange={setNewGroupOpen}
        friends={friends}
        onCreate={async (name, memberIds) => {
          const conversation = await chat.createGroup(name, memberIds);
          setNewGroupOpen(false);
          open(conversation.id);
        }}
      />
    </>
  );
}
