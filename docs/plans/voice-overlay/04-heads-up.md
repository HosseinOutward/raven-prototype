# Plan 04 — Knocks and messages in the overlay

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`, desktop app in `apps/desktop`). Read
`docs/plans/voice-overlay/README.md` first.

Plans 01–03 must be done; this plan adds two optional heads-up lines to the card from
plan 02 and uses plan 03's action channel. Check before starting; if they're missing,
stop and tell the user.

## Before you start

- Load `raven-ui` (read `references/writing.md`; these lines are words people read
  mid-game). Read `project_raven_alpha_feedback` in memory: knocks are the only thing
  Raven notifies about, which is why they're here and other inbox items aren't.
- Build and app rules as in plan 01. Don't commit unless asked.

## What is true now

Paths are under `apps/desktop`. Line numbers are from 2026-10-26; verify them.

- Knocks reach the client as inbox items: `PendingItem` with `kind: "knock"` in
  `src/shells/ravenv1/state.ts` (~line 88). `data.dismissKnock(knockId)` exists. Find how
  the inbox opens a knock (`Inbox.tsx`) and reuse that for Open.
- Text rooms are separate from voice nests. A tree's text rooms are chat conversations
  with `summary.kind === "nest"` and `summary.treeId` (`src/lib/chat/reducer.ts` ~line
  572). The chat store is created in the shell with `useChat(data)`
  (`src/shells/ravenv1/useChat.ts`); `useTreeChatSummaries`, `useChatSelector` read it.
  Check how unread and muted conversations are worked out there before deciding what
  counts as a new message.
- The overlay snapshot is built in `DeviceDock.tsx`. It has no chat or inbox data.

## Design

Heads-up lines sit inside the card, at the edge away from the screen edge it's anchored
to (the top of a column anchored at the bottom, and so on), above or beside the people,
so the card stays one spot. At most two lines at once; a newer one replaces the oldest.
Each line slides in and out briefly; nothing pulses or repeats. A line wakes a faded card
(plan 02's quiet fade).

### Knocks

Switch `showKnocks` (on).

- "Arash knocked", with their avatar. It stays until it's dismissed in Raven or the knock
  goes away, or for 30 s, whichever is first.
- While interactive: **Open** (shows the Raven window and opens the knock the way the
  inbox does; this takes focus from the game, which is what the user asked for) and
  **Dismiss** (`dismissKnock`). These go through plan 03's action channel as
  `{ kind: "knock", knockId, open: boolean }`.
- No knock lines outside a call? Decide from the code: if the overlay can be shown
  outside a call (hotkey), show knocks there too. They're the one notification Raven
  has.

### Messages from text rooms

Setting `showMessages`: `"off"` (default) | `"tree"` ("From this tree", using
`data.labels` for the noun).

- Only text rooms in the tree of the nest you're calling in. Nothing from direct
  messages or groups, and nothing when the call isn't in a tree.
- Not your own messages; not conversations the user muted, if muting exists; not the
  conversation that is open in a focused Raven window.
- One line: "Mina in design: can someone check the build", one line, cut with "…". Text
  only: attachments read as "sent a file" (check `lib/chat/format.ts` for an existing
  preview helper and use it).
- Shown for 6 s. While interactive, the line stays as long as the pointer is on it. No
  reply from the overlay.

### Snapshot changes

Add `headsUp: Array<{ id, kind: "knock" | "message", actorName, avatarUrl, text, at }>`
to `VoiceOverlaySnapshot` (Rust and TypeScript, `#[serde(default)]`), built in the main
window. The overlay owns the timing (how long a line shows). Keep the list short: only
what the overlay could still show.

### Settings rows

Heads-up group: "Show knocks" (switch) and "Show messages" (Off / From this tree, hint:
"From text rooms in the tree you're calling in.").

## Checking your work

1. `bun run build`, `bun test` (put the selection logic in a `.ts` file with tests), the
   `raven-ui` sweep, `cargo test`.
2. In the real app with a second account: a knock shows, Open and Dismiss work from the
   overlay, and the inbox agrees; messages in a text room of the same tree show with
   "From this tree", don't with Off, don't from another tree or a DM, and your own don't.
3. Report what you saw and what you couldn't check.

## As built (2026-10-29)

Built on branch `claude/overlay-heads-up-0f9729` (commit `eccafca`, not pushed). Where the build
differs from the text above, this wins:

- **Logic lives in `src/lib/voiceOverlayHeadsUp.ts`** (tests in `voiceOverlayHeadsUp.test.ts`).
  Main-window half: `knockCandidates`, `messageCandidates`, `trackHeadsUp`. Overlay half:
  `advanceHeadsUp`, `closeHeadsUp`, `headsUpFirst`, `cutText`. The hook is
  `shells/ravenv1/useVoiceOverlayHeadsUp.ts`; `DeviceDock` takes a new `chat` prop.
- **What counts as new** is decided in the main window by local time and first sight, not by the
  server's `createdAt`. What exists on the first look (knocks once the home data has loaded,
  messages once the chat list has loaded) is old news. A message that arrives while Show messages is
  Off, or in a room you are reading, is used up and does not appear if you switch it on later.
  The snapshot lists a knock for 60 s and a message for 20 s; the overlay shows them 30 s and 6 s
  from when it first sees them, and does not replay a finished line while it is still listed.
- **Knocks work with or without a call**: with no call the snapshot is the empty one plus `headsUp`.
  Open runs the inbox's own target (`pendingTarget`, now exported from `Inbox.tsx`: the person's
  view), then un-minimizes, shows and focuses Raven. Dismiss calls `dismissKnock`. Both close the
  line at once. Open does not dismiss the knock.
- **Placement**: the layout event now carries `anchorCorner` (the card did not know its anchor
  before). Column: lines at the top when anchored at the bottom, at the bottom when anchored at
  the top. Row: at the left end when anchored at the right, at the right end when anchored at the
  left. A hairline separates them from the people; with no people they sit above "Not in a call".
- **Holding**: while interactive, a line the pointer is on stays; 1.5 s after it leaves, it goes.
  Knocks are held the same way.
- **Settings** (`showKnocks` on, `showMessages` off | tree) in Heads-up; the noun comes from
  `data.labels.treeSingular`, passed to the panel as `treeLabel`.
- **Not in the app, so not done**: muting (there is no way to mute a text room in the client, so
  nothing to honour), attachments (messages are text only; `lib/chat/format.ts` does not exist and
  chat has no file messages, so there is no "sent a file" case), a reply from the overlay.
- The `at` field is when Raven first saw the line, not when the server created it.

Seen in the dev app (signed out, so snapshots injected with `overlay_update_snapshot`): a knock and a
message in a Column anchored top-left and (by emitting a layout event) bottom-left, and in a Row; the
interactive card with Open and Dismiss; Open and Dismiss each sent `{kind:"knock", knockId, open}`
to the main window and closed the line; a message that had run its 6 s did not replay on the next
snapshot; a message with the pointer on it was still there after 8 s and left about 2 s after the
pointer did; `overlay_get_layout` returns `anchorCorner`.

Not checked: a real knock or message from a second account (the dev app opened signed out, on
server 192.168.28.172:6711, and no second account's password is in the repo), so the main window's
side was only unit tested: `data.pending` and the chat store feeding the snapshot, Open bringing the
Raven window forward and opening the person, Dismiss reaching the inbox, "From this tree" against a
real tree and DM; the Settings rows on screen; a message arriving while the Raven window is focused
on that room; the quiet fade waking for a line; a second monitor or a scale other than 100 %.
