import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { api, ApiError, type AccountDeletionState } from "@/lib/api";
import { hostOf } from "@/lib/accounts";
import { canDeleteAccount, deleteErrorText, exportErrorText, exportFileName, savedFileName, type MessageChoice } from "@/lib/accountExit";
import type { RavenShellData, RavenView } from "./state";
import { SettingsChoice, SettingsPage, SettingsRow, SettingsRows, SettingsSection } from "./SettingsScaffold";

/** Taking a copy of your data, and leaving for good. */
export function YourDataSettings({ data, onNavigate }: { data: RavenShellData; onNavigate?: (view: RavenView) => void }) {
  const trees = data.labels.treePlural.toLowerCase();
  return (
    <SettingsPage title="Your data">
      <DownloadSection data={data} trees={trees} />
      <DeleteSection data={data} onNavigate={onNavigate} />
    </SettingsPage>
  );
}

function errorParts(error: unknown, fallback: string) {
  if (error instanceof ApiError) return { status: error.status, message: error.message, retryAfterSeconds: error.retryAfterSeconds };
  return { message: error instanceof Error ? error.message : fallback };
}

function DownloadSection({ data, trees }: { data: RavenShellData; trees: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const download = async () => {
    setBusy(true);
    setError("");
    try {
      const bytes = await api.exportAccount();
      const name = exportFileName(data.user?.username ?? "account", new Date());
      const saved = await invoke<string | null>("save_export_file", new Uint8Array(bytes), { headers: { "X-Raven-Export-Name": name } });
      if (saved) toast({ title: `Saved your data to ${savedFileName(saved)}.`, tone: "success" });
    } catch (err) {
      setError(exportErrorText(errorParts(err, "The copy could not be made."), new Date()));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="Download your data"
      description={`A single .zip file with your profile, settings and friends, the ${trees} you belong to, and every conversation you can still read, including the files you sent. Each conversation comes as plain text you can read anywhere, and as JSON for moving to another app.`}
    >
      <p className="text-small text-muted-foreground">Calls are never recorded. Your copy only lists when you joined and left them.</p>
      <p className="text-small text-muted-foreground">Your copy includes other people&rsquo;s messages too. Keep it somewhere private.</p>
      {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
      <Button variant="secondary" disabled={busy} onClick={() => void download()}>
        <Download className="h-4 w-4" />
        {busy ? "Preparing your copy…" : "Download my data"}
      </Button>
    </SettingsSection>
  );
}

function DeleteSection({ data, onNavigate }: { data: RavenShellData; onNavigate?: (view: RavenView) => void }) {
  const host = hostOf(data.apiServerUrl);
  const [state, setState] = useState<AccountDeletionState | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let current = true;
    // If this cannot be read the server still refuses a deletion that is blocked.
    api.accountDeletion().then((next) => current && setState(next)).catch(() => current && setState({ ownedTrees: [], onlyAdmin: false, inCall: false }));
    return () => {
      current = false;
    };
  }, []);

  const blocked = state !== null && (state.ownedTrees.length > 0 || state.onlyAdmin || state.inCall);
  return (
    <SettingsSection
      title="Delete your account"
      description={`Deleting your account on ${host} removes your profile, friends, settings and memberships for good. It can’t be undone, not even by an administrator.`}
    >
      <p className="text-small text-muted-foreground">Want to keep anything? Download your data first.</p>
      {state && blocked ? <Blockers state={state} data={data} onNavigate={onNavigate} /> : (
        <Button variant="destructive" disabled={state === null} onClick={() => setOpen(true)}>
          <Trash2 className="h-4 w-4" />
          Delete account…
        </Button>
      )}
      <DeleteDialog open={open} onOpenChange={setOpen} data={data} host={host} />
    </SettingsSection>
  );
}

function Blockers({ state, data, onNavigate }: { state: AccountDeletionState; data: RavenShellData; onNavigate?: (view: RavenView) => void }) {
  const count = state.ownedTrees.length;
  const word = (count === 1 ? data.labels.treeSingular : data.labels.treePlural).toLowerCase();
  return (
    <div className="space-y-3">
      {count > 0 ? (
        <>
          <p className="text-small">You own {count} {word}. Give each one to someone else, or delete it, before you delete your account.</p>
          <SettingsRows>
            {state.ownedTrees.map((tree) => (
              <SettingsRow
                key={tree.id}
                label={tree.name}
                control={onNavigate ? <Button variant="secondary" size="sm" onClick={() => onNavigate({ kind: "tree-settings", id: tree.id })}>Open settings</Button> : undefined}
              />
            ))}
          </SettingsRows>
        </>
      ) : null}
      {state.onlyAdmin ? <p className="text-small">You&rsquo;re the only administrator on this server. Make someone else an administrator first, in the admin dashboard.</p> : null}
      {state.inCall ? <p className="text-small">Leave the call first.</p> : null}
    </div>
  );
}

function DeleteDialog({ open, onOpenChange, data, host }: { open: boolean; onOpenChange: (open: boolean) => void; data: RavenShellData; host: string }) {
  const username = data.user?.username ?? "";
  const [choice, setChoice] = useState<MessageChoice | null>(null);
  const [password, setPassword] = useState("");
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) return;
    setChoice(null);
    setPassword("");
    setTyped("");
    setError("");
  }, [open]);

  const remove = async () => {
    if (!choice) return;
    setDeleting(true);
    setError("");
    try {
      await api.deleteAccount({ password, confirmUsername: typed, messages: choice });
      data.accountDeleted(host);
    } catch (err) {
      setError(deleteErrorText(errorParts(err, "")));
      setDeleting(false);
    }
  };

  const tree = data.labels.treeSingular.toLowerCase();
  return (
    <Dialog open={open} onOpenChange={(next) => (deleting ? undefined : onOpenChange(next))} title="Delete your account?" widthClassName="max-w-lg">
      <div className="space-y-4">
        <div className="space-y-2">
          <p id="delete-messages-label" className="text-small text-muted-foreground">Your messages:</p>
          <div role="radiogroup" aria-labelledby="delete-messages-label" className="space-y-2">
            <SettingsChoice
              title="Erase my messages"
              copy={'Everything you wrote and every file you sent is removed. People see “Message deleted” where your words were.'}
              selected={choice === "erase"}
              disabled={deleting}
              onSelect={() => setChoice("erase")}
            />
            <SettingsChoice
              title="Leave them for the people I talked with"
              copy={'Your messages and files stay in their conversations, shown as from “Deleted account”. Nobody can reply to you or reach you.'}
              selected={choice === "keep"}
              disabled={deleting}
              onSelect={() => setChoice("keep")}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <p className="text-small text-muted-foreground">What happens right away:</p>
          <ul className="list-disc space-y-1 pl-5 text-small">
            <li>You&rsquo;re signed out of Raven on every device.</li>
            <li>Your profile, picture, friends and settings are deleted.</li>
            <li>You leave every {tree}, group and conversation.</li>
            <li>Your username {username} stays reserved, so nobody can use it to pose as you.</li>
          </ul>
        </div>
        <label className="block space-y-1.5 text-small text-muted-foreground">
          Password
          <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" disabled={deleting} />
        </label>
        <label className="block space-y-1.5 text-small text-muted-foreground">
          Type {username} to confirm
          <Input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} disabled={deleting} />
        </label>
        {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={deleting} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" disabled={deleting || !canDeleteAccount({ choice, typed, username, password })} onClick={() => void remove()}>
            {deleting ? "Deleting…" : "Delete my account"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
