import { useMemo, type ReactNode } from "react";
import { AlertCircle, Eye, Loader2, Mic, MicOff, MonitorUp, Video, VideoOff } from "lucide-react";
import { pushToTalkKeyLabel } from "@/lib/pushToTalk";
import { usePushToTalk } from "../usePushToTalk";
import { groupAudioSatellites, type SatelliteActions } from "@/components/media/audioSatellites";
import { LiveMediaStage } from "@/components/media/LiveMediaStage";
import type { VoiceModeration } from "@/components/media/VoiceModeration";
import { watchNewSharesPreference } from "@/components/media/stageState";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api, type LauncherNest, type Nest } from "@/lib/api";
import { knownConnectedPeerIds } from "@/lib/callArrivals";
import { callStatesByUser, callStateSupported, voiceModerationSupported } from "@/lib/callState";
import { canModerateVoice } from "@/lib/permissions";
import { toast } from "@/components/ui/toast";
import { AvatarStack, GroupedList, LiveDot } from "../atoms";
import { formatRelativeTime, type RavenShellData, type RavenView } from "../state";
import type { RavenMediaAdapterState } from "../useRavenMediaAdapter";
import type { NestEntryController } from "../useNestEntry";
import { namesSentence, nestPeople, treeNameFor } from "./shared";

/**
 * A nest is either a threshold (you are looking in, deciding whether to enter)
 * or the room itself (you are inside). Looking never joins.
 */
export function NestView({
  nest,
  data,
  media,
  entry,
  onNavigate,
  onBack,
}: {
  nest: Nest | LauncherNest;
  data: RavenShellData;
  media: RavenMediaAdapterState;
  entry: NestEntryController;
  onNavigate: (view: RavenView) => void;
  onBack: () => void;
}) {
  const mediaHere = media.activeNestId === nest.id;
  const inside = mediaHere && (media.phase === "connected" || media.phase === "leaving");
  const linkedAudioIds = useMemo(
    () => new Set((media.videoState?.localSources ?? []).flatMap((source) => source.linkedAudioSourceId ? [source.linkedAudioSourceId] : [])),
    [media.videoState?.localSources],
  );
  const satellites = useMemo(
    () => groupAudioSatellites(inside ? media.audioState : null, media.sourceActivity, linkedAudioIds),
    [inside, linkedAudioIds, media.audioState, media.sourceActivity],
  );
  const activeSession = data.getActiveSession(nest.id);
  const connectedPeers = useMemo(
    () => (inside ? knownConnectedPeerIds({ session: activeSession, audioState: media.audioState, videoState: media.videoState }) : null),
    [activeSession, inside, media.audioState, media.videoState],
  );
  const localUserId = data.user?.id;
  const { localAway, localDeafened } = media;
  const callStates = useMemo(
    () => (inside && callStateSupported(activeSession)
      ? callStatesByUser(activeSession?.participants, localUserId ? { userId: localUserId, away: localAway, deafened: localDeafened } : undefined)
      : null),
    [activeSession, inside, localAway, localDeafened, localUserId],
  );
  const treeDetails = nest.treeId ? data.getTreeDetails(nest.treeId) : undefined;
  const canOfferModeration = inside && voiceModerationSupported(activeSession);
  const voiceModeration = useMemo<VoiceModeration | undefined>(() => {
    if (!canOfferModeration || !localUserId) return undefined;
    return {
      canModerate: (userId) => canModerateVoice(nest, treeDetails, localUserId, userId),
      setLimit: (userId, patch) => {
        void api.moderateVoice(nest.id, userId, patch).catch((err: unknown) => {
          toast({ title: "That didn’t go through", description: err instanceof Error ? err.message : "Try again in a moment.", tone: "error" });
        });
      },
    };
  }, [canOfferModeration, localUserId, nest, treeDetails]);
  const { setRemoteTrackVolume, setRemoteTrackMuted, stopScreenShare } = media;
  const satelliteActions = useMemo<SatelliteActions>(() => ({
    setVolume: async (satellite, gainDb) => {
      if (satellite.remote) await setRemoteTrackVolume(satellite.remote.participantId, satellite.remote.trackId, gainDb);
    },
    setMutedForMe: async (satellite, muted) => {
      if (satellite.remote) await setRemoteTrackMuted(satellite.remote.participantId, satellite.remote.trackId, muted);
    },
    openMixer: () => onNavigate({ kind: "mixer" }),
    stopShare: () => void stopScreenShare().catch(() => undefined),
  }), [onNavigate, setRemoteTrackMuted, setRemoteTrackVolume, stopScreenShare]);

  if (inside) {
    return (
      <LiveMediaStage
        title={nest.name}
        subtitle={treeNameFor(data, nest.treeId)}
        connected={media.phase === "connected"}
        phase={media.phase}
        audioNotice={media.audioNotice}
        audioNoticeKind={media.audioNoticeKind}
        videoState={media.videoState}
        speakingActivity={media.speakingActivity}
        videoStreamEndpoint={media.videoStreamEndpoint}
        selfMediaPreviewMode={media.selfMediaPreviewMode}
        watchNewShares={watchNewSharesPreference(data.preferences)}
        onWatchNewSharesChange={(watchNewShares) => void data.updatePreferences({ watchNewShares }).catch(() => undefined)}
        onStopScreenShare={() => void media.stopScreenShare().catch(() => undefined)}
        onRetryAudio={() => void media.retryIncomingAudio()}
        satellites={satellites}
        satelliteActions={satelliteActions}
        roomLabel={data.labels.nestSingular}
        connectedPeerIds={connectedPeers}
        callStates={callStates}
        voiceModeration={voiceModeration}
        callVote={media.callVote}
        localUserId={localUserId}
        pictureInPictureKeys={media.pictureInPictureKeys}
        onOpenPictureInPicture={media.openPictureInPicture}
        onClosePictureInPicture={media.closePictureInPicture}
      />
    );
  }

  return <NestThreshold nest={nest} data={data} media={media} entry={entry} onNavigate={onNavigate} onBack={onBack} />;
}

