import type { AdminApi } from "../api";
import { Loading, Notice, PageHeader, Section } from "../components/ui";
import { describeAction, describeDetail, formatAgo } from "../lib/format";
import { routeHref } from "../lib/route";
import { useLoad } from "../lib/useLoad";

export function OverviewView({ api }: { api: AdminApi }) {
  const overview = useLoad(() => api.overview(), "overview");
  const recent = useLoad(() => api.audit(), "recent-audit");
  return (
    <>
      <PageHeader title="Overview" description="What is on this server right now." />
      {overview.error ? <Notice>{overview.error}</Notice> : null}
      {overview.data ? (
        <dl className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Users" value={overview.data.users} href={routeHref({ page: "users" })} note={overview.data.suspendedUsers > 0 ? `${overview.data.suspendedUsers} suspended` : `${overview.data.admins} admin`} />
          <Stat label="Spaces" value={overview.data.spaces} href={routeHref({ page: "spaces" })} />
          <Stat label="Rooms" value={overview.data.voiceRooms + overview.data.textRooms} note={`${overview.data.voiceRooms} voice · ${overview.data.textRooms} text`} />
          <Stat label="In calls now" value={overview.data.peopleInCalls} note={`${overview.data.liveCalls} ${overview.data.liveCalls === 1 ? "call" : "calls"}`} live={overview.data.peopleInCalls > 0} />
        </dl>
      ) : overview.loading ? (
        <Loading />
      ) : null}
      <Section title="Recent changes" actions={<a href={routeHref({ page: "audit" })} className="text-small text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">Open audit log</a>}>
        {recent.error ? <Notice>{recent.error}</Notice> : null}
        {recent.data && recent.data.length === 0 ? <p className="text-small text-muted-foreground">Nothing has been changed from the dashboard yet.</p> : null}
        <ul className="divide-y divide-border">
          {(recent.data ?? []).slice(0, 8).map((event) => (
            <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 py-2 text-small">
              <span className="font-medium">{describeAction(event.action)}</span>
              <span className="text-muted-foreground">{event.entityLabel}</span>
              <span className="text-subtle">{describeDetail(event.detail)}</span>
              <span className="ml-auto text-subtle">
                {event.actorLabel} · {formatAgo(event.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function Stat({ label, value, note, href, live }: { label: string; value: number; note?: string; href?: string; live?: boolean }) {
  const body = (
    <div className="h-full rounded-card bg-secondary/50 p-4 transition-colors">
      <dt className="text-caption text-subtle">{label}</dt>
      <dd className={live ? "mt-1 text-display font-semibold tabular-nums text-live" : "mt-1 text-display font-semibold tabular-nums"}>{value}</dd>
      {note ? <dd className="mt-0.5 text-caption text-muted-foreground">{note}</dd> : null}
    </div>
  );
  return href ? (
    <a href={href} className="block rounded-card hover:[&>div]:bg-accent/60">
      {body}
    </a>
  ) : (
    body
  );
}
