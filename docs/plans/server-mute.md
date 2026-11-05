# Server mute and server deafen

## Context

Discord's Server Mute and Server Deafen let a moderator silence someone for the whole room. The muted person cannot undo it from their own app. Raven has neither: mute and deafen are the person's own choice, and `session_participants.deafened` is only a marker they set.

Enforcement belongs on the server and in LiveKit, not in the client. A client that merely agrees to stay quiet is no mute at all. Raven's split into three LiveKit identities makes this simple: `<userId>#audio` publishes and plays all of a person's audio, including satellites, so limiting that one identity leaves camera, screen share and received video alone.

### Decisions (Soroush, 2026-11-04)

- **Scope:** stored on the membership, so it follows the person across rooms and calls until someone lifts it. In a space that is `tree_members`. A temporary room has no space, so it is `nest_members`, and it ends with the room.
- **What mute covers:** microphone and satellites (system audio, app audio, extra inputs). Camera and screen share video stay.
- **Who:** moderators on members, the owner on anyone else, the starter of a temporary room on anyone else. Same rank rule as removing someone. Nobody can act on themselves.
- **Audit:** none for now.
- **When a mute is lifted, the mic stays off** until the person unmutes it. A moderator must not be able to open someone's mic. Satellites resume as they were.

### Choices made in this plan

- **Deafen also mutes,** as on Discord. The two flags are stored separately: lifting a deafen leaves a mute in place.
- **Deafen cuts audio only.** It sets `CanSubscribe=false` on `#audio`. The viewer identity still receives video, so a deafened person still sees the room.
- **The muted person sees "a moderator", not a name.** The server stores no actor, in line with no audit.
- **Controls live on the stage,** which departs from `raven-ui` rule 9 ("tools that give one person power over another live in settings, behind a confirm"). This is for the moment someone is disrupting a call, and it is instantly reversible, so there is no confirm. Rule 9 gets a line naming this exception. The power stays visible (manifesto 7, "visible, limited, accountable"): everyone in the room sees the mark.

Not in this plan: a list of muted people in space settings, muting per room, durations, audit, marking the difference in the voice overlay. Someone muted while away can be unmuted only once they are in a room again.

## Design

### Step 0: check LiveKit's behaviour first

These decide details below and are not established by reading code. Check them against the local server with a throwaway test before building on them:

1. After `UpdateParticipant` with `CanPublish=false`, does the SFU remove the published tracks, and what does the Rust SDK emit locally?
2. Is `local_participant().permission()` populated on `Connected`, or only after the first change?
3. After an SDK-internal full reconnect, does the participant keep the reduced permission or return to the original token's grants?
4. After `CanSubscribe` returns to true, are subscriptions restored, or must the engine call `set_subscribed` again?

### Server (`services/api/internal`)

**Schema.** New `database/voice_moderation_migrations.go`, registered where `callStateStatements` is:

```sql
ALTER TABLE tree_members ADD COLUMN server_muted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tree_members ADD COLUMN server_deafened BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE nest_members ADD COLUMN server_muted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE nest_members ADD COLUMN server_deafened BOOLEAN NOT NULL DEFAULT FALSE;
```

Leaving and rejoining must not clear these, or the mute is one click from gone. The existing `ON CONFLICT ... DO UPDATE` clauses in `tree_ops.go`, `domain.go` and `server.go` do not touch them; keep it that way and test it. `transferTreeOwnership` clears them on the new owner, because nobody outranks an owner and the flags would be stuck.

**Policy (`http/policy.go`).** Add `treeActionModerateVoice = "voice.moderate"`, minimum role moderator, listed in `treeViewerActions`. A helper `voiceLimitsOf(nest, userID)` reads the right table using `nestBelongsToTree`.

**Permissions in one place (`auth/livekit.go`).** A pure function gives the grants for an identity kind (`audio`, `video`, viewer) and `{muted, deafened}`, used by both the token and the live update so they cannot drift:

| Identity | Muted or deafened | Deafened |
|---|---|---|
| `#audio` | `CanPublish=false` | also `CanSubscribe=false` |
| `#video`, viewer | `CanPublishSources=[CAMERA, SCREEN_SHARE]` | no further change |

The second row exists because peers accept a `raven-audio-*` track from any identity with the person's base id, so a modified client could otherwise publish its mic from `#video`. `liveKitToken` in `http/server.go` passes the limits to `SignLiveKitToken`.

`UpdateParticipant` replaces the whole permission set. Every call must also send `CanPublishData` and `CanUpdateMetadata`, or reconcile's `set_metadata` starts failing.

**Live update (`http/tree_ops.go`).** `applyVoiceLimits(nestID, userID)` beside `kickFromCall`: one `UpdateParticipant` per identity, in a goroutine with `liveKitCallTimeout`, ignoring `liveKitNotFound`, behind a function field on `Server` like `removeParticipant` so tests can record it. A space-wide change applies to every nest of that tree the person holds a seat in, using the query in `kickFromKnownCalls`.

**Closing the gaps.** An old token stays valid for 2 hours, and a token minted just before the mute can join after it. So `heartbeatNestActivity` re-applies limits for restricted people, at most once per 15 seconds per person and nest (an in-memory map). This also heals a failed LiveKit call.

**Endpoint.** `POST /v1/nests/:id/participants/:userId/voice` with `{ "muted"?: bool, "deafened"?: bool }`:

