import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { api, type Invite } from "@/lib/api";
import { inviteMessage } from "@/lib/invites";
import { capabilitiesOf } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { SettingsHint, SettingsPage, SettingsRows, SettingsSection } from "./SettingsScaffold";
import type { RavenShellData } from "./state";

const STATE_TEXT: Record<Invite["state"], string> = {
  open: "Open",
  used: "Used",
  expired: "Expired",
  revoked: "Withdrawn",
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "an unknown date" : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** Make single-use codes for friends, and see what became of them. */
export function InvitationsSettings({ data }: { data: RavenShellData }) {
  const limit = capabilitiesOf(data.user).maxOpenInvites ?? null;
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [making, setMaking] = useState(false);
  const [withdrawing, setWithdrawing] = useState("");
  const [error, setError] = useState("");
  // The code exists only here, once: the server keeps a hash.
  const [fresh, setFresh] = useState<{ invite: Invite; code: string } | null>(null);

  const load = async () => {
    try {
      const result = await api.listInvites();
      setInvites(result.invites);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your invites could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openCount = invites.filter((invite) => invite.state === "open").length;
  const atLimit = limit !== null && openCount >= limit;

  const make = async () => {
    setMaking(true);
    setError("");
    try {
      const result = await api.createInvite();
      setFresh(result);
      setInvites((current) => [result.invite, ...current]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The invite could not be made.");
    } finally {
      setMaking(false);
    }
  };

  const withdraw = async (invite: Invite) => {
    setWithdrawing(invite.id);
    setError("");
    try {
      await api.revokeInvite(invite.id);
      if (fresh?.invite.id === invite.id) setFresh(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The invite could not be withdrawn.");
    } finally {
      setWithdrawing("");
    }
  };

  const copy = (code: string, expiresAt: string) => {
    void navigator.clipboard.writeText(inviteMessage(data.apiServerUrl, code, expiresAt)).then(
      () => toast({ title: "Copied" }),
      () => toast({ title: "Couldn’t copy", description: "Select the code and copy it instead.", tone: "error" }),
    );
  };

  return (
    <SettingsPage
      title="Invitations"
      description="Give a friend a code to make an account here. It works once, for 7 days, and makes the two of you friends."
    >
      <SettingsSection title="New invite">
        {fresh ? (
          <div className="space-y-3 rounded-card bg-secondary/50 px-4 py-3">
            <div className="rv-mono text-title select-all">{fresh.code}</div>
            <p className="text-caption text-muted-foreground">
              You will only see this code now. It works until {formatDate(fresh.invite.expiresAt)}.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => copy(fresh.code, fresh.invite.expiresAt)}>
                Copy message
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setFresh(null)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Button disabled={making || loading || atLimit} onClick={() => void make()}>
              {making ? "Making…" : "Make an invite"}
            </Button>
            {atLimit ? (
              <span className="text-small text-muted-foreground">
                You have {openCount} open {openCount === 1 ? "invite" : "invites"}, the most you can have.
              </span>
            ) : null}
          </div>
        )}
        {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
      </SettingsSection>

      <SettingsSection title="Your invites">
        {loading ? <SettingsHint>Loading…</SettingsHint> : null}
        {!loading && invites.length === 0 ? <SettingsHint>You have not made any invites yet.</SettingsHint> : null}
        {invites.length ? (
          <SettingsRows>
            {invites.map((invite) => {
              const settled = invite.state === "expired" || invite.state === "revoked";
              return (
                <div key={invite.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <div className={cn("text-body", settled && "text-muted-foreground")}>
                      <span className="rv-mono">…{invite.hint}</span> · {STATE_TEXT[invite.state]}
                    </div>
                    <div className="mt-0.5 text-caption text-muted-foreground">
                      {invite.state === "used" && invite.usedBy
                        ? `Joined as ${invite.usedBy.displayName || invite.usedBy.username}`
                        : invite.state === "open"
                          ? `Works until ${formatDate(invite.expiresAt)}`
                          : `Made ${formatDate(invite.createdAt)}`}
                    </div>
                  </div>
                  {invite.state === "open" ? (
                    <Button variant="secondary" size="sm" className="shrink-0" disabled={Boolean(withdrawing)} onClick={() => void withdraw(invite)}>
                      {withdrawing === invite.id ? "Withdrawing…" : "Withdraw"}
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </SettingsRows>
        ) : null}
      </SettingsSection>
    </SettingsPage>
  );
}
