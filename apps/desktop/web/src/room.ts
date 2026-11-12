import { createLocalAudioTrack, Room, type LocalAudioTrack, RoomEvent, Track, type RemoteTrack, type RemoteTrackPublication, type RemoteParticipant, type RemoteVideoTrack } from "livekit-client";
import { api, type UserPresence } from "@/lib/api";
import { stripSidecarIdentity } from "@/lib/mediaIdentity";
import { presenceForActiveNest } from "@/shells/ravenv1/state";

/**
 * The phone's side of a voice Nest: one LiveKit connection as `<userId>#audio`, which
 * desktop's audio engine hears as a person. It sends the microphone and receives voices,
 * cameras and screen shares; it never sends video. The caller has already joined the
 * Nest (`data.joinNest`), as desktop's `useNestEntry` does before `connectMedia`.
 */

/** Desktop's `useRavenMediaAdapter`: heartbeat every 5 s, given up after 8 s. */
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 8000;

/** Desktop's audio engine plays only tracks named this way (`raven-audio-<trackId>`, a UUID). */
export function micTrackName() {
  return `raven-audio-${crypto.randomUUID()}`;
}

/**
 * Whether to receive a remote track: other people's Raven audio (desktop's
 * `desired_remote_audio_subscription`), and the cameras and screen shares their video
 * publishers (`#video`) send. Our own other connections are never received.
 */
export function wantsTrack(localUserId: string, identity: string, trackName: string, kind: Track.Kind, source: Track.Source) {
  if (stripSidecarIdentity(identity) === localUserId) return false;
  if (kind === Track.Kind.Audio) return trackName.startsWith("raven-audio-");
  return identity.endsWith("#video") && (source === Track.Source.Camera || source === Track.Source.ScreenShare);
}

export interface RemoteVideo {
  key: string;
  userId: string;
  source: "camera" | "screen";
  track: RemoteVideoTrack;
}

export interface Call {
  setMuted: (muted: boolean) => Promise<void>;
  /** Starts blocked call audio; it must be called from a tap. */
  startAudio: () => Promise<void>;
  leave: () => Promise<void>;
}

export interface CallOptions {
  nestId: string;
  userId: string;
  /** The server's own media address, when it gives one (`serverProperties.rtcServerUrl`). */
  rtcServerUrl?: string;
  presence: UserPresence | null;
  onVideos: (videos: RemoteVideo[]) => void;
  /** The browser refuses to play call audio until a tap (Safari), or lets it play again. */
  onAudioBlocked: (blocked: boolean) => void;
  /** The call ended without `leave`: the room dropped, or the server timed us out. */
  onDropped: () => void;
}

export async function joinCall({ nestId, userId, rtcServerUrl, presence, onVideos, onAudioBlocked, onDropped }: CallOptions): Promise<Call> {
  const room = new Room({ adaptiveStream: true });
  const videos = new Map<string, RemoteVideo>();
  const audio = new Map<string, HTMLMediaElement>();
  let ended = false;
  let heartbeat: number | undefined;
  let mic: LocalAudioTrack | undefined;

  const consider = (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    if (wantsTrack(userId, participant.identity, publication.trackName, publication.kind, publication.source)) publication.setSubscribed(true);
  };
  room.on(RoomEvent.TrackPublished, consider);
  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    const key = `${participant.identity}/${publication.trackSid}`;
    if (track.kind === Track.Kind.Audio) {
      // Attached elements play on their own; they only need to be in the page.
      audio.set(key, document.body.appendChild(track.attach()));
      return;
    }
    videos.set(key, { key, userId: stripSidecarIdentity(participant.identity), source: publication.source === Track.Source.ScreenShare ? "screen" : "camera", track: track as RemoteVideoTrack });
    onVideos([...videos.values()]);
  });
  room.on(RoomEvent.AudioPlaybackStatusChanged, () => onAudioBlocked(!room.canPlaybackAudio));
  room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    const key = `${participant.identity}/${publication.trackSid}`;
    track.detach();
    audio.get(key)?.remove();
    audio.delete(key);
    if (videos.delete(key)) onVideos([...videos.values()]);
  });

  // Desktop's leave: media down first, then the goodbye; if that does not reach the
  // server, it times this client out of the Nest by itself.
  const end = async () => {
    if (ended) return;
    ended = true;
    window.clearTimeout(heartbeat);
    await room.disconnect();
    mic?.stop();
    audio.forEach((element) => element.remove());
    await api.disconnectFromNest(nestId).catch(() => undefined);
  };
  // livekit-client resumes short drops itself; this is it giving up.
  room.on(RoomEvent.Disconnected, () => {
    if (!ended) void end().then(onDropped);
  });

  try {
    const token = await api.liveKitToken(nestId, "audio");
    await room.connect(rtcServerUrl || token.url, token.token, { autoSubscribe: false });
    // A room joined late already has tracks; TrackPublished only reports new ones.
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) consider(publication, participant);
    }
    mic = await createLocalAudioTrack();
    await room.localParticipant.publishTrack(mic, { name: micTrackName(), source: Track.Source.Microphone });

    // Desktop's `connectMedia`, after the media is up.
    await api.joinSession(nestId);
    await api.joinNestPresence(nestId);
    const next = presenceForActiveNest(presence);
    await api.updatePresence(next.state, next.reachability, nestId);
  } catch (error) {
    await end();
    throw error;
  }

  const beat = async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT_MS);
    try {
      const result = await api.presenceHeartbeat(controller.signal, true, nestId);
      // The server timed us out of the Nest. Desktop rejoins here; the phone stops.
      if (result.nestActive === false && !ended) {
        await end();
        onDropped();
        return;
      }
    } catch {
      // Presence expiry is the server's; try again at the next beat.
    } finally {
      window.clearTimeout(timeout);
    }
    if (!ended) heartbeat = window.setTimeout(() => void beat(), HEARTBEAT_INTERVAL_MS);
  };
  void beat();

  return {
    setMuted: async (muted) => {
      await (muted ? mic?.mute() : mic?.unmute());
    },
    startAudio: () => room.startAudio(),
    leave: end,
  };
}
