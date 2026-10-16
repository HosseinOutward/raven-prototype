import { useEffect, useState } from "react";
import { PasswordChangeForm } from "./PasswordChangeForm";
import { Keyboard, MessageSquare, MonitorUp, Palette, PanelBottom, RefreshCw, Server as ServerIcon, ShieldCheck, User as UserIcon, Video } from "lucide-react";
import { ChatSettingsPage } from "@/components/chat/ChatSettings";
import type { ChatStore } from "@/lib/chat/store";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VoiceOverlaySettingsPanel } from "@/components/VoiceOverlaySettings";
import { MediaHotkeySettingsPanel } from "@/components/MediaHotkeySettings";
import { TraySettingsPanel } from "@/components/TraySettings";
import { SquareImageUpload } from "@/components/SquareImageUpload";
import { UpdatesSettingsPanel } from "@/components/updates/UpdatesSettings";
import { api, type AuthSession, type UILabelPreference } from "@/lib/api";
import type { RavenUpdater } from "@/lib/updater";
import {
  SettingsChoice,
  SettingsField,
  SettingsHint,
  SettingsNav,
  SettingsPage,
  SettingsReadOnlyRow,
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsToggleRow,
  type SettingsCategoryGroup,
} from "./SettingsScaffold";
import { InfoTooltip } from "./atoms";
import { DockSettingsSection } from "./DockSettings";
import type { RavenShellData } from "./state";
import type {
  NetworkActivityCategory,
  NetworkActivityDirection,
  RavenMediaAdapterState,
} from "./useRavenMediaAdapter";

export type UserSettingsSection = "profile" | "messages" | "sessions" | "appearance" | "audio-video" | "hotkeys" | "voice-overlay" | "tray" | "server" | "updates";

const GROUPS: SettingsCategoryGroup[] = [
  {
    label: "You",
    categories: [
      { id: "profile", label: "Profile", icon: <UserIcon /> },
      { id: "messages", label: "Messages", icon: <MessageSquare /> },
      { id: "sessions", label: "Password and devices", icon: <ShieldCheck /> },
    ],
  },
  {
    label: "App",
    categories: [
      { id: "appearance", label: "Appearance", icon: <Palette /> },
      { id: "audio-video", label: "Audio and video", icon: <Video /> },
      { id: "hotkeys", label: "Hotkeys", icon: <Keyboard /> },
      { id: "voice-overlay", label: "Voice overlay", icon: <MonitorUp /> },
      { id: "tray", label: "Tray", icon: <PanelBottom /> },
    ],
  },
  {
    label: "System",
    categories: [
      { id: "server", label: "Server", icon: <ServerIcon /> },
      { id: "updates", label: "Updates", icon: <RefreshCw /> },
    ],
  },
];

const SECTION_IDS = new Set(GROUPS.flatMap((group) => group.categories.map((category) => category.id)));

export function resolveUserSettingsSection(section?: string): UserSettingsSection {
  return section && SECTION_IDS.has(section) ? (section as UserSettingsSection) : "profile";
}

export function UserSettingsNav({
  section,
  onSelect,
  onBack,
}: {
  section: UserSettingsSection;
  onSelect: (section: UserSettingsSection) => void;
  onBack: () => void;
}) {
  return (
    <SettingsNav
      title="Settings"
      backLabel="Back"
      onBack={onBack}
      groups={GROUPS}
      activeId={section}
      onSelect={(id) => onSelect(id as UserSettingsSection)}
    />
  );
}

/**
 * Preferences apply as soon as you change them. The stored value stays the
 * source of truth; the local copy only covers the moment before it comes back.
 */
function useAppliedPreference<T>(stored: T, apply: (value: T) => Promise<void>) {
  const [value, setValue] = useState(stored);
  useEffect(() => setValue(stored), [stored]);
  const change = (next: T) => {
    setValue(next);
    void apply(next).catch(() => setValue(stored));
  };
  return [value, change] as const;
}

