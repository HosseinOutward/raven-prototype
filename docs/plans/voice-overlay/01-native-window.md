# Plan 01 — The overlay window: size, anchor, click-through, interaction

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`, desktop app in `apps/desktop`). Read
`docs/plans/voice-overlay/README.md` first: it has the design Soroush chose on 2026-10-26,
his decisions, the final settings layout and the rules for all five plans.

This plan changes the overlay **window**, not the card's design (that is plan 02). When
you're done the overlay looks roughly as it does today, but:

- the window is exactly as big as what it shows, and grows away from the screen edge it
  is anchored to;
- clicks go through it to the game unless the user is interacting with it;
- it never takes keyboard or mouse focus from the game;
- the user can interact by pointing at it (after a short rest), by holding the overlay
  key, or not at all, per a new setting;
- it snaps to screen edges, and its shape (row or column) can follow the edge;
- it has a Size setting.

## Before you start

- Load `raven-ui` and read its `references/design-system.md` and `references/writing.md`.
- Rust builds go through `.claude/skills/raven-media-engine/scripts/cargo.ps1` or
  `tauri.ps1`. `CARGO_TARGET_DIR` is `%USERPROFILE%\rv`, shared by every checkout, so expect
  waits if another session is building. Only one Raven dev app can run at a time: check
  first, and if one is running, ask the user rather than stopping it.
- In a git worktree, copy `.claude/skills` and `.env` from the main checkout and run
  `bun install` in `apps/desktop`.
- Don't commit, push or release unless asked.

## What is true now

Paths are under `apps/desktop`. Line numbers are from 2026-10-26; verify them.

- `src-tauri/src/overlay.rs` owns the window. `ensure_overlay_window` (~line 413) builds
  it: transparent, undecorated, always on top, `skip_taskbar`, not resizable, a fixed size
  from `overlay_dimensions(layout)` (280×360 vertical, 320×112 horizontal, lines 20–23).
  It is created hidden and shown only by the hotkey (`toggle_overlay_window`). Nothing in
  the main window calls `overlay_show`.
- The window takes clicks over its whole rectangle, transparent parts included, and
  activates (takes focus) when clicked.
- Position: the overlay window listens to `onMoved` and calls `overlay_save_position`
  with the top-left `{x, y}` after 180 ms (`VoiceOverlayWindow.tsx` ~line 95).
  `restore_overlay_position` / `clamp_overlay_position` keep it on a monitor. Dragging is
  `startDragging()` from a header that appears on hover.
- The hotkey is registered in `register_hotkey` (~line 607) with
  `tauri_plugin_global_shortcut`. The handler only reacts to `ShortcutState::Pressed` and
  toggles visibility.
- Settings: `VoiceOverlaySettings` (enabled, hotkey, layout, show_names,
  name_background, position), saved to `voice-overlay-settings.json` with
  `#[serde(default)]`. The TypeScript mirror is in `src/lib/voiceOverlay.ts`; the panel
  is `src/components/VoiceOverlaySettings.tsx` (it saves with a button).
- Tauri is 2.5 (`src-tauri/Cargo.toml`).

## Design

### 1. Size to content, anchored

The window's size comes from the card, not from a constant.

- In the overlay window, observe the card's element (`ResizeObserver`) and send its size
  in CSS pixels to a new command, `overlay_set_content_size({ width, height })`. Debounce
  lightly (one frame); skip identical sizes. Add a little margin for the speaking ring and
  shadow, and keep that margin click-through (see 3).
- Rust converts to physical pixels with the window's scale factor and resizes the window
  so that the **anchor corner stays put**. The anchor is the corner of the window nearest
  the monitor edge it is snapped to (top-left by default). Growing a card anchored
  bottom-right moves its top-left up and left; it never walks off the screen.
- Replace the stored `position: {x, y}` with an anchored position:
  `{ monitor: name or index, corner: "topLeft" | "topRight" | "bottomLeft" | "bottomRight", dx, dy }`,
  the distance from that corner of the monitor's work area to the same corner of the
  window. An old `{x, y}` loads as `topLeft` with offsets computed against the monitor
  that contains it. Keep the clamping so a removed monitor or a changed resolution still
  brings the overlay back on screen.
- Cap the window at a maximum per Size (below) so a 20-person call scrolls inside the
  card instead of covering the screen. The overlay window's root must stay
  `overflow: hidden`.
- Remove the fixed `overlay_dimensions` / `apply_overlay_dimensions` path and the min/max
  size pinning. Keep `resizable(false)`.

### 2. Snapping and shape

