import { useMemo } from "react";
import { AlertCircle, ChevronLeft, Eye, Loader2, Mic, MicOff, MonitorUp, Video, VideoOff } from "lucide-react";
import { pushToTalkKeyLabel } from "@/lib/pushToTalk";
import { usePushToTalk } from "../usePushToTalk";
import { groupAudioSatellites, type SatelliteActions } from "@/components/media/audioSatellites";
import { LiveMediaStage } from "@/components/media/LiveMediaStage";
import type { VoiceModeration } from "@/components/media/VoiceModeration";
import { watchNewSharesPreference } from "@/components/media/stageState";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { PortsControl } from "@/components/workshop/PortsPanel";
import { api, type LauncherNest, type Nest } from "@/lib/api";
import { knownConnectedPeerIds } from "@/lib/callArrivals";
import { callStatesByUser, callStateSupported, voiceModerationSupported } from "@/lib/callState";
import { canModerateVoice } from "@/lib/permissions";
import { toast } from "@/components/ui/toast";
import { AvatarStack, GroupedList, LiveDot } from "../atoms";
import { formatRelativeTime, type RavenShellData, type RavenView } from "../state";
import type { RavenMediaAdapterState } from "../useRavenMediaAdapter";
import type { NestEntryController } from "../useNestEntry";
import { DoorwayHeader, DoorwayPage, DoorwayRow, namesSentence, nestPeople, treeNameFor } from "./shared";

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
        headerExtra={<PortsControl placeKind="nest" placeId={nest.id} userId={localUserId} people={nestPeople(nest, data).filter((person) => person.id !== localUserId)} />}
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

  const settingsLink = (
    <button type="button" onClick={() => onNavigate({ kind: "settings", section: "audio-video" })} className="rounded-chip text-foreground underline underline-offset-4 transition-colors hover:text-muted-foreground">
      Change this in Settings
    </button>
  );

  const join = () => {
    void entry
      .enter(nest.id)
      .then((result) => {
        if (result === "joined") onNavigate({ kind: "nest", id: nest.id });
      })
      .catch(() => undefined);
  };

  return (
    <DoorwayPage>
      <DoorwayHeader
        context={
          tree ? (
            <button
              type="button"
              onClick={() => onNavigate({ kind: "tree", id: tree.id })}
              className="inline-flex min-w-0 items-center gap-0.5 rounded-chip transition-colors hover:text-foreground"
            >
              <ChevronLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <bdi className="truncate">{tree.name}</bdi>
            </button>
          ) : (
            <span className="truncate">
              {data.labels.temporaryNest}
              {nest.expiresAt && !closed ? ` · closes ${formatRelativeTime(nest.expiresAt)}` : ""}
            </span>
          )
        }
        title={nest.name}
      />

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
            <DoorwayRow
              icon={micOn ? <Mic /> : <MicOff />}
              label="Microphone"
              value={
                !media.audioSupported
                  ? "No microphone found"
                  : joinsMuted
                    ? <>You join muted. {settingsLink}</>
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
            <DoorwayRow
              icon={cameraOn ? <Video /> : <VideoOff />}
              label="Camera"
              value={
                !media.cameraSupported
                  ? "No camera found"
                  : joinsCameraOff
                    ? <>You join with it off. {settingsLink}</>
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
              <DoorwayRow
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
            <DoorwayRow
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
                    {/* A device or connection failure says what to do; the raw engine text stays out of it. A refusal from the server is already written for people. */}
                    <p className="mt-0.5 text-muted-foreground">{media.lastError ? media.lastError.action : media.error}</p>
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
              <div role="status" className="flex h-11 flex-1 items-center rounded-control bg-secondary px-5 text-body">
                Joining in {countdown.secondsLeft}…
              </div>
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
            {enteringHere || countdown ? (
              <Button size="lg" variant="ghost" onClick={entry.cancel}>Cancel</Button>
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
    </DoorwayPage>
  );
}
