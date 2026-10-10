import { useEffect, useState, type ReactNode } from "react";
import { LiveMediaStage } from "@/components/media/LiveMediaStage";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { RavenUpdater } from "@/lib/updater";
import { Check, ChevronLeft, Eye, Globe2, Hand, Info, LogIn, LogOut, Lock, Mic, Network, Phone, Plus, Radio, Search, Settings, Shield, Trash2, UserMinus, UserPlus, UserX, Users, Video, X } from "lucide-react";
import { SquareImageUpload } from "@/components/SquareImageUpload";
import { UserSettingsView } from "./UserSettings";
import {
  SettingsField,
  SettingsHint,
  SettingsScaffold,
  SettingsSection,
  type SettingsCategory,
} from "./SettingsScaffold";
import { api, type LauncherNest, type Nest, type TreeDetails, type TreeMember, type TreeRole, type TreeSearchResult } from "@/lib/api";
import { AvatarStack, MonoLabel, PresenceDot } from "./atoms";
import {
  displayNameFor,
  formatRelativeTime,
  lifecycleLabel,
  PRESENCE,
  presenceFromApi,
  type RavenShellData,
  type RavenView,
  type ShellPerson,
} from "./state";
import type { RavenMediaAdapterState } from "./useRavenMediaAdapter";

export function MainView({
  view,
  data,
  media,
  updater,
  onNavigate,
}: {
  view: RavenView;
  data: RavenShellData;
  media: RavenMediaAdapterState;
  updater: RavenUpdater;
  onNavigate: (view: RavenView) => void;
}) {
  if (data.error) {
    return (
      <>
        <ViewHeader eyebrow="Raven" title="State unavailable" subtitle={data.error} />
        <ViewBody>
          <Button variant="secondary" onClick={() => void data.refresh()}>
            Retry
          </Button>
        </ViewBody>
      </>
    );
  }

  switch (view.kind) {
    case "home":
      return <HomeView data={data} onNavigate={onNavigate} />;
    case "tree": {
      const details = data.getTreeDetails(view.id);
      return details ? <TreeLobbyView details={details} data={data} onNavigate={onNavigate} /> : <MissingView title={`${data.labels.treeSingular} unavailable`} />;
    }
    case "tree-preview":
      return <PublicTreePreviewView initialResult={view.result} data={data} onNavigate={onNavigate} />;
    case "tree-settings": {
      const details = data.getTreeDetails(view.id);
      return details ? <TreeSettingsView details={details} data={data} onNavigate={onNavigate} /> : <MissingView title={`${data.labels.treeSingular} unavailable`} />;
    }
    case "settings":
      return <UserSettingsView data={data} media={media} updater={updater} onNavigate={onNavigate} />;
    case "user": {
      const person = data.getPerson(view.id) ?? view.person;
      return person ? <UserPageView person={person} data={data} onNavigate={onNavigate} /> : <MissingView title="Person unavailable" />;
    }
    case "waiting": {
      const nest = data.getNest(view.id);
      return nest ? <WaitingRoomView nest={nest} data={data} media={media} onNavigate={onNavigate} /> : <MissingView title={`${data.labels.nestSingular} unavailable`} />;
    }
    case "nest": {
      const nest = data.getNest(view.id);
      return nest ? <ActiveNestView nest={nest} data={data} media={media} onNavigate={onNavigate} /> : <MissingView title={`${data.labels.nestSingular} unavailable`} />;
    }
  }
}

