import { useEffect, useState } from "react";
import type { AdminApi } from "../api";
import type { CapabilityDefault } from "../types";
import { Button, Input, List, Loading, Notice, PageHeader, Row, Section, Select } from "../components/ui";
import { CAPABILITY_TEXT } from "../lib/format";
import { errorMessage, useLoad } from "../lib/useLoad";

export function SettingsView({ api }: { api: AdminApi }) {
  const loaded = useLoad(() => api.capabilityDefaults(), "capability-defaults");
  const [draft, setDraft] = useState<CapabilityDefault[] | null>(null);
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!loaded.data) return;
    setDraft(loaded.data);
    const spaces = loaded.data.find((item) => item.capability === "spaces.create");
    setLimit(spaces?.limit == null ? "" : String(spaces.limit));
  }, [loaded.data]);

  const changed = draft !== null && loaded.data !== null && (JSON.stringify(draft) !== JSON.stringify(loaded.data) || limit !== currentLimit(loaded.data));

  const save = async () => {
    if (!draft) return;
    const parsed = limit.trim() === "" ? null : Number.parseInt(limit, 10);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 1)) {
      setError("The limit must be a whole number of 1 or more, or empty for no limit.");
      return;
    }
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const next = await api.setCapabilityDefaults(draft.map((item) => (item.capability === "spaces.create" ? { ...item, limit: item.allowed ? parsed : null } : item)));
      loaded.set(next);
      setSaved(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Settings" description="What applies to the whole server." />
      <Section
        title="Default permissions"
        description="What an account may do unless it has its own setting. A new account starts with these. Administrators are never limited."
        actions={
          <Button variant="primary" size="sm" disabled={!changed || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        }
      >
        {loaded.error ? <Notice>{loaded.error}</Notice> : null}
        {error ? <div className="mb-3"><Notice>{error}</Notice></div> : null}
        {saved && !changed ? <div className="mb-3"><Notice tone="neutral">Saved. It applies to everyone signed in now.</Notice></div> : null}
        {draft ? (
          <List>
            {draft.map((item) => {
              const text = CAPABILITY_TEXT[item.capability];
              return (
                <Row key={item.capability}>
                  <div className="min-w-0 flex-1 py-1">
                    <p className="font-medium">{text.title}</p>
                    <p className="text-small text-muted-foreground">{text.description}</p>
                  </div>
                  {item.capability === "spaces.create" && item.allowed ? (
                    <Input className="w-24" inputMode="numeric" aria-label="Most spaces one account may own" placeholder="No limit" value={limit} onChange={(event) => { setLimit(event.target.value); setSaved(false); }} />
                  ) : null}
                  <Select
                    aria-label={text.title}
                    value={item.allowed ? "allow" : "deny"}
                    onChange={(event) => {
                      setSaved(false);
                      setDraft(draft.map((other) => (other.capability === item.capability ? { ...other, allowed: event.target.value === "allow" } : other)));
                    }}
                  >
                    <option value="allow">Allowed</option>
                    <option value="deny">Not allowed</option>
                  </Select>
                </Row>
              );
            })}
          </List>
        ) : loaded.loading ? (
          <Loading />
        ) : null}
      </Section>
      <ServerImage api={api} />
    </>
  );
}

function currentLimit(defaults: CapabilityDefault[]): string {
  const spaces = defaults.find((item) => item.capability === "spaces.create");
  return spaces?.limit == null ? "" : String(spaces.limit);
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const IMAGE_MAX_BYTES = 512 * 1024;

function ServerImage({ api }: { api: AdminApi }) {
  // The address changes after an upload so the browser fetches the new picture.
  const [version, setVersion] = useState(0);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) {
      setError("Choose a PNG, JPEG or WebP image.");
      return;
    }
    if (file.size > IMAGE_MAX_BYTES) {
      setError("That image is larger than 512 KB. Choose a smaller one.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.uploadServerImage(file);
      setMissing(false);
      setVersion((value) => value + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Server image" description="Shown beside the server’s name in the Raven app.">
      {error ? <div className="mb-3"><Notice>{error}</Notice></div> : null}
      <div className="flex items-center gap-4 rounded-card bg-secondary/50 p-4">
        {missing ? (
          <div className="grid h-16 w-16 shrink-0 place-items-center rounded-card bg-accent text-caption text-subtle">None</div>
        ) : (
          <img src={`/v1/media/server/avatar?v=${version}`} alt="Current server image" className="h-16 w-16 shrink-0 rounded-card bg-accent object-cover" onError={() => setMissing(true)} />
        )}
        <p className="min-w-0 flex-1 text-small text-muted-foreground">A square PNG, JPEG or WebP, up to 512 KB.</p>
        <label className="inline-flex h-8 cursor-pointer items-center rounded-control bg-secondary px-3 text-small font-medium text-secondary-foreground hover:bg-accent has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring">
          {busy ? "Uploading…" : "Choose image"}
          <input type="file" accept={IMAGE_TYPES.join(",")} className="sr-only" disabled={busy} onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
        </label>
      </div>
    </Section>
  );
}
