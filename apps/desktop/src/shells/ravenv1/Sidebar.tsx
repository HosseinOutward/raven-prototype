import type { ReactNode } from "react";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { Hand, Mail, Network, Radio, Users } from "lucide-react";
import { AvatarStack, Island, MonoLabel, PresenceDot } from "./atoms";
import { displayNameFor, PRESENCE, type RavenShellData, type RavenView } from "./state";

export function Sidebar({
  view,
  data,
  onNavigate,
}: {
  view: RavenView;
  data: RavenShellData;
  onNavigate: (view: RavenView) => void;
}) {
  const activeTreeCount = data.trees.filter((tree) => {
    const details = data.treeDetails[tree.id];
    return details ? details.activeNests.length > 0 : true;
  }).length;
  const serverName = data.serverProperties.name || "Raven";
  const serverDescription = data.serverProperties.description || "Desktop RTC";

  return (
    <Island className="flex min-h-0 flex-col">
      <div className="flex items-start gap-2.5 px-4 pb-3 pt-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">
          {data.serverProperties.avatar ? (
            <img src={data.serverProperties.avatar} alt="" className="h-full w-full rounded-xl object-cover" />
          ) : (
            serverName.slice(0, 1).toUpperCase()
          )}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold tracking-tight">{serverName}</div>
          <div className="max-h-8 overflow-hidden text-xs leading-4 text-muted-foreground">{serverDescription}</div>
        </div>
        <span className="rv-mono ml-auto text-[10px] text-muted-foreground/70">self-hosted</span>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-2 pb-4 pt-1">
        {data.pending.length > 0 ? (
          <Section label="Reaching you" count={data.pending.length}>
            {data.pending.map((item) => (
              <Row
                key={`${item.kind}:${item.id}`}
                onClick={() => {
                  if (item.kind === "knock") onNavigate({ kind: "user", id: item.fromId });
                  else if (item.kind === "friend") onNavigate({ kind: "user", id: item.fromId });
                  else if (item.kind === "invite") onNavigate({ kind: "waiting", id: item.nestId });
                  else onNavigate({ kind: "waiting", id: item.nestId });
                }}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary/50 text-muted-foreground">
                  {item.kind === "knock" ? <Hand className="h-4 w-4" /> : item.kind === "friend" ? <Users className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{item.from}</div>
                  <div className="truncate rv-mono text-[11px] text-muted-foreground">{item.context}</div>
                </div>
              </Row>
            ))}
          </Section>
        ) : null}

        <Section label="Active people" count={data.people.length}>
          {data.people.length ? (
            data.people.map((person) => (
              <Row
                key={person.id}
                active={view.kind === "user" && view.id === person.id}
                onClick={() => onNavigate({ kind: "user", id: person.id })}
              >
                <Avatar name={person.name} className="h-8 w-8 text-[10px]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{person.name}</div>
                  <div className="truncate rv-mono text-[11px] text-muted-foreground">{PRESENCE[person.presence].label}</div>
                </div>
                <PresenceDot presence={person.presence} />
              </Row>
            ))
          ) : (
            <EmptyRow text="No reachable people" />
          )}
        </Section>

        <Section label={data.labels.activeTrees} count={activeTreeCount}>
          {data.trees.length ? (
            data.trees.map((tree) => {
              const details = data.treeDetails[tree.id];
              const liveCount = details?.activeNests.length ?? 0;
              return (
                <Row key={tree.id} active={view.kind === "tree" && view.id === tree.id} onClick={() => onNavigate({ kind: "tree", id: tree.id })}>
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary/60 text-muted-foreground">
                    <Network className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">{tree.name}</div>
                    <div className="truncate rv-mono text-[11px] text-muted-foreground">
                      {liveCount} live · {details?.members.length ?? 1} members
                    </div>
                  </div>
                </Row>
              );
            })
          ) : (
            <EmptyRow text={`No ${data.labels.treePlural.toLowerCase()} yet`} />
          )}
        </Section>

        <Section label={data.labels.liveNests} count={data.activeNests.length}>
          {data.activeNests.length ? (
            data.activeNests.map((nest) => (
              <Row
                key={nest.id}
                active={(view.kind === "nest" || view.kind === "waiting") && view.id === nest.id}
                onClick={() => onNavigate(nest.type === "temporary" && nest.lifecycleState !== "active" ? { kind: "waiting", id: nest.id } : { kind: "nest", id: nest.id })}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
                  <Radio className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{nest.name}</div>
                  <div className="truncate rv-mono text-[11px] text-muted-foreground">
                    {treeName(data, nest.treeId)} · {nest.activeParticipantCount} inside
                  </div>
                </div>
                <AvatarStack names={nest.currentParticipants.map((participant) => displayNameFor(participant))} max={3} />
              </Row>
            ))
          ) : (
            <EmptyRow text={`No live ${data.labels.nestPlural.toLowerCase()}`} />
          )}
        </Section>
      </div>
    </Island>
  );
}

function treeName(data: RavenShellData, treeId?: string | null) {
  if (!treeId) return "Temporary";
  return data.getTree(treeId)?.name ?? data.labels.treeSingular;
}

function Section({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2 px-2.5">
        <MonoLabel>{label}</MonoLabel>
        <span className="rv-mono text-[10px] text-muted-foreground/60">{count}</span>
      </div>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

function Row({ children, active, onClick }: { children: ReactNode; active?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
        active ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      {children}
    </button>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div className="px-2.5 py-2 rv-mono text-[11px] text-muted-foreground">{text}</div>;
}