export function UserSettingsView({
  section,
  data,
  media,
  updater,
  chat = null,
}: {
  section: UserSettingsSection;
  data: RavenShellData;
  media: RavenMediaAdapterState;
  updater: RavenUpdater;
  chat?: ChatStore | null;
}) {
  switch (section) {
    case "profile":
      return <ProfileSettings data={data} />;
    case "messages":
      return <ChatSettingsPage chat={chat} />;
    case "sessions":
      return (
        <SettingsPage title="Password and devices" description="Your password, and every place your account is signed in. Sign out anything you do not recognise.">
          <SessionSettings data={data} />
        </SettingsPage>
      );
    case "appearance":
      return <AppearanceSettings data={data} />;
    case "audio-video":
      return <AudioVideoSettings data={data} media={media} />;
    case "hotkeys":
      return (
        <SettingsPage title="Hotkeys" description="Shortcuts that work even when Raven is in the background.">
          <MediaHotkeySettingsPanel />
        </SettingsPage>
      );
    case "voice-overlay":
      return (
        <SettingsPage title="Voice overlay" description="A small panel that stays on top of other windows and shows who is speaking.">
          <VoiceOverlaySettingsPanel />
        </SettingsPage>
      );
    case "tray":
      return (
        <SettingsPage title="Tray" description="Raven’s icon next to the clock, and what closing the window does.">
          <TraySettingsPanel />
        </SettingsPage>
      );
    case "server":
      return <ServerSettings data={data} />;
    case "updates":
      return (
        <SettingsPage title="Updates">
          <UpdatesSettingsPanel updater={updater} />
        </SettingsPage>
      );
  }
}

function ProfileSettings({ data }: { data: RavenShellData }) {
  const username = data.user?.username ?? "";
  const [displayName, setDisplayName] = useState(data.preferences.displayName);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => setDisplayName(data.preferences.displayName), [data.preferences.displayName]);

  const saveName = async () => {
    const next = displayName.trim();
    if (!next) {
      setDisplayName(data.preferences.displayName);
      return;
    }
    if (next === data.preferences.displayName) return;
    setStatus("saving");
    setError("");
    try {
      await data.updatePreferences({ displayName: next });
      setStatus("saved");
    } catch (err) {
      setStatus("idle");
      setError(err instanceof Error ? err.message : "Your name could not be saved.");
    }
  };

  const uploadAvatar = async (file: File) => {
    setUploading(true);
    setError("");
    try {
      await api.uploadProfileAvatar(file);
      await data.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your picture could not be uploaded.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <SettingsPage title="Profile" description="How you appear to other people in Raven.">
      <SettingsSection title="Picture and name">
        <div className="flex items-center gap-4">
          <Avatar name={displayName || username} src={data.user ? api.userAvatarUrl(data.user.id, data.user.updatedAt) : undefined} className="h-16 w-16 text-title" />
          <div className="min-w-0">
            <SquareImageUpload disabled={uploading} label={uploading ? "Uploading…" : "Choose a picture"} onUpload={uploadAvatar} onError={setError} />
            <p className="mt-1.5 text-caption text-muted-foreground">You crop it to a square. Raven keeps it under 512 KB.</p>
          </div>
        </div>
        <SettingsField
          label="Display name"
          hint={status === "saved" ? "Saved." : status === "saving" ? "Saving…" : "This is the name people see. It saves when you leave the field."}
        >
          <Input
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.currentTarget.value);
              setStatus("idle");
            }}
            onBlur={() => void saveName()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setDisplayName(data.preferences.displayName);
            }}
            placeholder={username}
            maxLength={80}
          />
        </SettingsField>
        {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
      </SettingsSection>

      <SettingsSection title="Account">
        <SettingsReadOnlyRow label="Username" value={username ? `@${username}` : ""} />
        <SettingsHint>You sign in with your username, and people find you by it. It cannot be changed here.</SettingsHint>
      </SettingsSection>

      <SettingsSection title="Sign out">
        <SettingsRow
          label="Sign out of Raven on this device"
          description="If you are in a call, you leave it first."
          control={<Button variant="secondary" size="sm" onClick={data.logout}>Sign out</Button>}
        />
      </SettingsSection>
    </SettingsPage>
  );
}

function AppearanceSettings({ data }: { data: RavenShellData }) {
  const [uiLabels, setUiLabels] = useAppliedPreference<UILabelPreference>(data.preferences.uiLabels, (value) => data.updatePreferences({ uiLabels: value }));
  return (
    <SettingsPage title="Appearance">
      <SettingsSection title="Words" description="What Raven calls groups and the rooms inside them.">
        <SettingsRows>
          <SettingsChoice
            title="Tree and Nest"
            copy="Raven’s own names: a Tree is a group, a Nest is a room in it."
            selected={uiLabels === "tree_nest"}
            onSelect={() => setUiLabels("tree_nest")}
          />
          <SettingsChoice
            title="Space and Room"
            copy="Plainer names for the same two things."
            selected={uiLabels === "space_room"}
            onSelect={() => setUiLabels("space_room")}
          />
        </SettingsRows>
      </SettingsSection>
      <SettingsSection title="Theme">
        <SettingsReadOnlyRow label="Colour" value="Raven dark" />
        <SettingsHint>Raven has one theme for now.</SettingsHint>
      </SettingsSection>
    </SettingsPage>
  );
}

