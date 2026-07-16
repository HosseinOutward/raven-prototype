import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  RAVEN_CLIENT_CAPABILITIES,
  RAVEN_PROTOCOL_VERSION,
  subscribeApiCompatibilityFailures,
  type ServerCompatibility,
} from "@/lib/api";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "awaiting_restart"
  | "installing"
  | "deferred"
  | "paused"
  | "check_failed"
  | "download_failed"
  | "verification_failed"
  | "installation_failed"
  | "unsupported_version"
  | "blocked_version";

export type UpdateChannel = "alpha" | "stable";
export type UpdateCohort = "internal" | "friends";
export type MeteredBehavior = "ask" | "never" | "allow";
export type MeteredConnection = "unknown" | "unmetered" | "metered";
export type UpdateClassification = "optional" | "recommended" | "required" | "blocked";
export type AccessMode = "allowed" | "required" | "unsupported" | "blocked";

export interface UpdateCompatibility {
  status: string;
  reasonCode: string;
  message: string;
  clientVersion: string;
  serverVersion: string;
  protocolVersion: number;
  minimumClientVersion: string;
  recommendedClientVersion: string;
  minimumServerVersion: string;
  maximumServerVersion: string;
  requiredCapabilities: string[];
  missingCapabilities: string[];
  graceEndsAt?: string | null;
}

export interface UpdateAccess {
  mode: AccessMode;
  reasonCode: string;
  message: string;
}

export interface UpdateSettings {
  channel: UpdateChannel;
  cohort: UpdateCohort;
  automaticDownload: boolean;
  meteredBehavior: MeteredBehavior;
  consent: {
    deliveryAccepted: boolean;
    deliveryConsentVersion: string;
    deliveryAcceptedAtMs?: number | null;
    aggregateOutcomes: boolean;
    detailedDiagnostics: boolean;
  };
}

export interface AvailableUpdate {
  releaseId: string;
  version: string;
  notes: string;
  publishedAt?: string | null;
  classification: UpdateClassification;
  size: number;
  sha256: string;
  signaturePresent: boolean;
  eligible: boolean;
  rolloutBucket: number;
  decision: string;
  reasonCode: string;
  message: string;
  compatibility: UpdateCompatibility;
  localDataSchemaVersion: number;
  localMigrationReversible: boolean;
  rollbackSafe: boolean;
  approvedRollbackReleaseId?: string | null;
}

export interface DownloadedUpdate {
  releaseId: string;
  version: string;
  stagingFile: string;
  size: number;
  sha256: string;
  verifiedAtMs: number;
}

export interface UpdaterError {
  category: string;
  message: string;
  action: string;
  currentInstallationSafe: boolean;
  communicationOrPrivacyAffected: boolean;
  retryable: boolean;
  atMs: number;
}

export interface UpdaterSnapshot {
  schemaVersion: number;
  currentVersion: string;
  endpoint: string;
  platform: string;
  architecture: string;
  rolloutBucket: number;
  settings: UpdateSettings;
  phase: UpdatePhase;
  phaseChangedAtMs: number;
  available?: AvailableUpdate | null;
  downloaded?: DownloadedUpdate | null;
  progress?: { downloaded: number; total?: number | null; percent?: number | null } | null;
  verifiedInCurrentProcess: boolean;
  installOnClose: boolean;
  activeSession: boolean;
  activeSessionReason: string;
  meteredConnection: MeteredConnection;
  lastSuccessfulCheckAtMs?: number | null;
  lastCheckAttemptAtMs?: number | null;
  nextAutomaticCheckAtMs?: number | null;
  endpointStatus: string;
  rolloutEligibility: string;
  verificationStatus: string;
  installationStatus: string;
  compatibility: UpdateCompatibility;
  access: UpdateAccess;
  lastError?: UpdaterError | null;
  retryAttempt: number;
  logs: Array<{ atMs: number; level: string; event: string; message: string }>;
}