- In a space: `authorizeTreeTarget(..., treeActionModerateVoice, targetRole)`, target must be joined, otherwise `errTreeMemberNotFound`.
- In a temporary room: actor is `CreatorUserID`, target is someone else with a seat.
- Update the row, call `applyVoiceLimits`, then `broadcastSessionUpdate(nestID, sessionID, "participant.state")`. No event log entry (no audit).

**Session summary.** `ParticipantSummary` gains `serverMuted` and `serverDeafened`, read in `activeParticipants` (`http/sessions.go`) by joining `nests` and the right membership table.

### Engine (`apps/desktop/src-tauri/src/audio`)

This is a new exception to engine rule 5, "Mute keeps the track": a server mute takes the track away, because the SFU refuses it. Update the rule in the `raven-media-engine` skill and `docs/architecture.md`.

- **Reading it.** The engine reads `local_participant().permission()` on `Connected` and `Reconnected`, and handles `RoomEvent::ParticipantPermissionChanged` for the local participant in `engine.rs`. LiveKit is the authority, so this works however the change arrived. It stores `publish_revoked` and `subscribe_revoked` in the model, then runs the normal reconcile (rule 2), with no separate path.
- **Publishing.** `reconcile_publications` desires nothing while `publish_revoked`. A refused publish must not surface as an audio error or start a retry loop.
- **Capture.** `CaptureDemand` gains `publish_revoked` (the zero value keeps today's behaviour): `wants_capture` becomes `(call_active && !publish_revoked) || monitoring`. The device is released, so the OS stops reporting the mic in use. The Mixer's local meters still work.
- **Lift.** On `publish_revoked` going true, set the microphone sources' `muted` in the model, so lifting leaves the mic off. Satellites resume.
- **Receiving.** `reconcile_room_subscriptions` is called with `receive_remote_audio && !subscribe_revoked`, and runs again when it clears.
- **Serde.** Add both fields to `domain.rs` and their twins to `src/lib/audio.ts`.
- Check that auto-level holds its fader while nothing is captured, and that push to talk does nothing.

### Desktop UI (`apps/desktop/src`)

- `lib/permissions.ts`: add `"voice.moderate"` to `TreePermission`.
- `lib/callState.ts`: `ParticipantCallState` gains `serverMuted` and `serverDeafened`, defaulting to false so an older server hides everything.
- `lib/api.ts`: `moderateVoice(nestId, userId, patch)`.
- **`LiveMediaStage.tsx` and `MediaTile.tsx`:** a person menu on `VoiceRoom`, `VoiceStrip` and the existing tile menu, with "Mute for everyone" or "Unmute for everyone", and "Deafen for everyone" or "Undeafen for everyone". It shows only when the viewer may act on that person: `treeCan` plus `treeOutranks` in a space, or being the starter of a temporary room. The stage takes this as a prop from `views/NestView.tsx`. The trigger is a real button with an `aria-label`, reachable by keyboard (rule 13).
- **Mark:** the same `MicOff` and `HeadphoneOff`, but as a filled destructive chip rather than a plain slashed icon, titled "Muted by a moderator" or "Deafened by a moderator". Shape before hue (rule 4), in both voice and tile forms (rule 6).
- **Dock (`DeviceDock.tsx`):** mic and hear buttons show the cut state and do nothing while limited, with the tooltip "A moderator muted you". Gate it in the shared device action near `DeviceDock.tsx:193`, so hotkeys, tray and thumbnail toolbar buttons are covered, and do it before `toggleMic`'s sound cue. Disable the "You're muted" hint while server-muted.
- **Adapter (`useRavenMediaAdapter.ts`):** expose `localServerMuted` and `localServerDeafened` from audio state. Keep them apart from `deafened`, which `setCallState` shares as the person's own choice, so lifting a server deafen returns to their own setting.
- **Notices,** in the existing status style, no sound:
  - "A moderator muted you. People here can't hear you."
  - "A moderator deafened you. You can't hear anyone, and they can't hear you."
  - "You can talk again. Your mic stays off until you turn it on."
- Add a row to the role table and a short section to `docs/permissions.md`.

## Compatibility

The migration only adds columns. Deploy the API first:

- A new app on an old API gets no fields and shows no menu.
- An old app on the new API is still silenced by LiveKit, but its user sees no explanation. Check in step 0 that it does not loop on republish.

## Known limit

LiveKit grants cannot limit subscribing by track kind, and the viewer identity needs `CanSubscribe` for video. A modified client could therefore keep listening through its viewer identity while server-deafened. Normal clients never subscribe to audio there. Mute has no such gap, apart from a modified client with a pre-mute token that also stops sending heartbeats, which is possible for at most the token's 2 hours.

## Verification

1. **Go** (`permissions_test.go`, `sessions_test.go`): the rank matrix including self and temporary rooms; the grants function for every identity and flag; token grants for a limited person; flags survive leave and rejoin; flags clear on transfer to the new owner; deafen and mute stored separately; the recorded `UpdateParticipant` calls carry `CanPublishData` and `CanUpdateMetadata`; the heartbeat throttle.
2. **Rust:** `CaptureDemand` with `publish_revoked`; the subscription rule; the mic stays muted after a lift.
3. **TS:** `callState` defaults, and who gets the menu.
4. **Live, once at the end** (`reference_raven_live_call_testing`, tone bot): mute a talking member and measure time until the peer's level drops. Check the OS mic indicator clears, and that camera and screen share keep running. Rejoin and confirm still silent. Force a reconnect and confirm still silent. Unmute and confirm silent until the person turns the mic on. Deafen and confirm received level is zero while video continues. Note what was compiled only on Linux and macOS.
