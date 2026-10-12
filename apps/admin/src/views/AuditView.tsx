import { useState } from "react";
import type { AdminApi } from "../api";
import type { AuditEvent } from "../types";
import { Button, List, Loading, Notice, PageHeader, Row, Select } from "../components/ui";
import { describeAction, describeDetail, formatDateTime } from "../lib/format";
import { routeHref } from "../lib/route";
import { errorMessage, useLoad } from "../lib/useLoad";

const PAGE = 100;

export function AuditView({ api }: { api: AdminApi }) {
  const [entityType, setEntityType] = useState("");
  const [older, setOlder] = useState<AuditEvent[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const first = useLoad(async () => {
    setOlder([]);
    setExhausted(false);
    return api.audit({ entityType });
  }, entityType);
  const events = [...(first.data ?? []), ...older];
  const more = async () => {
    const last = events[events.length - 1];
    if (!last) return;
    setBusy(true);
    setError("");
    try {
      const next = await api.audit({ entityType, before: last.createdAt });
      setOlder((current) => [...current, ...next]);
      if (next.length < PAGE) setExhausted(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Audit log" description="Every change made from this dashboard or the server’s command line, and every change of a space’s owner. Entries cannot be edited or removed." />
      <div className="mb-4">
        <Select aria-label="Show" value={entityType} onChange={(event) => setEntityType(event.target.value)}>
          <option value="">Everything</option>
          <option value="user">Users</option>
          <option value="space">Spaces</option>
          <option value="room">Rooms</option>
          <option value="server">Server settings</option>
        </Select>
      </div>
      {first.error ? <Notice>{first.error}</Notice> : null}
      {first.data ? (
        <List empty="Nothing has been recorded yet.">
          {events.map((event) => (
            <Row key={event.id}>
              <div className="min-w-0 flex-1 py-1">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{describeAction(event.action)}</span>
                  <Subject event={event} />
                </p>
                {describeDetail(event.detail) ? <p className="break-words text-small text-subtle">{describeDetail(event.detail)}</p> : null}
              </div>
              <div className="shrink-0 text-right text-small">
                <p className="text-muted-foreground">{event.actorLabel === "cli" ? "Command line" : `@${event.actorLabel}`}</p>
                <p className="text-subtle">{formatDateTime(event.createdAt)}</p>
              </div>
            </Row>
          ))}
        </List>
      ) : first.loading ? (
        <Loading />
      ) : null}
      {error ? <div className="mt-3"><Notice>{error}</Notice></div> : null}
      {first.data && first.data.length >= PAGE && !exhausted ? (
        <div className="mt-4 flex justify-center">
          <Button size="sm" disabled={busy} onClick={() => void more()}>
            {busy ? "Loading…" : "Show older"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function Subject({ event }: { event: AuditEvent }) {
  const label = event.entityLabel || event.entityId;
  // A deleted space has no page to open.
  if (event.entityType === "user") {
    return (
      <a href={routeHref({ page: "user", id: event.entityId })} className="text-muted-foreground hover:underline">
        @{label}
      </a>
    );
  }
  if (event.entityType === "space" && event.action !== "space.deleted") {
    return (
      <a href={routeHref({ page: "space", id: event.entityId })} className="text-muted-foreground hover:underline">
        {label}
      </a>
    );
  }
  return <span className="text-muted-foreground">{label}</span>;
}
