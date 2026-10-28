import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api, type NestDetails, type SessionSummary, type User } from "@/lib/api";
import { callStatesByUser, callStateSupported } from "@/lib/callState";
import type { AudioMixerState } from "@/lib/audio";
import type { VideoMixerState } from "@/lib/video";
import { connectedPeerIds } from "@/lib/callArrivals";
import { stripSidecarIdentity } from "@/lib/mediaIdentity";
import {
  resolveParticipantVoicePresentation,
  speakingIntensityPercent,
  type ParticipantVoiceActivityMap,
} from "@/lib/speakingActivity";

export const VOICE_OVERLAY_STATE_CHANGED_EVENT = "voice-overlay-state-changed";
export const VOICE_OVERLAY_SETTINGS_CHANGED_EVENT = "voice-overlay-settings-changed";
export const DEFAULT_VOICE_OVERLAY_HOTKEY = "Alt+F8";
export const HORIZONTAL_VOICE_OVERLAY_LIMIT = 5;

export interface VoiceOverlayPosition {
  x: number;
  y: number;
}

export interface VoiceOverlaySettings {
  supported: boolean;
  enabled: boolean;
  hotkey: string;
  layout: VoiceOverlayLayout;
  showNames: boolean;
  nameBackground: VoiceOverlayNameBackground;
  position: VoiceOverlayPosition | null;
  registrationError: string | null;
}

export type VoiceOverlayLayout = "vertical" | "horizontal";

/** The fill behind each name, so it stays readable over any game. */
export type VoiceOverlayNameBackground = "off" | "light" | "strong";

export const DEFAULT_VOICE_OVERLAY_NAME_BACKGROUND: VoiceOverlayNameBackground = "light";

export interface VoiceOverlaySettingsPatch {
  enabled?: boolean;
  hotkey?: string;
  layout?: VoiceOverlayLayout;
  showNames?: boolean;
  nameBackground?: VoiceOverlayNameBackground;
}

export interface VoiceOverlayParticipant {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  isLocal: boolean;
  speaking: boolean;
  speakingLevel: number;
  muted: boolean;
  deafened: boolean;
  /** "Back in a bit". */
  away: boolean;
  screenSharing: boolean;
  cameraOn: boolean;
}

export interface VoiceOverlaySnapshot {
  nestId: string | null;
  nestName: string | null;
  locationLabel: string;
  connected: boolean;
  /** False against a server that predates the shared call state: no Back in a bit button. */
  awaySupported: boolean;
  participants: VoiceOverlayParticipant[];
}

export const EMPTY_VOICE_OVERLAY_SNAPSHOT: VoiceOverlaySnapshot = {
  nestId: null,
  nestName: null,
  locationLabel: "nest",
  connected: false,
  awaySupported: false,
  participants: [],
};

export const voiceOverlayCommands = {
  isSupported: () => invoke<boolean>("overlay_is_supported"),
  getSettings: () => invoke<VoiceOverlaySettings>("overlay_get_settings"),
  updateSettings: (patch: VoiceOverlaySettingsPatch) =>
    invoke<VoiceOverlaySettings>("overlay_update_settings", { patch }),
  toggle: () => invoke<boolean>("overlay_toggle"),
  show: () => invoke<void>("overlay_show"),
  hide: () => invoke<void>("overlay_hide"),
  savePosition: (position: VoiceOverlayPosition) =>
    invoke<VoiceOverlaySettings>("overlay_save_position", { position }),
  getSnapshot: () => invoke<VoiceOverlaySnapshot>("overlay_get_snapshot"),
  updateSnapshot: (snapshot: VoiceOverlaySnapshot) =>
    invoke<void>("overlay_update_snapshot", { snapshot }),
};

export async function subscribeVoiceOverlaySnapshot(
  onSnapshot: (snapshot: VoiceOverlaySnapshot) => void,
) {
  return listen<VoiceOverlaySnapshot>(VOICE_OVERLAY_STATE_CHANGED_EVENT, (event) =>
    onSnapshot(event.payload),
  );
}

