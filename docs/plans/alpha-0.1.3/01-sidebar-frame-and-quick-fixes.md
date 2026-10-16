# Plan 01 — Resizable sidebar and three quick UI fixes

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`, desktop app in `apps/desktop`). Soroush (the owner)
ran a closed alpha of v0.1.3 with friends: about 8 hours of calls. This plan covers four
of the items they reported. All four are UI only; no Rust and no API changes.

| # | Item | Size |
|---|---|---|
| 1 | The voice overlay shows a broken image for people with no profile picture | XS |
| 2 | In the Mixer's "Add a source" dialog, the second dropdown shows icons above the text | XS |
| 3 | The sidebar's collapse button is at the top, but expand is at the bottom of the rail | XS |
| 4 | Let users resize the sidebar | S |

## Before you start

- Load the `raven-ui` skill and read `references/design-system.md` and
  `references/verifying.md` before writing markup. Follow its rules; they override your
  defaults.
- If you are in a git worktree, `.claude/skills` and `.env` are gitignored, so they are
  missing there. Copy both from `C:\Users\Soroush Taheri\code\raven`, run `bun install` in
  `apps/desktop`, and set `RAVEN_REPO` to your worktree path when you run the skill's
  scripts.
- Other sessions may be working on other plans in this batch at the same time. Only one
  Raven dev app can run on this machine. Before you start it, check whether one is already
  running. If it is, ask the user rather than stopping it.
- Don't commit, push or release unless the user asks. Never stash or reset over
  uncommitted work.

## 1. Overlay avatar

`apps/desktop/src/components/VoiceOverlayWindow.tsx:269` (`ParticipantAvatar`) renders a
raw `<img>` whenever `participant.avatarUrl` is set. `lib/voiceOverlay.ts:200` always sets
it to `api.userAvatarUrl(userId)`. That URL returns 404 for people without a picture, and
nothing handles the error.

Fix: render `<Avatar name={participant.displayName} src={participant.avatarUrl ?? undefined} className="h-8 w-8 text-[10px]" />`.
`components/ui/avatar.tsx` already falls back to initials when the image fails to load.

- Keep the wrapper and its speaking glow exactly as they are.
- The overlay window's size is set natively, so don't change any dimensions.
- Check: the overlay (`drive.ts --window overlay`) with yourself and, if you can, someone
  without a picture.

## 2. Add-a-source dropdown layout

Root cause: in `apps/desktop/src/components/ui/select.tsx:141`, `SelectItem` wraps its
children in `<span className="min-w-0 flex-1 truncate">`. That span is not a flex row,
and Tailwind's preflight makes `img` and `svg` `display: block`. So when an option has an
icon (the Application and Output device dropdowns in `AddSourceForm`,
`components/AudioMixerPanel.tsx:733`), the icon sits on its own line above the text.

Fix it in the primitive so every select benefits:

- Make the wrapper a row: `flex min-w-0 flex-1 items-center gap-2`.
- Make sure plain text children still truncate with an ellipsis. Text directly inside a
  flex container can't take `text-overflow`, so wrap string children in a truncating span,
  or otherwise ensure truncation still works.
- Then check every `SelectItem` usage (`grep -rn "SelectItem" apps/desktop/src`) for a
  regression. Pay particular attention to items whose children are several elements or
  two-line blocks, for example in `components/nest/VideoPickers.tsx` and the Settings
  pages.
- `AudioMixerPanel.tsx` is a boundary file: change classes only, never its callbacks or
  command order.

## 3. Collapse and expand in the same place

- The expanded sidebar has Collapse in its header row (`shells/ravenv1/Sidebar.tsx:198`).
- The collapsed rail has Expand at the very bottom (`Sidebar.tsx:175`).

Move Expand to the top of the rail, so the toggle stays in the same corner whichever state
the sidebar is in. The Home button follows it. Keep the tooltips and `aria-label`s.

## 4. Resizable sidebar

Today the width is fixed: `grid-cols-[256px_minmax(0,1fr)]` at
`shells/RavenShellV1.tsx:274`, which becomes `60px` when collapsed. The Settings layout
uses its own `256px` column at `RavenShellV1.tsx:357`. The collapsed state is stored in
`localStorage` under `raven.sidebarCollapsed`.

Build:

- **A drag handle on the sidebar's right edge.** Make it a thin hit area, about 6–8 px,
  over the gap between the sidebar and the raised main panel.
  - `cursor: col-resize`.
  - On hover or drag, show a hairline in `border` or `subtle`, never the `live` colour.
- **Persistence and limits.**
  - Store the width in `localStorage` as `raven.sidebarWidth`. Wrap reads and writes in
    try/catch and fall back to 256.
  - Clamp it to about 220–400 px.
  - Also keep the main panel usable at the 980×700 minimum window: cap the sidebar so the
    main panel never drops below roughly 600 px. Re-clamp when the window is resized.
- **Snap to the rail.** Dragging below about 160 px collapses to the rail when released.
  Dragging the rail outward expands it again. A double-click on the handle resets to 256.
- **Keyboard.** The handle is a focusable `role="separator"` with
  `aria-orientation="vertical"`, `aria-valuenow`/`min`/`max` and an `aria-label` such as
  "Resize sidebar".
  - Left/Right move it by 16 px; Home/End go to the minimum/maximum.
  - It shows the global focus ring; don't add `outline-none`.
- **Settings.** Use the same width for the Settings category column (the skill's rule 10:
  Settings categories take the sidebar's place). The two should not jump between widths.
- **Smooth dragging.** Don't re-render the whole shell on every pointer move. Update a CSS
  variable or the grid template on the element directly (or use rAF), and commit to state
  and storage on pointer-up.
- **Wide widths.** Check how the sidebar content looks wide: the status captions use
  `max-w-[45%]`, and trees and nest rows truncate.

Out of scope: changing what the sidebar lists. Plan 06 rewrites its contents, and
`Sidebar.tsx` is that plan's main file. Keep your edits to `Sidebar.tsx` limited to the
rail's toggle button.

## Checking your work

1. In `apps/desktop`: `bun run build`, `bun test`. Then
   `bun .claude/skills/raven-ui/scripts/sweep.ts` should print "Clean".
2. In the real app (`references/verifying.md`):
   - At 980×700, 1280×820 and 1920×1080: drag to the minimum and maximum, snap to the
     rail, expand again, double-click to reset, resize by keyboard (`--focus` shows the
     ring), then restart the app and confirm the width is kept.
   - Settings at a non-default width.
   - The collapsed rail, with the toggle at the top.
   - The Add a source dialog with each source type and its dropdown open.
   - The voice overlay.
3. Report what you saw, with screenshots, and separately what you could not see.
