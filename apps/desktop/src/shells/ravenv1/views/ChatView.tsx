import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, Eraser, LogOut, MoreHorizontal, Pencil, Trash2, UserRound, Users } from "lucide-react";
import { GroupPeopleDialog, RenameDialog } from "@/components/chat/ChatDialogs";
import { Composer } from "@/components/chat/Composer";
import { ConversationAvatar } from "@/components/chat/ConversationRow";
import { MessageList, type MessageListHandle } from "@/components/chat/MessageList";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { failureText } from "@/lib/chat/errors";
import { excerptOf } from "@/lib/chat/reducer";
import type { ChatStore } from "@/lib/chat/store";
import type { ChatMember, ChatMessage, ConversationState } from "@/lib/chat/types";
import { EmptyState, PersonAvatar } from "../atoms";
import { personStatus } from "../people";
import type { RavenShellData, RavenView } from "../state";
import { useChatSelector, useConversation, useWindowActive } from "../useChat";
import { ViewHeader } from "./shared";

type Confirmation =
  | { kind: "remove-message"; message: ChatMessage }
  | { kind: "delete-message"; message: ChatMessage }
  | { kind: "clear" }
  | { kind: "leave" }
  | { kind: "delete" }
  | { kind: "remove-member"; member: ChatMember };

/** One conversation: a direct message, a group, or a text nest. */
export function ChatView({
  conversationId,
  chat,
  data,
  onNavigate,
  onBack,
}: {
  conversationId: string;
  chat: ChatStore | null;
  data: RavenShellData;
  onNavigate: (view: RavenView) => void;
  onBack: () => void;
}) {
  const conversation = useConversation(chat, conversationId);
  const listLoaded = useChatSelector(chat, (state) => state.listLoaded, false);

  useEffect(() => {
    if (!chat) return;
    void chat.openConversation(conversationId);
    return () => chat.closeConversation(conversationId);
  }, [chat, conversationId]);

  if (!chat) {
    return (
      <Unavailable title="Messages aren’t available here" text="The server you are connected to does not have text chat." onNavigate={onNavigate} />
    );
  }
  if (!conversation) {
    if (!listLoaded) {
      return <div className="flex min-h-0 flex-1 items-center justify-center text-small text-muted-foreground" role="status">Loading…</div>;
    }
    return (
      <Unavailable title="This conversation isn’t available" text="It may have been deleted, or you may no longer be part of it." onNavigate={onNavigate} />
    );
  }
  return <OpenConversation key={conversationId} conversation={conversation} chat={chat} data={data} onNavigate={onNavigate} onBack={onBack} />;
}

function Unavailable({ title, text, onNavigate }: { title: string; text: string; onNavigate: (view: RavenView) => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <EmptyState title={title} text={text}>
        <Button variant="secondary" onClick={() => onNavigate({ kind: "home" })}>Go home</Button>
      </EmptyState>
    </div>
  );
}