export async function subscribeVoiceOverlaySettings(
  onSettings: (settings: VoiceOverlaySettings) => void,
) {
  return listen<VoiceOverlaySettings>(VOICE_OVERLAY_SETTINGS_CHANGED_EVENT, (event) =>
    onSettings(event.payload),
  );
}

export function buildVoiceOverlaySnapshot({
  user,
  details,
  activeSession,
  connected,
  mixerState,
  videoMixer,
  speakingActivity,
  screenSharingUserIds,
  locationLabel,
  localCallState,
}: {
  user: User;
  details: NestDetails;
  activeSession: SessionSummary | null;
  connected: boolean;
  mixerState: AudioMixerState | null;
  videoMixer: VideoMixerState | null;
  speakingActivity: ParticipantVoiceActivityMap;
  screenSharingUserIds: string[];
  locationLabel: string;
  /** What you just set; the server's echo of it arrives a moment later. */
  localCallState?: { away: boolean; deafened: boolean };
}): VoiceOverlaySnapshot {
  const callStates = callStatesByUser(
    activeSession?.participants,
    localCallState ? { userId: user.id, ...localCallState } : undefined,
  );
  // Who is listed is exactly who the room view counts as connected (`connectedPeerIds`),
  // so a slow joiner shows up here at the same moment their avatar stops "connecting".
  const connectedIds = connectedPeerIds({ session: activeSession, audioState: mixerState, videoState: videoMixer });
  const names = new Map<string, string>();
  for (const participant of activeSession?.participants ?? []) {
    names.set(participant.userId, participant.displayName || participant.username);
  }
  for (const remoteParticipant of mixerState?.remoteParticipants ?? []) {
    const userId = stripSidecarIdentity(remoteParticipant.participantId);
    if (userId && !names.has(userId) && remoteParticipant.displayName) names.set(userId, remoteParticipant.displayName);
  }
  for (const track of videoMixer?.remoteTracks ?? []) {
    const userId = stripSidecarIdentity(track.participantId);
    if (userId && !names.has(userId) && track.displayName) names.set(userId, track.displayName);
  }

  const participants = new Map<string, { userId: string; displayName: string; isLocal: boolean }>();
  for (const participant of activeSession?.participants ?? []) {
    participants.set(participant.userId, {
      userId: participant.userId,
      displayName: names.get(participant.userId) ?? participant.userId,
      isLocal: participant.userId === user.id,
    });
  }

  if (connected || participants.size > 0) {
    participants.set(user.id, {
      userId: user.id,
      displayName: participants.get(user.id)?.displayName ?? user.displayName ?? user.username,
      isLocal: true,
    });
  }

  for (const userId of connectedIds) {
    if (participants.has(userId)) continue;
    participants.set(userId, { userId, displayName: names.get(userId) ?? userId, isLocal: userId === user.id });
  }

  const screenSharing = new Set(screenSharingUserIds.map(stripSidecarIdentity).filter(Boolean));
  if (
    videoMixer?.localSources.some(
      (source) =>
        (source.kind === "display" || source.kind === "window") &&
        (source.publishing || source.publishedTrack != null),
    )
  ) {
    screenSharing.add(user.id);
  }
  const cameraUsers = cameraUserIdsForOverlay(videoMixer, user.id);
  const liveKitSpeaking = new Map<string, boolean>();
  for (const participant of videoMixer?.participants ?? []) {
    const userId = stripSidecarIdentity(participant.participantId);
    liveKitSpeaking.set(userId, Boolean(liveKitSpeaking.get(userId) || participant.speaking));
  }

  return {
    nestId: details.nest.id,
    nestName: details.nest.name,
    locationLabel: normalizeVoiceOverlayLocationLabel(locationLabel),
    connected,
    awaySupported: callStateSupported(activeSession),
    participants: Array.from(participants.values()).map((participant) => {
      const voice = resolveParticipantVoicePresentation(
        liveKitSpeaking.get(participant.userId) ?? false,
        speakingActivity[participant.userId],
      );
      return {
        userId: participant.userId,
        displayName: participant.displayName,
        avatarUrl: api.userAvatarUrl(participant.userId),
        isLocal: participant.isLocal,
        speaking: voice.speaking,
        speakingLevel: speakingIntensityPercent(voice.intensity),
        muted: participant.isLocal
          ? isLocalMuted(mixerState)
          : isRemoteMuted(mixerState, participant.userId),
        deafened: callStates.get(participant.userId)?.deafened ?? false,
        away: callStates.get(participant.userId)?.away ?? false,
        screenSharing: screenSharing.has(participant.userId),
        cameraOn: cameraUsers.has(participant.userId),
      };
    }),
  };
}

