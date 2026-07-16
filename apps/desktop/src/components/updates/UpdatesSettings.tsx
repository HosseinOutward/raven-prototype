import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Download,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  canRestartForUpdate,
  formatUpdateBytes,
  updatePhaseLabel,
  type MeteredBehavior,
  type RavenUpdater,
  type UpdateChannel,
  type UpdateCohort,
} from "@/lib/updater";
import {
  SettingsField,
  SettingsHint,
  SettingsReadOnlyRow,
  SettingsSection,
  SettingsToggleRow,
} from "@/shells/ravenv1/SettingsScaffold";

export function UpdatesSettingsPanel({ updater }: { updater: RavenUpdater }) {
  const state = updater.state;
  const [copied, setCopied] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const lastCheck = useMemo(
    () => formatTime(state?.lastSuccessfulCheckAtMs),
    [state?.lastSuccessfulCheckAtMs],
  );

  if (updater.loading || !state) {
    return (
      <SettingsSection title="Updates">
        <SettingsHint>Opening the local updater state...</SettingsHint>
      </SettingsSection>
    );
  }

  const consent = state.settings.consent;
  const available = state.available;
  const progress = state.progress;
  const restartAvailable = canRestartForUpdate(state);
  const reportCopy = async () => {
    const report = await updater.getRedactedReport();
    await navigator.clipboard.writeText(report);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <>
      {updater.error ? (
        <div className="rounded-xl border border-destructive/35 bg-destructive/10 p-4 text-sm">
          <div className="font-medium text-destructive">Update action could not complete</div>
          <p className="mt-1 leading-5 text-muted-foreground">{updater.error}</p>
          <Button className="mt-3" size="sm" variant="outline" onClick={updater.clearError}>Dismiss</Button>
        </div>
      ) : null}

      {!consent.deliveryAccepted ? (
        <SettingsSection
          title="Closed-alpha update enrollment"
          description="Raven does not contact the managed update service until you accept this delivery contract."
        >
          {state.access.mode !== "allowed" ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
              <div className="text-sm font-medium">Service access remains restricted for Raven {state.currentVersion}</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {state.access.message || "The last confirmed compatibility policy still requires recovery."} With managed delivery consent withdrawn, Raven will not check for or download a repair. You can re-enroll below or use the exact signed manual recovery installer.
              </p>
            </div>
          ) : null}
          <div className="rounded-xl border border-primary/25 bg-primary/5 p-4 text-sm leading-6 text-muted-foreground">
            <div className="font-medium text-foreground">Minimum data needed to deliver updates</div>
            <p className="mt-2">
              Raven sends its current version, Windows or Linux target, x86_64 architecture, selected channel and cohort,
              anonymous installation identifier, stable rollout bucket, update protocol and capabilities, consent version,
              and request time. The service also sees network information inherent to the request.
            </p>
            <p className="mt-2">
              The installation identifier is random, stays on this device, and is separate from your Raven account.
              It is used only to keep staged rollout membership stable. Nest activity, media state, relationships, and
              hardware fingerprints are not update-delivery data.
            </p>
            <p className="mt-2">
              Enrollment data and outstanding download grants are removed when withdrawal reaches the service. Request logs are operational records, not behavioral analytics. Any detailed diagnostic report you explicitly share expires after 14 days.
            </p>
          </div>
          <Button
            className="w-fit gap-2"
            disabled={updater.busy}
            onClick={() => void updater.updateSettings({ deliveryAccepted: true })}
          >
            <ShieldCheck className="h-4 w-4" />
            Accept and enroll this installation
          </Button>
          {state.endpointStatus === "consent_withdrawal_pending" ? (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/8 p-3 text-xs leading-5 text-muted-foreground">
              Local update activity has stopped. Raven will retry the single-purpose enrollment removal request when the update service is reachable; it will not check for or download updates while consent is withdrawn.
            </div>
          ) : null}
          <SettingsHint>You can withdraw enrollment below. Withdrawing stops checks and removes staged update data, but a last-known safety block remains visible.</SettingsHint>
        </SettingsSection>
      ) : (
        <>
          <SettingsSection title="Update status" description="Raven checks and verifies updates without silently installing them.">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-background/40 p-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{updatePhaseLabel(state.phase)}</span>
                  <Badge variant={severityVariant(available?.classification)}>{available?.classification ?? "current"}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {available?.message || "No newer signed release is currently selected for this installation."}
                </p>
              </div>
              <Button
                variant="outline"
                className="gap-2"
                disabled={updater.busy || state.phase === "checking" || state.phase === "downloading" || state.phase === "installing"}
                onClick={() => void updater.checkNow()}
              >
                <RefreshCw className={`h-4 w-4 ${state.phase === "checking" ? "animate-spin" : ""}`} />
                Check now
              </Button>
            </div>
            <SettingsReadOnlyRow label="Current version" value={state.currentVersion} />
            <SettingsReadOnlyRow label="Last successful check" value={lastCheck} />
            <SettingsReadOnlyRow label="Update endpoint" value={humanize(state.endpointStatus)} />
            <SettingsReadOnlyRow label="Rollout eligibility" value={`${humanize(state.rolloutEligibility)} · bucket ${state.rolloutBucket} of 9999`} />
          </SettingsSection>

          {available ? (
            <SettingsSection title={`Raven ${available.version}`} description={available.message}>
              <div className="grid gap-3 sm:grid-cols-2">
                <StatusCard label="Download" value={formatUpdateBytes(available.size)} />
                <StatusCard label="Signature" value={available.signaturePresent ? "Present" : "Missing"} danger={!available.signaturePresent} />
                <StatusCard label="Verification" value={humanize(state.verificationStatus)} />
                <StatusCard label="Compatibility" value={available.compatibility.message || "Compatible"} />
              </div>
              {available.notes ? (
                <div className="whitespace-pre-wrap rounded-xl bg-background/40 p-4 text-sm leading-6 text-muted-foreground">
                  {available.notes}
                </div>
              ) : null}
              {progress ? (
                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{formatUpdateBytes(progress.downloaded)} downloaded</span>
                    <span>{progress.percent ?? 0}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress.percent ?? 0}%` }} />
                  </div>
                </div>
              ) : null}
              {!state.downloaded ? (
                <Button
                  className="w-fit gap-2"
                  disabled={updater.busy || state.phase === "downloading" || state.phase === "paused"}
                  onClick={() => void updater.download(state.meteredConnection === "metered")}
                >
                  <Download className="h-4 w-4" />
                  {state.meteredConnection === "metered" ? `Approve ${formatUpdateBytes(available.size)} download` : "Download update"}
                </Button>
              ) : (
                <div className="space-y-3 rounded-xl border border-primary/25 bg-primary/5 p-4">
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                    <div>
                      <div className="text-sm font-medium">Signed update staged</div>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Raven verified the Tauri signature, {formatUpdateBytes(state.downloaded.size)} size, and SHA-256 hash.
                        A recovered download is revalidated and re-verified before installation.
                      </p>
                    </div>
                  </div>
                  {state.activeSession ? (
                    <div className="flex gap-2 rounded-lg bg-amber-500/10 p-3 text-xs leading-5 text-amber-200">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      Raven will not restart while {state.activeSessionReason || "a communication or device operation is active"}. The update can install after you leave or normally close Raven.
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      className="gap-2"
                      disabled={updater.busy || !restartAvailable}
                      onClick={() => void updater.installNow()}
                    >
                      <RefreshCw className="h-4 w-4" />
                      {state.verifiedInCurrentProcess ? "Restart now" : "Reverify and restart"}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={updater.busy}
                      onClick={() => void updater.setInstallOnClose(!state.installOnClose)}
                    >
                      {state.installOnClose ? "Cancel install on close" : "Install when Raven closes"}
                    </Button>
                  </div>
                </div>
              )}
            </SettingsSection>
          ) : null}

          {state.lastError ? (
            <SettingsSection title="What needs attention">
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                <div className="text-sm font-medium">{state.lastError.message}</div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{state.lastError.action}</p>
                <div className="mt-3 text-[11px] text-muted-foreground">
                  Current installation: {state.lastError.currentInstallationSafe ? "unchanged and safe" : "restricted pending recovery"} · Communication/privacy state: {state.lastError.communicationOrPrivacyAffected ? "may be affected" : "not affected by this updater failure"}
                </div>
                {state.installationStatus === "startup_failed" || state.installationStatus === "rollback_refused" ? (
                  <Button
                    variant="outline"
                    className="mt-3 gap-2"
                    disabled={updater.busy}
                    onClick={() => void updater.attemptRollback()}
                  >
                    <RotateCcw className="h-4 w-4" />
                    Request approved rollback
                  </Button>
                ) : null}
              </div>
            </SettingsSection>
          ) : null}

          <SettingsSection title="Delivery controls" description="These choices save locally on this installation.">
            <SettingsField label="Channel" hint={state.settings.channel === "alpha" ? "Alpha can contain less-tested builds. Switching channels never silently downgrades Raven." : "Stable receives releases after wider validation."}>
              <Select
                value={state.settings.channel}
                disabled={updater.busy}
                onValueChange={(value) => void updater.updateSettings({ channel: value as UpdateChannel })}
              >
                <SelectTrigger className="rounded-xl border-border"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup><SelectItem value="alpha">Alpha</SelectItem><SelectItem value="stable">Stable</SelectItem></SelectGroup></SelectContent>
              </Select>
            </SettingsField>
            <SettingsField label="Closed-alpha cohort" hint="Cohort eligibility and the anonymous installation bucket remain separate from your Raven account.">
              <Select
                value={state.settings.cohort}
                disabled={updater.busy}
                onValueChange={(value) => void updater.updateSettings({ cohort: value as UpdateCohort })}
              >
                <SelectTrigger className="rounded-xl border-border"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup><SelectItem value="friends">Friends</SelectItem><SelectItem value="internal">Internal</SelectItem></SelectGroup></SelectContent>
              </Select>
            </SettingsField>
            <SettingsToggleRow
              label="Download updates automatically"
              description="Downloads may happen in the background on ordinary connections. Installation still needs your action."
              checked={state.settings.automaticDownload}
              disabled={updater.busy}
              onChange={(automaticDownload) => void updater.updateSettings({ automaticDownload })}
            />
            <SettingsField label="Metered connections">
              <Select
                value={state.settings.meteredBehavior}
                disabled={updater.busy}
                onValueChange={(value) => void updater.updateSettings({ meteredBehavior: value as MeteredBehavior })}
              >
                <SelectTrigger className="rounded-xl border-border"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup><SelectItem value="ask">Ask before downloading</SelectItem><SelectItem value="never">Never download automatically</SelectItem><SelectItem value="allow">Allow automatic download</SelectItem></SelectGroup></SelectContent>
              </Select>
            </SettingsField>
          </SettingsSection>

          <SettingsSection title="Outcome and diagnostic consent" description="Neither option is required for update delivery.">
            <SettingsToggleRow
              label="Share anonymous aggregate outcomes"
              description="Shares update stage, success or failure, versions, platform, architecture, and a coarse error category. It excludes account identity and Nest or media activity."
              checked={consent.aggregateOutcomes}
              disabled={updater.busy}
              onChange={(aggregateOutcomes) => void updater.updateSettings({ aggregateOutcomes })}
            />
            <SettingsToggleRow
              label="Allow detailed diagnostics sharing"
              description="Enables the separate Share report action. Reports are redacted locally and are never sent automatically."
              checked={consent.detailedDiagnostics}
              disabled={updater.busy}
              onChange={(detailedDiagnostics) => void updater.updateSettings({ detailedDiagnostics })}
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" className="gap-2" onClick={() => setShowDiagnostics((value) => !value)}>
                <ShieldCheck className="h-4 w-4" />
                {showDiagnostics ? "Hide local diagnostics" : "View local diagnostics"}
              </Button>
              <Button variant="outline" className="gap-2" onClick={() => void reportCopy()}>
                <Clipboard className="h-4 w-4" />
                {copied ? "Copied redacted report" : "Copy redacted report"}
              </Button>
              <Button
                variant="outline"
                disabled={!consent.detailedDiagnostics || updater.busy}
                onClick={() => void updater.shareDiagnostics()}
              >
                Share this redacted report
              </Button>
            </div>
            {showDiagnostics ? <Diagnostics state={state} /> : null}
          </SettingsSection>

          <SettingsSection title="Enrollment">
            <Button
              variant="outline"
              className="w-fit text-destructive hover:text-destructive"
              disabled={updater.busy}
              onClick={() => void updater.updateSettings({ deliveryAccepted: false })}
            >
              Withdraw managed update consent
            </Button>
            <SettingsHint>Withdrawal stops managed checks and outcome sharing and removes staged update data. Manual signed recovery remains available.</SettingsHint>
          </SettingsSection>
        </>
      )}
    </>
  );
}

function Diagnostics({ state }: { state: NonNullable<RavenUpdater["state"]> }) {
  return (
    <div className="space-y-3 rounded-xl bg-background/50 p-4">
      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <DiagnosticValue label="Platform" value={`${state.platform} / ${state.architecture}`} />
        <DiagnosticValue label="Channel" value={`${state.settings.channel} / ${state.settings.cohort}`} />
        <DiagnosticValue label="Artifact" value={state.available ? `${state.available.version} · ${formatUpdateBytes(state.available.size)}` : "None"} />
        <DiagnosticValue label="SHA-256" value={state.available ? `${state.available.sha256.slice(0, 16)}…` : "None"} />
        <DiagnosticValue label="Verification" value={humanize(state.verificationStatus)} />
        <DiagnosticValue label="Installation" value={humanize(state.installationStatus)} />
        <DiagnosticValue label="Compatibility" value={state.compatibility.status || "not checked"} />
      </div>
      <div className="max-h-48 space-y-1 overflow-auto rounded-lg bg-background/70 p-3 rv-mono text-[10px] leading-4 text-muted-foreground">
        {state.logs.length ? state.logs.map((entry) => (
          <div key={`${entry.atMs}-${entry.event}`}>
            {new Date(entry.atMs).toLocaleTimeString()} · {entry.event} · {entry.message}
          </div>
        )) : <div>No local updater log entries yet.</div>}
      </div>
      <SettingsHint>The report omits the installation identifier and automatically redacts tokens, cookies, credentials, account identifiers, IP addresses, and home-directory usernames.</SettingsHint>
    </div>
  );
}

function StatusCard({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="rounded-xl bg-background/40 p-3">
      <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className={`mt-1 text-sm ${danger ? "text-destructive" : "text-foreground"}`}>{value}</div>
    </div>
  );
}

function DiagnosticValue({ label, value }: { label: string; value: string }) {
  return <div><span className="text-muted-foreground">{label}:</span> {value}</div>;
}

function formatTime(value?: number | null) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function severityVariant(classification?: string) {
  return classification === "required" || classification === "blocked" ? "warning" : "secondary";
}

function humanize(value: string) {
  return value.replace(/_/g, " ");
}
