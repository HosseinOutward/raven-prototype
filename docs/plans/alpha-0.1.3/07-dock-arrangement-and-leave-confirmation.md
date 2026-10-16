# Plan 07 — Rearrangeable dock buttons and an optional confirmation before leaving

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`, desktop app in `apps/desktop`). The dock is the
64 px bar at the bottom of the window. Left to right it holds:

- your presence;
- the four device controls (microphone, camera, screen share, hearing/deafen), each a
  split button with a chevron menu;
- the call chip, Leave, the network readout and the Mixer button.

Two requests from the v0.1.3 closed alpha:

1. **Reorder the dock's device buttons.** Soroush decided users should arrange them to
   their own preference, with a properly designed arrangement experience, not a fixed new
   order.
2. **An optional confirmation before leaving the room.**

## Before you start

- Load `raven-ui` and read `references/design-system.md`, `references/surfaces.md` (the
  dock recipe), `references/writing.md`, `references/verifying.md`.
- The dock's behaviour (global hotkeys, the voice-overlay snapshot, the muted hint, call
  actions) must survive unchanged. Load `raven-media-engine` only if you need to touch
  media behaviour; you shouldn't.
- If you are in a git worktree, `.claude/skills` and `.env` are gitignored, so they are
  missing there. Copy both from `C:\Users\Soroush Taheri\code\raven`, run `bun install` in
  `apps/desktop`, and set `RAVEN_REPO` to your worktree for the skill's scripts.
- Only one Raven dev app can run at a time. Check before starting it, and if one is
  running, ask the user rather than stopping it.
- Don't commit, push or release unless the user asks.

## What is true now

- `shells/ravenv1/DeviceDock.tsx`:
  - `DockDeviceControls` (line 507) renders four `DockControl`s in a fixed order: mic,
    camera, screen, hear.
  - The footer grid and Leave button are around lines 337–430. Leave calls
    `runCallAction("leave")`.
- Other Leave paths exist: the tray menu's Leave (`src-tauri/src/tray.rs`, `ID_LEAVE`) and
  the "Leave the nest" button on the Updates page (`shells/RavenShellV1.tsx:420`).
- `@dnd-kit/core`, `@dnd-kit/sortable` and `@dnd-kit/utilities` are installed, and
  `shells/ravenv1/views/TreeNestsSection.tsx` already uses them to arrange nests. Reuse
  its patterns: sensors, keyboard coordinates, announcements.
- Settings: `shells/ravenv1/UserSettings.tsx` (categories at lines 44–63; "Audio and
  video" is `audio-video`), built from `SettingsScaffold.tsx` atoms.
- Per-device preferences live in `localStorage`. See `raven.mediaSettings` in
  `useRavenMediaAdapter.ts:67`. Don't add fields to `/v1/preferences`: that is a wire
  contract shared with the Go API.
- `ConfirmDialog` is in `components/ui/dialog.tsx:75`.

## Design

### Arranging the dock buttons

- **What can move.** The four device controls. Each moves as a whole, with its chevron
  menu attached.
  - Nothing can be hidden. A user must always be able to see whether they are audible or
    visible.
  - The presence button, call chip, Leave, network readout and Mixer stay where they are.
- **Default.** The current order, unless you find a strong reason in the skill to change
  it. If so, ask the user.
- **Arrange in place (the main path).**
  - Right-click the device-control group, or use a new "Arrange buttons…" item at the
    bottom of any device chevron menu. Either one enters arrange mode for the group.
  - In arrange mode:
    - The controls are **inert**: clicking must never mute, unmute or start a share. They
      show a grab affordance (cursor and a subtle outline using `border` or `subtle`
      tokens; no `live` colour, no wiggle or looping animation).
    - A small floating bar above the group says "Drag to reorder", with Reset and Done.
    - Drag with the pointer (dnd-kit horizontal sortable).
    - With the keyboard: focus a control, Space or Enter picks it up, Left/Right move it,
      Space or Enter drops it, Escape cancels the pick-up. Screen-reader announcements go
      through dnd-kit's `announcements`.
    - Done or Enter commits. Escape leaves arrange mode and restores the order from
      before you entered it. Clicking outside commits.
  - Arrange mode works in or out of a call. It must not interfere with global hotkeys:
    hotkeys still toggle the mic while arranging.
- **Settings path (discoverable and accessible).**
  - In Settings › Audio and video, add a "Dock" or "Calls" section showing the four
    controls as a preview row in the current order.
  - Make the row sortable the same way, and give each item explicit "Move left/right"
    buttons.
  - Add "Reset to default".
- **Persistence.**
  - Store the order in `localStorage` (for example `raven.dock.order`) through a small
    typed helper in a `.ts` file. Component files export components only.
  - Wrap storage in try/catch.
  - Validate on load: drop unknown ids, append missing ones in default order. A control
    added later then appears without breaking anyone's arrangement.
- **Everywhere the controls appear.** Apply the order wherever the device controls are
  rendered. If there is a fullscreen or compact variant, check it.

### Optional confirmation before leaving

- **Setting.** In the same Settings section: "Ask before leaving a call", off by default.
- **When on.** The dock's Leave button opens a `ConfirmDialog`:
  - Title: "Leave <nest name>?" (noun from `data.labels`).
  - A short body.
  - "Leave" (destructive) and "Stay". Default focus is on Stay, so a stray Enter doesn't
    leave.
  - Wording follows `references/writing.md`.
- **Other paths.** The tray's Leave and the Updates page's "Leave the nest" are
  deliberate, two-step actions. Leave them unconfirmed and say so in your report.
- **The dock button.** Its pending and disabled behaviour (`pendingCallActions`) is
  unchanged. Opening the dialog doesn't count as pending.

## Checking your work

- `bun run build`, `bun test` (tests for the order helper's validation and migration),
  `sweep.ts` should print Clean.
- In the real app, following the skill's dock checklist:
  - out of a call; in a call muted and unmuted; at 980px;
  - enter arrange mode both ways; drag; keyboard-arrange with `--focus` screenshots of
    the ring;
  - confirm clicks are inert while arranging (`cdp.ts state` shows the mic unchanged);
  - Escape restores; Done persists across an app restart;
  - Reset works;
  - the Settings section works;
  - Leave with the setting off (immediate) and on (dialog, Stay keeps you in, Leave
    leaves).
- A call needs only you plus the stack (`stack.ps1 up`). Report what you saw with
  screenshots, and what you couldn't.