export function normalizeVoiceOverlayLocationLabel(locationLabel: string) {
  return locationLabel.trim().toLowerCase() || "nest";
}

export function cameraUserIdsForOverlay(videoMixer: VideoMixerState | null, localUserId: string) {
  const cameraUsers = new Set<string>();
  if (
    videoMixer?.localSources.some(
      (source) => source.kind === "camera" && (source.publishing || source.publishedTrack != null),
    )
  ) {
    cameraUsers.add(localUserId);
  }
  for (const track of videoMixer?.remoteTracks ?? []) {
    if (track.source !== "camera" || track.muted) continue;
    const userId = stripSidecarIdentity(track.participantId);
    // LiveKit can briefly retain the local participant's subscribed camera track
    // after the native source has stopped. The local source is authoritative for
    // the local camera indicator; remote tracks are only authoritative for peers.
    if (userId && userId !== localUserId) cameraUsers.add(userId);
  }
  return cameraUsers;
}

export function visibleHorizontalVoiceOverlayParticipants(
  participants: VoiceOverlayParticipant[],
  limit = HORIZONTAL_VOICE_OVERLAY_LIMIT,
) {
  const prioritized = [
    ...participants.filter((participant) => participant.speaking),
    ...participants.filter((participant) => !participant.speaking),
  ];
  return {
    participants: prioritized.slice(0, limit),
    hiddenCount: Math.max(0, prioritized.length - limit),
  };
}

export function formatHotkeyEvent(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string | null {
  const key = normalizeHotkeyKey(event.key, event.code);
  if (!key) return null;

  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Control");
  if (event.metaKey) parts.push("Command");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(key);

  return parts.join("+");
}

function isLocalMuted(mixerState: AudioMixerState | null) {
  const micSources = (mixerState?.localSources ?? []).filter((source) => source.sourceType === "microphone");
  if (micSources.length === 0) return true;
  return !micSources.some(
    (source) =>
      source.publishedTrack != null &&
      !source.publishedTrack.muted &&
      !source.channelStrip.mute.muted,
  );
}

function isRemoteMuted(mixerState: AudioMixerState | null, participantId: string) {
  const tracks = remoteMicTracks(mixerState, participantId);
  if (tracks.length === 0) return true;
  return tracks.every((track) => track.track.muted);
}

function remoteMicTracks(mixerState: AudioMixerState | null, participantId: string) {
  return (mixerState?.remoteTracks ?? []).filter(
    (track) =>
      stripSidecarIdentity(track.track.participantId) === participantId &&
      track.track.sourceType === "microphone",
  );
}

function normalizeHotkeyKey(key: string, code: string) {
  const aliases: Record<string, string> = {
    " ": "Space",
    Esc: "Escape",
    Del: "Delete",
    Ins: "Insert",
    Up: "ArrowUp",
    Down: "ArrowDown",
    Left: "ArrowLeft",
    Right: "ArrowRight",
  };
  const normalized = aliases[key] ?? key;
  if (["Control", "Alt", "Shift", "Meta", "OS"].includes(normalized)) return null;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(normalized)) return normalized;
  if (/^[a-z]$/i.test(normalized)) return normalized.toUpperCase();
  if (/^[0-9]$/.test(normalized)) return normalized;
  if (code.startsWith("Numpad") && /^[0-9]$/.test(key)) return key;
  return normalized;
}