- When a drag ends, if an edge of the window is within 24 physical px of an edge of the
  monitor's work area, snap to it (a small margin of 12 px stays, so the card doesn't touch
  the bezel). Pick the anchor corner from the nearest edges.
- **Shape** replaces **Layout**: `followEdge` (default for new installs) | `column` |
  `row`. Saved `vertical` loads as `column`, `horizontal` as `row`, so nobody's overlay
  changes shape on update.
- With `followEdge`, the shape is **row** when the window is snapped to the top or bottom
  edge and not to a side edge, and **column** otherwise (sides, corners, floating). Rust
  works out the effective shape and sends it with the settings (`effectiveShape`) so the
  card doesn't have to know about monitors.
- The effective shape changes only when a drag ends, never mid-drag.

### 3. Click-through and never taking focus

- Build the window so it can't be activated: try `WebviewWindowBuilder::focusable(false)`
  first (check it exists in our Tauri version and that WebView2 still gets clicks). If it
  doesn't work, set `WS_EX_NOACTIVATE` on the HWND (`window.hwnd()`, then
  `GetWindowLongPtrW`/`SetWindowLongPtrW` from the `windows` crate already in the tree).
  Show it with `show()` but never `set_focus()`. Check by holding a key in another app
  (Notepad, or a game) while you click the overlay's buttons: typing must keep going to
  that app.
- By default the whole window ignores the cursor:
  `window.set_ignore_cursor_events(true)`. It stops ignoring it only while the user is
  interacting (4). Everything is click-through again as soon as interaction ends.
- Tell the overlay window when interaction starts and ends with a new event,
  `voice-overlay-interaction-changed` (`{ interactive: boolean }`). Plan 02 and 03 use it
  to show controls; for now use it to show the drag affordance.

### 4. Interaction modes

New setting `interact`: `"hover"` (default) | `"hold"` | `"never"`.

- **`hover` — "When I point at it".** A click-through window gets no mouse events, so the
  webview can't detect hover. Instead, while the overlay is visible and the mode is
  `hover`, poll the cursor from Rust (`GetCursorPos`, about 30 times a second, on its own
  thread or a Tokio interval; stop polling when hidden). The overlay window reports the
  card's rectangle with its content size (1), so the window's outer margin doesn't count.
  - Cursor inside the card rectangle for **300 ms** → interactive.
  - Cursor outside for **400 ms** → back to click-through. The grace covers moving between
    the card and its controls.
  - Make both numbers constants with a comment saying why (Soroush's decision 1 in the
    README).
- **`hold` — "While I hold the key".** Use the existing overlay hotkey. The shortcut
  handler must react to both `Pressed` and `Released`.
  - Released within **250 ms** of Pressed: a tap, which toggles visibility as today.
  - Still held after 250 ms: interactive (and shown, if it was hidden) until Released;
    then back to click-through, and hidden again if it was hidden before.
  - First check that `tauri_plugin_global_shortcut` delivers `Released` on Windows for
    our version (the underlying `global-hotkey` crate does on recent versions). If it
    doesn't, stop and tell the user: say what you found and offer polling the key state
    with `GetAsyncKeyState` while it's held as the fallback.
- **`never`.** Always click-through. The hotkey only toggles visibility. Dragging is
  impossible in this mode, so say so in the setting's hint and offer a "Reset position"
  button in Settings (it moves the overlay back to the default corner).
- In every mode, the tap behaviour of the hotkey is unchanged.

### 5. Dragging

- Dragging works only while interactive: press on the card's background (not on a button
  or a person's row once plan 03 adds controls) and call `startDragging()`.
- Remove the header bar. While interactive, the card shows its interactive look (plan 02
  designs it; for now, a slightly stronger background and a hairline outline). The
  cursor over the card's background is `move`.
- After the drag (the last `onMoved` plus the debounce), call a new command,
  `overlay_finish_move`, which snaps (2), works out the anchor and the effective shape,
  saves, and emits the new settings. Keep `overlay_save_position` working for one release
  as a thin wrapper, or remove it if nothing else calls it.

### 6. Size

New setting `size`: `"medium"` (default) | `"small"` | `"large"`. Rust only uses it for
the maximum window size; the card uses it for its type and avatar sizes. Suggested
scale (plan 02 owns the final numbers):

| Size | Text | Avatar | Max column height |
|---|---|---|---|
| Small | 12 px (`text-caption`; never below, rule 3) | 20 px | 40% of the work area |
| Medium | 13 px | 24 px | 50% |
| Large | 15 px | 30 px | 60% |

### 7. Settings

