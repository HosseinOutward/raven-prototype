# Seen by whom and when

Show who has read the last message, and when, in direct messages, groups and text nests.
Each person chooses where they take part, per kind of conversation.

## Decisions

Soroush's (2026-10-31):
- Read receipts become four switches: **Direct messages, Groups, Private spaces, Public spaces**.
  "Spaces" are trees; a text nest counts as private or public by its tree's `visibility`.
- Each switch is mutual: with it off you are not shown to others there, and you don't see
  others there either.
- Only the **last message** shows who saw it, for now.
- Invisible keeps withholding read status, as it does for direct messages today.

Mine, change them if they're wrong:
- Defaults: Direct messages keeps each person's current setting; Groups on; Private spaces on;
  Public spaces off.
- "Seen" shows only under the last message when **you** sent it, in every kind of conversation.
  The existing read ticks in direct messages stay as they are.
- The time is when the person's read position reached that message. If it was withheld while
  they were Invisible, the time is when it was released.

## Why this is small

Read positions already exist: `chat_members.shared_read_seq` only moves forward, and messages
carry a gapless `seq`. Since only the last message matters, "when" needs one more column, not a
history table. A reader's position can't go past the last message, so the last time it moved
is the time they reached it.

## Design

### Data (one migration; follow `services/api/internal/database/update_migrations.go`)
- `chat_user_settings`: add `read_dm`, `read_group`, `read_private_space`, `read_public_space`
  (BOOLEAN). Copy `share_read_status` into `read_dm`; use the defaults above for the rest. Keep
  `share_read_status` for now, so the migration is additive.
- `chat_members`: add `shared_read_at TEXT NULL`, set whenever `shared_read_seq` moves forward.

### Rules (Go, `services/api/internal/http/chat_conversations.go`, `chat_messages.go`)
- `chatReadCategory(access)` returns `dm`, `group`, `private_space` or `public_space`. For a
  nest, it reads the tree's current visibility.
- **Writing** (`markChatRead`): `shared_read_seq`/`shared_read_at` move forward when the reader's
  own switch for that category is on and they are not Invisible. Drop the check of the other
  person's setting here; it moves to reading. The rule for releasing what was withheld stays the same.
- **Reading**: someone's position is shown to a viewer only if the viewer's switch and that
  person's switch are both on for the category. Left or removed members are never shown, and
  for nests the person must still be a tree member. Make this one helper used by both places
  below, which replaces `chatSharesReadStatus`.
- DM summary (`peer_read_seq` query at the top of `chat_conversations.go`): add `peerReadAt`,
  with the same filtering.
- New `GET /api/chat/conversations/:id/seen` returns
  `{ seq, readers: [{ userId, username, displayName, at }] }` for the conversation's last
  message (`seq` = last seq). It includes only people whose shared position is ≥ `seq`, never
  the caller or the sender, and returns an empty list if the caller's own switch is off.
  Register it next to the other chat routes in `server.go`.
- **Events**: when `shared_read_seq` moves, `conversation.read` (with `readSeq` and a new
  `readAt`) goes to the people who may see it. Today that's the DM peer; for groups and nests
  it's the other members whose switch is on. Reuse the recipient lookup that message sends use.
- **Settings** (`getChatSettings`/`updateChatSettings`): read and write the four switches, and
  keep `shareReadStatus` as an alias for `read_dm` in both directions for older clients.
  Changing a switch publishes a new `conversation.seen` event (no payload) to the members of the
  conversations in that category, so open views fetch `/seen` again. Today's DM re-notify becomes
  this event.

### Desktop (`apps/desktop/src/lib/chat/*`, `components/chat/*`)
- `types.ts`: `peerReadAt` on the summary; `ChatSettings` gets the four switches; the new event.
- `reducer.ts`: per conversation, keep `seen: { seq, readers }`. Fetch it (a new effect) when the
  conversation opens and on `conversation.seen`. On `conversation.read` from someone else with
  `readSeq ≥ seen.seq`, add or update that reader. A new message replaces `seen` with
  `{ seq: newSeq, readers: [] }`. Keep the existing DM `peerReadSeq` path, and add `peerReadAt`.
- `MessageList.tsx` (around the `read`/`sent` status, ~line 260): under your own last message,
  a DM shows "Seen 14:32". A group or nest shows up to 4 small avatars plus "+N"; hovering or
  clicking opens a popover listing names and times. Reuse the existing time formatting and
  avatar component. Follow the `raven-ui` skill for wording, spacing and focus.
- `ChatSettings.tsx`: the single switch becomes four under one heading, with one line saying
  they work both ways.

### Docs
Update `docs/chat.md`: the read-status row (line ~25), the Invisible note (~30), the events
table (`conversation.read`, new `conversation.seen`, ~210) and the coverage table (~264).

## Tests
- Go (next to the existing chat tests):
  - the migration copies `share_read_status`
  - each category is gated by the reader's own switch
  - the mutual filter works both ways
  - Invisible withholds, and releasing records the release time
  - a nest's category follows its tree's visibility, including after the visibility changes
  - left members and ex-tree members are hidden
  - `/seen` excludes the caller, the sender, and positions below the last seq
  - the `shareReadStatus` alias still works
- Vitest (`reducer.test.ts`, `store.test.ts`):
  - a group read adds a reader
  - a new message clears the readers
  - `conversation.seen` triggers a fetch
  - `peerReadAt` is kept up to date
- Live, once at the end: with `chatpeer`/`chatpeer2` (check they still exist), one screenshot
  of a DM showing "Seen" and one of a group popover.

## Execution
1. **Session A (Sonnet, fresh):** the Go part: migration, rules, `/seen`, events, settings, Go
   tests, `docs/chat.md`. Read this plan plus `chat_conversations.go` (lines 20–140 and
   960–1140), `chat_messages.go:185`, `chat_migrations.go`, and the migration pattern file. Run
   `go test ./...` in `services/api`.
2. **Session B (Sonnet, fresh), after A:** the desktop part and Vitest. Read this plan plus the
   files under Desktop, and load the `raven-ui` skill. Run the chat Vitest files, then do the
   single live check.
3. One `/code-review low`, then commit to local `main` via a temporary worktree. Pushing and
   deploying are Soroush's call.

## Risks
- **Fan-out in big public spaces:** each read notifies every opted-in tree member. That's fine
  at alpha scale. If it grows, coalesce reads per conversation on the server before sending.
- **Older clients** never see group or space receipts. That's harmless, since they don't send
  the new switches.