function ViewHeader({
  eyebrow,
  title,
  subtitle,
  meta,
  actions,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-start gap-4 border-b border-border/60 px-7 py-5">
      <div className="min-w-0 flex-1">
        <MonoLabel>{eyebrow}</MonoLabel>
        <h1 className="mt-1.5 truncate text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p> : null}
        {meta ? <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

function RoomHeader({
  roomLabel,
  title,
  subtitle,
  startedAt,
  actions,
}: {
  roomLabel: string;
  title: string;
  subtitle: string;
  startedAt?: string | null;
  actions: ReactNode;
}) {
  return (
    <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/50 px-4 py-2">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-primary shadow-[0_0_12px_hsl(var(--primary)/0.65)]" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
        <span className="shrink-0 rv-mono text-[10px] uppercase tracking-[0.12em] text-primary">Live {roomLabel}</span>
        <h1 className="truncate text-[15px] font-semibold tracking-tight">{title}</h1>
        <span className="hidden truncate text-xs text-muted-foreground md:inline">{subtitle}</span>
        {startedAt ? <span className="hidden shrink-0 rv-mono text-[10px] text-muted-foreground xl:inline">{formatRelativeTime(startedAt)}</span> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
    </div>
  );
}

function ViewBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-7 py-6", className)}>{children}</div>;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <MonoLabel className="mb-3 block">{children}</MonoLabel>;
}

function Chip({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "primary" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 rv-mono text-[11px]",
        tone === "primary" ? "border-primary/30 bg-primary/10 text-primary" : "border-border text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-2xl bg-background/30 p-6 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function MissingView({ title }: { title: string }) {
  return (
    <>
      <ViewHeader eyebrow="Raven" title={title} />
      <ViewBody>
        <Empty text="This page is not available right now." />
      </ViewBody>
    </>
  );
}

function PublicTreePreviewView({
  initialResult,
  data,
  onNavigate,
}: {
  initialResult: TreeSearchResult;
  data: RavenShellData;
  onNavigate: (view: RavenView) => void;
}) {
  const [result, setResult] = useState(initialResult);
  const treeLabel = data.labels.treeSingular;
  const joined = result.accessState === "joined";
  const pending = result.accessState === "pending";
  const openTree = async () => {
    await data.refresh();
    onNavigate({ kind: "tree", id: result.tree.id });
  };
  const joinTree = async () => {
    if (joined) {
      await openTree();
      return;
    }
    const status = await data.joinTree(result.tree.id);
    if (status === "joined") {
      onNavigate({ kind: "tree", id: result.tree.id });
      return;
    }
    setResult((current) => ({ ...current, accessState: "pending" }));
  };

  useEffect(() => {
    setResult(initialResult);
  }, [initialResult]);

  return (
    <>
      <ViewHeader
        eyebrow={`Public ${treeLabel}`}
        title={result.tree.name}
        subtitle={result.tree.description || `A public ${treeLabel.toLowerCase()} visible in search.`}
        actions={
          pending ? (
            <Chip>Waiting for approval</Chip>
          ) : (
            <Button className="gap-2" onClick={() => void joinTree()} disabled={data.busy}>
              {joined || result.tree.joinPolicy === "free" ? <LogIn className="h-4 w-4" /> : <Hand className="h-4 w-4" />}
              {joined ? "Open" : result.tree.joinPolicy === "free" ? "Join" : "Ask to join"}
            </Button>
          )
        }
      />
      <ViewBody>
        <div className="max-w-2xl space-y-4">
          <div className="rounded-2xl bg-background/40 p-4">
            <SectionTitle>Access</SectionTitle>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                {result.tree.joinPolicy === "free"
                  ? `Anyone signed in to this Raven server can join this public ${treeLabel.toLowerCase()}.`
                  : `Joining this public ${treeLabel.toLowerCase()} requires approval from an owner or moderator.`}
              </p>
              {pending ? <p>Your request is pending.</p> : null}
            </div>
          </div>
        </div>
      </ViewBody>
    </>
  );
}

function HomeView({ data, onNavigate }: { data: RavenShellData; onNavigate: (view: RavenView) => void }) {
  const selfPresence = presenceFromApi(data.presence);
  const reachable = data.people.filter((person) => person.presence === "open" || person.activeNestIds.length > 0);
  const [createTreeOpen, setCreateTreeOpen] = useState(false);
  const [treeSearchQuery, setTreeSearchQuery] = useState("");
  const [treeSearchResults, setTreeSearchResults] = useState<TreeSearchResult[]>([]);
  const [treeSearching, setTreeSearching] = useState(false);
  const runTreeSearch = async () => {
    const query = treeSearchQuery.trim();
    if (query.length < 2) {
      setTreeSearchResults([]);
      return;
    }
    setTreeSearching(true);
    try {
      setTreeSearchResults(await data.searchTrees(query));
    } finally {
      setTreeSearching(false);
    }
  };
  return (
    <>
      <ViewHeader
        eyebrow="Overview"
        title="Home"
        subtitle={`Your presence, live ${data.labels.nestPlural}, and reachable people.`}
        meta={
          <>
            <Chip tone="primary">
              <PresenceDot presence={selfPresence} />
              {PRESENCE[selfPresence].label}
            </Chip>
            <Chip>{data.activeNests.length} live {data.labels.nestPlural.toLowerCase()}</Chip>
            <Chip>{data.pending.length} pending</Chip>
          </>
        }
        actions={
          <Button className="gap-2" onClick={() => setCreateTreeOpen(true)} disabled={data.busy}>
            <Plus className="h-4 w-4" />
            New {data.labels.treeSingular}
          </Button>
        }
      />
      <ViewBody>
        <div className="max-w-4xl space-y-8">
          <section>
            <SectionTitle>Find public {data.labels.treePlural}</SectionTitle>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void runTreeSearch();
              }}
            >
              <Input
                value={treeSearchQuery}
                onChange={(event) => setTreeSearchQuery(event.currentTarget.value)}
                placeholder={`Search public ${data.labels.treePlural.toLowerCase()}`}
              />
              <Button type="submit" variant="secondary" className="gap-2" disabled={treeSearching || treeSearchQuery.trim().length < 2}>
                <Search className="h-4 w-4" />
                Search
              </Button>
            </form>
            {treeSearchResults.length ? (
              <div className="mt-3 space-y-2">
                {treeSearchResults.map((result) => (
                  <TreeSearchRow
                    key={result.tree.id}
                    result={result}
                    data={data}
                    onOpen={() => onNavigate({ kind: "tree", id: result.tree.id })}
                    onJoin={async () => {
                      const status = await data.joinTree(result.tree.id);
                      setTreeSearchResults((items) =>
                        items.map((item) =>
                          item.tree.id === result.tree.id ? { ...item, accessState: status === "joined" ? "joined" : "pending" } : item,
                        ),
                      );
                    }}
                  />
                ))}
              </div>
            ) : treeSearchQuery.trim().length >= 2 && !treeSearching ? (
              <Empty text={`No public ${data.labels.treePlural.toLowerCase()} match that search.`} />
            ) : null}
          </section>

          {(data.incomingFriendRequests.length > 0 || data.outgoingFriendRequests.length > 0) ? (
            <section>
              <SectionTitle>Friend requests</SectionTitle>
              <div className="space-y-2">
                {data.incomingFriendRequests.map((request) => (
                  <FriendRequestRow
                    key={request.id}
                    name={request.fromDisplayName || request.fromUsername}
                    meta="incoming"
                    onOpen={() => onNavigate({ kind: "user", id: request.fromUserId })}
                    actions={
                      <>
                        <Button size="sm" className="gap-1.5" onClick={() => void data.acceptFriendRequest(request.id)} disabled={data.busy}>
                          <Check className="h-3.5 w-3.5" />
                          Accept
                        </Button>
                        <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => void data.declineFriendRequest(request.id)} disabled={data.busy}>
                          <X className="h-3.5 w-3.5" />
                          Decline
                        </Button>
                      </>
                    }
                  />
                ))}
                {data.outgoingFriendRequests.map((request) => (
                  <FriendRequestRow
                    key={request.id}
                    name={request.toDisplayName || request.toUsername}
                    meta="sent"
                    onOpen={() => onNavigate({ kind: "user", id: request.toUserId })}
                    actions={
                      <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => void data.cancelFriendRequest(request.id)} disabled={data.busy}>
                        <X className="h-3.5 w-3.5" />
                        Cancel
                      </Button>
                    }
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section>
            <SectionTitle>{data.labels.liveNests}</SectionTitle>
            {data.activeNests.length ? (
              <div className="grid gap-3">
                {data.activeNests.map((nest) => (
                  <NestCard key={nest.id} nest={nest} data={data} onNavigate={onNavigate} />
                ))}
              </div>
            ) : (
              <Empty text={`No ${data.labels.nestPlural.toLowerCase()} are live right now.`} />
            )}
          </section>

          <section>
            <SectionTitle>Reachable people</SectionTitle>
            {reachable.length ? (
              <div className="space-y-2">
                {reachable.map((person) => (
                  <ReachableRow key={person.id} person={person} data={data} onNavigate={onNavigate} />
                ))}
              </div>
            ) : (
              <Empty text={`No one is reachable from your visible ${data.labels.treePlural} and ${data.labels.nestPlural}.`} />
            )}
          </section>
        </div>
      </ViewBody>
      <CreateTreeDialog
        open={createTreeOpen}
        onOpenChange={setCreateTreeOpen}
        busy={data.busy}
        title={`Create ${data.labels.treeSingular}`}
        placeholder={`${data.labels.treeSingular} name`}
        onCreate={async (name) => {
          const tree = await data.createTree(name);
          setCreateTreeOpen(false);
          onNavigate({ kind: "tree", id: tree.id });
        }}
      />
    </>
  );
}

function FriendRequestRow({
  name,
  meta,
  actions,
  onOpen,
}: {
  name: string;
  meta: string;
  actions: ReactNode;
  onOpen: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-background/40 px-3 py-2.5">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <Avatar name={name} className="h-8 w-8 text-[10px]" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{name}</div>
          <div className="rv-mono text-[11px] text-muted-foreground">{meta}</div>
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
    </div>
  );
}

function ReachableRow({ person, data, onNavigate }: { person: ShellPerson; data: RavenShellData; onNavigate: (view: RavenView) => void }) {
  const activeNest = person.activeNestIds[0] ? data.getNest(person.activeNestIds[0]) : null;
  return (
    <div className="flex items-center gap-3 rounded-xl bg-background/40 px-3 py-2.5">
      <button type="button" onClick={() => onNavigate({ kind: "user", id: person.id })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <Avatar name={person.name} src={`${data.apiServerUrl}/v1/media/users/${person.id}/avatar`} className="h-9 w-9" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{person.name}</div>
          <div className="mt-0.5 flex items-center gap-1.5 rv-mono text-[11px] text-muted-foreground">
            <PresenceDot presence={person.presence} />
            {activeNest ? `In ${activeNest.name}` : PRESENCE[person.presence].label}
          </div>
        </div>
      </button>
      <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => void data.knockUser(person.id)} disabled={data.busy}>
        <Hand className="h-3.5 w-3.5" />
        Knock
      </Button>
    </div>
  );
}

function TreeSearchRow({
  result,
  data,
  onOpen,
  onJoin,
}: {
  result: TreeSearchResult;
  data: RavenShellData;
  onOpen: () => void;
  onJoin: () => void | Promise<void>;
}) {
  const policy = result.tree.joinPolicy === "free" ? "Free join" : "Request required";
  return (
    <div className="flex items-center gap-3 rounded-xl bg-background/40 px-3 py-2.5">
      <button type="button" onClick={result.accessState === "joined" ? onOpen : undefined} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/70">
          <Globe2 className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{result.tree.name}</div>
          <div className="mt-0.5 truncate rv-mono text-[11px] text-muted-foreground">
            {policy}{result.tree.description ? ` · ${result.tree.description}` : ""}
          </div>
        </div>
      </button>
      {result.accessState === "joined" ? (
        <Button size="sm" variant="secondary" className="gap-1.5" onClick={onOpen}>
          <LogIn className="h-3.5 w-3.5" />
          Open
        </Button>
      ) : result.accessState === "pending" ? (
        <Chip>Request sent</Chip>
      ) : (
        <Button size="sm" className="gap-1.5" onClick={() => void onJoin()} disabled={data.busy}>
          {result.tree.joinPolicy === "free" ? <LogIn className="h-3.5 w-3.5" /> : <Hand className="h-3.5 w-3.5" />}
          {result.tree.joinPolicy === "free" ? "Join" : "Ask to join"}
        </Button>
      )}
    </div>
  );
}

function TreeLobbyView({
  details,
  data,
  onNavigate,
}: {
  details: TreeDetails;
  data: RavenShellData;
  onNavigate: (view: RavenView) => void;
}) {
  const nests = [...details.activeNests, ...details.inactiveNests];
  const selfMember = details.members.find((member) => member.userId === data.user?.id);
  const canManage = selfMember?.role === "owner" || selfMember?.role === "moderator";
  const canAssignOwner = selfMember?.role === "owner";
  const [createNestOpen, setCreateNestOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  return (
    <>
      <ViewHeader
        eyebrow={`${data.labels.treeSingular} lobby`}
        title={details.tree.name}
        subtitle={details.tree.description || `Visible ${data.labels.nestPlural} and members from your ${data.labels.treeSingular} membership.`}
        actions={
          canManage ? (
            <>
              <Button variant="ghost" className="gap-2" onClick={() => onNavigate({ kind: "tree-settings", id: details.tree.id })} disabled={data.busy}>
                <Settings className="h-4 w-4" />
                Settings
              </Button>
              <Button variant="secondary" className="gap-2" onClick={() => setAddMemberOpen(true)} disabled={data.busy}>
                <UserPlus className="h-4 w-4" />
                Add person
              </Button>
              <Button className="gap-2" onClick={() => setCreateNestOpen(true)} disabled={data.busy}>
                <Plus className="h-4 w-4" />
                {data.labels.nestSingular}
              </Button>
            </>
          ) : null
        }
      />
      <ViewBody>
        <div className="space-y-8">
          {canManage && details.joinRequests.length ? (
            <section>
              <SectionTitle>Join requests</SectionTitle>
              <div className="space-y-2">
                {details.joinRequests.map((request) => (
                  <FriendRequestRow
                    key={request.id}
                    name={request.displayName || request.username}
                    meta={`wants to join ${details.tree.name}`}
                    onOpen={() => onNavigate({ kind: "user", id: request.userId })}
                    actions={
                      <>
                        <Button size="sm" className="gap-1.5" onClick={() => void data.acceptTreeJoinRequest(details.tree.id, request.id)} disabled={data.busy}>
                          <Check className="h-3.5 w-3.5" />
                          Accept
                        </Button>
                        <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => void data.rejectTreeJoinRequest(details.tree.id, request.id)} disabled={data.busy}>
                          <X className="h-3.5 w-3.5" />
                          Decline
                        </Button>
                      </>
                    }
                  />
                ))}
              </div>
            </section>
          ) : null}
          <section>
            <SectionTitle>{data.labels.nestPlural}</SectionTitle>
            <div className="grid gap-3">
              {nests.length ? nests.map((nest) => <NestCard key={nest.id} nest={nest} data={data} onNavigate={onNavigate} />) : <Empty text={`No ${data.labels.nestPlural} are visible in this ${data.labels.treeSingular}.`} />}
            </div>
          </section>
          <section>
            <SectionTitle>People here</SectionTitle>
            <div className="space-y-2">
              {details.members
                .map((member) => {
                  const presence = presenceFromApi({ state: member.presenceState, reachability: member.reachability });
                  return (
                    <TreeMemberRow
                      key={member.userId}
                      member={member}
                      presence={presence}
                      canManage={canManage}
                      canAssignOwner={canAssignOwner}
                      isSelf={member.userId === data.user?.id}
                      onOpen={() => onNavigate({ kind: "user", id: member.userId })}
                      onRole={(role) => void data.updateTreeMemberRole(details.tree.id, member.userId, role)}
                      onRemove={() => void data.removeTreeMember(details.tree.id, member.userId)}
                    />
                  );
                })}
            </div>
          </section>
        </div>
      </ViewBody>
      <CreateNestDialog
        open={createNestOpen}
        onOpenChange={setCreateNestOpen}
        busy={data.busy}
        title={`Create ${data.labels.nestSingular}`}
        placeholder={`${data.labels.nestSingular} name`}
        onCreate={async (name) => {
          const nest = await data.createTreeNest(details.tree.id, name);
          setCreateNestOpen(false);
          onNavigate({ kind: "nest", id: nest.id });
        }}
      />
      <AddTreeMemberDialog
        open={addMemberOpen}
        onOpenChange={setAddMemberOpen}
        busy={data.busy}
        title={`Add person to ${data.labels.treeSingular}`}
        onAdd={async (username, role) => {
          await data.addTreeMember(details.tree.id, username, role);
          setAddMemberOpen(false);
        }}
      />
    </>
  );
}

function TreeMemberRow({
  member,
  presence,
  canManage,
  canAssignOwner,
  isSelf,
  onOpen,
  onRole,
  onRemove,
}: {
  member: TreeMember;
  presence: ReturnType<typeof presenceFromApi>;
  canManage: boolean;
  canAssignOwner: boolean;
  isSelf: boolean;
  onOpen: () => void;
  onRole: (role: TreeRole) => void;
  onRemove: () => void;
}) {
  const canRemoveMember = canManage && !(isSelf && member.role === "owner");
  const roleBadge = treeRoleBadge(member.role);
  return (
    <div className="flex items-center gap-3 rounded-xl bg-background/40 px-3 py-2.5">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <Avatar name={displayNameFor(member)} src={api.userAvatarUrl(member.userId)} className="h-8 w-8 text-[10px]" />
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{displayNameFor(member)}</span>
            {isSelf ? <Badge variant="outline" className="px-1.5 py-0 text-[10px]">you</Badge> : null}
            {roleBadge ? <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{roleBadge}</Badge> : null}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 rv-mono text-[11px] text-muted-foreground">
            <PresenceDot presence={presence} />
            {PRESENCE[presence].label}
          </div>
        </div>
      </button>
      {canManage ? (
        <div className="flex shrink-0 items-center gap-2">
          <Select
            value={member.role}
            onValueChange={(value) => onRole(value as TreeRole)}
          >
            <SelectTrigger size="sm" className="w-[120px]">
              <SelectValue>{member.role}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="member">member</SelectItem>
                <SelectItem value="moderator">moderator</SelectItem>
                <SelectItem value="owner" disabled={!canAssignOwner}>owner</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          {canRemoveMember ? (
            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onRemove} aria-label="Remove from group">
              <UserX className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <span className="rv-mono text-[10px] text-muted-foreground">kept</span>
          )}
        </div>
      ) : (
        null
      )}
    </div>
  );
}

function treeRoleBadge(role: TreeRole) {
  if (role === "owner") return "owner";
  if (role === "moderator") return "admin";
  return null;
}

function UserPageView({
  person,
  data,
  onNavigate,
}: {
  person: ShellPerson;
  data: RavenShellData;
  onNavigate: (view: RavenView) => void;
}) {
  const sharedTrees = person.treeIds.map((id) => data.getTree(id)).filter(Boolean);
  const activeNests = person.activeNestIds.map((id) => data.getNest(id)).filter(Boolean);
  const incomingFriendRequest = data.incomingFriendRequests.find((request) => request.fromUserId === person.id);
  const outgoingFriendRequest = data.outgoingFriendRequests.find((request) => request.toUserId === person.id);
  const isFriend = data.friends.some((friend) => friend.userId === person.id);
  return (
    <>
      <ViewHeader
        eyebrow="Person"
        title={person.name}
        meta={
          <span className="inline-flex items-center gap-1.5 rv-mono text-[12px] text-muted-foreground">
            <PresenceDot presence={person.presence} />
            {activeNests[0] ? `In ${activeNests[0].name}` : PRESENCE[person.presence].label}
          </span>
        }
        actions={
          <>
            {activeNests[0] ? (
              <Button className="gap-2" onClick={() => onNavigate({ kind: "nest", id: activeNests[0]!.id })}>
                <Phone className="h-4 w-4" />
                Open {data.labels.nestSingular}
              </Button>
            ) : null}
            <Button variant="secondary" className="gap-2" onClick={() => void data.knockUser(person.id)} disabled={data.busy}>
              <Hand className="h-4 w-4" />
              Knock
            </Button>
            <FriendActionButtons
              busy={data.busy}
              isFriend={isFriend}
              incomingRequestId={incomingFriendRequest?.id}
              outgoingRequestId={outgoingFriendRequest?.id}
              onSend={() => void data.sendFriendRequest(person.id)}
              onAccept={() => incomingFriendRequest && void data.acceptFriendRequest(incomingFriendRequest.id)}
              onDecline={() => incomingFriendRequest && void data.declineFriendRequest(incomingFriendRequest.id)}
              onCancel={() => outgoingFriendRequest && void data.cancelFriendRequest(outgoingFriendRequest.id)}
              onRemove={() => void data.removeFriend(person.id)}
            />
          </>
        }
      />
      <ViewBody>
        <div className="max-w-2xl space-y-8">
          <div className="flex items-center gap-4">
            <Avatar name={person.name} src={`${data.apiServerUrl}/v1/media/users/${person.id}/avatar`} className="h-16 w-16 text-lg" />
            <p className="text-sm leading-relaxed text-muted-foreground">
              You can see {person.name} through shared {data.labels.treeSingular} membership or current {data.labels.nestSingular} activity.
            </p>
          </div>
          <section>
            <SectionTitle>Shared spaces</SectionTitle>
            <div className="flex flex-wrap gap-2">
              {sharedTrees.map((tree) => (
                <Chip key={tree!.id} tone="primary">
                  <Network className="h-3.5 w-3.5" />
                  {tree!.name}
                </Chip>
              ))}
              {activeNests.map((nest) => (
                <Chip key={nest!.id}>
                  <Radio className="h-3.5 w-3.5" />
                  {nest!.name}
                </Chip>
              ))}
              {!sharedTrees.length && !activeNests.length ? <Chip>No shared live context</Chip> : null}
            </div>
          </section>
          <section>
            <SectionTitle>Available actions</SectionTitle>
            <div className="rv-mono space-y-1 text-[12px] leading-relaxed text-muted-foreground">
              <div>knock: available</div>
              <div>call: represented by joining or opening a {data.labels.nestSingular}</div>
              <div>friend: {isFriend ? "connected" : incomingFriendRequest ? "incoming request" : outgoingFriendRequest ? "request sent" : "not connected"}</div>
            </div>
          </section>
        </div>
      </ViewBody>
    </>
  );
}

function FriendActionButtons({
  busy,
  isFriend,
  incomingRequestId,
  outgoingRequestId,
  onSend,
  onAccept,
  onDecline,
  onCancel,
  onRemove,
}: {
  busy: boolean;
  isFriend: boolean;
  incomingRequestId?: string;
  outgoingRequestId?: string;
  onSend: () => void;
  onAccept: () => void;
  onDecline: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  if (isFriend) {
    return (
      <Button variant="outline" className="gap-2" onClick={onRemove} disabled={busy}>
        <UserMinus className="h-4 w-4" />
        Remove
      </Button>
    );
  }
  if (incomingRequestId) {
    return (
      <>
        <Button className="gap-2" onClick={onAccept} disabled={busy}>
          <Check className="h-4 w-4" />
          Accept
        </Button>
        <Button variant="ghost" className="gap-2" onClick={onDecline} disabled={busy}>
          <X className="h-4 w-4" />
          Decline
        </Button>
      </>
    );
  }
  if (outgoingRequestId) {
    return (
      <Button variant="outline" className="gap-2" onClick={onCancel} disabled={busy}>
        <X className="h-4 w-4" />
        Cancel
      </Button>
    );
  }
  return (
    <Button variant="outline" className="gap-2" onClick={onSend} disabled={busy}>
      <UserPlus className="h-4 w-4" />
      Friend
    </Button>
  );
}

function WaitingRoomView({
  nest,
  data,
  media,
  onNavigate,
}: {
  nest: Nest | LauncherNest;
  data: RavenShellData;
  media: RavenMediaAdapterState;
  onNavigate: (view: RavenView) => void;
}) {
  const details = data.getNestDetails(nest.id);
  const session = data.getActiveSession(nest.id);
  const invited = details?.members.filter((member) => member.state === "invited") ?? [];
  const inside = session?.participants ?? [];
  const cameraSummary = media.availableCameras.length
    ? `${media.availableCameras.length} camera${media.availableCameras.length === 1 ? "" : "s"} available`
    : media.cameraSupported
      ? "Camera supported; no device selected"
      : "Camera unavailable";
  const micSummary = media.availableInputDevices.length
    ? `${media.micLabel}; ${media.availableInputDevices.length} input${media.availableInputDevices.length === 1 ? "" : "s"} available`
    : media.audioSupported
      ? media.micLabel
      : "Microphone unavailable";
  const shareSummary = media.screenShareSupported
    ? `${media.availableDisplays.length} displays / ${media.availableWindows.length} windows`
    : "Screen sharing unavailable";
  const join = async () => {
    const result = await data.joinNest(nest.id);
    if (result === "joined") {
      await media.joinMediaSession(nest.id);
      onNavigate({ kind: "nest", id: nest.id });
    } else {
      onNavigate({ kind: "waiting", id: nest.id });
    }
  };
  return (
    <>
      <ViewHeader
        eyebrow={nest.type === "temporary" ? data.labels.temporaryNest : `Waiting ${data.labels.nestSingular.toLowerCase()}`}
        title={nest.name}
        subtitle={nest.type === "temporary" ? `A temporary communication space outside a ${data.labels.treeSingular}.` : treeSubtitle(data, nest.treeId)}
        meta={
          <>
            <Chip>{lifecycleLabel(nest)}</Chip>
            {nest.expiresAt ? <Chip>expires {formatRelativeTime(nest.expiresAt)}</Chip> : null}
            <Chip>{inside.length} inside</Chip>
          </>
        }
      />
      <ViewBody>
        <div className="max-w-xl space-y-6">
          <div className="rounded-2xl bg-background/40 p-5">
            <MonoLabel className="mb-4 block">Before you enter</MonoLabel>
            <div className="space-y-3">
              <DisclosureRow label="Microphone" value={micSummary}>
                <Mic className="h-4 w-4" />
              </DisclosureRow>
              <DisclosureRow label="Camera" value={cameraSummary}>
                <Video className="h-4 w-4" />
              </DisclosureRow>
              <DisclosureRow label="Share" value={shareSummary}>
                <Eye className="h-4 w-4" />
              </DisclosureRow>
              <DisclosureRow label="Visibility" value={visibilityText(nest, data)}>
                <Eye className="h-4 w-4" />
              </DisclosureRow>
              <DisclosureRow label="Invitees" value={invited.length ? invited.map((member) => displayNameFor(member)).join(", ") : "No visible invitees"}>
                <Users className="h-4 w-4" />
              </DisclosureRow>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button className="gap-2" onClick={() => void join()} disabled={data.busy || media.busy}>
              <LogIn className="h-4 w-4" />
              {media.phase === "joining" ? "Joining..." : `Join ${data.labels.nestSingular}`}
            </Button>
            <Button variant="ghost" className="ml-auto text-muted-foreground" onClick={() => onNavigate({ kind: "home" })}>
              Decline
            </Button>
          </div>
        </div>
      </ViewBody>
    </>
  );
}

function DisclosureRow({ children, label, value }: { children: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground">
        {children}
      </span>
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        <div className="rv-mono text-[11px] text-muted-foreground">{value}</div>
      </div>
    </div>
  );
}

function ActiveNestView({
  nest,
  data,
  media,
  onNavigate,
}: {
  nest: Nest | LauncherNest;
  data: RavenShellData;
  media: RavenMediaAdapterState;
  onNavigate: (view: RavenView) => void;
}) {
  const session = data.getActiveSession(nest.id);
  const mediaConnectedHere = media.phase === "connected" && media.activeNestId === nest.id;
  const connect = async () => {
    const result = await data.joinNest(nest.id);
    if (result === "joined") await media.joinMediaSession(nest.id);
  };
  const leave = async () => {
    await media.leaveMediaSession();
    onNavigate({ kind: "home" });
  };
  return (
    <>
      <RoomHeader
        roomLabel={data.labels.nestSingular}
        title={nest.name}
        subtitle={treeSubtitle(data, nest.treeId)}
        startedAt={session?.startedAt}
        actions={
          <>
            {!mediaConnectedHere ? (
              <Button size="sm" className="h-8 gap-1.5 px-3 text-xs" onClick={() => void connect()} disabled={data.busy || media.busy}>
                <LogIn className="h-4 w-4" />
                {media.phase === "joining" ? "Joining..." : `Enter ${data.labels.nestSingular}`}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 border-destructive/35 px-3 text-xs text-destructive hover:bg-destructive/10"
              onClick={() => void leave()}
              disabled={media.busy}
            >
              <LogOut className="h-4 w-4" />
              {mediaConnectedHere ? "Leave" : "Close"}
            </Button>
          </>
        }
      />
      <ViewBody className="flex flex-col px-3 pb-3 pt-2">
        <div className="flex min-h-0 flex-1 flex-col">
          <LiveMediaStage
            connected={mediaConnectedHere}
            phase={media.phase}
            error={media.error}
            errorAction={media.lastError?.action}
            audioNotice={media.audioNotice}
            audioNoticeKind={media.audioNoticeKind}
            videoState={media.videoState}
            speakingActivity={media.speakingActivity}
            videoStreamEndpoint={media.videoStreamEndpoint}
            selfMediaPreviewMode={media.selfMediaPreviewMode}
            followScreenShares={data.preferences.followScreenShares}
            onFollowScreenSharesChange={(followScreenShares) => void data.updatePreferences({ followScreenShares })}
            onConnect={() => void connect()}
            onRetryAudio={() => void media.retryIncomingAudio()}
            roomLabel={data.labels.nestSingular}
            className="flex-1"
          />
        </div>
      </ViewBody>
    </>
  );
}

function NestCard({
  nest,
  data,
  onNavigate,
}: {
  nest: Nest | LauncherNest;
  data: RavenShellData;
  onNavigate: (view: RavenView) => void;
}) {
  const session = data.getActiveSession(nest.id);
  const participants = "currentParticipants" in nest ? nest.currentParticipants : session?.participants ?? [];
  return (
    <button
      type="button"
      onClick={() => onNavigate(nest.type === "temporary" && nest.lifecycleState !== "active" ? { kind: "waiting", id: nest.id } : { kind: "nest", id: nest.id })}
      className="group flex items-center gap-3 rounded-2xl bg-background/40 p-3 text-left transition-colors hover:bg-accent/30"
    >
      <span className={cn("h-2 w-2 shrink-0 rounded-full", nest.lifecycleState === "active" ? "bg-primary" : "bg-muted-foreground")} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{nest.name}</div>
        <div className="mt-1 rv-mono text-[11px] text-muted-foreground">
          {treeSubtitle(data, nest.treeId)} · {lifecycleLabel(nest)}
        </div>
      </div>
      <AvatarStack names={participants.map((participant) => displayNameFor(participant))} />
      <span className="ml-1 rounded-full bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
        {nest.lifecycleState === "active" ? "Open" : "Preview"}
      </span>
    </button>
  );
}

function CreateTreeDialog({
  open,
  onOpenChange,
  busy,
  title,
  placeholder,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  title: string;
  placeholder: string;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const nextName = name.trim();
          if (!nextName) return;
          void onCreate(nextName).then(() => setName(""));
        }}
      >
        <Input value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder={placeholder} autoFocus />
        <Button className="w-full" disabled={busy || !name.trim()}>
          Create
        </Button>
      </form>
    </Dialog>
  );
}

function TreeSettingsView({
  details,
  data,
  onNavigate,
}: {
  details: TreeDetails;
  data: RavenShellData;
  onNavigate: (view: RavenView) => void;
}) {
  const tree = details.tree;
  const treeLabel = data.labels.treeSingular;
  const nestPlural = data.labels.nestPlural;
  const selfMember = details.members.find((member) => member.userId === data.user?.id);
  const canManage = selfMember?.role === "owner" || selfMember?.role === "moderator";
  const canDelete = selfMember?.role === "owner";

  const [active, setActive] = useState<"general" | "access" | "danger">("general");
  const [name, setName] = useState(tree.name);
  const [description, setDescription] = useState(tree.description);
  const [joinPolicy, setJoinPolicy] = useState(tree.joinPolicy);
  const [visibility, setVisibility] = useState(tree.visibility);
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setName(tree.name);
    setDescription(tree.description);
    setJoinPolicy(tree.joinPolicy);
    setVisibility(tree.visibility);
    setConfirmation("");
    setError("");
  }, [tree.id, tree.name, tree.description, tree.joinPolicy, tree.visibility]);

  if (!canManage) {
    return <MissingView title={`${treeLabel} settings unavailable`} />;
  }

  const dirty =
    name !== tree.name || description !== tree.description || joinPolicy !== tree.joinPolicy || visibility !== tree.visibility;
  const canSave = dirty && Boolean(name.trim()) && !saving;
  const editing = active !== "danger";

  const categories: SettingsCategory[] = [
    { id: "general", label: "General", icon: <Info /> },
    { id: "access", label: "Access", icon: <Shield /> },
    ...(canDelete ? [{ id: "danger", label: `Delete ${treeLabel.toLowerCase()}`, icon: <Trash2 /> } as SettingsCategory] : []),
  ];

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await data.updateTreeSettings(tree.id, {
        name: name.trim(),
        description: description.trim(),
        joinPolicy,
        visibility,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : `${treeLabel} settings could not be saved`);
    } finally {
      setSaving(false);
    }
  };
  const uploadAvatar = async (file: File) => {
    setAvatarUploading(true);
    setError("");
    try {
      await api.uploadTreeAvatar(tree.id, file);
      await data.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${treeLabel} profile image could not be uploaded`);
    } finally {
      setAvatarUploading(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setError("");
    try {
      await data.deleteTree(tree.id, confirmation.trim());
      onNavigate({ kind: "home" });
    } catch (err) {
      setError(err instanceof Error ? err.message : `${treeLabel} could not be deleted`);
      setSaving(false);
    }
  };

  return (
    <SettingsScaffold
      eyebrow={`${treeLabel} settings`}
      title={tree.name}
      subtitle={`Control how this ${treeLabel.toLowerCase()} appears and how new people may enter.`}
      meta={
        <>
          <Chip>{visibility === "public" ? "Public" : "Private"}</Chip>
          <Chip>{joinPolicy === "free" ? "Free join" : "Join requests"}</Chip>
          <Chip>{details.members.length} members</Chip>
        </>
      }
      categories={categories}
      activeId={active}
      onSelect={(id) => setActive(id as typeof active)}
      actions={
        <>
          <Button variant="ghost" className="gap-2 text-muted-foreground" onClick={() => onNavigate({ kind: "tree", id: tree.id })}>
            <ChevronLeft className="h-4 w-4" />
            Back to lobby
          </Button>
          {editing ? (
            <Button className="gap-2" onClick={() => void save()} disabled={!canSave}>
              <Check className="h-4 w-4" />
              {saving ? "Saving…" : "Save changes"}
            </Button>
          ) : null}
        </>
      }
    >
      {editing && error ? <p className="text-sm text-destructive">{error}</p> : null}

      {active === "general" ? (
        <SettingsSection title="General" description={`The name and description people see for this ${treeLabel.toLowerCase()}.`}>
          <div className="flex items-center gap-4 rounded-xl bg-card/55 p-4">
            <Avatar name={tree.name} src={api.treeAvatarUrl(tree.id, tree.updatedAt)} className="h-16 w-16 rounded-xl text-lg" />
            <div>
              <div className="text-sm font-medium">{treeLabel} profile picture</div>
              <p className="mt-1 text-xs text-muted-foreground">Square-cropped and optimized to 512 KB or less.</p>
              <SquareImageUpload disabled={avatarUploading} label={avatarUploading ? "Uploading…" : "Choose image"} onUpload={uploadAvatar} onError={setError} />
            </div>
          </div>
          <SettingsField label="Name">
            <Input value={name} onChange={(event) => setName(event.currentTarget.value)} />
          </SettingsField>
          <SettingsField label="Description" hint="What people should know before joining.">
            <textarea
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
              rows={3}
              maxLength={240}
              className="min-h-20 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="What people should know before joining"
            />
          </SettingsField>
        </SettingsSection>
      ) : null}

      {active === "access" ? (
        <SettingsSection title="Access" description={`Who can find this ${treeLabel.toLowerCase()} and how new people join.`}>
          <div className="grid gap-3 sm:grid-cols-2">
            <SettingsField label="Join policy">
              <Select value={joinPolicy} onValueChange={(value) => setJoinPolicy(value as typeof joinPolicy)}>
                <SelectTrigger className="rounded-xl border-border">
                  <SelectValue>{joinPolicy === "free" ? "Free join" : "Request required"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="free">Free join</SelectItem>
                    <SelectItem value="request">Request required</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </SettingsField>
            <SettingsField label="Visibility">
              <Select value={visibility} onValueChange={(value) => setVisibility(value as typeof visibility)}>
                <SelectTrigger className="rounded-xl border-border">
                  <SelectValue>{visibility === "public" ? "Public" : "Private"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="public">Public</SelectItem>
                    <SelectItem value="private">Private</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </SettingsField>
          </div>
          <div className="grid gap-2 rounded-xl bg-background/40 p-3 text-xs text-muted-foreground">
            <div className="flex items-start gap-2">
              {visibility === "public" ? <Globe2 className="mt-0.5 h-3.5 w-3.5" /> : <Lock className="mt-0.5 h-3.5 w-3.5" />}
              <span>{visibility === "public" ? `Public ${data.labels.treePlural.toLowerCase()} can appear in search.` : `Private ${data.labels.treePlural.toLowerCase()} stay out of search and require an existing membership or owner/moderator add.`}</span>
            </div>
            <div className="flex items-start gap-2">
              <Shield className="mt-0.5 h-3.5 w-3.5" />
              <span>{joinPolicy === "free" ? `People can join this public ${treeLabel.toLowerCase()} without approval.` : "New public join attempts wait for an owner or moderator."}</span>
            </div>
          </div>
        </SettingsSection>
      ) : null}

      {active === "danger" && canDelete ? (
        <SettingsSection title={`Delete ${treeLabel.toLowerCase()}`}>
          <SettingsHint>
            This deletes the {treeLabel.toLowerCase()}, its membership, and every {nestPlural.toLowerCase().replace(/s$/, "")} attached to it. This cannot be undone.
          </SettingsHint>
          <SettingsField label={`Type "${tree.name}" to confirm`}>
            <Input value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value)} placeholder={tree.name} />
          </SettingsField>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end">
            <Button
              type="button"
              variant="destructive"
              className="gap-2"
              disabled={saving || confirmation.trim() !== tree.name}
              onClick={() => void remove()}
            >
              <Trash2 className="h-4 w-4" />
              Delete permanently
            </Button>
          </div>
        </SettingsSection>
      ) : null}
    </SettingsScaffold>
  );
}

function CreateNestDialog({
  open,
  onOpenChange,
  busy,
  title,
  placeholder,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  title: string;
  placeholder: string;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const nextName = name.trim();
          if (!nextName) return;
          void onCreate(nextName).then(() => setName(""));
        }}
      >
        <Input value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder={placeholder} autoFocus />
        <Button className="w-full" disabled={busy || !name.trim()}>
          Create
        </Button>
      </form>
    </Dialog>
  );
}

function AddTreeMemberDialog({
  open,
  onOpenChange,
  busy,
  title,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  title: string;
  onAdd: (username: string, role: TreeRole) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<TreeRole>("member");
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const nextUsername = username.trim();
          if (!nextUsername) return;
          void onAdd(nextUsername, role).then(() => {
            setUsername("");
            setRole("member");
          });
        }}
      >
        <Input value={username} onChange={(event) => setUsername(event.currentTarget.value)} placeholder="username" autoFocus />
        <label className="block space-y-1.5 text-xs text-muted-foreground">
          Role
          <Select value={role} onValueChange={(value) => setRole(value as TreeRole)}>
            <SelectTrigger className="mt-1.5">
              <SelectValue>{role}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="member">member</SelectItem>
                <SelectItem value="moderator">moderator</SelectItem>
                <SelectItem value="owner">owner</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>
        <Button className="w-full" disabled={busy || !username.trim()}>
          Add
        </Button>
      </form>
    </Dialog>
  );
}

function treeSubtitle(data: RavenShellData, treeId?: string | null) {
  if (!treeId) return data.labels.temporaryNest;
  return data.getTree(treeId)?.name ?? data.labels.treeSingular;
}

function visibilityText(nest: Nest | LauncherNest, data?: RavenShellData) {
  if (nest.type === "temporary") return "Visible to invited or admitted participants";
  return `Visible through ${data?.labels.treeSingular ?? "Tree"} membership and ${data?.labels.nestSingular ?? "Nest"} permissions`;
}
