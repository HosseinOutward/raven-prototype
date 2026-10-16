# Plan 02 — Release the microphone when the user leaves a call

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`, desktop app in `apps/desktop`). All media is native
Rust under `apps/desktop/src-tauri/src/audio` and `video`.

During the v0.1.3 closed alpha, a tester noticed that after leaving the voice room their
sound card driver kept using CPU. Raven still had the microphone open. Soroush has decided:
**release capture when the user leaves, unless the Mixer view is open.** The Mixer is the
only place that shows live input levels outside a call.

## Before you start

- Load the `raven-media-engine` skill and read `references/audio-engine.md`,
  `references/control-plane.md` and `references/testing.md`. Load `raven-ui` if anything
  you change is visible.
- If you are in a git worktree, `.claude/skills` and `.env` are gitignored, so they are
  missing there. Copy both from `C:\Users\Soroush Taheri\code\raven` and run `bun install`
  in `apps/desktop`.
- Rust builds go through the skill's `scripts/cargo.ps1` or `tauri.ps1`.
  `CARGO_TARGET_DIR` is `%USERPROFILE%\rv`, shared by every checkout, so expect waits if
  another session is building. Only one Raven dev app can run at a time. Check before
  starting it, and if one is running, ask the user rather than stopping it.
- Don't commit, push or release unless the user asks.

## What is true now

- `src-tauri/src/audio/capture.rs:1649`: `should_capture_source(source) = source.enabled`.
  Nothing else gates capture, so an enabled source captures in or out of a call.
- The microphone source is created lazily on the first join by `ensureDefaultMic`
  (`src/shells/ravenv1/useRavenMediaAdapter.ts:707`) and stays enabled afterwards. So
  from the first call until the app quits, the device is open, and APM (sonora), the
  processor chain and the meters keep running.
- `disconnect_audio_room` (`src-tauri/src/audio/state.rs:2208`) disconnects LiveKit,
  clears remote tracks and runs `reconcile_media`. Capture survives because only
  `enabled` is checked.
- The speaker output stream already stops on disconnect (`audio/engine.rs:630`).
  Don't change that.
- The Mixer is a main-panel view: `view.kind === "mixer"`, toggled in
  `shells/RavenShellV1.tsx:206` and rendered from `RavenShellV1.tsx:488`.

## What to build

Capture should run only when there is a reason to:

```
capture a source  ⇔  source.enabled && (in a call || monitoring requested)
```

- **"In a call"** means from join until the user leaves, including the app's own
  reconnect cycle.
  - The React supervisor rejoins after a lost connection, and its cleanup path calls
    `audioCommands.disconnectRoom()` (see `useRavenMediaAdapter.ts` around lines 449 and
    534) before reconnecting.
  - Closing and reopening the device on every retry would be wrong and slow. Decide where
    this state lives so a reconnect keeps capture open and a real Leave, sign-out,
    duplicate sign-in, removal or closed room releases it.
  - An explicit engine flag set by the adapter is fine. Reusing the LiveKit connection
    state is not.
- **"Monitoring requested"** is a new, small command (for example
  `audio_set_monitoring(enabled: bool)`) that the UI sets while the Mixer view is mounted.
  - Set it from the Mixer view's wrapper or the shell, not by editing
    `AudioMixerPanel.tsx`'s callbacks.
  - Clear it when the view unmounts.
  - Add the typed wrapper in `src/lib/audio.ts`.
  - This is a new wire command, and Soroush's decision authorises it. Keep it minimal.
- Follow the engine rules: commands edit the model, then one reconcile pass makes capture
  match. Lock order is `ops` then state; never hold the state lock across an `.await`.
  No side path that bypasses reconcile.
- When capture stops, the source's runtime goes to `Inactive` and its meter resets (the
  existing reconcile code already does this for inactive runtimes).
- **Join must not lose the first words.**
  - Capture now opens at join instead of already running, so measure the time from Join
    to the first published audio frame.
  - The join countdown (about 3 s) gives you room. If opening the device is slow, open it
    when the countdown starts (`entry.enter`) rather than at connect.
  - Report the measured numbers.
- Mute is unchanged. Hot-mic mute is Soroush's decision: in a call, a muted mic stays
  open and published with zeroed samples.
- Linked share audio sources (system or app audio) only exist during a share. Check they
  are still removed on disconnect as today.

## Docs to update

The skill states this as an open question. Once it's done, update `SKILL.md` ("Known open
question" paragraph) in `.claude/skills/raven-media-engine`, the relevant reference
(`audio-engine.md` or `control-plane.md`), and the "Desktop media engines" section of
`docs/architecture.md` if it describes capture lifetime.

## Checking your work

- Unit tests for the capture decision (enabled × in-call × monitoring) and for the
  reconnect case.
- `bun run build` and `bun test` in `apps/desktop`; the Rust tests via the skill's
  testing reference.
- On the live rig (`references/testing.md`: `stack.ps1 up`, `app.ps1 up`, the tone bot,
  `cdp.ts state`):
  - Join, talk, leave. After leave, the mic source's runtime is `Inactive`.
  - Windows no longer reports the mic in use. Check
    `HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged`:
    Raven's entry gets a non-zero `LastUsedTimeStop` after leave. The tray's microphone
    privacy icon also disappears.
  - Raven's CPU drops back to idle.
  - Open the Mixer outside a call: meters are live. Close it: capture stops.
  - Force a reconnect (the testing reference shows how): capture stays open throughout.
  - Join again: the bot hears you from the first word. Report the time to first frame.
- Report measured results, not "should work". Linux and macOS backends can't be compiled
  here; say so.
