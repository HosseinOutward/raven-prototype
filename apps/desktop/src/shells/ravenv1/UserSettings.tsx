import { useEffect, useMemo, useState } from "react";
import { Check, MonitorUp, Palette, RefreshCw, Server as ServerIcon, ShieldCheck, User as UserIcon, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VoiceOverlaySettingsPanel } from "@/components/VoiceOverlaySettings";
import { UpdatesSettingsPanel } from "@/components/updates/UpdatesSettings";
import { api, type AuthSession, type UILabelPreference } from "@/lib/api";
import type { SelfPreviewMode, VideoPresentationProfile } from "@/lib/video";
import { cn } from "@/lib/utils";
import type { RavenUpdater } from "@/lib/updater";
import {
  SettingsField,
  SettingsHint,
  SettingsReadOnlyRow,
  SettingsScaffold,
  SettingsSection,
  SettingsToggleRow,
  type SettingsCategory,
} from "./SettingsScaffold";
import { InfoTooltip } from "./atoms";
import type { RavenShellData, RavenView } from "./state";
import type {
  DeafenMode,
  NetworkActivityCategory,
  NetworkActivityDirection,
  RavenMediaAdapterState,
} from "./useRavenMediaAdapter";

type UserSettingsCategoryId = "profile" | "appearance" | "audio-video" | "updates" | "sessions" | "server" | "voice-overlay";

const CATEGORIES: (SettingsCategory & { id: UserSettingsCategoryId })[] = [
  { id: "profile", label: "Profile", icon: <UserIcon /> },
  { id: "appearance", label: "Appearance", icon: <Palette /> },
  { id: "audio-video", label: "Audio & video", icon: <Video /> },
  { id: "updates", label: "Updates", icon: <RefreshCw /> },
  { id: "sessions", label: "Sessions", icon: <ShieldCheck /> },
  { id: "server", label: "Server", icon: <ServerIcon /> },
  { id: "voice-overlay", label: "Voice overlay", icon: <MonitorUp /> },
];

