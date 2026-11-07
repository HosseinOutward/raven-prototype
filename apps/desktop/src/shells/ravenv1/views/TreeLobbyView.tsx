import { useEffect, useMemo, useState } from "react";
import { ArrowUpDown, ChevronRight, FolderPlus, Globe2, Hand, Lock, LogIn, MoreHorizontal, Plus, Settings, UserPlus } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api, type Nest, type TreeDetails, type TreeMember, type TreeSearchResult } from "@/lib/api";
import type { ChatStore } from "@/lib/chat/store";
import { treeCan } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { EmptyState, GroupedList, NestGlyph, PersonAvatar, SectionLabel } from "../atoms";
import { displayNameFor, lifecycleLabel, PRESENCE, presenceFromApi, type RavenShellData, type RavenView } from "../state";
import type { RavenMediaAdapterState } from "../useRavenMediaAdapter";
import { useTreeChatSummaries } from "../useChat";
import type { NestEntryController } from "../useNestEntry";
import { AddTreeMemberDialog, NameDialog, TREE_ROLE_LABEL } from "./dialogs";
import { ProfilePictureViewer } from "./ProfilePictureViewer";
import { LiveNestCard, nestView, ViewBody, ViewHeader } from "./shared";
import { TreeNestsSection } from "./TreeNestsSection";

