import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, LogOut, Radio, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UpdatesSettingsPanel } from "@/components/updates/UpdatesSettings";
import { Island } from "./ravenv1/atoms";
import { DeviceDock } from "./ravenv1/DeviceDock";
import { Sidebar } from "./ravenv1/Sidebar";
import { BareTopBar, TopBar } from "./ravenv1/TopBar";
import { MainView } from "./ravenv1/views";
import type { RavenView } from "./ravenv1/state";
import { useRavenShellData } from "./ravenv1/useRavenShellData";
import { useRavenMediaAdapter } from "./ravenv1/useRavenMediaAdapter";
import { useRavenUpdater } from "@/lib/updater";
import type { RavenUpdater } from "@/lib/updater";
import type { RavenShellData } from "./ravenv1/state";
import type { RavenMediaAdapterState } from "./ravenv1/useRavenMediaAdapter";
import { UserSettingsView } from "./ravenv1/UserSettings";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";

export function RavenShellV1() {
  const [history, setHistory] = useState<{ entries: RavenView[]; index: number }>({ entries: [{ kind: "home" }], index: 0 });
  const [recoverySettings, setRecoverySettings] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("raven.sidebarCollapsed") === "true");
  const previousAccessMode = useRef<string | undefined>(undefined);
  const updater = useRavenUpdater();
  const data = useRavenShellData();
  const media = useRavenMediaAdapter(data.refresh, {
    alwaysJoinMuted: data.preferences.alwaysJoinMuted,
    joinWithCameraOff: data.preferences.joinWithCameraOff,
    joinWithoutScreenSharing: data.preferences.joinWithoutScreenSharing,
    nestLabel: data.labels.nestSingular,
    rtcServerUrl: data.serverProperties.rtcServerUrl,
    presenceState: data.presence?.state,
    presenceReachability: data.presence?.reachability,
    localUserId: data.user?.id,
  });
  const pendingCallFlow = data.pending.some((item) => item.kind === "knock");
  const view = history.entries[history.index] ?? { kind: "home" };
  const canGoBack = history.index > 0;
  const canGoForward = history.index < history.entries.length - 1;

  useEffect(() => {
    setHistory({ entries: [{ kind: "home" }], index: 0 });
  }, [data.user?.id]);

  useEffect(() => {
    const disableContextMenu = (event: MouseEvent) => event.preventDefault();
    window.addEventListener("contextmenu", disableContextMenu);
    return () => window.removeEventListener("contextmenu", disableContextMenu);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      localStorage.setItem("raven.sidebarCollapsed", String(next));
      return next;
    });
  }, []);

  useEffect(() => {
    if (!updater.state) return;
    const captureActive = media.screenSharing || media.windowSharing || media.appAudioCapturing || media.localCameraEnabled || media.localMicEnabled;
    const transitionActive = media.phase === "joining" || media.phase === "leaving";
    const active = Boolean(media.activeNestId || media.busy || data.busy || captureActive || transitionActive || pendingCallFlow);
    const reason = media.activeNestId
      ? `an active ${data.labels.nestSingular} is connected`
      : transitionActive
        ? `a ${data.labels.nestSingular} connection is changing`
        : pendingCallFlow
          ? "an incoming or outgoing call flow is waiting"
        : captureActive
          ? "camera, microphone, screen, or app-audio capture is active"
          : media.busy
            ? "a sensitive device operation is in progress"
            : "";
    void updater.setActiveSession(active, reason).catch(() => undefined);
  }, [
    updater.state?.schemaVersion,
    media.activeNestId,
    media.busy,
    media.phase,
    media.screenSharing,
    media.windowSharing,
    media.appAudioCapturing,
    media.localCameraEnabled,
    media.localMicEnabled,
    data.busy,
    pendingCallFlow,
    data.labels.nestSingular,
    updater.setActiveSession,
  ]);

  useEffect(() => {
    if (!updater.state) return;
    void updater.refreshServerCompatibility().catch(() => undefined);
  }, [data.apiServerUrl, updater.state?.settings.channel, updater.refreshServerCompatibility]);

  useEffect(() => {
    if (data.loading || updater.loading || !updater.state) return;
    const timer = window.setTimeout(() => {
      void updater.markStartupHealthy().catch(() => undefined);
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [data.loading, updater.loading, updater.state?.currentVersion, updater.markStartupHealthy]);

  useEffect(() => {
    const mode = updater.state?.access.mode;
    if (!mode) return;
    if (previousAccessMode.current && previousAccessMode.current !== "allowed" && mode === "allowed" && data.user) {
      void data.refresh().catch(() => undefined);
    }
    previousAccessMode.current = mode;
  }, [updater.state?.access.mode, data.user, data.refresh]);

  const navigate = useCallback(
    (next: RavenView) => {
      setHistory((current) => {
        const active = current.entries[current.index] ?? { kind: "home" };
        if (viewKey(active) === viewKey(next)) return current;
        const entries = [...current.entries.slice(0, current.index + 1), next];
        return { entries, index: entries.length - 1 };
      });
    },
    [],
  );

  const goBack = useCallback(() => {
    setHistory((current) => (current.index > 0 ? { ...current, index: current.index - 1 } : current));
  }, []);

  const goForward = useCallback(() => {
    setHistory((current) => (current.index < current.entries.length - 1 ? { ...current, index: current.index + 1 } : current));
  }, []);

  const navigation = useMemo(
    () => ({ canGoBack, canGoForward, goBack, goForward, navigate }),
    [canGoBack, canGoForward, goBack, goForward, navigate],
  );

  if (data.loading || updater.loading) {
    return (
      <div className="ravenv1-scope flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <BareTopBar />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Radio className="h-5 w-5 animate-pulse text-primary" />
            <span className="text-sm">Opening Raven...</span>
          </div>
        </div>
      </div>
    );
  }

  if (updater.state && updater.state.access.mode !== "allowed") {
    return (
      <UpdateRecoveryShell
        data={data}
        media={media}
        updater={updater}
        showSettings={recoverySettings}
        onShowSettings={setRecoverySettings}
      />
    );
  }

  if (!data.user) {
    if (data.serverUnreachable) {
      return <ServerUnreachable busy={data.busy} serverUrl={data.apiServerUrl} onRetry={data.retryConnection} onLogout={data.logout} />;
    }
    return (
      <ShellLogin
        busy={data.busy}
        error={data.error}
        serverName={data.serverProperties.name}
        serverDescription={data.serverProperties.description}
        serverAvatar={data.serverProperties.avatar}
        apiServerUrl={data.apiServerUrl}
        apiServerHistory={data.apiServerHistory}
        onServerSelect={data.selectApiServer}
        onLogin={data.login}
      />
    );
  }

  return (
    <div className="ravenv1-scope flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TopBar
        view={view}
        data={data}
        onNavigate={navigation.navigate}
        canGoBack={navigation.canGoBack}
        canGoForward={navigation.canGoForward}
        onBack={navigation.goBack}
        onForward={navigation.goForward}
      />

      <div className={cn("grid min-h-0 flex-1 gap-3 px-3 pb-2 pt-1", sidebarCollapsed ? "grid-cols-[72px_minmax(0,1fr)]" : "grid-cols-[300px_minmax(0,1fr)]")}>
        <Sidebar view={view} data={data} collapsed={sidebarCollapsed} onToggle={toggleSidebar} onNavigate={navigation.navigate} />
        <Island className="flex min-h-0 flex-col overflow-hidden">
          <MainView view={view} data={data} media={media} updater={updater} onNavigate={navigation.navigate} />
        </Island>
      </div>

      <div className="px-3 pb-2">
        <DeviceDock data={data} media={media} />
      </div>
    </div>
  );
}

function UpdateRecoveryShell({
  data,
  media,
  updater,
  showSettings,
  onShowSettings,
}: {
  data: RavenShellData;
  media: RavenMediaAdapterState;
  updater: RavenUpdater;
  showSettings: boolean;
  onShowSettings: (value: boolean) => void;
}) {
  const state = updater.state;
  if (!state) return null;
  const blocked = state.access.mode === "blocked";
  const title = blocked ? "This Raven version is blocked" : state.access.mode === "required" ? "Raven must be updated" : "Compatibility action is required";

  return (
    <div className="ravenv1-scope flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <BareTopBar />
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <Island className="mx-auto min-h-full w-full max-w-5xl p-6">
          {showSettings && data.user ? (
            <UserSettingsView
              data={data}
              media={media}
              updater={updater}
              onNavigate={() => onShowSettings(false)}
            />
          ) : (
            <div className="space-y-6">
              <div className="flex flex-col gap-5 border-b border-border/60 pb-6 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex max-w-2xl gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/12 text-amber-300">
                    <AlertTriangle className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="rv-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Safe recovery</div>
                    <h1 className="mt-1 text-xl font-semibold tracking-tight">{title}</h1>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      {state.access.message || "Normal Raven service access is paused until compatibility can be restored."}
                    </p>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      Raven will not join a new {data.labels.nestSingular}, publish new media, or use incompatible service features from this recovery screen. It will not restart without your action.
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Your local Raven data remains in place. Recovery will refuse an unapproved downgrade or any rollback whose local migration was not declared reversible.
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {data.user ? (
                    <Button variant="outline" className="gap-2" onClick={() => onShowSettings(true)}>
                      <Settings className="h-4 w-4" />
                      Settings
                    </Button>
                  ) : null}
                  {data.user ? (
                    <Button variant="outline" className="gap-2" onClick={data.logout}>
                      <LogOut className="h-4 w-4" />
                      Sign out
                    </Button>
                  ) : null}
                </div>
              </div>

              {media.activeNestId ? (
                <div className="rounded-xl border border-amber-500/25 bg-amber-500/8 p-4">
                  <div className="text-sm font-medium">Your active {data.labels.nestSingular} was not interrupted</div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Restart stays unavailable until you deliberately leave. No update action will start camera, microphone, screen, or app-audio sharing.
                  </p>
                  <Button
                    className="mt-3"
                    variant="outline"
                    disabled={media.busy}
                    onClick={() => void media.leaveMediaSession()}
                  >
                    Leave active {data.labels.nestSingular} safely
                  </Button>
                </div>
              ) : null}

              <UpdatesSettingsPanel updater={updater} />
            </div>
          )}
        </Island>
      </div>
    </div>
  );
}

function ServerUnreachable({
  busy,
  serverUrl,
  onRetry,
  onLogout,
}: {
  busy: boolean;
  serverUrl: string;
  onRetry: () => Promise<void>;
  onLogout: () => void;
}) {
  return (
    <div className="ravenv1-scope flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <BareTopBar />
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Island className="w-full max-w-[420px] p-7 text-center">
          <div className="mx-auto mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
            <Radio className="h-5 w-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Server is unreachable</h1>
          <p className="mt-2 text-sm text-muted-foreground">Raven could not connect to your server. Your session has been kept on this device.</p>
          <p className="rv-mono mt-3 break-all text-[11px] text-muted-foreground">{serverUrl}</p>
          <div className="mt-7 grid grid-cols-2 gap-3">
            <Button variant="outline" disabled={busy} onClick={onLogout}>Logout</Button>
            <Button disabled={busy} onClick={() => void onRetry()}>{busy ? "Trying..." : "Try again"}</Button>
          </div>
        </Island>
      </div>
    </div>
  );
}

function viewKey(view: RavenView) {
  switch (view.kind) {
    case "home":
    case "settings":
      return view.kind;
    case "tree-preview":
      return `${view.kind}:${view.result.tree.id}`;
    default:
      return `${view.kind}:${view.id}`;
  }
}

function ShellLogin({
  busy,
  error,
  serverName,
  serverDescription,
  serverAvatar,
  apiServerUrl,
  apiServerHistory,
  onServerSelect,
  onLogin,
}: {
  busy: boolean;
  error: string;
  serverName: string;
  serverDescription: string;
  serverAvatar: string;
  apiServerUrl: string;
  apiServerHistory: string[];
  onServerSelect: (url: string) => Promise<void>;
  onLogin: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [serverUrl, setServerUrl] = useState(apiServerUrl);
  const [serverError, setServerError] = useState("");

  useEffect(() => {
    setServerUrl(apiServerUrl);
  }, [apiServerUrl]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setServerError("");
    try {
      await onServerSelect(serverUrl);
      await onLogin(username, password);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Enter a valid Raven API server URL");
    }
  };

  return (
    <div className="ravenv1-scope flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <BareTopBar />
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Island className="w-full max-w-[420px] p-7">
          <div className="mb-7 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl bg-primary text-sm font-bold text-primary-foreground">
              {serverAvatar ? <img src={api.assetUrl(serverAvatar)} alt="" draggable={false} className="h-full w-full object-cover" /> : (serverName || "Raven").slice(0, 1).toUpperCase()}
            </div>
            <div>
              <div className="text-lg font-semibold tracking-tight">{serverName || "Raven"}</div>
              <div className="rv-mono text-[11px] text-muted-foreground">{serverDescription || "Desktop"}</div>
            </div>
          </div>
          <form className="space-y-4" onSubmit={submit}>
            <label className="block space-y-2 text-sm font-medium" htmlFor="ravenv1-server">
              Raven API server
              <Input id="ravenv1-server" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="http://127.0.0.1:6977" />
            </label>
            {apiServerHistory.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {apiServerHistory.map((url) => (
                  <button
                    key={url}
                    type="button"
                    onClick={() => setServerUrl(url)}
                    className="rv-mono rounded-lg border border-border bg-secondary/40 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {url}
                  </button>
                ))}
              </div>
            ) : null}
            <label className="block space-y-2 text-sm font-medium" htmlFor="ravenv1-username">
              Username
              <Input id="ravenv1-username" value={username} onChange={(event) => setUsername(event.target.value)} autoFocus />
            </label>
            <label className="block space-y-2 text-sm font-medium" htmlFor="ravenv1-password">
              Password
              <Input id="ravenv1-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            {serverError || error ? <p className="text-sm text-destructive">{serverError || error}</p> : null}
            <Button className="w-full" disabled={busy || !serverUrl || !username || !password}>
              Sign in
            </Button>
          </form>
        </Island>
      </div>
    </div>
  );
}
