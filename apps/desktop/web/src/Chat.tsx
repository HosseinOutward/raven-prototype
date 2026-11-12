import { useEffect, useRef, useState } from "react";
import { Composer } from "@/components/chat/Composer";
import { MessageList, type MessageListHandle } from "@/components/chat/MessageList";
import { toast } from "@/components/ui/toast";
import { reactionLimits } from "@/lib/chat/attachments";
import { failureText } from "@/lib/chat/errors";
import { excerptOf, summarize } from "@/lib/chat/reducer";
import type { ChatStore } from "@/lib/chat/store";
import type { ChatMessage } from "@/lib/chat/types";
import type { RavenShellData } from "@/shells/ravenv1/state";
import { useConversation, useWindowActive } from "@/shells/ravenv1/useChat";
import { Header } from "./Lists";

const ignore = () => undefined;

/** One conversation, with desktop's message list and composer. Text only: no images are sent from here. */
export function ChatScreen({ conversationId, data, chat, onBack }: { conversationId: string; data: RavenShellData; chat: ChatStore; onBack: () => void }) {
  const conversation = useConversation(chat, conversationId);
  const windowActive = useWindowActive();
  const list = useRef<MessageListHandle>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const me = data.user?.id ?? "";

  useEffect(() => {
    void chat.openConversation(conversationId);
    return () => chat.closeConversation(conversationId);
  }, [chat, conversationId]);

  if (!conversation) {
    return (
      <>
        <Header title="Messages" onBack={onBack} />
        <div className="flex flex-1 items-center justify-center text-small text-muted-foreground" role="status">Loading…</div>
      </>
    );
  }
  const { summary } = conversation;
  // A direct message is titled with who they are now, as on desktop.
  const name = (summary.kind === "dm" && summary.peer ? data.getPerson(summary.peer.id)?.name : undefined) ?? summary.name;
  const report = (fallback: string) => (failure: unknown) => toast({ title: failureText(failure, fallback), tone: "error" });
  const confirmed = (action: () => Promise<unknown>, question: string) => {
    if (window.confirm(question)) void action().catch(report("That didn’t work. Nothing was changed."));
  };

  return (
    <>
      <Header title={name} onBack={onBack} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <MessageList
          ref={list}
          store={chat}
          reactionLimits={reactionLimits(data.serverProperties.properties)}
          conversation={conversation}
          me={me}
          windowActive={windowActive}
          onReply={(message) => {
            setEditing(null);
            setReplyingTo(message);
          }}
          onEdit={(message) => {
            setReplyingTo(null);
            setEditing(message);
          }}
          onRemoveForMe={(message) => confirmed(() => chat.deleteForMe(conversationId, message.id), "Remove this message for you?")}
          onDeleteForEveryone={(message) => confirmed(() => chat.deleteForEveryone(conversationId, message.id), "Delete this message for everyone?")}
          onOpenImage={ignore}
          onOpenPerson={ignore}
        />
        {summary.canSend ? (
          <Composer
            conversationId={conversationId}
            name={name}
            replyingTo={replyingTo}
            editing={editing}
            onCancelReply={() => setReplyingTo(null)}
            onCancelEdit={() => setEditing(null)}
            onSend={(body) => {
              const reply = replyingTo;
              chat.send(conversationId, body, reply ? { id: reply.id, seq: reply.seq, senderId: reply.senderId, senderName: reply.senderName, excerpt: excerptOf(reply.body), attachments: summarize(reply.attachments) } : undefined);
              setReplyingTo(null);
              list.current?.scrollToLatest();
            }}
            onSaveEdit={(body) =>
              chat.edit(conversationId, editing!.id, body).catch((failure) => {
                report("Couldn’t save the change.")(failure);
                throw failure;
              })
            }
            onTyping={() => chat.typing(conversationId)}
            onEditLast={ignore}
            imageLimits={null}
          />
        ) : null}
      </div>
    </>
  );
}
