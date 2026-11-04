import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, subscribeUpdateRequired, type ServerCompatibility } from "@/lib/api";

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "ready" | "installing";

export interface PastRelease {
  version: string;
  notes: string;
}

export interface AvailableUpdate {
  version: string;
  notes: string;
  /** Notes of the versions before this one, for someone several versions behind. */
  history?: PastRelease[];
  /** The signed installer itself, offered as a manual download if installing fails. */
  downloadUrl: string;
}

/** Mirrors `UpdaterSnapshot` in `src-tauri/src/updater.rs`. */
export interface UpdaterSnapshot {
  currentVersion: string;
  phase: UpdatePhase;
  available?: AvailableUpdate | null;
  progress?: { downloaded: number; total?: number | null } | null;
  /** What went wrong in the last step the user asked for; the phase says where they are left. */
  error?: string | null;
  lastCheckedAtMs?: number | null;
  /** Restarting now would interrupt something (a call, a capture). */
  busy: boolean;
  busyReason: string;
}

function compareVersions(a: string, b: string) {
  const [left, right] = [a, b].map((version) => version.split(".").map((part) => Number.parseInt(part, 10) || 0));
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/** The notes someone on `currentVersion` has not seen yet, newest first. */
export function releasesSince(available: AvailableUpdate, currentVersion: string): PastRelease[] {
  const earlier = (available.history ?? []).filter(
    (release) => compareVersions(release.version, currentVersion) > 0 && compareVersions(release.version, available.version) < 0,
  );
  return [{ version: available.version, notes: available.notes }, ...earlier.sort((a, b) => compareVersions(b.version, a.version))]
    .filter((release) => release.notes);
}

export interface RavenUpdater {
  state: UpdaterSnapshot | null;
  loading: boolean;
  /** A command that was refused outright, such as restarting during a call. */
  error: string;
  /** Set while the server refuses this version of Raven as too old. */
  updateRequired: ServerCompatibility | null;
  checkNow: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  setBusy: (busy: boolean, reason: string) => Promise<void>;
  checkCompatibility: () => Promise<void>;
}

export function useRavenUpdater(): RavenUpdater {
  const [state, setState] = useState<UpdaterSnapshot | null>(null);
  const [loading, setLoading] = useState(isTauriRuntime());
  const [error, setError] = useState("");
  const [updateRequired, setUpdateRequired] = useState(() => api.getUpdateRequired());

  useEffect(() => subscribeUpdateRequired(setUpdateRequired), []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void listen<UpdaterSnapshot>("raven-updater-state", (event) => setState(event.payload)).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    void invoke<UpdaterSnapshot>("updater_get_state")
      .then(setState)
      .catch((reason) => setError(messageFromError(reason)))
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const run = useCallback(async (command: string, args?: Record<string, unknown>) => {
    if (!isTauriRuntime()) return;
    setError("");
    try {
      setState(await invoke<UpdaterSnapshot>(command, args));
    } catch (reason) {
      setError(messageFromError(reason));
    }
  }, []);

  const checkNow = useCallback(() => run("updater_check"), [run]);
  const download = useCallback(() => run("updater_download"), [run]);
  const install = useCallback(() => run("updater_install"), [run]);
  const setBusy = useCallback(
    (busy: boolean, reason: string) => run("updater_set_busy", { busy, reason }),
    [run],
  );
  const checkCompatibility = useCallback(async () => {
    await api.checkCompatibility();
  }, []);

  return useMemo(
    () => ({ state, loading, error, updateRequired, checkNow, download, install, setBusy, checkCompatibility }),
    [state, loading, error, updateRequired, checkNow, download, install, setBusy, checkCompatibility],
  );
}

/** One line saying where the update stands, for the Updates page. */
export function updateStatusLine(state: UpdaterSnapshot) {
  const version = state.available?.version ?? "";
  switch (state.phase) {
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Raven ${version} is available.`;
    case "downloading":
      return `Downloading Raven ${version}…`;
    case "ready":
      return `Raven ${version} is downloaded. Restart to finish updating.`;
    case "installing":
      return `Installing Raven ${version}…`;
    default:
      return "Raven is up to date.";
  }
}

/** Download progress from 0 to 100, or null while the size is not known. */
export function downloadPercent(state: UpdaterSnapshot) {
  const progress = state.progress;
  if (!progress?.total) return null;
  return Math.min(100, Math.floor((progress.downloaded / progress.total) * 100));
}

export function formatUpdateBytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value < 0) return "";
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

function messageFromError(error: unknown) {
  return error instanceof Error && error.message ? error.message : String(error || "That didn't work. Try again.");
}

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}
