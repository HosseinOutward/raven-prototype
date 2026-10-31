# Plan 01 — Sharing an app that is minimized

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`, desktop app in `apps/desktop`). All media is native
Rust under `apps/desktop/src-tauri/src/audio` and `video`. Window and screen capture on
Windows uses Windows Graphics Capture (WGC) through the `windows-capture` crate.

The v0.1.4 closed alpha reported: **"when an app is minimized, its preview and screen
share is broken."** Two things are covered by that report:

1. picking an app that is *already minimized* (its picker thumbnail and the share itself);
2. an app being *minimized during* a share.

Windows does not draw minimized windows, so nothing can capture one. The job is to make
both cases behave well, not to capture the impossible.

Soroush has decided:

- **Starting a share of a minimized app quietly un-minimizes it**, without focusing it, as
  the code already does. Keep that.
- **When the shared app is minimized during a share, keep the last picture and tell both
  the sharer and the viewers that sharing is paused because the app is minimized.**
  Sharing resumes by itself when the app is restored.

## Before you start

- Load the `raven-media-engine` skill and read `references/video-engine.md`,
  `references/control-plane.md` and `references/testing.md`. Load `raven-ui` too: this
  plan adds a visible state to the dock, the tile and the picker. Read its
  `references/writing.md` and `references/surfaces.md`.
- If you are in a git worktree, `.claude/skills` and `.env` are gitignored, so they are
  missing there. Copy both from `C:\Users\Soroush Taheri\code\raven` and run `bun install`
  in `apps/desktop`.
- Rust builds go through the skill's `scripts/cargo.ps1` or `tauri.ps1`.
  `CARGO_TARGET_DIR` is `%USERPROFILE%\rv`, shared by every checkout, so expect waits if
  another session is building. Only one Raven dev app can run at a time. Check before
  starting it, and if one is running, ask the user rather than stopping it.
- Plan 03 also edits `MediaTile.tsx`, `DeviceDock.tsx` and `VideoPickers.tsx`. Do not run
  the two at the same time in the same checkout.
- Don't commit, push or release unless the user asks.

## What is true now

All paths are under `apps/desktop`. Line numbers are from 2026-10-17; verify them.

- **The picker reads a minimized window's size wrongly.**
  `src-tauri/src/video/capture.rs:1113` `window_size` uses `GetWindowRect`. For a
  minimized (iconic) window that returns the small title-bar box Windows parks off screen
  (around 160×28 at -32000,-32000), not the window's real size.
- **The picker thumbnail is wrong for the same reason.** `window_thumbnail`
  (`capture.rs:1130`) sizes its bitmap from `GetWindowRect` and calls `PrintWindow`. For a
  minimized window that gives a stub or a black image.
- **That wrong size becomes the size of the share, and is the likely main cause of
  "broken".**
  - The picker passes the listed `width`/`height` to `video_start_window_share`
    (`src-tauri/src/video/state.rs:567`).
  - The command fixes the output size once with
    `profile.resolved_for_source(source_width, source_height)` (`state.rs:597`,
    `domain.rs:236`).
  - Capture restores the window (`capture.rs:936`, `restore_window_if_minimized`), but the
    output stays at the title-bar size. Every real frame is scaled into that tiny,
    wrong-shaped picture (`capture.rs:205`).
  - Confirm this on the rig before building on it: share a minimized window and read
    `getStreamStats` or the runtime state's width and height.
- **Minimizing during a share.** WGC stops delivering frames while the window is
  minimized. Nothing detects this. I expect viewers see a frozen picture with no
  explanation, and someone who presses Watch during the pause sees nothing, because no
  new keyframe is sent. Verify this on the rig as well.
- **A muted video track means "not sharing" to the UI.** `useNativeMediaTiles.ts:86`
  treats a muted remote screen track as no share, so the tile would disappear. Do not use
  track mute to signal a pause.
- **Participant attributes are available.** LiveKit's `LocalParticipant::set_attributes`
  exists in the pinned SDK (0.7.45), and the Go token grants `CanUpdateOwnMetadata`
  (`services/api/internal/auth/livekit.go:28`). The publisher is the `<userId>#video`
  participant (`video/engine.rs`).
- **How the dock shows sharing.** It shows the screen-share state from
  `media.screenShareStatus` (`src/shells/ravenv1/useRavenMediaAdapter.ts:411`). Runtime
  status today is `Inactive | Starting | Running | Error` (`video/domain.rs:83`).

