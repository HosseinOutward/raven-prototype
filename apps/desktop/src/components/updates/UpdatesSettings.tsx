import { invoke } from "@tauri-apps/api/core";
import { Download, RefreshCw, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadPercent, formatUpdateBytes, updateStatusLine, type RavenUpdater } from "@/lib/updater";
import {
  SettingsHint,
  SettingsReadOnlyRow,
  SettingsRow,
  SettingsRows,
  SettingsSection,
} from "@/shells/ravenv1/SettingsScaffold";

export function UpdatesSettingsPanel({ updater }: { updater: RavenUpdater }) {
  const state = updater.state;
  if (updater.loading || !state) {
    return (
      <SettingsSection title="Updates">
        <SettingsHint>Checking for updates…</SettingsHint>
      </SettingsSection>
    );
  }

  const available = state.available;
  const working = state.phase === "checking" || state.phase === "downloading" || state.phase === "installing";
  const percent = downloadPercent(state);
  const error = updater.error || state.error || "";

  return (
    <SettingsSection title={`Raven ${state.currentVersion}`} description="Raven tells you when a new version is out. It downloads and restarts only when you ask.">
      {error ? (
        <div role="alert" className="rounded-card bg-destructive/10 px-3.5 py-3 text-small">
          {error}
          {available ? (
            <>
              {" "}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => void invoke("plugin:opener|open_url", { url: available.downloadUrl }).catch(() => undefined)}
              >
                Download the installer instead
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <SettingsRows>
        <SettingsRow
          label={updateStatusLine(state)}
          description={
            state.phase === "ready" && state.busy
              ? `Raven can’t restart while ${state.busyReason || "it is in use"}.`
              : state.phase === "downloading" && state.progress
                ? `${formatUpdateBytes(state.progress.downloaded)}${state.progress.total ? ` of ${formatUpdateBytes(state.progress.total)}` : ""}`
                : undefined
          }
          control={
            state.phase === "ready" || state.phase === "installing" ? (
              <Button disabled={state.busy || working} onClick={() => void updater.install()}>
                <RotateCw className="h-4 w-4" />
                {state.phase === "installing" ? "Restarting…" : "Restart to update"}
              </Button>
            ) : state.phase === "available" || state.phase === "downloading" ? (
              <Button disabled={working} onClick={() => void updater.download()}>
                <Download className="h-4 w-4" />
                {state.phase === "downloading" ? (percent == null ? "Downloading…" : `Downloading… ${percent}%`) : "Download"}
              </Button>
            ) : (
              <Button variant="secondary" disabled={working} onClick={() => void updater.checkNow()}>
                <RefreshCw className="h-4 w-4" />
                {state.phase === "checking" ? "Checking…" : "Check now"}
              </Button>
            )
          }
        />
        {state.phase === "downloading" ? (
          <div className="px-4 py-3">
            <div
              className="h-1.5 overflow-hidden rounded-full bg-border"
              role="progressbar"
              aria-label="Download progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
            >
              <div className="h-full rounded-full bg-foreground transition-[width]" style={{ width: `${percent ?? 0}%` }} />
            </div>
          </div>
        ) : null}
        <SettingsReadOnlyRow label="Last checked" value={formatTime(state.lastCheckedAtMs)} />
      </SettingsRows>

      {available?.notes ? (
        <div className="rounded-card bg-secondary/50 px-4 py-3">
          <div className="text-body">What’s new in {available.version}</div>
          <p className="mt-1 select-text whitespace-pre-wrap text-small text-muted-foreground">{available.notes}</p>
        </div>
      ) : null}
    </SettingsSection>
  );
}

function formatTime(value?: number | null) {
  if (!value) return "Not yet";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
