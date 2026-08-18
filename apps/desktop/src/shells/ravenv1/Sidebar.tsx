import type { ReactNode } from "react";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { Hand, Mail, PanelLeftClose, PanelLeftOpen, Radio, Users } from "lucide-react";
import { AvatarStack, Island, MonoLabel, PresenceDot } from "./atoms";
import { displayNameFor, PRESENCE, type RavenShellData, type RavenView } from "./state";

export function Sidebar({
  view,
  data,
  collapsed,
  onToggle,
  onNavigate,
}: {
  view: RavenView;
  data: RavenShellData;
  collapsed: boolean;
  onToggle: () => void;
  onNavigate: (view: RavenView) => void;
}) {
  const activeTreeCount = data.trees.filter((tree) => {
    const details = data.treeDetails[tree.id];
    return details ? details.activeNests.length > 0 : true;
  }).length;
  const serverName = data.serverProperties.name || "Raven";
  const serverDescription = data.serverProperties.description || "Desktop RTC";

  return (
    <Island className="relative flex min-h-0 flex-col">
      <div className={cn("flex items-start gap-2.5 pb-3 pt-4", collapsed ? "justify-center px-2" : "px-4")}>
        {!collapsed ? (
          <>
            <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-primary text-sm font-bold text-primary-foreground">
              {data.serverProperties.avatar ? (
                <img src={data.serverProperties.avatar.startsWith("/") ? data.apiServerUrl + data.serverProperties.avatar : data.serverProperties.avatar} alt="" className="h-full w-full object-cover" draggable={false} />
              ) : (
                serverName.slice(0, 1).toUpperCase()
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <div className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">{serverName}</div>
                <span className="rv-mono shrink-0 text-[10px] text-muted-foreground/70">self-hosted</span>
              </div>
              <div className="max-h-8 overflow-hidden text-xs leading-4 text-muted-foreground">{serverDescription}</div>
            </div>
          </>
        ) : null}

        <button
          type="button"
          onClick={onToggle}
          className={cn(
            "flex shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            collapsed ? "h-10 w-10 rounded-xl bg-secondary/35" : "h-8 w-8 rounded-lg",
          )}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>

      <div className={cn("min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-1", collapsed ? "space-y-3" : "space-y-5")}>
        {data.pending.length > 0 ? (
          <Section label="Reaching you" count={data.pending.length} collapsed={collapsed}>
            {data.pending.map((item) => (
              <Row collapsed={collapsed} title={`${item.from}: ${item.context}`}
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
                <div className={cn("min-w-0 flex-1", collapsed && "hidden")}>
                  <div className="truncate text-xs font-medium">{item.from}</div>
                  <div className="truncate rv-mono text-[11px] text-muted-foreground">{item.context}</div>
                </div>
              </Row>
            ))}
          </Section>
        ) : null}

        <Section label="Active people" count={data.people.length} collapsed={collapsed}>
          {data.people.length ? (
            data.people.map((person) => (
              <Row collapsed={collapsed} title={person.name}
                key={person.id}
                active={view.kind === "user" && view.id === person.id}
                onClick={() => onNavigate({ kind: "user", id: person.id })}
              >
                <Avatar name={person.name} src={`${data.apiServerUrl}/v1/media/users/${person.id}/avatar`} className="h-8 w-8 text-[10px]" />
                <div className={cn("min-w-0 flex-1", collapsed && "hidden")}>
                  <div className="truncate text-xs font-medium">{person.name}</div>
                  <div className="truncate rv-mono text-[11px] text-muted-foreground">{PRESENCE[person.presence].label}</div>
                </div>
                {!collapsed ? <PresenceDot presence={person.presence} /> : null}
              </Row>
            ))
          ) : (
            <EmptyRow text="No reachable people" collapsed={collapsed} />
          )}
        </Section>

        <Section label={data.labels.activeTrees} count={activeTreeCount} collapsed={collapsed}>
          {data.trees.length ? (
            data.trees.map((tree) => {
              const details = data.treeDetails[tree.id];
              const liveCount = details?.activeNests.length ?? 0;
              return (
                <Row key={tree.id} title={tree.name} collapsed={collapsed} active={view.kind === "tree" && view.id === tree.id} onClick={() => onNavigate({ kind: "tree", id: tree.id })}>
                  <Avatar name={tree.name} src={`${data.apiServerUrl}/v1/media/trees/${tree.id}/avatar?v=${encodeURIComponent(tree.updatedAt)}`} className="h-8 w-8 rounded-lg text-[10px]" />
                  <div className={cn("min-w-0 flex-1", collapsed && "hidden")}>
                    <div className="truncate text-xs font-medium">{tree.name}</div>
                    <div className="truncate rv-mono text-[11px] text-muted-foreground">
                      {liveCount} live · {details?.members.length ?? 1} members
                    </div>
                  </div>
                </Row>
              );
            })
          ) : (
            <EmptyRow text={`No ${data.labels.treePlural.toLowerCase()} yet`} collapsed={collapsed} />
          )}
        </Section>

        <Section label={data.labels.liveNests} count={data.activeNests.length} collapsed={collapsed}>
          {data.activeNests.length ? (
            data.activeNests.map((nest) => (
              <Row collapsed={collapsed} title={nest.name}
                key={nest.id}
                active={(view.kind === "nest" || view.kind === "waiting") && view.id === nest.id}
                onClick={() => onNavigate(nest.type === "temporary" && nest.lifecycleState !== "active" ? { kind: "waiting", id: nest.id } : { kind: "nest", id: nest.id })}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
                  <Radio className="h-4 w-4" />
                </span>
                <div className={cn("min-w-0 flex-1", collapsed && "hidden")}>
                  <div className="truncate text-xs font-medium">{nest.name}</div>
                  <div className="truncate rv-mono text-[11px] text-muted-foreground">
                    {treeName(data, nest.treeId)} · {nest.activeParticipantCount} inside
                  </div>
                </div>
                {!collapsed ? <AvatarStack names={nest.currentParticipants.map((participant) => displayNameFor(participant))} max={3} /> : null}
              </Row>
            ))
          ) : (
            <EmptyRow text={`No live ${data.labels.nestPlural.toLowerCase()}`} collapsed={collapsed} />
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

function Section({ label, count, collapsed, children }: { label: string; count: number; collapsed: boolean; children: ReactNode }) {
  return (
    <section>
      <div className={cn("mb-1.5 items-center gap-2 px-2.5", collapsed ? "hidden" : "flex")}>
        <MonoLabel>{label}</MonoLabel>
        <span className="rv-mono text-[10px] text-muted-foreground/60">{count}</span>
      </div>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

function Row({ children, active, collapsed, title, onClick }: { children: ReactNode; active?: boolean; collapsed?: boolean; title?: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
        collapsed && "justify-center px-2",
        active ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      {children}
    </button>
  );
}

function EmptyRow({ text, collapsed }: { text: string; collapsed: boolean }) {
  return collapsed ? null : <div className="px-2.5 py-2 rv-mono text-[11px] text-muted-foreground">{text}</div>;
}