## What to build

### 1. Real size and an honest thumbnail for minimized windows (picker)

- For an iconic window, take its size from `GetWindowPlacement`'s `rcNormalPosition`
  (the restored rectangle). Watch for DPI scaling and for maximized-then-minimized windows
  (`WPF_RESTORETOMAXIMIZED`: use the monitor's work area).
- Don't run `PrintWindow` on a minimized window. Return no thumbnail and add a
  `minimized: bool` field to `WindowTarget` (`video/domain.rs` and its twin in
  `src/lib/video.ts`).
- In the picker (`src/components/nest/VideoPickers.tsx`, the Apps tab around line 260),
  show the app icon in place of the thumbnail with the caption "Minimized". Under the
  share button, add one quiet line: "It will be restored when you share it." Follow the
  `raven-ui` writing rules.

### 2. Resolve the output size from the window as it really is

- Don't trust a size the UI sent once. When a window share starts, resolve the output
  from the window's real size after restoring it (or from `rcNormalPosition`). The UI's
  numbers can stay a hint.
- The engine rules apply. Commands edit the model, and reconcile starts capture. Restore
  inside capture start as today, then resolve. Don't add a side path.
- Check what happens when a shared window is resized during a share. If the output stays
  stretched or letterboxed wrongly, say so in your report. Fixing it is out of scope
  unless it is the same small change.

### 3. Detect a pause and keep the picture alive

- While a window share runs, watch for the window being minimized and restored. Poll
  `IsIconic` from the capture runtime every 250 ms or so, or use
  `SetWinEventHook(EVENT_SYSTEM_MINIMIZESTART/END)` if that fits the runtime's thread
  better. Never block the frame callback.
- While paused, keep publishing the last captured frame at a low rate (1–2 fps). Viewers
  then keep a picture, stats stay alive, and someone who presses Watch during the pause
  still gets a keyframe. Keep the track **unmuted**.
- Add a `Paused` runtime status, or a `paused_reason`, to `VideoSourceRuntimeState`, so
  the sharer's UI can read it. Keep the serde twin in `src/lib/video.ts` in step.
- Tell viewers through a participant attribute on the `#video` participant, for example
  `raven.share.paused = "minimized"`. Clear it on restore and when the share stops.
  Surface it on `RemoteVideoTrackState`, or wherever the viewer already reads per-track
  state.
- If the window is *closed*, the share should end as it does today. Check that it does.

### 4. Show the pause (UI)

Follow `raven-ui`: state is shape before hue, the call lives in the dock, and a failure
never replaces what the user is looking at.

- **Viewers' tile** (`MediaTile.tsx`): keep the last frame, dim it slightly, and show a
  chip like the existing "Video paused" one (`MediaTile.tsx:176`). Suggested wording:
  "<Name> minimized the app. Sharing is paused."
- **Sharer**:
  - Their own share tile carries the same chip, worded for them: "Sharing is paused
    while <App> is minimized."
  - The dock's share control stays visibly on: people still see the last picture. Add the
    line to its chevron popover.
  - Consider one toast when the pause starts. No looping or pulsing.
- **Voice overlay**: no change, unless it already shows share state.

## Docs to update

- `references/video-engine.md` in the `raven-media-engine` skill: minimized windows, the
  pause state, and the attribute.
- `docs/architecture.md` if its media-engine section lists runtime statuses.

## Checking your work

- Rust unit tests for the restored-size resolution (normal, maximized-then-minimized) and
  for the paused state transitions.
- `bun run build`, `bun test`, and `sweep.ts` from `raven-ui` should print Clean.
- On the live rig (`references/testing.md`), with a second participant watching:
  1. Minimize Notepad (or any app), open the picker. It shows "Minimized" with the icon
     and the real size.
  2. Share it. It is restored without taking focus, and the viewer receives the real
     resolution. Report the width and height from stream stats, before and after the fix.
  3. Minimize it during the share. Within about half a second, both sides show the
     paused chip and the viewer keeps the last picture. Report the frame rate during the
     pause.
  4. Have the viewer stop and start Watch during the pause: they still get a picture.
  5. Restore the app. Sharing resumes by itself, and the chips clear.
  6. Close the app during a share: the share ends cleanly.
- Report measured results, not "should work". Linux and macOS capture backends cannot be
  compiled here; say so, and leave a note if their minimized behaviour is unknown.
