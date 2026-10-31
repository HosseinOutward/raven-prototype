# Message notifications handoff

Implemented Plan 01 from the main checkout's `docs/plans/messages-and-emoji` in the
separate `raven-messages-and-emoji` worktree, on `codex/messages-and-emoji`, based on
local main `c3798b0`. The original checkout's uncommitted work was left untouched.

## What changed

- Migration `2026103101_chat_notify` adds per-person notification modes. Summaries
  expose `notify`; `POST /v1/chat/conversations/:id/notifications` updates the caller
  and publishes `conversation.changed` only to their devices, without allocating seq.
- The prescribed rising-fifth Message cue and Messages sound switch default on.
  The native gate respects volume, deafen in a call and 1500 ms spacing.
- Optional Windows message notifications default off, with message text default on.
  Knocks retain their command and settings. Both use the existing native foreground check.
- A live store subscription deduplicates incoming messages, waits up to five seconds
  for a new conversation summary, and respects kind defaults, mute, DND and the focused
  conversation. Toasts have a 20-second per-conversation cooldown after a successful
  display; in-flight requests cannot produce duplicate toasts.
- The conversation menu exposes mute/unmute only when the server announces support.
  Existing sidebar and conversation-list rows have no Archive menu, so none was added.
  Explicitly muted direct messages and groups show the quiet slashed-bell icon.
- API and chat docs describe the wire contract and behavior.

The subscription decisions live in `lib/chat/messageNotifications.ts` so they can be
tested without mounting React or mocking native modules. `useMessageNotifications`
provides current view, presence and focus through a ref and owns the cooldown map.
The store also retains a bounded set of live message IDs because unloaded conversations
do not retain messages; checking loaded messages alone cannot deduplicate their events.

## Validation

- `bun test`: 490 passed, zero failed.
- `bun run build`: passed; existing large-chunk advisory remains.
- `go test ./...`: passed with the default SQLite backend. PostgreSQL was not run.
- Raven UI sweep: no new findings. Both the worktree and original checkout report the
  same four existing black/white media-overlay findings in `WatcherStack.tsx`.
- `git diff --check`: passed.
- `cargo test --lib cues`: attempted; native dependency compilation exhausted C: disk
  space before tests could run. Removed this worktree's generated target output with
  `cargo clean`, then reran Go successfully. Build settings were not changed. The
  Message notes and existing synthesis-test thresholds are unchanged; Message is in
  the nine-cue test matrix, with an added gate/default-settings test.

The desktop app was not launched, as directed by the plan. Review still needs the
native cue suite, listening to the cue, and live Windows/UI checks (background toast,
focus/DND/mute behavior, first-message delivery and another device's setting sync).
No push, merge, deployment or release was performed.