function AudioVideoSettings({ data, media }: { data: RavenShellData; media: RavenMediaAdapterState }) {
  const nest = data.labels.nestSingular.toLowerCase();
  const [joinMuted, setJoinMuted] = useAppliedPreference(data.preferences.alwaysJoinMuted, (value) => data.updatePreferences({ alwaysJoinMuted: value }));
  const [joinCameraOff, setJoinCameraOff] = useAppliedPreference(data.preferences.joinWithCameraOff, (value) => data.updatePreferences({ joinWithCameraOff: value }));
  const [joinNoShare, setJoinNoShare] = useAppliedPreference(data.preferences.joinWithoutScreenSharing, (value) => data.updatePreferences({ joinWithoutScreenSharing: value }));

  return (
    <SettingsPage title="Audio and video" description="Devices and their live controls are in the bar at the bottom. These settings decide how Raven behaves around them.">
      <SettingsSection title={`When you join a ${nest}`}>
        <SettingsRows>
          <SettingsToggleRow label="Join muted" description="Your microphone stays off until you unmute." checked={joinMuted} onChange={setJoinMuted} />
          <SettingsToggleRow label="Join with camera off" description="Your camera stays off until you turn it on." checked={joinCameraOff} onChange={setJoinCameraOff} />
          <SettingsToggleRow label="Never join already sharing" description="A screen share you started earlier does not carry into the next call." checked={joinNoShare} onChange={setJoinNoShare} />
        </SettingsRows>
      </SettingsSection>

      <DockSettingsSection />

      <SettingsSection title="Seeing yourself" description="How Raven shows your own camera or screen back to you. Other people are not affected.">
        <SettingsRows>
          <SettingsChoice
            title="Straight from this device"
            copy="No delay and no extra network use. Recommended."
            selected={media.selfMediaPreviewMode === "local"}
            disabled={media.busy}
            onSelect={() => void media.setSelfMediaPreviewMode("local")}
          />
          <SettingsChoice
            title="As other people receive it"
            copy="Shows what the call actually delivers. Uses network and adds a short delay."
            selected={media.selfMediaPreviewMode === "rtc"}
            disabled={media.busy}
            onSelect={() => void media.setSelfMediaPreviewMode("rtc")}
          />
        </SettingsRows>
      </SettingsSection>

      <SettingsSection title="Video smoothness" description="How much of this computer Raven uses to draw video. It does not change what you send to others.">
        <SettingsRows>
          <SettingsChoice
            title="Efficient"
            copy="Least processor and battery use. Screen shares up to 15 frames a second."
            selected={media.videoPresentationProfile === "efficiency"}
            disabled={media.busy}
            onSelect={() => void media.setVideoPresentationProfile("efficiency")}
          />
          <SettingsChoice
            title="Balanced"
            copy="Screen shares as smooth as they are sent, up to 30 frames a second. Recommended."
            selected={media.videoPresentationProfile === "balanced"}
            disabled={media.busy}
            onSelect={() => void media.setVideoPresentationProfile("balanced")}
          />
          <SettingsChoice
            title="Best quality"
            copy="Larger camera video and screen shares up to 60 frames a second. Uses more of the processor."
            selected={media.videoPresentationProfile === "quality"}
            disabled={media.busy}
            onSelect={() => void media.setVideoPresentationProfile("quality")}
          />
        </SettingsRows>
      </SettingsSection>

      <SettingsSection title="When you stop hearing people" description="What the headphones button in the bottom bar does.">
        <SettingsRows>
          <SettingsChoice
            title="Silence it here"
            copy="Sound keeps arriving but is not played. Comes back instantly."
            selected={media.deafenMode === "instant"}
            disabled={media.busy}
            onSelect={() => void media.setDeafenMode("instant")}
          />
          <SettingsChoice
            title="Stop receiving it"
            copy="Saves network. Sound takes a moment to return."
            selected={media.deafenMode === "bandwidthSaver"}
            disabled={media.busy}
            onSelect={() => void media.setDeafenMode("bandwidthSaver")}
          />
        </SettingsRows>
      </SettingsSection>

      <SettingsSection
        title={(
          <span className="inline-flex items-center gap-1.5">
            Network activity
            <InfoTooltip label="About network activity">
              Media only. Total is what Raven measures for audio, video and screen sharing; sign-in, signalling and other system traffic are not included. Audio includes shared sound. These choices are kept on this device.
            </InfoTooltip>
          </span>
        )}
        description="A small live readout in the bottom bar while you are in a call."
      >
        <SettingsRows>
          <SettingsToggleRow
            label="Show network activity"
            checked={media.networkActivity.enabled}
            onChange={(enabled) => media.setNetworkActivity({ enabled })}
          />
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
        </SettingsRows>
        <SettingsRows>
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
        </SettingsRows>
      </SettingsSection>
    </SettingsPage>
  );
}

