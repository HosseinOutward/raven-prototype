import { useState } from "react";
import { capabilitiesOf } from "@/lib/permissions";
import { Hand, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useProfileKnock } from "../useProfileKnock";
import { EmptyState, GroupedList, PersonAvatar, SectionLabel } from "../atoms";
import { PendingList } from "../Inbox";
import { personStatus, reachRank } from "../people";
import { PRESENCE, type RavenShellData, type RavenView, type ShellPerson } from "../state";
import { focusGlobalSearch } from "../searchFocus";
import { usePendingActions } from "../usePendingActions";
import type { RavenMediaAdapterState } from "../useRavenMediaAdapter";
import type { NestEntryController } from "../useNestEntry";
import { NameDialog } from "./dialogs";
import { LiveNestCard, nestView } from "./shared";

/**
 * Home answers one question: who is meaningfully reachable right now?
 * It is empty and calm when nothing is happening.
 */
export function HomeView({
  data,
  media,
  entry,
  onNavigate,
}: {
  data: RavenShellData;
  media: RavenMediaAdapterState;
  entry: NestEntryController;
  onNavigate: (view: RavenView) => void;
}) {
  const [createTreeOpen, setCreateTreeOpen] = useState(false);
  const actions = usePendingActions();
  const treeSingular = data.labels.treeSingular.toLowerCase();
  const nestSingular = data.labels.nestSingular.toLowerCase();
  const liveNests = data.activeNests.filter((nest) => nest.lifecycleState === "active" || nest.activeParticipantCount > 0);
  // People already in a nest are represented by that nest's card.
  const openPeople = data.people
    .filter((person) => person.presence === "open" && person.activeNestIds.length === 0)
    .sort((a, b) => reachRank(a) - reachRank(b) || a.name.localeCompare(b.name));
  const canJoin = !entry.enteringNestId && media.phase !== "joining" && media.phase !== "leaving";
  // A request you sent is still waiting on someone, so it keeps Home from being empty:
  // this is the one place it can be seen and withdrawn.
  const quiet = data.pending.length === 0 && liveNests.length === 0 && openPeople.length === 0 && data.outgoingFriendRequests.length === 0;

  // Joining always passes the threshold, so the person sees what they will reveal first.
  const join = (nestId: string) => onNavigate({ kind: "nest", id: nestId });

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {quiet ? (
          <div className="flex min-h-full items-center justify-center p-8">
            <EmptyState
              title="It’s quiet right now"
              text={
                data.trees.length
                  ? `Nobody is in a ${nestSingular}. Open one of your ${data.labels.treePlural.toLowerCase()} to start talking, and the people there will see it.`
                  : `Raven is a home for the groups you trust. Start a ${treeSingular} for yours, or find a public one.`
              }
            >
              {capabilitiesOf(data.user).createSpaces ? (
                <Button onClick={() => setCreateTreeOpen(true)}>
                  <Plus className="h-4 w-4" />
                  New {treeSingular}
                </Button>
              ) : null}
              <Button variant="secondary" onClick={focusGlobalSearch}>
                <Search className="h-4 w-4" />
                Find a {treeSingular}
              </Button>
            </EmptyState>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
            {data.pending.length > 0 ? (
              <section>
                <SectionLabel className="mb-1">Reaching you</SectionLabel>
                <GroupedList className="p-1">
                  <PendingList data={data} onNavigate={onNavigate} />
                </GroupedList>
              </section>
            ) : null}

            {liveNests.length > 0 ? (
              <section>
                <SectionLabel className="mb-1">Live now</SectionLabel>
                <div className="grid gap-3 sm:grid-cols-2">
                  {liveNests.map((nest) => (
                    <LiveNestCard
                      key={nest.id}
                      nest={nest}
                      data={data}
                      here={media.activeNestId === nest.id}
                      canJoin={canJoin}
                      onOpen={() => onNavigate(nestView(nest))}
                      onJoin={() => join(nest.id)}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {openPeople.length > 0 ? (
              <section>
                <SectionLabel className="mb-1">Open to talk</SectionLabel>
                <GroupedList>
                  {openPeople.map((person) => (
                    <ReachableRow key={person.id} person={person} data={data} onNavigate={onNavigate} />
                  ))}
                </GroupedList>
              </section>
            ) : null}

            {data.outgoingFriendRequests.length > 0 ? (
              <section>
                <SectionLabel className="mb-1">Friend requests you sent</SectionLabel>
                <GroupedList>
                  {data.outgoingFriendRequests.map((request) => {
                    const name = request.toDisplayName || request.toUsername;
                    return (
                      <div key={request.id} className="flex items-center gap-3 px-3 py-2.5">
                        <button type="button" onClick={() => onNavigate({ kind: "user", id: request.toUserId })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                          <PersonAvatar id={request.toUserId} name={name} className="h-8 w-8" />
                          <span className="min-w-0">
                            <span className="block truncate text-small font-medium">{name}</span>
                            <span className="block text-caption text-muted-foreground">Waiting for a reply</span>
                          </span>
                        </button>
                        <Button size="sm" variant="ghost" disabled={actions.isPending(request.id)} onClick={() => actions.run(request.id, () => data.cancelFriendRequest(request.id))}>
                          Cancel request
                        </Button>
                      </div>
                    );
                  })}
                </GroupedList>
              </section>
            ) : null}
          </div>
        )}
      </div>
      <NameDialog
        open={createTreeOpen}
        onOpenChange={setCreateTreeOpen}
        title={`New ${treeSingular}`}
        description={`A ${treeSingular} is a private home for a group. You choose who joins.`}
        label="Name"
        placeholder="Weekend crew"
        submitLabel={`Create ${treeSingular}`}
        onSubmit={async (name) => {
          const tree = await data.createTree(name);
          setCreateTreeOpen(false);
          onNavigate({ kind: "tree", id: tree.id });
        }}
      />
    </>
  );
}

export function ReachableRow({ person, data, onNavigate }: { person: ShellPerson; data: RavenShellData; onNavigate: (view: RavenView) => void }) {
  const profileKnock = useProfileKnock(data, person.id);
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <button type="button" onClick={() => onNavigate({ kind: "user", id: person.id })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <PersonAvatar id={person.id} name={person.name} presence={person.presence} className="h-8 w-8" />
        <span className="min-w-0">
          <span className="block truncate text-small font-medium">{person.name}</span>
          <span className="block truncate text-caption text-muted-foreground">{personStatus(person, data) ?? PRESENCE[person.presence].label}</span>
        </span>
      </button>
      <Button variant="secondary" size="sm" disabled={profileKnock.disabled} onClick={profileKnock.knock} title={profileKnock.description}>
        <Hand className="h-4 w-4" />
        {profileKnock.label}
      </Button>
    </div>
  );
}
