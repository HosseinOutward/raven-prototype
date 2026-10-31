# Plan 03 — Five small UI fixes: stream info, a stray tooltip, hotkey saving, dock order, custom quality

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`, desktop app in `apps/desktop`, React in `src`). These
five reports come from the v0.1.4 closed alpha. All of them are TypeScript only.

| # | Report | Priority |
|---|---|---|
| A | "Stream info" in a tile's menu does nothing | P1 |
| B | Clicking Network activity shows the little info tooltip | P3 |
| C | No success shown after saving hotkeys | P2 |
| D | Device buttons order belongs in Appearance | P3 |
| E | Custom screen-share quality should start from the last preset and keep the source's shape | P2 |

A and B share a cause: focus moving when a floating layer opens or closes. Fix them with
one shared approach, not two hacks.

## Before you start

- Load `raven-ui` and read `references/design-system.md`, `references/writing.md` and
  `references/verifying.md`. Note the traps on Radix floating layers and on dialogs that
  are opened from menus.
- Load `raven-media-engine` only to read how a custom profile is used
  (`references/video-engine.md`). Nothing here changes the engine or a wire contract.
- If you are in a git worktree, `.claude/skills` and `.env` are gitignored, so they are
  missing there. Copy both from `C:\Users\Soroush Taheri\code\raven`, run `bun install` in
  `apps/desktop`, and set `RAVEN_REPO` to your worktree for the skill's scripts.
- Plan 01 also edits `MediaTile.tsx`, `DeviceDock.tsx` and `VideoPickers.tsx`. Don't run
  the two at the same time in the same checkout.
- Only one Raven dev app can run at a time. Check before starting it, and if one is
  running, ask the user rather than stopping it.
- Don't commit, push or release unless the user asks.

Paths below are under `apps/desktop/src`. Line numbers are from 2026-10-17; verify them.

## A — "Stream info" does nothing

**Now.** `components/media/MediaTile.tsx:184–248`:

- The tile's action cluster is a `PopoverAnchor`. A controlled `Popover`
  (`infoOpen`) holds `StreamInfo`.
- The "…" `DropdownMenu` has a "Stream info" item, with
  `onSelect={() => window.setTimeout(() => setInfoOpen(true), 0)}` (line 220). It only
  appears for remote streams being received (`canShowInfo`, line 109).

**Likely cause** (reproduce first):

1. The menu closes and the timeout opens the popover.
2. The menu's focus scope then hands focus back to the "…" trigger. Radix does that on
   unmount, after its exit animation.
3. That focus lands outside the popover's content, so the popover's dismissable layer
   closes it at once.

Confirm it: log `onOpenChange` and the `onFocusOutside` / `onInteractOutside` events of
the popover's `PopoverContent`.

**Fix.**

- Open the popover from the menu's `onCloseAutoFocus` instead of a timer.
  `preventDefault()` there so focus is not sent back to the trigger, then open, and the
  popover moves focus into itself.
- Or, if that proves fragile, ignore a focus-outside event whose target is inside the
  anchor while the popover is opening.
- Whichever you choose, keep it local to `MediaTile` unless the same pattern exists
  elsewhere. Search for other menus that open a popover or dialog. If one exists, make a
  small shared helper.
- Escape and clicking outside must still close the popover. When it closes, focus goes
  back to the "…" button.

## B — The info tooltip appears when Network activity is clicked

**Now.** `shells/ravenv1/DeviceDock.tsx:1270–1305`. Clicking the dock's network readout
opens a `Popover`.

- Radix moves focus to the first focusable element in the content. Here that is the
  ⓘ `InfoTooltip` button (`shells/ravenv1/atoms.tsx:138`).
- A Radix tooltip opens on focus, so the tooltip shows without being hovered.
- The same can happen on close: focus returns to the trigger, whose own "Network
  activity" tooltip may then show. Check it.

**Fix.**

- On this `PopoverContent`, take `onOpenAutoFocus`, prevent the default, and focus the
  content container itself (give it `tabIndex={-1}`). Keyboard users can then Tab to the
  ⓘ button, and the tooltip shows only when someone actually moves to it.
- Check whether the trigger's tooltip reappears on close. If it does, prevent that the
  same way the dock does at `DeviceDock.tsx:948`.
- Check the other popovers that contain an `InfoTooltip`, or a tooltip on their first
  control (`grep -rn "InfoTooltip\|<Tooltip" src`), and apply the same fix where it
  happens. Don't change the `Tooltip` primitive's focus behaviour: keyboard users need
  focus tooltips everywhere else.

## C — Saving hotkeys shows no success

**Now.** In `components/MediaHotkeySettings.tsx:72–127`:

- `save()` sets `saving` and `error`, and nothing else.
- "Save shortcuts" is enabled even when nothing changed.
- "Restore defaults" only changes the draft. It isn't clear that it still needs saving.
- A save can resolve with a `registrationError` (one key refused by the OS) and is then
  only half successful.

**Fix.**

- Track the last saved bindings and derive `dirty` from the draft.
- Disable Save when nothing has changed.
- After a save with no `registrationError`, show "Saved." beside the button, in the
  pattern of `shells/ravenv1/views/TreeSettingsView.tsx:156`. Clear it on the next edit.
- When some keys registered and one didn't, show the error (it already does) and no
  "Saved.". Say which shortcut failed, if the error lets you.
- After Restore defaults, the form is dirty, so Save is enabled. The wording can stay as
  it is.
- No toast for success. A toast is for failures from shell-data actions, and this one is
  inline.

## D — Move device button order to Appearance

Soroush decided: **only the device-button order moves.** "Ask before leaving a call"
stays where it is.

**Now.** `shells/ravenv1/DockSettings.tsx:36` `DockSettingsSection` is a "Calls" section
holding both the sortable device buttons and the "Ask before leaving a call" toggle. It
is rendered under Audio and video (`shells/ravenv1/UserSettings.tsx`, `<DockSettingsSection />`
in `AudioVideoSettings`).

**Fix.**

- Split it into two components in `DockSettings.tsx`:
  - a "Bottom bar" section (or similar, per `references/writing.md`) with the device
    buttons and Reset, rendered in `AppearanceSettings` between "Words" and "Theme";
  - the leave toggle, which stays in Audio and video as a small "Calls" section.
- Keep the copy pointing at right-click in the bar.
- The arrange-in-place flow in the dock is unchanged.
- Check that the "Settings" link or hint that the dock's arrange mode might show (search
  for `audio-video` near `DOCK_ARRANGE` or "Arrange") now points to Appearance.

## E — Custom quality starts from the last preset and keeps the shape

Soroush decided: **yes for screen shares, and yes for the camera.**

**Now.** In `components/nest/VideoPickers.tsx`:

- Both pickers keep `customDraft` initialised from `DEFAULT_VIDEO_PROFILE` (lines 64 and
  172), whatever preset was chosen before.
- `VideoProfileFields` (line 357) shows free Width, Height and FPS fields.
- For screen and window shares, the engine treats custom width × height only as a pixel
  budget and keeps the source's aspect ratio
  (`src-tauri/src/video/domain.rs:236` `resolved_for_source`). The fields can claim a
  shape that is never sent.
- For the camera, the engine requests the width and height as typed
  (`capture.rs`, `CameraFormat::new_from`).

**Fix.**

- **Inherit.** When the user switches to Custom, fill the fields from what the previous
  selection would send:
  - For a share with a source selected, that is `outputForBudget(source.width,
    source.height, preset.maxPixels)` and the preset's fps. That's the same number the
    summary already shows ("Sent at W×H").
  - With no source selected, use the preset's width, height and fps.
  - For the camera, use the preset's width, height and fps.
- **Re-seed.** If the selected source changes while Custom is on, re-seed the fields from
  the new source's shape, keeping the current pixel count as closely as even numbers
  allow.
- **Keep the shape.** Editing Width recomputes Height from the aspect ratio, and the
  other way round. Round to even numbers and clamp to the existing limits. FPS is
  independent.
  - Aspect comes from the selected screen or app.
  - For the camera, it comes from the preset Custom was entered from (the camera list
    has no native formats, `lib/video.ts:142` `CameraDevice`).
  - Do not add a lock toggle. Soroush asked for the shape to be kept.
- **Commit cleanly.** Recompute on blur or commit as well as on change, so a
  half-typed number doesn't fight the user. Typing "1" on the way to "1280" must not
  set Height to 2.
- **Test the helpers.** Put the inherit, aspect and rounding logic in a `.ts` helper with
  unit tests. Component files export components only.

## Checking your work

- `bun run build`, `bun test` (new tests for E's helper, and for C's `dirty` logic if it
  is extracted), and `bun .claude/skills/raven-ui/scripts/sweep.ts` should print Clean.
- In the real app (`references/verifying.md`):
  - **A.** In a call with a remote screen share being watched, "…" → Stream info opens
    the popover and it stays open with live numbers. Escape closes it, and focus returns
    to "…". You need a second participant, so use the media engine's test rig. If you
    can't get a remote stream, say so.
  - **B.** Click the network readout: no tooltip. Tab once: the ⓘ tooltip shows. Close
    the popover: no stray tooltip on the readout. Take `--focus` screenshots.
  - **C.** Change a shortcut and save: "Saved." shows. Edit again: it clears. Save is
    disabled with no changes. Also take a refused-key case if you can produce one (a
    combination another app holds).
  - **D.** Appearance shows the device buttons with Reset. Audio and video shows only the
    leave toggle. Both work. Check at 980px wide.
  - **E.** Pick a 1920×1080 screen, choose High quality, then switch to Custom: the
    fields show what High would send. Edit Width: Height follows at 16:9. Pick an app
    window of a different shape: the fields re-seed. Do the same in the camera picker.
- Report what you saw and, separately, what you could not see.