function ServerSettings({ data }: { data: RavenShellData }) {
  const serverName = data.serverProperties.name || "Raven";

  return (
    <SettingsPage title="Server" description="The Raven server this app is connected to. Your calls and account live there.">
      <SettingsSection title="Connection">
        <SettingsRows>
          <SettingsReadOnlyRow label="Name" value={serverName} />
          {data.serverProperties.description ? <SettingsReadOnlyRow label="Description" value={data.serverProperties.description} /> : null}
          <SettingsReadOnlyRow label="Address" value={data.apiServerUrl} />
          <SettingsReadOnlyRow label="Calls go through" value={data.serverProperties.rtcServerUrl || "Not announced by this server"} />
        </SettingsRows>
        <SettingsHint>To use a different server, sign out first.</SettingsHint>
      </SettingsSection>
    </SettingsPage>
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
      setError(err instanceof Error ? err.message : "Could not load your signed-in devices.");
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
      setError(err instanceof Error ? err.message : "That device could not be signed out.");
    } finally {
      setTerminating("");
    }
  };

  return (
    <>
    <SettingsSection title="Password" description="Changing it signs you out on your other devices.">
      <PasswordChangeForm currentLabel="Current password" onChange={data.changePassword} onChanged={() => void load()} />
    </SettingsSection>
    <SettingsSection title="Devices">
      {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
      {loading ? <SettingsHint>Loading…</SettingsHint> : null}
      {!loading && sessions.length === 0 && !error ? <SettingsHint>No signed-in devices were found.</SettingsHint> : null}
      {sessions.length ? (
        <SettingsRows>
          {sessions.map((session) => (
            <div key={session.id} className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-body font-medium">{session.deviceName || "Raven desktop"}</span>
                  {session.current ? <span className="rounded-chip bg-accent px-1.5 py-0.5 text-caption text-foreground">This device</span> : null}
                </div>
                <div className="mt-0.5 text-caption text-muted-foreground">{session.os || "Unknown system"} · {session.latestIp || "Unknown address"}</div>
                <div className="mt-0.5 text-caption text-muted-foreground">
                  Last used {formatSessionTime(session.lastAccessedAt)} · Signed in {formatSessionTime(session.createdAt)}
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                disabled={Boolean(terminating)}
                onClick={() => void terminate(session)}
              >
                {terminating === session.id ? "Signing out…" : "Sign out"}
              </Button>
            </div>
          ))}
        </SettingsRows>
      ) : null}
      <SettingsHint>The address is the last one this server saw for the device. Behind a proxy it may show the proxy instead.</SettingsHint>
    </SettingsSection>
    </>
  );
}

function formatSessionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "at an unknown time";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const NETWORK_DIRECTIONS: Array<{ id: NetworkActivityDirection; label: string }> = [
  { id: "incoming", label: "Show incoming" },
  { id: "outgoing", label: "Show outgoing" },
];

const NETWORK_CATEGORIES: Array<{ id: NetworkActivityCategory; label: string; description?: string }> = [
  { id: "audio", label: "Audio", description: "Voice and any sound you or others share." },
  { id: "video", label: "Video" },
  { id: "screenShare", label: "Screen share" },
  { id: "total", label: "Total" },
];

function toggleSelection<T extends string>(values: T[], value: T, checked: boolean): T[] {
  if (checked) return values.includes(value) ? values : [...values, value];
  return values.filter((candidate) => candidate !== value);
}
