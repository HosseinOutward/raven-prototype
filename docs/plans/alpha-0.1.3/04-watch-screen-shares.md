# Plan 04 — Opt-in "Watch" for screen shares, several streams at once, and stream info

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`, desktop app in `apps/desktop`). Media is native Rust.
React only shows state and invokes commands. Remote video reaches the WebView as MJPEG
`<img>` streams.

From the v0.1.3 closed alpha, testers asked for "Don't watch" on screen shares and
cameras, and for a viewer to see a share's specs. Soroush decided:

- **Screen shares become opt-in**, Discord-style: you see that someone is sharing and
  choose Watch.
- **Plan for watching several streams at the same time.**
- Cameras stay received by default. "Stop watching" a camera must be easy to find.
- Each watched stream can show its specs ("Stream info").

**This plan depends on plan 03**, which adds the per-stream stats command (for example
`video_get_stream_stats`). If it isn't there yet, build everything else, and leave Stream
info for last or stub it behind the command's absence.

## Before you start

- Load `raven-ui` (read `references/design-system.md`, `references/surfaces.md`,
  `references/writing.md`) and `raven-media-engine` (`references/video-engine.md`,
  `references/webrtc-livekit.md`, `references/testing.md`).
- If you are in a git worktree, `.claude/skills` and `.env` are gitignored, so they are
  missing there. Copy both from `C:\Users\Soroush Taheri\code\raven`, run `bun install` in
  `apps/desktop`, and set `RAVEN_REPO` to your worktree when running the skill's scripts.
- `CARGO_TARGET_DIR` is `%USERPROFILE%\rv`, shared by every checkout. Only one Raven dev
  app can run at a time. Check before starting it, and if one is running, ask the user
  rather than stopping it.
- Don't commit, push or release unless the user asks.

## What is true now

- **Subscription decision.** `video/engine.rs:935` `should_receive_video` falls back to
  `remote_preference.unwrap_or(true)` for every remote video.
  - Preferences live in `VideoEngineState.remote_preferences`, keyed by
    `subscription_key(participant, source)`.
  - They survive automatic rejoin (they're passed into `connect`) and are cleared by
    `video_disconnect_room`.
- **The command already takes a source.**
  `video_set_remote_video_receiving(participantId, source, receiving)` accepts
  `"screenshare"`, but the UI only ever sends `"camera"`
  (`components/media/LiveMediaStage.tsx:77–80`,
  `components/media/useParticipantMediaPreferences.ts`).
- **Unsubscribed shares are still visible in state.** `reflect_viewer_state`
  (`engine.rs` around line 1008) lists every remote video publication in
  `remoteTracks`, with `subscribed` and `desired` flags. So the UI can know someone is
  sharing without receiving it. `screenSharingUserIds` (`useRavenMediaAdapter.ts:425`)
  comes from those tracks.
- **The stage.** `LiveMediaStage.tsx` handles layout:
  - grid or focus with a filmstrip;
  - a manual pin;
  - "Follow screen shares" (default `true` in `shells/ravenv1/state.ts:175`), which
    auto-focuses a new share and shows "X started sharing" (around lines 98–110).
  - `MediaTile.tsx` has the tile `…` menu: "Hide their video for me" for cameras
    (line 154), Fit/Fill, and fullscreen.
  - The "Video hidden for you" fallback is at line 79.
  - `stageState.ts` `partitionStageTiles` splits visual tiles from voice-only people.
- **Cost.** Every received share is decoded in software, then re-encoded to 1080p JPEG
  for the `<img>`. Opt-in watching saves download bandwidth and CPU for everyone.

## What to build

### Engine

- Screen shares default to **not received**: the fallback becomes `false` for
  `VideoTrackSource::Screenshare`. Cameras keep `true`. Self-preview behaviour is
  unchanged.
- "Watch" and "Stop watching" call the existing command with `"screenshare"`.
- Keep the preference across reconnects (it already is). Clear it on Leave (it already
  is).
- Unit-test `should_receive_video` for both sources.

### Experience

Design it with the `raven-ui` rules. Voice first: people who are only talking are avatars.
Tiles are for video someone has chosen to see. Colour belongs to people.

- **Seeing that someone is sharing.**
  - An unwatched share appears as a compact share card in the stage's visual area, not a
    full tile. It shows the person, "Sara is sharing their screen", and a Watch button.
  - Don't show the window title: it can reveal what someone is doing.
  - The "Sara started sharing" notice offers Watch instead of switching focus.
  - In the voice room or strip (`VoiceRoom` and `VoiceStrip` in `LiveMediaStage.tsx`), a
    sharing person's avatar carries a small sharing mark that also offers Watch.
- **Watching.** Watch subscribes and turns the card into a normal share tile, with a
  "Starting…" state until frames arrive. "Stop watching" is in the tile's `…` menu and
  also a visible hover/focus button on the tile, and it turns the tile back into a card.
- **Watching several.** Any number of shares can be watched.
  - One watched share: it takes focus, as today.
  - Two or more: they share the stage side by side in a grid of equal size. Pinning one
    makes it the focus, with the others in the filmstrip.
  - Each tile keeps its own fullscreen, Fit/Fill and Stop watching.
  - Cameras and voice-only people keep their places (filmstrip or voice strip).
  - Check the layout with 2 and 3 watched shares plus a camera at 980×700 and at
    1920×1080.
- **"Follow screen shares".** Its old meaning ("bring a new share to the front") no longer
  fits.
  - Replace it with "Watch new shares automatically" in the stage's view options, off by
    default. When on, a new share is watched and brought to the front as before.
  - Migrate the stored preference sensibly; the old value was `true` by default, so don't
    blindly carry it over.
- **Your own share.** Don't show it as a large tile by default.
  - Show a compact card: "You're sharing your screen" with Preview and Stop.
  - Preview shows the existing self-preview tile. With preview off, no JPEG work is done
    for it, because the frame hub only encodes for subscribers.
  - This is the proposed default. Keep it easy to change if Soroush disagrees on review.
- **Cameras.** Keep received by default.
  - Add a hover/focus "Stop watching" button on camera tiles, next to the existing menu
    item, with consistent wording: "Stop watching" / "Watch again".
  - The hidden state keeps the person's place, with the existing "Video hidden for you"
    fallback.
- **Stream info.** In each watched tile's `…` menu, "Stream info" opens a small popover
  that polls plan 03's per-stream command every 1–2 s while it's open, and stops when it
  closes. Show:
  - resolution;
  - fps arriving and fps shown (the second can be lower because of Settings › Audio and
    video › video quality shown; say so in one line if it is);
  - bitrate, packet loss and codec/decoder.

  Use mono for the numbers. Show it only on request; no always-on badges (rule 9).
- **Voice overlay.** It already knows who is sharing (`screenSharingUserIds`). Leave it
  unchanged.
- **Keyboard and screen readers.** Watch and Stop watching are real buttons with clear
  labels ("Watch Sara's screen"). Cards and tiles are reachable by Tab.

### Wording

Follow `references/writing.md`: "Watch", "Stop watching", "Sara is sharing their screen",
"You're sharing your screen". Read product nouns from `data.labels` where they appear.

## Files you will likely touch

- `src-tauri/src/video/engine.rs` (`should_receive_video`) and its tests
- `components/media/LiveMediaStage.tsx`, `MediaTile.tsx`, `stageState.ts` (and its tests),
  `useNativeMediaTiles.ts`, `useParticipantMediaPreferences.ts`
- `shells/ravenv1/state.ts` (the follow preference)

Plan 05 later edits `VoiceRoom` and `VoiceStrip` in `LiveMediaStage.tsx`. Keep your
changes there small: the sharing mark only.

## Checking your work

- `bun run build`, `bun test` (extend `stageState.test.ts` for cards, multi-watch layout
  and the follow migration), `sweep.ts` should print Clean; the Rust tests.
- **A second sharer is needed.** Extend the skill's bot (`scripts/make-bot.ts`; see
  `references/testing.md`) to publish a canvas video track with source `screen_share`
  (identity `<32-hex>#video`), or two of them for multi-watch. Then, in the real app:
  - the share card appears and nothing is received (the network popover's screen-share
    rate stays near zero);
  - Watch: the tile arrives and the rate rises;
  - watch two shares together and check the layout;
  - Stop watching: the rate falls back;
  - reconnect keeps what you watch;
  - Leave and rejoin starts unwatched;
  - "Watch new shares automatically" works;
  - Stream info shows live numbers.
- Your own share captures the real screen. Tell the user before you start one.
- Report what you saw with screenshots, and what you could not check (for example a real
  second Raven client's camera).