export interface UpdateSettingsPatch {
  channel?: UpdateChannel;
  cohort?: UpdateCohort;
  automaticDownload?: boolean;
  meteredBehavior?: MeteredBehavior;
  deliveryAccepted?: boolean;
  aggregateOutcomes?: boolean;
  detailedDiagnostics?: boolean;
}

export interface RavenUpdater {
  state: UpdaterSnapshot | null;
  loading: boolean;
  busy: boolean;
  error: string;
  refresh: () => Promise<void>;
  checkNow: () => Promise<void>;
  download: (approveMetered?: boolean) => Promise<void>;
  installNow: () => Promise<void>;
  setInstallOnClose: (enabled: boolean) => Promise<void>;
  updateSettings: (patch: UpdateSettingsPatch) => Promise<void>;
  setActiveSession: (active: boolean, reason: string) => Promise<void>;
  refreshServerCompatibility: () => Promise<void>;
  getRedactedReport: () => Promise<string>;
  shareDiagnostics: () => Promise<void>;
  attemptRollback: () => Promise<void>;
  markStartupHealthy: () => Promise<void>;
  clearError: () => void;
}

export function useRavenUpdater(): RavenUpdater {
  const [state, setState] = useState<UpdaterSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = useCallback(async (operation: () => Promise<UpdaterSnapshot>) => {
    setBusy(true);
    setError("");
    try {
      const next = await operation();
      setState(next);
    } catch (reason) {
      setError(messageFromError(reason));
      throw reason;
    } finally {
      setBusy(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!isTauriRuntime()) {
      setLoading(false);
      return;
    }
    try {
      const next = await invoke<UpdaterSnapshot>("updater_get_state");
      setState(next);
      api.setUpdateChannel(next.settings.channel);
      api.setUpdateCohort(next.settings.cohort);
      api.setServiceAccess(next.access);
    } catch (reason) {
      setError(messageFromError(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    if (!isTauriRuntime()) {
      setLoading(false);
      return;
    }
    void listen<UpdaterSnapshot>("raven-updater-state", (event) => {
      setState(event.payload);
      api.setUpdateChannel(event.payload.settings.channel);
      api.setUpdateCohort(event.payload.settings.cohort);
      api.setServiceAccess(event.payload.access);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    void refresh();
    return () => unlisten?.();
  }, [refresh]);

  useEffect(() => subscribeApiCompatibilityFailures((compatibility) => {
    if (!isTauriRuntime()) return;
    void run(() => invoke<UpdaterSnapshot>("updater_set_server_context", {
      context: {
        serverVersion: compatibility.serverVersion ?? "",
        protocolVersion: RAVEN_PROTOCOL_VERSION,
        capabilities: RAVEN_CLIENT_CAPABILITIES,
        compatibility: normalizeCompatibility(compatibility),
      },
    })).catch(() => undefined);
  }), [run]);

  const checkNow = useCallback(
    () => run(() => invoke<UpdaterSnapshot>("updater_check_now")),
    [run],
  );
  const download = useCallback(
    (approveMetered = false) =>
      run(() => invoke<UpdaterSnapshot>("updater_download", { approveMetered })),
    [run],
  );
  const installNow = useCallback(
    () => run(() => invoke<UpdaterSnapshot>("updater_install_now")),
    [run],
  );
  const setInstallOnClose = useCallback(
    (enabled: boolean) =>
      run(() => invoke<UpdaterSnapshot>("updater_schedule_install_on_close", { enabled })),
    [run],
  );
  const updateSettings = useCallback(
    async (patch: UpdateSettingsPatch) => {
      await run(() => invoke<UpdaterSnapshot>("updater_update_settings", { patch }));
      if (patch.channel) api.setUpdateChannel(patch.channel);
      if (patch.cohort) api.setUpdateCohort(patch.cohort);
      if (patch.deliveryAccepted === true || patch.channel || patch.cohort) {
        await run(() => invoke<UpdaterSnapshot>("updater_check_now"));
      }
    },
    [run],
  );
  const setActiveSession = useCallback(
    (active: boolean, reason: string) =>
      run(() => invoke<UpdaterSnapshot>("updater_set_active_session", { active, reason })),
    [run],
  );
  const refreshServerCompatibility = useCallback(async () => {
    if (!isTauriRuntime()) return;
    const response = await api.serverCompatibility();
    const compatibility = normalizeCompatibility(response.compatibility);
    await run(() =>
      invoke<UpdaterSnapshot>("updater_set_server_context", {
        context: {
          serverVersion: compatibility.serverVersion,
          protocolVersion: RAVEN_PROTOCOL_VERSION,
          capabilities: RAVEN_CLIENT_CAPABILITIES,
          compatibility,
        },
      }),
    );
  }, [run]);
  const getRedactedReport = useCallback(
    () => invoke<string>("updater_redacted_report"),
    [],
  );
  const shareDiagnostics = useCallback(
    () => run(() => invoke<UpdaterSnapshot>("updater_share_diagnostics")),
    [run],
  );
  const attemptRollback = useCallback(
    () => run(() => invoke<UpdaterSnapshot>("updater_attempt_rollback")),
    [run],
  );
  const markStartupHealthy = useCallback(
    () => run(() => invoke<UpdaterSnapshot>("updater_mark_startup_healthy")),
    [run],
  );
  const clearError = useCallback(() => setError(""), []);

  return useMemo(
    () => ({
      state,
      loading,
      busy,
      error,
      refresh,
      checkNow,
      download,
      installNow,
      setInstallOnClose,
      updateSettings,
      setActiveSession,
      refreshServerCompatibility,
      getRedactedReport,
      shareDiagnostics,
      attemptRollback,
      markStartupHealthy,
      clearError,
    }),
    [
      state,
      loading,
      busy,
      error,
      refresh,
      checkNow,
      download,
      installNow,
      setInstallOnClose,
      updateSettings,
      setActiveSession,
      refreshServerCompatibility,
      getRedactedReport,
      shareDiagnostics,
      attemptRollback,
      markStartupHealthy,
      clearError,
    ],
  );
}

export function formatUpdateBytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value < 0) return "Unknown";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let amount = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

export function canRestartForUpdate(state: UpdaterSnapshot | null) {
  return Boolean(
    state?.downloaded &&
      !state.activeSession &&
      ["awaiting_restart", "deferred", "installation_failed"].includes(state.phase),
  );
}

export function updatePhaseLabel(phase: UpdatePhase) {
  return PHASE_LABELS[phase];
}

const PHASE_LABELS: Record<UpdatePhase, string> = {
  idle: "Up to date",
  checking: "Checking",
  available: "Available",
  downloading: "Downloading",
  downloaded: "Downloaded",
  awaiting_restart: "Ready to install",
  installing: "Installing",
  deferred: "Deferred safely",
  paused: "Release paused",
  check_failed: "Check failed",
  download_failed: "Download failed",
  verification_failed: "Verification failed",
  installation_failed: "Installation needs attention",
  unsupported_version: "Compatibility action required",
  blocked_version: "Installed version blocked",
};

function normalizeCompatibility(value: ServerCompatibility): UpdateCompatibility {
  return {
    status: value.status ?? "unknown",
    reasonCode: value.reasonCode ?? "unknown",
    message: value.message ?? "Compatibility could not be confirmed.",
    clientVersion: value.clientVersion ?? "",
    serverVersion: value.serverVersion ?? "",
    protocolVersion: value.protocolVersion ?? RAVEN_PROTOCOL_VERSION,
    minimumClientVersion: value.minimumClientVersion ?? "",
    recommendedClientVersion: value.recommendedClientVersion ?? "",
    minimumServerVersion: value.minimumServerVersion ?? "",
    maximumServerVersion: value.maximumServerVersion ?? "",
    requiredCapabilities: value.requiredCapabilities ?? [],
    missingCapabilities: value.missingCapabilities ?? [],
    graceEndsAt: value.graceEndsAt,
  };
}

function messageFromError(error: unknown) {
  return error instanceof Error && error.message ? error.message : String(error || "The update operation could not be completed.");
}

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}
