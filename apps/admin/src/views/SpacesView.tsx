import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Plus } from "lucide-react";
import type { AdminApi } from "../api";
import { Badge, Button, Dialog, Field, Input, List, Loading, Notice, PageHeader, Row } from "../components/ui";
import { plural } from "../lib/format";
import { navigate, routeHref } from "../lib/route";
import { errorMessage, useLoad } from "../lib/useLoad";

export function SpacesView({ api }: { api: AdminApi }) {
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(typed), 200);
    return () => window.clearTimeout(timer);
  }, [typed]);
  const spaces = useLoad(() => api.spaces(query), query);

  return (
    <>
      <PageHeader
        title="Spaces"
        description="Every space on this server, with its rooms and members. Messages and calls stay private."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={16} aria-hidden />
            New space
          </Button>
        }
      />
      <div className="mb-4">
        <Input className="max-w-xs" type="search" placeholder="Search by space or owner" aria-label="Search spaces" value={typed} onChange={(event) => setTyped(event.target.value)} />
      </div>
      {spaces.error ? <Notice>{spaces.error}</Notice> : null}
      {spaces.data ? (
        <>
          <List empty={query ? "No spaces match." : "No spaces yet."}>
            {spaces.data.map((space) => (
              <Row key={space.id} href={routeHref({ page: "space", id: space.id })}>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate font-medium">
                    {space.name}
                    {space.visibility === "public" ? <Badge>Public</Badge> : null}
                    {!space.ownerId ? <Badge tone="warning">No owner</Badge> : null}
                    {space.ownerStatus === "suspended" ? <Badge tone="warning">Owner suspended</Badge> : null}
                  </p>
                  <p className="truncate text-small text-muted-foreground">{space.ownerUsername ? `Owned by @${space.ownerUsername}` : "Nobody owns this space"}</p>
                </div>
                <p className="hidden w-28 text-right text-small text-muted-foreground sm:block">{plural(space.voiceRooms + space.textRooms, "room")}</p>
                <p className="w-28 text-right text-small text-muted-foreground">{plural(space.memberCount, "member")}</p>
              </Row>
            ))}
          </List>
          <p className="mt-3 text-caption text-subtle">{plural(spaces.data.length, "space")}</p>
        </>
      ) : spaces.loading ? (
        <Loading />
      ) : null}
      {creating ? <CreateSpaceDialog api={api} onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function CreateSpaceDialog({ api, onClose }: { api: AdminApi; onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [ownerUsername, setOwnerUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const created = await api.createSpace({ name: name.trim(), description: description.trim(), ownerUsername: ownerUsername.trim() });
      navigate({ page: "space", id: created.space.id });
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };
  return (
    <Dialog title="New space" onClose={onClose}>
      <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
        <Field label="Name">
          {(id) => <Input id={id} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required />}
        </Field>
        <Field label="Description" hint="Optional.">
          {(id) => <Input id={id} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={240} />}
        </Field>
        <Field label="Owner’s username" hint="They run the space. This does not count against their own limit on creating spaces.">
          {(id) => <Input id={id} value={ownerUsername} onChange={(event) => setOwnerUsername(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required />}
        </Field>
        <p className="text-small text-muted-foreground">It starts private, with people joining by request. The owner can change that.</p>
        {error ? <Notice>{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim() || !ownerUsername.trim()}>
            {busy ? "Creating…" : "Create space"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
