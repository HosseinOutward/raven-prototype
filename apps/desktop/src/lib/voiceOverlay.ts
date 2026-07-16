import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { NestDetails, SessionSummary, User } from "@/lib/api";
import type { AudioMixerState } from "@/lib/audio";
import type { VideoMixerState } from "@/lib/video";
import { stripSidecarIdentity } from "@/lib/mediaIdentity";

export const VOICE_OVERLAY_STATE_CHANGED_EVENT = "voice-overlay-state-changed";
export const DEFAULT_VOICE_OVERLAY_HOTKEY = "Alt+F8";

const SPEAKING_RMS_THRESHOLD_DB = -52;

export interface VoiceOverlayPosition {
  x: number;
  y: number;
}

export interface VoiceOverlaySettings {
  supported: boolean;
  enabled: boolean;
  hotkey: string;
  position: VoiceOverlayPosition | null;
  registrationError: string | null;
}

export interface VoiceOverlaySettingsPatch {
  enabled?: boolean;
  hotkey?: string;
}

export interface VoiceOverlayParticipant {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  isLocal: boolean;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  screenSharing: boolean;
}

export interface VoiceOverlaySnapshot {
  nestId: string | null;
  nestName: string | null;
  connected: boolean;
  participants: VoiceOverlayParticipant[];
}

export const EMPTY_VOICE_OVERLAY_SNAPSHOT: VoiceOverlaySnapshot = {
  nestId: null,
  nestName: null,
  connected: false,
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

export function buildVoiceOverlaySnapshot({
  user,
  details,
  activeSession,
  connected,
  mixerState,
  videoMixer,
  screenSharingUserIds,
}: {
  user: User;
  details: NestDetails;
  activeSession: SessionSummary | null;
  connected: boolean;
  mixerState: AudioMixerState | null;
  videoMixer: VideoMixerState | null;
  screenSharingUserIds: string[];
}): VoiceOverlaySnapshot {
  const participants = new Map<string, { userId: string; displayName: string; isLocal: boolean }>();

  for (const participant of activeSession?.participants ?? []) {
    participants.set(participant.userId, {
      userId: participant.userId,
      displayName: participant.displayName || participant.username,
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

  for (const remoteParticipant of mixerState?.remoteParticipants ?? []) {
    const userId = stripSidecarIdentity(remoteParticipant.participantId);
    if (!userId || userId === user.id || participants.has(userId)) continue;
    participants.set(userId, {
      userId,
      displayName: remoteParticipant.displayName ?? userId,
      isLocal: false,
    });
  }

  for (const userId of screenSharingUserIds.map(stripSidecarIdentity)) {
    if (!userId || participants.has(userId)) continue;
    participants.set(userId, {
      userId,
      displayName: userId,
      isLocal: userId === user.id,
    });
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

  return {
    nestId: details.nest.id,
    nestName: details.nest.name,
    connected,
    participants: Array.from(participants.values()).map((participant) => ({
      userId: participant.userId,
      displayName: participant.displayName,
      avatarUrl: null,
      isLocal: participant.isLocal,
      speaking: participant.isLocal
        ? isLocalSpeaking(mixerState)
        : isRemoteSpeaking(mixerState, participant.userId),
      muted: participant.isLocal
        ? isLocalMuted(mixerState)
        : isRemoteMuted(mixerState, participant.userId),
      deafened: false,
      screenSharing: screenSharing.has(participant.userId),
    })),
  };
}

export function formatHotkeyEvent(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string | null {
  const key = normalizeHotkeyKey(event.key, event.code);
  if (!key) return null;

  const parts: string[] = [];
  if (event.ctrlKey) parts.push("CommandOrControl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  parts.push(key);

  return parts.join("+");
}

function isLocalSpeaking(mixerState: AudioMixerState | null) {
  return (mixerState?.localSources ?? []).some(
    (source) =>
      source.sourceType === "microphone" &&
      source.publishedTrack != null &&
      !source.publishedTrack.muted &&
      !source.channelStrip.mute.muted &&
      source.channelStrip.meter.rmsDb > SPEAKING_RMS_THRESHOLD_DB,
  );
}

function isRemoteSpeaking(mixerState: AudioMixerState | null, participantId: string) {
  return remoteMicTracks(mixerState, participantId).some(
    (track) =>
      !track.track.muted &&
      !track.receiverChannelStrip.mute.muted &&
      track.receiverChannelStrip.meter.rmsDb > SPEAKING_RMS_THRESHOLD_DB,
  );
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