/** Before you enter: who is inside, what you will reveal, and one way in. */
function NestThreshold({
  nest,
  data,
  media,
  entry,
  onNavigate,
  onBack,
}: {
  nest: Nest | LauncherNest;
  data: RavenShellData;
  media: RavenMediaAdapterState;
  entry: NestEntryController;
  onNavigate: (view: RavenView) => void;
  onBack: () => void;
}) {
  const nestLabel = data.labels.nestSingular.toLowerCase();
  const treeLabel = data.labels.treeSingular.toLowerCase();
  const tree = nest.treeId ? data.getTree(nest.treeId) : undefined;
  const selfId = data.user?.id;
  const people = nestPeople(nest, data).filter((person) => person.id !== selfId);
  const enteringHere = entry.enteringNestId === nest.id;
  const countdown = entry.pending?.nestId === nest.id ? entry.pending : null;
  const requested = entry.requestedNestId === nest.id;
  const busyElsewhere = Boolean(entry.enteringNestId && !enteringHere) || media.phase === "leaving";
  const otherNest = media.activeNestId && media.activeNestId !== nest.id ? data.getNest(media.activeNestId) : undefined;
  const closed = nest.lifecycleState === "expired" || nest.lifecycleState === "closed" || nest.status === "ended";
  const failed = !enteringHere && media.phase === "error" && Boolean(media.error);
  // The API refuses a voted-out person with "You were voted out of this call. You can come back in N minutes."
  const votedOut = failed ? /^You were voted out of this call\.\s*(.*)$/.exec(media.error ?? "")?.[1] || null : null;

  const joinsMuted = data.preferences.alwaysJoinMuted;
  const joinsCameraOff = data.preferences.joinWithCameraOff;
  const micOn = media.localMicOn;
  const pushToTalk = usePushToTalk().settings;
  const cameraOn = media.localCameraEnabled && !joinsCameraOff;
  const sharing = media.screenSharing && !data.preferences.joinWithoutScreenSharing;

  const join = () => {
    void entry
      .enter(nest.id)
      .then((result) => {
        if (result === "joined") onNavigate({ kind: "nest", id: nest.id });
      })
      .catch(() => undefined);
  };

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-[420px]">
        {tree ? (
          <button
            type="button"
            onClick={() => onNavigate({ kind: "tree", id: tree.id })}
            className="rounded-chip text-small text-muted-foreground transition-colors hover:text-foreground"
          >
            {tree.name}
          </button>
        ) : (
          <div className="text-small text-muted-foreground">
            {data.labels.temporaryNest}
            {nest.expiresAt && !closed ? ` · closes ${formatRelativeTime(nest.expiresAt)}` : ""}
          </div>
        )}
        <h1 className="mt-1 text-display font-semibold">{nest.name}</h1>

        <div className="mt-4 flex min-h-7 items-center gap-3">
          {people.length ? (
            <>
              <AvatarStack people={people} max={5} size="md" />
              <span className="flex min-w-0 items-center gap-2 text-small text-muted-foreground">
                <LiveDot />
                <span className="truncate">{namesSentence(people.map((person) => person.name), 3)} {people.length === 1 ? "is" : "are"} here</span>
              </span>
            </>
          ) : (
            <span className="text-small text-muted-foreground">{closed ? `This ${nestLabel} has closed.` : "Nobody is here yet. You would be the first."}</span>
          )}
        </div>

        {closed ? null : (
          <>
            <GroupedList className="mt-6">
              <RevealRow
                icon={micOn ? <Mic /> : <MicOff />}
                label="Microphone"
                value={
                  !media.audioSupported
                    ? "No microphone found"
                    : joinsMuted
                      ? "You join muted. Change this in Settings."
                      : !micOn
                        ? "Muted. Nobody will hear you."
                        : pushToTalk?.supported && pushToTalk.enabled
                          ? `On. People hear you while you hold ${pushToTalkKeyLabel(pushToTalk.key)}.`
                          : "On. People will hear you."
                }
                control={
                  media.audioSupported && !joinsMuted ? (
                    <Switch aria-label="Microphone" checked={micOn} disabled={media.busy} onCheckedChange={() => void media.toggleMic().catch(() => undefined)} />
                  ) : null
                }
              />
              <RevealRow
                icon={cameraOn ? <Video /> : <VideoOff />}
                label="Camera"
                value={
                  !media.cameraSupported
                    ? "No camera found"
                    : joinsCameraOff
                      ? "You join with it off. Change this in Settings."
                      : cameraOn
                        ? media.cameraStatus === "live" ? "On. People will see you." : "It turns on when you join. People will see you."
                        : "Off. Nobody will see you."
                }
                control={
                  media.cameraSupported && !joinsCameraOff ? (
                    <Switch aria-label="Camera" checked={media.localCameraEnabled} disabled={media.busy} onCheckedChange={() => void media.toggleCamera().catch(() => undefined)} />
                  ) : null
                }
              />
              {sharing ? (
                <RevealRow
                  icon={<MonitorUp />}
                  label="Screen"
                  value={
                    media.screenShareStatus === "live"
                      ? "You are sharing. People here will see it as soon as you join."
                      : "Ready to share. People will see it as soon as you join."
                  }
                  control={<Button size="xs" variant="secondary" onClick={() => void media.stopScreenShare().catch(() => undefined)}>Stop</Button>}
                />
              ) : null}
              <RevealRow
                icon={<Eye />}
                label="Who sees you here"
                value={
                  tree
                    ? `Members of ${tree.name} can see that you are in this ${nestLabel}.`
                    : `Only people invited or let in can see that you are in this ${nestLabel}.`
                }
              />
            </GroupedList>

            {failed ? (
              <div role="alert" className="mt-4 flex items-start gap-2.5 rounded-card bg-destructive/10 px-3.5 py-3 text-small">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div className="min-w-0">
                  {votedOut ? (
                    <>
                      <div className="font-medium">You were voted out of this call.</div>
                      <p className="mt-0.5 text-muted-foreground">{votedOut}</p>
                    </>
                  ) : (
                    <>
                      <div className="font-medium">Couldn’t connect. You are not in the {nestLabel}.</div>
                      <p className="mt-0.5 text-muted-foreground">{media.error}{media.lastError?.action ? ` ${media.lastError.action}` : ""}</p>
                    </>
                  )}
                </div>
              </div>
            ) : null}

            {requested && !enteringHere ? (
              <div role="status" className="mt-4 rounded-card bg-secondary/60 px-3.5 py-3 text-small text-muted-foreground">
                You asked to join. Someone inside needs to let you in.
              </div>
            ) : null}

            <div className="mt-6 flex items-center gap-2">
              {countdown ? (
                <Button size="lg" variant="secondary" className="flex-1" onClick={entry.cancel}>
                  Joining in {countdown.secondsLeft}… Cancel
                </Button>
              ) : enteringHere ? (
                <Button size="lg" className="flex-1" disabled>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Connecting…
                </Button>
              ) : (
                <Button size="lg" className="flex-1" disabled={busyElsewhere} onClick={join}>
                  {failed ? "Try again" : requested ? "Ask again" : `Join ${nestLabel}`}
                </Button>
              )}
              {enteringHere ? (
                countdown ? null : <Button size="lg" variant="ghost" onClick={entry.cancel}>Cancel</Button>
              ) : (
                <Button size="lg" variant="ghost" onClick={onBack}>Not now</Button>
              )}
            </div>

            <p className="mt-3 text-caption text-subtle">
              {countdown
                ? "People inside have been told you are coming."
                : otherNest
                  ? `You are in ${otherNest.name}. Joining here leaves it.`
                  : people.length
                    ? "People inside get a few seconds’ notice before you enter."
                    : tree ? `Others in this ${treeLabel} will see it come alive.` : ""}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function RevealRow({ icon, label, value, control }: { icon: ReactNode; label: string; value: string; control?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-3">
      <span className="shrink-0 text-muted-foreground [&>svg]:h-[18px] [&>svg]:w-[18px]">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-small font-medium">{label}</div>
        <div className="text-caption text-muted-foreground">{value}</div>
      </div>
      {control}
    </div>
  );
}