Extend `VoiceOverlaySettings`, `VoiceOverlaySettingsView`, `VoiceOverlaySettingsPatch`
(Rust) and their mirrors in `lib/voiceOverlay.ts` with `shape`, `effectiveShape` (view
only), `size`, `interact`, and the anchored `position`. Keep `layout` readable from old
files (a `#[serde(alias)]` or a migration in `load_settings_from_path`) but stop writing it.
Extend the legacy-settings test (`legacy_settings_receive_overlay_display_defaults`) with
a file that has `layout: "horizontal"` and a plain `{x, y}` position.

In `VoiceOverlaySettings.tsx`, add the rows this plan owns (README table): **Shape**,
**Size** (Look group) and **Interact** (Using the overlay group), plus Reset position.
Arrange the panel into the README's groups now, even if some groups only hold today's
rows, so plans 02–04 only add rows. Apply each change as soon as it's made, except the
hotkey (it keeps its capture flow). If the panel keeps a Save button for the hotkey, show
that it saved. Interact's hint: "Otherwise clicks go straight through to your game."

## Checking your work

1. `cargo test` for `overlay.rs` (`scripts/cargo.ps1`), `bun run build` and `bun test` in
   `apps/desktop`, and the `raven-ui` sweep.
2. In the real app (`raven-ui` › `references/verifying.md`), show the overlay over another
   window (Notepad is enough, a borderless game is better):
   - with two people in a call (use the tone bot from `reference_raven_live_call_testing`
     in memory, or a second account), the window is the card's size; adding a person
     grows it away from the anchored edge;
   - clicking where the overlay is (card and margin) reaches the app underneath when not
     interactive;
   - typing in Notepad continues while you click the overlay in each mode;
   - hover: passing quickly over the card does nothing; resting 300 ms makes it
     clickable; leaving returns to click-through;
   - hold: tap toggles; hold makes it clickable and shows it if hidden; release restores;
   - snapping to each edge and corner, the shape with Follow edge, and that the position
     survives a restart and a resolution change;
   - each Size.
3. Report what you saw, and separately what you couldn't check (a real game, a second
   monitor, a cursor-locking game).

## As built (2026-10-27)

Done and checked in the real app. Where the build differs from the text above, this wins:

- **Window commands are async.** `overlay_show`, `overlay_toggle`, `overlay_hide`,
  `overlay_update_settings`, `overlay_set_content_size`, `overlay_drag` and
  `overlay_reset_position` are `async`: a synchronous command runs on the main thread, and
  building the overlay window there deadlocked on Windows. Keep any new command that
  creates, shows or moves the window async.
- **Show, hide, click-through, topmost and size go through `overlay.rs`'s `native`
  module** (Win32 `ShowWindow(SW_SHOWNOACTIVATE)`, `SetWindowPos(SWP_NOACTIVATE)`, the
  `WS_EX_TRANSPARENT | WS_EX_LAYERED` ex-style). Don't call Tauri's `show`, `hide`,
  `set_always_on_top` or `set_ignore_cursor_events` on the overlay: tao re-shows the window
  with `SW_SHOW` whenever one of its flags changes, which can activate it, and its flag
  bookkeeping would no longer match the window.
- **Dragging is `overlay_drag`, not `startDragging()` + `overlay_finish_move`.** The
  system move loop activated the overlay and took focus from the app underneath, and a
  pause mid-drag looked like the end of it. The overlay calls `overlay_drag` on a primary
  press on the card's background while interactive; Rust moves the window with the
  cursor until the button is released, then snaps, anchors and emits settings and layout.
- **Layout reaches the overlay as `voice-overlay-layout-changed`** (`overlay_get_layout`):
  effective shape, size, interact mode, `interactive`, and the max card size in CSS px.
  Interaction changes also arrive as `voice-overlay-interaction-changed`.
- The hover watcher also refuses to open while a mouse button is down, so a drag that
  started in the game (a selection box, a camera pan) ends in the game.
- Settings › Voice overlay is grouped (Showing the overlay, Who it shows, Look, Using the
  overlay) and applies each change at once; there is no Save button any more.

Checked in the app (single 1920×1080 monitor, scale 1, Notepad as the app underneath):
size to content, anchored growth, legacy position and layout carried over, click-through
(hit test reaches the window below), focus kept through hover, click, hold and drag,
hover opens after ~350 ms and a quick sweep doesn't open it, hold and tap, Never, snap to
top, bottom and left with Follow edge, Reset position, Small and Large, position kept
across a restart. Not checked: a real game, a second monitor or a scale other than 100%,
the Settings panel on screen (the dev app was signed out), the Linux build of the
non-Windows stubs.
