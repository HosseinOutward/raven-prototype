# Plan 05 — Extra audio sources as their own entries in the room, and motion on join and leave

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`, desktop app in `apps/desktop`). Media is native Rust.
React shows state. A user can publish several audio sources besides their microphone:
system audio, one application's audio (both added from the Mixer or linked to a screen
share), or a second input device.

Two requests from the v0.1.3 closed alpha:

1. **In the room, show each additional audio source a person publishes as its own small
   "sub-participant"**, so you can see that Sara's Spotify is playing and turn it down
   without hunting in the Mixer.
2. **An animation or transition when someone joins or leaves the voice room.**

Run this plan after plan 04 (opt-in Watch), which also edits `LiveMediaStage.tsx`.

## Before you start

- Load `raven-ui` (read `references/design-system.md`, `references/surfaces.md`,
  `references/writing.md`) and `raven-media-engine` (`references/mixer-dsp.md`,
  `references/control-plane.md`).
- If you are in a git worktree, `.claude/skills` and `.env` are gitignored, so they are
  missing there. Copy both from `C:\Users\Soroush Taheri\code\raven`, run `bun install` in
  `apps/desktop`, and set `RAVEN_REPO` to your worktree for the skill's scripts.
- Only one Raven dev app can run at a time. Check before starting it, and if one is
  running, ask the user rather than stopping it.
- Don't commit, push or release unless the user asks.

## What is true now

- **Remote track data.** Every remote audio track arrives in `AudioMixerState.remoteTracks`
  with `PublishedTrackMetadata` (`src-tauri/src/audio/domain.rs:763`):
  - `sourceType` (`microphone`, `systemAudio`, `appAudio`, …), `displayName`, `appName`,
    `appIconDataUrl`, `muted`, `participantId` (the `<userId>#audio` sidecar identity).
  - Meters are emitted per track (`subscribeAudioMeterChanged`).
- **Speaking detection is microphone-only.** `lib/speakingActivity.ts`
  (`useParticipantVoiceActivity`, `meterTargetForUpdate` around line 197) turns meters
  into per-person speaking activity, on purpose: a person "speaks" only through their
  mic. Keep that. Sub-participants need their own activity, keyed by track.
- **Per-viewer controls for shared audio already exist.**
  `ParticipantMediaPreference.sharedAudioVolume/sharedAudioMuted` in
  `components/media/useParticipantMediaPreferences.ts`. Check how they reach the engine
  (`RemoteTrackPreference` in `lib/audio.ts`, the receiver strips) before adding anything.
  Per-track volume may be the better fit.
- **Where people are drawn.**
  - Voice-only people: `VoiceRoom` and `VoiceStrip` in `LiveMediaStage.tsx` (around lines
    311–368).
  - People with video: `MediaTile.tsx`.
  - Tiles come from `useNativeMediaTiles.ts`, which uses the video engine's participants.
  - `stageState.ts` `partitionStageTiles` splits them.
- **Existing motion.**
  - `animate-pop-in`, `animate-fade-in` and `animate-sheet-in` exist (`styles.css`,
    `tailwind.config.ts`; custom names must also be registered in `lib/utils.ts`).
  - The skill's rule 12 and `references/design-system.md` › Motion say animation is
    welcome when it adds elegance, and is forbidden when it is flashy, attention-seeking,
    looping or overused. Follow that section's durations, easing and "not allowed" list.
  - An arrival chime already plays for the room you are in (`RavenShellV1.tsx:61–73`).

## What to build

### Sub-participants

- **Which tracks.** For each person in the room, every published audio track that isn't
  their microphone is drawn as a small satellite attached to that person. This includes
  your own extra sources, so you can see what you are sending (the skill's privacy rule:
  show what you are about to reveal).
- **What a satellite shows.**
  - The app's icon (`appIconDataUrl`), or a source-type glyph for system audio or another
    input.
  - The source's name (app name or display name) in its tooltip and accessible label, for
    example "Sara · Spotify".
  - A speaking ring driven by that track's own meter, using the same ring and `live`
    treatment as people.
  - A muted mark when the track is muted.
- **Placement.** It must read in both forms (rule 6):
  - voice room/strip: satellites sit at the person's avatar, smaller, clustered at one
    side;
  - tile: a small chip row inside the tile's corner.

  Several sources must not crowd: collapse beyond two or three into "+N" with a popover.
- **Actions.** Clicking a satellite opens a small popover: volume for me (slider) and
  Mute for me. Your own satellites instead offer "Open in Mixer" (and Stop, for a
  share-linked source, only if that action already exists).
- **Speaking state.** Extend the voice-activity tracker with a per-track activity map for
  non-microphone tracks. Don't let a person's speaking ring light up because their
  Spotify is playing.
- **Out of scope.** The voice overlay window (its size is set natively; mention it in your
  report as a possible follow-up), and new engine commands. If a per-track volume command
  doesn't exist and is truly needed, stop and ask the user.

### Join and leave motion

- **Join.** A person who joins while you are in the room pops in (`animate-pop-in`) in
  the voice room or strip, and a new tile fades in.
- **No pop on first render.** Nothing animates on the stage's first render or when *you*
  join (everyone already there just appears). The same goes for reconnect resyncs.
- **Leave.** The person fades and shrinks out (about 150–200 ms) before the layout
  closes the gap.
  - This needs the departing entry kept briefly: a small "leaving" list in the component,
    not in shared state.
  - Make sure the person doesn't flicker back if they rejoin during the exit.
- Sub-participants appear and disappear with the same motion.
- Reduced motion: the global rule in `styles.css` already turns animation off. Don't
  override it, and make sure nothing depends on seeing the movement.
- The skill's motion rules already cover join and leave. Don't rewrite them; if you add
  an animation token, list it in the Motion table in `references/design-system.md`.

## Checking your work

- `bun run build`, `bun test` (add tests for the per-track activity and the satellite
  grouping), `sweep.ts` should print Clean.
- **You need a second participant.** The skill's tone bot (`scripts/make-bot.ts`,
  `references/testing.md`) can join as `<hex>#audio` and publish tracks named
  `raven-audio-<uuid>`.
  - See whether the bot can publish a second, non-microphone track with metadata the
    engine accepts. Read how `PublishedTrackMetadata` reaches peers before deciding.
  - Also add your own system- or app-audio source from the Mixer to see your own
    satellite.
  - Join and leave the bot repeatedly to check the motion.
- `references/verifying.md` explains what the bot doesn't show (it isn't a Raven user).
  Report plainly which states you saw and which you couldn't.
