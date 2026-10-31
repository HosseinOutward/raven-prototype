# Plan 03 — Controls on the overlay

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`, desktop app in `apps/desktop`). Read
`docs/plans/voice-overlay/README.md` first and open `prototype.html` beside it: hover the
card there to see what this plan builds.

Plans 01 and 02 must be done (interaction modes and `voice-overlay-interaction-changed`
from 01; the card from 02). Check before starting; if either is missing, stop and tell
the user. Plan 05 (Back in a bit through the server) may or may not be done; this plan
works either way (see "Back in a bit").

## Before you start

- Load `raven-ui` and `raven-media-engine`. The media adapter
  (`src/shells/ravenv1/useRavenMediaAdapter.ts`) and the dock's effects
  (`DeviceDock.tsx`) are behaviour the `raven-ui` boundaries protect: add to them, don't
  restyle or reorder what's there.
- Build and app rules as in plan 01. Don't commit unless asked.

## What is true now

Paths are under `apps/desktop`. Line numbers are from 2026-10-26; verify them.

- The overlay window is a separate webview. It has no access to the media adapter, which
  lives in the main window. Today nothing flows from the overlay back to the main window.
- The dock already runs mute and deafen for global hotkeys and the taskbar thumbnail
  toolbar through `runCallAction` (`DeviceDock.tsx` ~line 133), guarded so a pending
  action isn't sent twice (`runGuardedThumbnailAction`, `setPendingCallActions`).
  Media hotkeys arrive as a Tauri event (`subscribeMediaHotkeys`,
  `MEDIA_HOTKEY_EVENT` in `src-tauri/src/media_hotkeys.rs`).
- A listener's own volume for one incoming track: `media.setRemoteTrackVolume(participantId, trackId, gainDb)`.
  Percent ↔ dB helpers: `gainDbToVolumePercent` / `volumePercentToGainDb` in
  `src/components/media/audioSatellites.ts` (0 % = −60 dB floor, 100 % = 0 dB, 200 % =
  +6 dB). A person's microphone tracks: `media.audioState.remoteTracks` filtered by
  participant and `sourceType === "microphone"` (see `remoteMicTracks` in
  `lib/voiceOverlay.ts`).

## Design

### The action channel

- The overlay calls a new command, `overlay_action(action)`. Rust emits it to the main
  window as `voice-overlay-action`. Don't let the overlay call media commands directly:
  the main window owns the call state, the pending guards and the error toasts.
- Actions:
  `{ kind: "mic" } | { kind: "deafen" } | { kind: "away", away: boolean } | { kind: "volume", userId: string, percent: number }`.
- `DeviceDock.tsx` subscribes next to `subscribeMediaHotkeys`. Mic and deafen go through
  `runCallAction`, so they behave exactly like the hotkeys. Volume maps to every
  microphone track of that user and calls `setRemoteTrackVolume` with
  `volumePercentToGainDb`. Away calls what plan 05 adds.
- Failures surface as the dock surfaces them today (a toast in the main window). The
  overlay just shows the state the next snapshot brings back.

### The button bar

While the card is interactive, a bar slides in directly under your row (in a row-shaped
card, after your avatar at the end nearest the screen edge). It slides out when
interaction ends. Brief, soft motion; none with reduced motion.

- **Mute:** mic icon; red slashed mic with a tinted `destructive` background while muted.
- **Deafen:** headphones; slashed and tinted while deafened.
- **Back in a bit** (wider, words): "Back in a bit"; while set: "I'm back".
- Each button has an `aria-label` and a `title` that includes the hotkey when one is set
  (the overlay can't host Radix tooltips well; don't add them).
- While an action is pending, only that button is disabled (rule 14).
- Outside a call, there's no bar.

Switches (`overlayButtons: { mute, deafen, away }`, all on): each hides its button; with
all three off, there's no bar. One row in Settings › Voice overlay, "Buttons on the
overlay", opening a small popover with three switches, or three switch rows if that reads
better in the panel. Your call, following `raven-ui`.

### Scroll for volume

Switch `scrollVolume` (on): "Scroll on a person to change their volume".

- While interactive, the mouse wheel over a person's row changes their volume by 10 % a
  notch, 0–200 %. Not on your own row.
- While changing, and for 1.5 s after, the row shows the percent on the right and a thin
  bar under the name (as in the prototype). After that, a person whose volume isn't 100 %
  keeps a small percent in `muted-foreground` while interactive, so you can find it again;
  never when not interactive.
- Clicking the percent resets to 100 %.
- Send at most every 80 ms while scrolling, and always the last value, the way
  `SatelliteCluster.tsx` throttles its slider.
- Add `volumePercent` to `VoiceOverlayParticipant` (Rust and TypeScript, default 100),
  read from that person's mic track gain, so the overlay shows the real value and stays in
  step with the Mixer.

### Back in a bit

- If the snapshot says the server supports it (`awaySupported`, added by plan 05), show
  the button. If plan 05 isn't there yet, add `awaySupported: false` and `away: false`
  per participant (Rust and TypeScript) and leave the button hidden; plan 05 turns it on.
- The button sends `{ kind: "away", away: !current }`. Your row shows "Back in a bit" in
  `muted-foreground`; other rows show it as their status (plan 02's priority order).

## Checking your work

1. `bun run build`, `bun test`, the `raven-ui` sweep, `cargo test`.
2. In the real app with a second participant, in each interaction mode: mute, deafen and
   (if 05 is in) Back in a bit from the overlay, and the dock agrees each time; volume by
   scrolling, and the Mixer agrees; a quick double press doesn't send twice; while
   clicking, keyboard input keeps going to the app underneath.
3. Each switch hides what it should.
4. Report what you saw and what you couldn't check.

## As built (2026-10-29)

Built, with no `setAway` wiring. Where the build differs from the text above, this wins:

- **Pure logic lives in `src/lib/voiceOverlayControls.ts`** (tests in `voiceOverlayControls.test.ts`):
  `takeWheelNotches` (trackpad deltas add up to whole notches, scrolling up is louder),
  `steppedVolumePercent` / `clampVolumePercent` (10 % a notch, 0–200), `cardButtons` (which
  buttons show), `volumeReadout` (flash for 1.5 s, then a changed value stays while
  interactive), `createLatestThrottle` (at most every 80 ms, always the last value).
- **Actions:** `overlay_action` (async) emits `voice-overlay-action` to the `main` window with
  `emit_to`. The action is tagged by `kind`: `mic`, `deafen`, `away`, `volume` (`userId`,
  `percent`). `DeviceDock.tsx` runs mic and deafen through `runCallAction`; volume goes to every
  microphone track of that person (`remoteMicTracks`) with `volumePercentToGainDb`; errors are
  toasts. `away` does nothing, with the comment `// Wired to media.setAway when plan 05 is merged.`