/** A tree's lobby answers: what is alive in this group right now? */
export function TreeLobbyView({
  details,
  data,
  media,
  entry,
  chat = null,
  onNavigate,
}: {
  details: TreeDetails;
  data: RavenShellData;
  media: RavenMediaAdapterState;
  entry: NestEntryController;
  /** Text chat, or null when the server has none. */
  chat?: ChatStore | null;
  onNavigate: (view: RavenView) => void;
}) {
  const [createTextNestOpen, setCreateTextNestOpen] = useState(false);
  const [createCategoryOpen, setCreateCategoryOpen] = useState(false);
  const [arranging, setArranging] = useState(false);
  const textNestCount = useTreeChatSummaries(chat).get(details.tree.id)?.count ?? 0;
  const tree = details.tree;
  const treeSingular = data.labels.treeSingular.toLowerCase();
  const nestSingular = data.labels.nestSingular.toLowerCase();
  const nestPlural = data.labels.nestPlural.toLowerCase();
  const selfMember = details.members.find((member) => member.userId === data.user?.id);
  const canManage = treeCan(details, "rooms.manage");
  const canManageMembers = treeCan(details, "members.manage");
  const [createNestOpen, setCreateNestOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  // Whose picture is open: this view stays mounted when moving from one tree to another.
  const [viewingPicture, setViewingPicture] = useState<string | null>(null);
  const canJoin = !entry.enteringNestId && media.phase !== "joining" && media.phase !== "leaving";

  // The launcher list knows who is inside; the tree's own list is the fallback.
  const liveNests: Nest[] = details.activeNests.map((nest) => data.activeNests.find((candidate) => candidate.id === nest.id) ?? nest);
  const quietNests = details.inactiveNests;
  const memberIds = useMemo(() => new Set(details.members.filter((member) => member.state === "joined").map((member) => member.userId)), [details.members]);
  const members = [...details.members].sort((a, b) => memberRank(a) - memberRank(b) || displayNameFor(a).localeCompare(displayNameFor(b)));

  const join = (nestId: string) => {
    onNavigate({ kind: "nest", id: nestId });
    void entry
      .enter(nestId)
      .then((result) => {
        if (result === "waiting") onNavigate({ kind: "waiting", id: nestId });
      })
      .catch(() => undefined);
  };

  return (
    <>
      {viewingPicture === tree.id ? <ProfilePictureViewer src={api.treeAvatarUrl(tree.id, tree.updatedAt)} alt={`${tree.name}’s picture`} onClose={() => setViewingPicture(null)} /> : null}
      <ViewHeader
        leading={<Avatar name={tree.name} src={api.treeAvatarUrl(tree.id, tree.updatedAt)} className="h-9 w-9 rounded-control" onOpen={() => setViewingPicture(tree.id)} />}
        title={tree.name}
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            {tree.visibility === "public" ? <Globe2 className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
            {tree.visibility === "public" ? "Public" : "Private"} · {details.members.length} {details.members.length === 1 ? "member" : "members"}
            {tree.description ? ` · ${tree.description}` : ""}
          </span>
        }
        actions={
          canManage ? (
            <>
              <Button size="sm" onClick={() => setCreateNestOpen(true)}>
                <Plus className="h-4 w-4" />
                New {nestSingular}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label={`More for ${tree.name}`}>
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {chat ? (
                    <>
                      <DropdownMenuItem onSelect={() => setCreateTextNestOpen(true)}>
                        <NestGlyph kind="text" className="text-muted-foreground" />
                        New text {nestSingular}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setCreateCategoryOpen(true)}>
                        <FolderPlus className="text-muted-foreground" />
                        New category
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setArranging(true)}>
                        <ArrowUpDown className="text-muted-foreground" />
                        Arrange {nestPlural}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  ) : null}
                  <DropdownMenuItem onSelect={() => setAddMemberOpen(true)}>
                    <UserPlus className="text-muted-foreground" />
                    Add a person
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onNavigate({ kind: "tree-settings", id: tree.id })}>
                    <Settings className="text-muted-foreground" />
                    {data.labels.treeSingular} settings
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : (
            <Button size="icon-sm" variant="ghost" aria-label={`${data.labels.treeSingular} settings`} onClick={() => onNavigate({ kind: "tree-settings", id: tree.id })}>
              <Settings className="h-4 w-4" />
            </Button>
          )
        }
      />
      <ViewBody>
        <div className="grid max-w-5xl gap-8 min-[1100px]:grid-cols-[minmax(0,1fr)_264px]">
          <div className="min-w-0 space-y-8">
            {canManageMembers && details.joinRequests.length ? (
              <section>
                <SectionLabel className="mb-1">Asking to join</SectionLabel>
                <GroupedList>
                  {details.joinRequests.map((request) => {
                    const name = request.displayName || request.username;
                    return (
                      <div key={request.id} className="flex items-center gap-3 px-3 py-2.5">
                        <button type="button" onClick={() => onNavigate({ kind: "user", id: request.userId })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                          <PersonAvatar id={request.userId} name={name} className="h-8 w-8" />
                          <span className="min-w-0 truncate text-small font-medium">{name}</span>
                        </button>
                        <Button size="sm" onClick={() => void data.acceptTreeJoinRequest(tree.id, request.id).catch(() => undefined)}>Accept</Button>
                        <Button size="sm" variant="ghost" onClick={() => void data.rejectTreeJoinRequest(tree.id, request.id).catch(() => undefined)}>Decline</Button>
                      </div>
                    );
                  })}
                </GroupedList>
              </section>
            ) : null}

            {liveNests.length ? (
              <section>
                <SectionLabel className="mb-1">Live now</SectionLabel>
                <div className="grid gap-3 sm:grid-cols-2">
                  {liveNests.map((nest) => (
                    <LiveNestCard
                      key={nest.id}
                      nest={nest}
                      data={data}
                      showTree={false}
                      here={media.activeNestId === nest.id}
                      canJoin={canJoin}
                      onOpen={() => onNavigate(nestView(nest))}
                      onJoin={() => join(nest.id)}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {chat ? (
              <TreeNestsSection
                details={details}
                data={data}
                media={media}
                chat={chat}
                canManage={canManage}
                arranging={arranging}
                onArrangingChange={setArranging}
                onNavigate={onNavigate}
              />
            ) : quietNests.length ? (
              <section>
                <SectionLabel className="mb-1">{liveNests.length ? `Quiet ${nestPlural}` : data.labels.nestPlural}</SectionLabel>
                <GroupedList>
                  {quietNests.map((nest) => {
                    const state = lifecycleLabel(nest);
                    return (
                      <button
                        key={nest.id}
                        type="button"
                        onClick={() => onNavigate(nestView(nest))}
                        className="group flex h-11 w-full items-center gap-3 px-3.5 text-left transition-colors hover:bg-secondary"
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-subtle/60" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-body">{nest.name}</span>
                        {state !== "Empty" && state !== "Created" ? <span className="shrink-0 text-caption text-muted-foreground">{state}</span> : null}
                        <ChevronRight className="h-4 w-4 shrink-0 text-subtle transition-colors group-hover:text-foreground" />
                      </button>
                    );
                  })}
                </GroupedList>
              </section>
            ) : null}

            {!liveNests.length && !quietNests.length && !textNestCount ? (
              <EmptyState
                title={`No ${nestPlural} yet`}
                text={canManage ? `A ${nestSingular} is a room people in this ${treeSingular} can drop into.` : `An owner or moderator can add the first ${nestSingular}.`}
              >
                {canManage ? (
                  <Button onClick={() => setCreateNestOpen(true)}>
                    <Plus className="h-4 w-4" />
                    New {nestSingular}
                  </Button>
                ) : null}
              </EmptyState>
            ) : null}
          </div>

          <aside className="min-w-0">
            <SectionLabel className="mb-1 px-2">Members · {members.length}</SectionLabel>
            <div className="space-y-px">
              {members.map((member) => (
                <MemberRow
                  key={member.userId}
                  member={member}
                  isSelf={member.userId === data.user?.id}
                  nestName={member.activeNestId ? data.getNest(member.activeNestId)?.name : undefined}
                  onOpen={() => onNavigate({ kind: "user", id: member.userId })}
                />
              ))}
            </div>
          </aside>
        </div>
      </ViewBody>

      <NameDialog
        open={createNestOpen}
        onOpenChange={setCreateNestOpen}
        title={`New ${nestSingular}`}
        description={`Everyone in ${tree.name} will be able to see it and join.`}
        label="Name"
        placeholder="Lounge"
        submitLabel={`Create ${nestSingular}`}
        onSubmit={async (name) => {
          const nest = await data.createTreeNest(tree.id, name);
          setCreateNestOpen(false);
          onNavigate({ kind: "nest", id: nest.id });
        }}
      />
      {chat ? (
        <>
          <NameDialog
            open={createTextNestOpen}
            onOpenChange={setCreateTextNestOpen}
            title={`New text ${nestSingular}`}
            description={`A place to write. Everyone in ${tree.name} can read it and write in it.`}
            label="Name"
            placeholder="general"
            submitLabel={`Create text ${nestSingular}`}
            onSubmit={async (name) => {
              const conversation = await chat.createTextNest(tree.id, name);
              setCreateTextNestOpen(false);
              onNavigate({ kind: "chat", id: conversation.id });
            }}
          />
          <NameDialog
            open={createCategoryOpen}
            onOpenChange={setCreateCategoryOpen}
            title="New category"
            description={`A heading to group ${nestPlural} under. Use Arrange to move them into it.`}
            label="Name"
            placeholder="Projects"
            submitLabel="Create category"
            onSubmit={async (name) => {
              await chat.createCategory(tree.id, name);
              setCreateCategoryOpen(false);
            }}
          />
        </>
      ) : null}
      <AddTreeMemberDialog
        open={addMemberOpen}
        onOpenChange={setAddMemberOpen}
        title={`Add a person to ${tree.name}`}
        canAssignRoles={treeCan(details, "roles.assign")}
        friends={data.friends}
        memberIds={memberIds}
        onAdd={async (username, role) => {
          await data.addTreeMember(tree.id, username, role);
          setAddMemberOpen(false);
        }}
      />
    </>
  );
}

function memberRank(member: TreeMember) {
  const presence = presenceFromApi({ state: member.presenceState, reachability: member.reachability });
  if (presence === "offline" || presence === "invisible") return 5;
  if (member.activeNestId) return 0;
  if (presence === "open") return 1;
  if (presence === "around") return 2;
  if (presence === "focused") return 3;
  return 4;
}

function MemberRow({
  member,
  isSelf,
  nestName,
  onOpen,
}: {
  member: TreeMember;
  isSelf: boolean;
  nestName?: string;
  onOpen: () => void;
}) {
  const presence = presenceFromApi({ state: member.presenceState, reachability: member.reachability });
  const away = presence === "offline" || presence === "invisible";
  const status = away ? null : nestName ? `In ${nestName}` : presence === "around" ? null : PRESENCE[presence].label;
  const tags = [isSelf ? "You" : null, member.role !== "member" ? TREE_ROLE_LABEL[member.role] : null].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${displayNameFor(member)} · ${PRESENCE[presence].label}`}
      className="flex min-h-10 w-full items-center gap-2.5 rounded-control px-2 py-1 text-left transition-colors hover:bg-secondary"
    >
      <PersonAvatar id={member.userId} name={displayNameFor(member)} presence={presence} className={cn("h-7 w-7", away && "opacity-60")} />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-small", away ? "text-muted-foreground" : "text-foreground")}>{displayNameFor(member)}</span>
        {status || tags ? <span className="block truncate text-caption text-muted-foreground">{[status, tags].filter(Boolean).join(" · ")}</span> : null}
      </span>
    </button>
  );
}

/** A public tree you have found but not joined yet. */
export function PublicTreePreviewView({
  initialResult,
  data,
  onNavigate,
}: {
  initialResult: TreeSearchResult;
  data: RavenShellData;
  onNavigate: (view: RavenView) => void;
}) {
  const [result, setResult] = useState(initialResult);
  const [working, setWorking] = useState(false);
  const treeLabel = data.labels.treeSingular.toLowerCase();
  const joined = result.accessState === "joined";
  const pending = result.accessState === "pending";
  const free = result.tree.joinPolicy === "free";

  useEffect(() => {
    setResult(initialResult);
  }, [initialResult]);

  const act = async () => {
    setWorking(true);
    try {
      if (joined) {
        await data.refresh();
        onNavigate({ kind: "tree", id: result.tree.id });
        return;
      }
      const status = await data.joinTree(result.tree.id);
      if (status === "joined") onNavigate({ kind: "tree", id: result.tree.id });
      else setResult((current) => ({ ...current, accessState: "pending" }));
    } catch {
      // Reported by the shell.
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-sm text-center">
        <Avatar name={result.tree.name} src={api.treeAvatarUrl(result.tree.id, result.tree.updatedAt)} className="mx-auto h-16 w-16 rounded-card text-title" />
        <h1 className="mt-4 text-display font-semibold">{result.tree.name}</h1>
        <p className="mt-1 text-small text-muted-foreground">{result.tree.description || `A public ${treeLabel}.`}</p>
        <p className="mt-5 text-small text-muted-foreground">
          {pending
            ? "Your request was sent. An owner or moderator will let you in."
            : free
              ? `Anyone on this server can join. Members will see that you joined.`
              : `Joining needs approval from an owner or moderator.`}
        </p>
        {pending ? null : (
          <Button className="mt-5" size="lg" disabled={working} onClick={() => void act()}>
            {joined || free ? <LogIn className="h-4 w-4" /> : <Hand className="h-4 w-4" />}
            {joined ? `Open ${treeLabel}` : free ? `Join ${treeLabel}` : "Ask to join"}
          </Button>
        )}
      </div>
    </div>
  );
}