export function UserSettingsView({
  data,
  media,
  updater,
  onNavigate,
}: {
  data: RavenShellData;
  media: RavenMediaAdapterState;
  updater: RavenUpdater;
  onNavigate: (view: RavenView) => void;
}) {
  const [active, setActive] = useState<UserSettingsCategoryId>("profile");
  const [displayName, setDisplayName] = useState(data.preferences.displayName);
  const [uiLabels, setUiLabels] = useState<UILabelPreference>(data.preferences.uiLabels);
  const [alwaysJoinMuted, setAlwaysJoinMuted] = useState(data.preferences.alwaysJoinMuted);
  const [joinWithCameraOff, setJoinWithCameraOff] = useState(data.preferences.joinWithCameraOff);
  const [joinWithoutScreenSharing, setJoinWithoutScreenSharing] = useState(data.preferences.joinWithoutScreenSharing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDisplayName(data.preferences.displayName);
    setUiLabels(data.preferences.uiLabels);
    setAlwaysJoinMuted(data.preferences.alwaysJoinMuted);
    setJoinWithCameraOff(data.preferences.joinWithCameraOff);
    setJoinWithoutScreenSharing(data.preferences.joinWithoutScreenSharing);
  }, [data.preferences.displayName, data.preferences.uiLabels, data.preferences.alwaysJoinMuted, data.preferences.joinWithCameraOff, data.preferences.joinWithoutScreenSharing]);

  const dirty = useMemo(
    () =>
      displayName !== data.preferences.displayName ||
      uiLabels !== data.preferences.uiLabels ||
      alwaysJoinMuted !== data.preferences.alwaysJoinMuted ||
      joinWithCameraOff !== data.preferences.joinWithCameraOff ||
      joinWithoutScreenSharing !== data.preferences.joinWithoutScreenSharing,
    [displayName, uiLabels, alwaysJoinMuted, joinWithCameraOff, joinWithoutScreenSharing, data.preferences],
  );

  const canSave = dirty && Boolean(displayName.trim()) && !saving;
  const prefCategory = active !== "voice-overlay" && active !== "server" && active !== "sessions" && active !== "updates";

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await data.updatePreferences({ displayName, uiLabels, alwaysJoinMuted, joinWithCameraOff, joinWithoutScreenSharing });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Settings could not be saved");
    } finally {
      setSaving(false);
    }
  };

  const username = data.user?.username ?? "username";

  return (
    <SettingsScaffold
      eyebrow="Raven"
      title="Settings"
      subtitle="Your profile, appearance, media defaults, updates, and overlay."
      categories={CATEGORIES}
      activeId={active}
      onSelect={(id) => setActive(id as UserSettingsCategoryId)}
      actions={
        <>
          {prefCategory ? (
            <Button className="gap-2" onClick={() => void save()} disabled={!canSave}>
              <Check className="h-4 w-4" />
              {saving ? "Saving…" : "Save changes"}
            </Button>
          ) : null}
          <Button variant="ghost" className="text-muted-foreground" onClick={() => onNavigate({ kind: "home" })}>
            Done
          </Button>
        </>
      }
    >
      {prefCategory && error ? <p className="text-sm text-destructive">{error}</p> : null}

      {active === "profile" ? (
        <>
          <SettingsSection title="Profile" description="How you appear to other people in Raven.">
            <SettingsField
              label="Display name"
              hint="People see this name in Raven. Your username stays unchanged for sign-in and search."
            >
              <Input
                value={displayName}
                onChange={(event) => setDisplayName(event.currentTarget.value)}
                placeholder={username}
                maxLength={80}
              />
            </SettingsField>
          </SettingsSection>
          <SettingsSection title="Account">
            <SettingsReadOnlyRow label="Login identity" value={username} />
            <SettingsReadOnlyRow label="Search handle" value={username} />
            <SettingsHint>Username changes are not available from settings. Search continues to use your username so people can find the exact account.</SettingsHint>
          </SettingsSection>
        </>
      ) : null}

      {active === "appearance" ? (
        <>
          <SettingsSection title="Labels" description="Choose the vocabulary Raven uses for groups and rooms.">
            <SettingsField label="UI labels">
              <Select value={uiLabels} onValueChange={(value) => setUiLabels(value as UILabelPreference)}>
                <SelectTrigger className="rounded-xl border-border">
                  <SelectValue>{uiLabels === "space_room" ? "Space / Room" : "Tree / Nest"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="tree_nest">Tree / Nest</SelectItem>
                    <SelectItem value="space_room">Space / Room</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </SettingsField>
          </SettingsSection>
          <SettingsSection title="Theme">
            <SettingsField label="Color palette" hint="Additional palettes are not available yet.">
              <Select value="raven_dark" disabled>
                <SelectTrigger className="rounded-xl border-border">
                  <SelectValue>Raven dark</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="raven_dark">Raven dark</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </SettingsField>
          </SettingsSection>
        </>
      ) : null}

      {active === "audio-video" ? (
        <>
          <SettingsSection title="Joining" description="How your devices behave when you enter a room.">
            <SettingsToggleRow
              label="Join with mic muted"
              description="Start every room with your microphone muted until you unmute."
              checked={alwaysJoinMuted}
              onChange={setAlwaysJoinMuted}
            />
            <SettingsToggleRow
              label="Join with camera off"
              description="Start every room with your camera disabled until you turn it on."
              checked={joinWithCameraOff}
              onChange={setJoinWithCameraOff}
            />
            <SettingsToggleRow
              label="Join without screen sharing"
              description="Never resume or automatically start screen sharing when entering a room."
              checked={joinWithoutScreenSharing}
              onChange={setJoinWithoutScreenSharing}
            />
            <SettingsHint>Live device controls stay in the bottom bar, available whether or not you are in a room.</SettingsHint>
          </SettingsSection>
          <SettingsSection
            title="Your camera and screen preview"
            description="Choose how Raven shows your own outgoing video back to you."
          >
            <SettingsModeOption
              mode="local"
              title="Show directly from this device"
              copy="Displays the same native camera or screen capture before it goes through the room connection. Uses no incoming media bandwidth and has the least delay."
              selected={media.selfMediaPreviewMode === "local"}
              disabled={media.busy}
              onSelect={(mode) => void media.setSelfMediaPreviewMode(mode)}
            />
            <SettingsModeOption
              mode="rtc"
              title="Show through the room connection"
              copy="Receives your published camera or screen share back through RTC. Useful for checking the room-delivered feed, but uses bandwidth and may add delay."
              selected={media.selfMediaPreviewMode === "rtc"}
              disabled={media.busy}
              onSelect={(mode) => void media.setSelfMediaPreviewMode(mode)}
            />
            <SettingsHint>This changes only your own preview. Other people still receive your published media normally.</SettingsHint>
          </SettingsSection>
          <SettingsSection
            title="Video presentation performance"
            description="Control how native video frames are prepared for the Raven interface. This does not change the quality sent to other people."
          >
            <SettingsModeOption
              mode="efficiency"
              title="Efficiency"
              copy="Uses the least CPU and memory bandwidth. Best for long calls, many tiles, or battery-powered devices."
              selected={media.videoPresentationProfile === "efficiency"}
              disabled={media.busy}
              onSelect={(profile) => void media.setVideoPresentationProfile(profile)}
            />
            <SettingsModeOption
              mode="balanced"
              title="Balanced"
              copy="Balances smooth motion, clarity, and processing cost. Recommended for most rooms."
              selected={media.videoPresentationProfile === "balanced"}
              disabled={media.busy}
              onSelect={(profile) => void media.setVideoPresentationProfile(profile)}
            />
            <SettingsModeOption
              mode="quality"
              title="Quality"
              copy="Uses more CPU for larger, smoother stage frames. Best when video detail matters and the device has headroom."
              selected={media.videoPresentationProfile === "quality"}
              disabled={media.busy}
              onSelect={(profile) => void media.setVideoPresentationProfile(profile)}
            />
            <SettingsHint>Frames are decoded, resized, and bounded in the native media engine. Raven only prepares frames while a visible tile is requesting them.</SettingsHint>
          </SettingsSection>
          <SettingsSection title="Deafen behavior" description="Choose how Raven handles incoming audio while you're deafened.">
            <SettingsModeOption
              mode="instant"
              title="Instant"
              copy="Mute incoming audio on this device. Fastest and most reliable."
              selected={media.deafenMode === "instant"}
              disabled={media.busy}
              onSelect={(mode) => void media.setDeafenMode(mode)}
            />
            <SettingsModeOption
              mode="bandwidthSaver"
              title="Bandwidth Saver"
              copy="Stop receiving incoming audio while deafened. Uses less network, but undeafening may take a moment."
              selected={media.deafenMode === "bandwidthSaver"}
              disabled={media.busy}
              onSelect={(mode) => void media.setDeafenMode(mode)}
            />
          </SettingsSection>
          <SettingsSection
            title={(
              <span className="inline-flex items-center gap-1.5">
                Network activity
                <InfoTooltip label="About network activity settings">
                  Total means measured media traffic, not process-wide traffic. API requests, realtime control, signaling, and OS-level traffic are excluded. Audio includes shared audio; Screen share covers screen and window video. These display choices save immediately on this device.
                </InfoTooltip>
              </span>
            )}
          >
            <SettingsToggleRow
              label="Show network activity"
              description="Display a quiet live summary near the right-side media controls."
              checked={media.networkActivity.enabled}
              onChange={(enabled) => media.setNetworkActivity({ enabled })}
            />
            <SettingsField label="Directions">
              <div className="grid gap-2 sm:grid-cols-2">
                {NETWORK_DIRECTIONS.map((direction) => (
                  <SettingsToggleRow
                    key={direction.id}
                    label={direction.label}
                    checked={media.networkActivity.directions.includes(direction.id)}
                    disabled={!media.networkActivity.enabled}
                    onChange={(checked) => media.setNetworkActivity({
                      directions: toggleSelection(media.networkActivity.directions, direction.id, checked),
                    })}
                  />
                ))}
              </div>
            </SettingsField>
            <SettingsField label="Categories">
              <div className="grid gap-2 sm:grid-cols-2">
                {NETWORK_CATEGORIES.map((category) => (
                  <SettingsToggleRow
                    key={category.id}
                    label={category.label}
                    description={category.description}
                    checked={media.networkActivity.categories.includes(category.id)}
                    disabled={!media.networkActivity.enabled}
                    onChange={(checked) => media.setNetworkActivity({
                      categories: toggleSelection(media.networkActivity.categories, category.id, checked),
                    })}
                  />
                ))}
              </div>
            </SettingsField>
          </SettingsSection>
        </>
      ) : null}

      {active === "server" ? (
        <>
          <SettingsSection title="Server" description="Properties returned by the Raven API server currently in use.">
            <SettingsReadOnlyRow label="Name" value={data.serverProperties.name || "Raven"} />
            <SettingsReadOnlyRow label="Description" value={data.serverProperties.description || "Desktop RTC for private Nests"} />
            <SettingsReadOnlyRow label="Avatar" value={data.serverProperties.avatar || "Not set"} />
            <SettingsReadOnlyRow label="Advertise URL" value={data.serverProperties.advertiseUrl || data.apiServerUrl} />
            <SettingsReadOnlyRow label="API server URL" value={data.apiServerUrl} />
            <SettingsReadOnlyRow label="Realtime server URL" value={data.serverProperties.rtcServerUrl || "Not advertised"} />
            <SettingsHint>To change servers, log out first. Server switching is disabled while you are signed in.</SettingsHint>
          </SettingsSection>
        </>
      ) : null}

      {active === "sessions" ? <SessionSettings data={data} /> : null}

      {active === "updates" ? <UpdatesSettingsPanel updater={updater} /> : null}

      {active === "voice-overlay" ? <VoiceOverlaySettingsPanel /> : null}
    </SettingsScaffold>
  );
}