function OpenConversation({
  conversation,
  chat,
  data,
  onNavigate,
  onBack,
}: {
  conversation: ConversationState;
  chat: ChatStore;
  data: RavenShellData;
  onNavigate: (view: RavenView) => void;
  onBack: () => void;
}) {
  const { summary } = conversation;
  const id = summary.id;
  const me = data.user?.id ?? "";
  const windowActive = useWindowActive();
  const connection = useChatSelector(chat, (state) => state.connection, "connecting");
  const sharesReadStatus = useChatSelector(chat, (state) => state.settings.shareReadStatus, true);
  const list = useRef<MessageListHandle>(null);

  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const [working, setWorking] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);

  // The list does not carry who is in a group; fetch that when the group is opened.
  const needsMembers = summary.kind === "group" && conversation.members.length === 0;
  useEffect(() => {
    if (needsMembers) chat.refreshConversation(id);
  }, [chat, id, needsMembers]);

  const peer = summary.kind === "dm" && summary.peer ? data.getPerson(summary.peer.id) : undefined;
  const tree = summary.treeId ? data.getTree(summary.treeId) : undefined;
  const friends = useMemo(() => data.friends.map((friend) => ({ id: friend.userId, name: friend.displayName || friend.username })), [data.friends]);

  // A failure is said once, off to the side. The conversation stays as it was.
  const report = useCallback((fallback: string) => (failure: unknown) => {
    toast({ title: failureText(failure, fallback), tone: "error" });
  }, []);

  const startReply = useCallback((message: ChatMessage) => {
    setEditing(null);
    setReplyingTo(message);
  }, []);
  const startEdit = useCallback((message: ChatMessage) => {
    setReplyingTo(null);
    setEditing(message);
  }, []);
  const askRemove = useCallback((message: ChatMessage) => setConfirming({ kind: "remove-message", message }), []);
  const askDelete = useCallback((message: ChatMessage) => setConfirming({ kind: "delete-message", message }), []);

  const send = (body: string) => {
    const reply = replyingTo;
    chat.send(id, body, reply ? { id: reply.id, seq: reply.seq, senderId: reply.senderId, senderName: reply.senderName, excerpt: excerptOf(reply.body) } : undefined);
    setReplyingTo(null);
    list.current?.scrollToLatest();
  };

  const editLast = () => {
    const mine = [...conversation.messages].reverse().find((message) => message.senderId === me && message.kind === "text" && !message.deletedAt);
    if (mine && summary.canSend) startEdit(mine);
  };

  const confirm = async () => {
    if (!confirming) return;
    setWorking(true);
    try {
      switch (confirming.kind) {
        case "remove-message":
          await chat.deleteForMe(id, confirming.message.id);
          break;
        case "delete-message":
          await chat.deleteForEveryone(id, confirming.message.id);
          break;
        case "remove-member":
          await chat.removeMember(id, confirming.member.id);
          break;
        case "clear":
          await chat.clear(id);
          if (summary.kind === "dm") onBack();
          break;
        case "leave":
          await chat.leave(id);
          onBack();
          break;
        case "delete":
          await chat.deleteConversation(id);
          onBack();
          break;
      }
      setConfirming(null);
    } catch (failure) {
      report("That didn’t work. Nothing was changed.")(failure);
    } finally {
      setWorking(false);
    }
  };

  const status = peer ? personStatus(peer, data) : null;
  const subtitle: ReactNode = connection === "offline"
    ? <span className="text-warning">Reconnecting… Messages you send will go when Raven is back online.</span>
    : summary.kind === "dm"
      ? status
      : summary.kind === "group"
        ? `${summary.memberCount} ${summary.memberCount === 1 ? "person" : "people"}`
        : [tree?.name, summary.topic].filter(Boolean).join(" · ") || undefined;

  const intro = summary.kind === "dm"
    ? `Messages here are between you and ${summary.name}.${summary.peerReadSeq !== undefined && sharesReadStatus ? " You can each see when the other has read them; Settings › Messages turns that off." : ""}`
    : summary.kind === "group"
      ? "Only people in this group can read it. Anyone added later sees messages from then on."
      : `Everyone in ${tree?.name ?? "this place"} can read and write here.`;

  const confirmation = confirming ? describeConfirmation(confirming, summary.name, summary.kind) : null;

  return (
    <>
      <ViewHeader
        leading={
          peer && summary.peer ? (
            <PersonAvatar id={summary.peer.id} name={summary.name} presence={peer.presence} className="h-9 w-9" />
          ) : (
            <ConversationAvatar conversation={summary} className="h-9 w-9" />
          )
        }
        title={summary.name}
        subtitle={subtitle}
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label={`More for ${summary.name}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {summary.kind === "dm" && summary.peer ? (
                <DropdownMenuItem onSelect={() => onNavigate({ kind: "user", id: summary.peer!.id })}>
                  <UserRound className="text-muted-foreground" />
                  Open {summary.name}’s page
                </DropdownMenuItem>
              ) : null}
              {summary.kind === "group" ? (
                <DropdownMenuItem onSelect={() => setPeopleOpen(true)}>
                  <Users className="text-muted-foreground" />
                  People
                </DropdownMenuItem>
              ) : null}
              {summary.kind !== "dm" && summary.canManage ? (
                <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                  <Pencil className="text-muted-foreground" />
                  Rename
                </DropdownMenuItem>
              ) : null}
              {summary.kind !== "nest" ? (
                <DropdownMenuItem onSelect={() => void chat.setArchived(id, !summary.archived).catch(report("Couldn’t change that."))}>
                  {summary.archived ? <ArchiveRestore className="text-muted-foreground" /> : <Archive className="text-muted-foreground" />}
                  {summary.archived ? "Move out of archive" : "Archive"}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setConfirming({ kind: "clear" })}>
                <Eraser className="text-muted-foreground" />
                Clear for me
              </DropdownMenuItem>
              {summary.kind === "group" ? (
                <DropdownMenuItem onSelect={() => setConfirming({ kind: "leave" })}>
                  <LogOut className="text-muted-foreground" />
                  Leave group
                </DropdownMenuItem>
              ) : null}
              {summary.kind !== "dm" && summary.canManage ? (
                <DropdownMenuItem destructive onSelect={() => setConfirming({ kind: "delete" })}>
                  <Trash2 />
                  Delete for everyone
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      <MessageList
        ref={list}
        store={chat}
        conversation={conversation}
        me={me}
        windowActive={windowActive}
        intro={intro}
        onReply={startReply}
        onEdit={startEdit}
        onRemoveForMe={askRemove}
        onDeleteForEveryone={askDelete}
      />

      {summary.canSend ? (
        <Composer
          conversationId={id}
          name={summary.name}
          replyingTo={replyingTo}
          editing={editing}
          onCancelReply={() => setReplyingTo(null)}
          onCancelEdit={() => setEditing(null)}
          onSend={send}
          onSaveEdit={(body) =>
            chat.edit(id, editing!.id, body).catch((failure) => {
              report("Couldn’t save the change.")(failure);
              throw failure;
            })
          }
          onTyping={() => chat.typing(id)}
          onEditLast={editLast}
        />
      ) : (
        <p className="mx-auto w-full max-w-3xl shrink-0 px-6 pb-5 text-center text-small text-muted-foreground">
          You and {summary.name} are not friends at the moment. What was said stays here, but new messages can’t be sent.
        </p>
      )}

      {confirmation ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(null);
          }}
          title={confirmation.title}
          description={confirmation.description}
          confirmLabel={confirmation.confirmLabel}
          destructive
          busy={working}
          onConfirm={confirm}
        />
      ) : null}
      {summary.kind === "group" ? (
        <GroupPeopleDialog
          open={peopleOpen}
          onOpenChange={setPeopleOpen}
          groupName={summary.name}
          members={conversation.members}
          me={me}
          canManage={summary.canManage}
          friends={friends}
          onAdd={async (userIds) => {
            await chat.addMembers(id, userIds);
          }}
          onRemove={(member) => {
            setPeopleOpen(false);
            setConfirming({ kind: "remove-member", member });
          }}
          onLeave={() => {
            setPeopleOpen(false);
            setConfirming({ kind: "leave" });
          }}
        />
      ) : null}
      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title={`Rename ${summary.name}`}
        current={summary.name}
        onRename={async (name) => {
          await chat.rename(id, { name });
        }}
      />
    </>
  );
}

/** The real question and its consequence, for each thing that cannot be undone. */
function describeConfirmation(confirming: Confirmation, name: string, kind: ConversationState["summary"]["kind"]) {
  switch (confirming.kind) {
    case "remove-message":
      return {
        title: "Remove this message for you?",
        description: "It disappears from your devices only. Everyone else still sees it.",
        confirmLabel: "Remove",
      };
    case "delete-message":
      return {
        title: "Delete this message for everyone?",
        description: "Its text is erased for everyone in the conversation and can’t be brought back. A note stays where it was.",
        confirmLabel: "Delete",
      };
    case "remove-member":
      return {
        title: `Remove ${confirming.member.displayName} from ${name}?`,
        description: "They stop receiving messages and can no longer read this group until someone adds them again.",
        confirmLabel: "Remove",
      };
    case "clear":
      return {
        title: `Clear ${name} for you?`,
        description: kind === "dm"
          ? "Everything here disappears from your devices, and the conversation leaves your list until there is a new message. The other person keeps their copy."
          : "Everything here disappears from your devices. Other people keep their copy, and new messages still arrive.",
        confirmLabel: "Clear",
      };
    case "leave":
      return {
        title: `Leave ${name}?`,
        description: "You stop receiving its messages and can no longer read it. Someone in the group can add you again.",
        confirmLabel: "Leave",
      };
    case "delete":
      return {
        title: `Delete ${name} for everyone?`,
        description: "The conversation and every message in it are erased for everyone. This can’t be undone.",
        confirmLabel: "Delete",
      };
  }
}
