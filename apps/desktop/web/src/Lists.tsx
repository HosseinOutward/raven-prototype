import { useMemo, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { ConversationRow, ConversationRowCompact } from "@/components/chat/ConversationRow";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { listedConversations, textNestsOfTree } from "@/lib/chat/reducer";
import type { ChatStore } from "@/lib/chat/store";
import { GroupedList, NestGlyph, SectionLabel } from "@/shells/ravenv1/atoms";
import type { RavenShellData } from "@/shells/ravenv1/state";
import { liveTreeNests } from "@/shells/ravenv1/treeLobby";
import { useChatState } from "@/shells/ravenv1/useChat";
import { namesSentence, nestPeople, ViewHeader } from "@/shells/ravenv1/views/shared";
import type { Screen } from "./App";

/** The Trees, then desktop's Messages list. */
export function HomeScreen({ data, chat, onOpen }: { data: RavenShellData; chat: ChatStore | null; onOpen: (screen: Screen) => void }) {
  const state = useChatState(chat);
  const me = data.user?.id ?? "";
  const conversations = useMemo(() => (state ? listedConversations(state) : []), [state]);

  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-title font-semibold">{data.serverProperties.name || "Raven"}</h1>
        <Button size="sm" variant="ghost" onClick={data.logout}>Sign out</Button>
      </div>
      <section>
        <SectionLabel className="px-1">{data.labels.treePlural}</SectionLabel>
        <GroupedList>
          {data.trees.map((tree) => (
            <button key={tree.id} type="button" onClick={() => onOpen({ kind: "tree", id: tree.id })} className="flex h-14 w-full items-center gap-3 px-3.5 text-left">
              <Avatar name={tree.name} src={api.treeAvatarUrl(tree.id, tree.updatedAt)} className="h-8 w-8 rounded-control" />
              <span className="min-w-0 flex-1 truncate text-body font-medium">{tree.name}</span>
            </button>
          ))}
        </GroupedList>
      </section>
      {chat ? (
        <section>
          <SectionLabel className="px-1">Messages</SectionLabel>
          <GroupedList>
            {conversations.map(({ summary }) => (
              <ConversationRow key={summary.id} conversation={summary} me={me} onOpen={(id) => onOpen({ kind: "chat", id })} />
            ))}
          </GroupedList>
        </section>
      ) : null}
    </div>
  );
}

/** A Tree's voice Nests, then its text Nests. */
export function TreeScreen({ treeId, data, chat, onOpen, onBack }: { treeId: string; data: RavenShellData; chat: ChatStore | null; onOpen: (screen: Screen) => void; onBack: () => void }) {
  const state = useChatState(chat);
  const details = data.getTreeDetails(treeId);
  const voiceNests = useMemo(() => (details ? [...liveTreeNests(details, data.activeNests), ...details.inactiveNests] : []), [details, data.activeNests]);
  const textNests = useMemo(() => (state ? textNestsOfTree(state, treeId) : []), [state, treeId]);

  return (
    <>
      <Header title={data.getTree(treeId)?.name ?? data.labels.treeSingular} onBack={onBack} />
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        <section>
          <SectionLabel className="px-1">Voice</SectionLabel>
          <GroupedList>
            {voiceNests.map((nest) => {
              const live = nest.lifecycleState === "active";
              return (
                <button key={nest.id} type="button" onClick={() => onOpen({ kind: "call", nestId: nest.id })} className="flex h-12 w-full items-center gap-3 px-3.5 text-left">
                  <NestGlyph kind="voice" live={live} className={live ? "text-live" : "text-subtle"} />
                  <span className="min-w-0 flex-1 truncate text-body">{nest.name}</span>
                  {live ? <span className="truncate text-caption text-muted-foreground">{namesSentence(nestPeople(nest, data).map((person) => person.name))}</span> : null}
                </button>
              );
            })}
          </GroupedList>
        </section>
        {textNests.length > 0 ? (
          <section>
            <SectionLabel className="px-1">Text</SectionLabel>
            <GroupedList className="p-1">
              {textNests.map(({ summary }) => (
                <ConversationRowCompact key={summary.id} conversation={summary} active={false} onOpen={(id) => onOpen({ kind: "chat", id })} />
              ))}
            </GroupedList>
          </section>
        ) : null}
      </div>
    </>
  );
}

/** Desktop's view header, with a way back. */
export function Header({ title, subtitle, onBack }: { title: string; subtitle?: ReactNode; onBack: () => void }) {
  return (
    <ViewHeader
      leading={
        <Button size="icon-sm" variant="ghost" aria-label="Back" onClick={onBack}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
      }
      title={title}
      subtitle={subtitle}
    />
  );
}