function SessionSettings({ data }: { data: RavenShellData }) {
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [terminating, setTerminating] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    setError("");
    try {
      const result = await api.authSessions();
      setSessions(result.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sessions could not be loaded");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const terminate = async (session: AuthSession) => {
    setTerminating(session.id);
    setError("");
    try {
      const result = await api.revokeAuthSession(session.id);
      if (result.current) {
        data.logout();
        return;
      }
      setSessions((current) => current.filter((item) => item.id !== session.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Session could not be terminated");
    } finally {
      setTerminating("");
    }
  };

  return (
    <SettingsSection title="Active sessions" 
    // description="Devices currently signed in to your Raven account. Terminate anything you do not recognize."
    >
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {loading ? <SettingsHint>Loading active sessions...</SettingsHint> : null}
      {!loading && sessions.length === 0 ? <SettingsHint>No active sessions were found.</SettingsHint> : null}
      {sessions.map((session) => (
        <div key={session.id} className="rounded-xl bg-background/40 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{session.deviceName || "Raven Desktop"}</span>
                {session.current ? <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">This device</span> : null}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{session.os || "Unknown OS"} · {session.latestIp || "Unknown IP"}</div>
              <div className="mt-2 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
                <span>Last access: {formatSessionTime(session.lastAccessedAt)}</span>
                <span>Signed in: {formatSessionTime(session.createdAt)}</span>
              </div>
              {session.userAgent ? <div className="rv-mono mt-2 break-all text-[10px] leading-4 text-muted-foreground/70">{session.userAgent}</div> : null}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 text-destructive hover:text-destructive"
              disabled={Boolean(terminating)}
              onClick={() => void terminate(session)}
            >
              {terminating === session.id ? "Terminating..." : session.current ? "Log out" : "Terminate"}
            </Button>
          </div>
        </div>
      ))}
      <SettingsHint>IP addresses reflect the latest connection seen by this server. If Raven is behind a proxy, the server must trust that proxy before forwarded client addresses are used.</SettingsHint>
    </SettingsSection>
  );
}

function formatSessionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
}

const NETWORK_DIRECTIONS: Array<{ id: NetworkActivityDirection; label: string }> = [
  { id: "incoming", label: "Incoming" },
  { id: "outgoing", label: "Outgoing" },
];

const NETWORK_CATEGORIES: Array<{ id: NetworkActivityCategory; label: string; description?: string }> = [
  { id: "audio", label: "Audio", description: "Voice, system, app, and shared audio measured by Raven's media paths." },
  { id: "video", label: "Video" },
  { id: "screenShare", label: "Screen share" },
  // { id: "other", label: "Other" },
  { id: "total", label: "Total" },
];

function toggleSelection<T extends string>(values: T[], value: T, checked: boolean): T[] {
  if (checked) return values.includes(value) ? values : [...values, value];
  return values.filter((candidate) => candidate !== value);
}

function SettingsModeOption<T extends DeafenMode | SelfPreviewMode | VideoPresentationProfile>({
  mode,
  title,
  copy,
  selected,
  disabled,
  onSelect,
}: {
  mode: T;
  title: string;
  copy: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: (mode: T) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect(mode)}
      className={cn(
        "flex w-full gap-3 rounded-xl bg-background/40 p-3 text-left transition-colors hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
        selected && "bg-primary/10 ring-1 ring-primary/45",
      )}
    >
      <span className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border", selected ? "border-primary bg-primary" : "border-muted-foreground/45")} />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{copy}</span>
      </span>
    </button>
  );
}