- **Snapshot:** `awaySupported` on the snapshot; `away` and `volumePercent` on each participant.
  `volumePercent` defaults to 100 on the Rust side (field-level serde default), read from the
  first microphone track's gain. Other people's `away` is always false until plan 05.
- **Settings:** `overlayButtons: { mute, deafen, away }` and `scrollVolume`, all on by default;
  a file without them loads with all on. The "Using the overlay" group has three button switch
  rows and the scroll row after Interact (not a popover), then Position.
- **The button bar:** under your row in Column, after your avatar in Row. It fades in and out
  with the `pop-in` / `pop-out` tokens. Press pending: the pressed button is disabled until the
  flag it changes changes, or 2 s pass. Each title shows the hotkey from `mediaHotkeyCommands`
  when one is set. Back in a bit stays hidden while `awaySupported` is false.
- **Scroll:** a non-passive wheel listener on the card, only on other people's rows
  (`data-volume-user`) and only while interactive. The changed value is kept for 2.5 s,
  until the main window's value takes over; the percent and bar show for 1.5 s. The bar
  is drawn in Column only; in Row there is the percent alone. Clicking the percent resets it to 100 %.

Seen in the dev app (signed out, one 1920×1080 monitor, scale 100 %, Column and Row):
the card at rest and interactive, the Mute and Deafen bar under your row, a changed volume
with its bar, the percent kept while interactive. A wheel-up on a row moved 60 % to 90 % and the
main window received the volume actions about 80 ms apart, ending on the last value. Mute
and Deafen clicks sent `mic` and `deafen`, and Mute was disabled until the pending window ended.
Each switch hid what it should; with all three off there is no bar; the scroll switch off removes
the volume rows.

Not checked: a real OS mouse wheel over the overlay (the wheel was dispatched inside the
overlay webview; the system setting "scroll inactive windows" reads as on); the dock's
handler and the media effect (the dock is not mounted while signed out, so no mute, deafen or
volume reached the engine); the Settings panel on screen (it needs sign-in); the Mixer agreeing
after a volume change; Back in a bit (plan 05); Hold mode.
