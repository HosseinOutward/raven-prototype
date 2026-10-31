# Plan 03: Reactions in the Go API

Read `C:\Users\Soroush Taheri\code\raven\docs\plans\messages-and-emoji\README.md` first.
Work in the worktree plan 01 made. Go only (`services/api`), plus docs.

When you're done, a person can add or remove an emoji reaction on a message. Everyone
who can see the message gets the change live, in order, through the existing sync, with no
new event type.

## How reactions fit the sync model

Read `docs/chat.md` "Ordering, idempotency and sync" first. A reaction is **a change to a
message**, exactly like an edit:

- It takes the conversation's next sequence number with
  `chatNextSeq(tx, conversationID, false, now)` as its first statement (the `false` means
  it is not a new message, so the conversation's activity time, its place in the list
  and unread counts don't move: check that in `chatNextSeq` and say so if not).
- It sets the message's `changed_seq` to that number.
- It publishes `message.updated` with the whole message, through `chatAudience` and
  `publishChatMessage`, like `editChatMessage` does. Clients already replace a message
  when its `changedSeq` is not older, and already fill gaps through `/changes`, so
  reactions sync with no client protocol change.
- A request that changes nothing (adding a reaction you already have, removing one you
  don't have) rolls back and returns the message, so the counter never moves without an
  event (rule 2).

`editChatMessage` in `internal/http/chat_messages.go` is the template: lock, begin,
next seq, `chatAccessFor`, checks, write, audience, commit, load, publish. Follow it
line for line.

## 1. Data

Migration `2026103102_chat_reactions` (register it after `2026103101_chat_notify` in
`internal/database/update_migrations.go`; statements next to the other chat ones; SQLite
and PostgreSQL):

```sql
CREATE TABLE IF NOT EXISTS chat_reactions (
  message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_chat_reactions_conversation ON chat_reactions(conversation_id);
```

No foreign keys, like `chat_message_hides`. Everywhere `chat_message_hides` rows are
deleted when a conversation, group or tree goes (`chat_conversations.go`, around the
`DELETE FROM chat_message_hides` lines), delete `chat_reactions` the same way. Clearing a
conversation for yourself and hiding a message for yourself leave reactions alone.

## 2. Wire shape

```go
// ChatReaction is one emoji on a message and who put it there, in the order they did.
type ChatReaction struct {
	Emoji   string   `json:"emoji"`
	Count   int      `json:"count"`
	UserIDs []string `json:"userIds"`
}
```

`ChatMessage` gets `Reactions []ChatReaction \`json:"reactions,omitempty"\``. Reactions
are ordered by the time their emoji was first added on that message; `UserIDs` by when
each person added it. Every person's id is sent (conversations are small: groups are
capped at 50, and text nests belong to small trees); the client works out "mine" itself.
This is why the field is the same for every viewer and one event serves the whole
audience.

Load them like attachments: a `withChatReactions(q, messages)` next to
`withChatAttachments` in `chat_attachments.go`'s style (one query for the whole page,
`WHERE message_id IN (...)`), called right after `withChatAttachments` in
`queryChatMessages` (`chat_messages.go`), so history, changes, send and edit responses
and events all carry them. Deleted messages have none. Previews and reply quotes don't
carry reactions.

## 3. The route

`POST /v1/chat/conversations/:id/messages/:messageId/reactions`, body
`{"emoji": "👍", "add": true}`, response `{"message": ChatMessage}`. Register it in
`registerChatRoutes` (`chat.go`) with `s.chatLimiter("react", 60, time.Minute)` and
`s.chatRoute("react", ...)`. Handler `reactToChatMessage` in a new
`internal/http/chat_reactions.go`.

Rules, inside the transaction:

1. Access: `chatAccessFor`; `!access.CanSend` → `access.sendError()` (so a direct message
   with an ended friendship refuses, like sending).
2. The message: same lookup as edit. Missing, below the caller's `VisibleFromSeq`, or
   hidden by the caller (`chatMessageHiddenBy`) → `errChatMessageGone`. A system message
   or a deleted one → a new `errChatCannotReact` (`409`, "That message can’t take
   reactions.") next to `errChatCannotEdit`.
3. The emoji must pass `validChatReaction` (below), else `400` "That isn’t an emoji.".
4. **Add**: if the caller already has this emoji on it, roll back and return the
   message. If the caller already has 3 reactions on this message, delete their oldest in
   the same transaction (a person never holds more than 3). If the message already has 20
   different emoji and this is a new one, `422` "This message has as many different
   reactions as it can take." Insert the row.
5. **Remove**: delete the row; if nothing was deleted, roll back and return the message.
6. `UPDATE chat_messages SET changed_seq = ? WHERE id = ?`, audience, commit, load,
   publish `message.updated` (with `ReplyTo` cleared, as edit does), return the message.

Name the limits as constants next to `chatEditWindow`: `chatMaxReactionsPerPerson = 3`,
`chatMaxReactionKinds = 20`.

**Delete for everyone** (`deleteChatMessageForEveryone`): delete the message's
`chat_reactions` rows in its transaction.

### `validChatReaction(s string) bool`

In `chat_validate.go`. The client only sends emoji from its picker, so this is a guard,
not a parser:

- Valid UTF-8, 1 to 64 bytes, at most 16 runes (a toned couple kissing,
  🧑🏻‍❤️‍💋‍🧑🏼, is 10 runes and 35 bytes).
- Every rune is one of: U+00A9, U+00AE, U+203C–U+3299, U+FE0F, U+200D, U+20E3,
  U+1F000–U+1FAFF, U+E0020–U+E007F, or `0-9`, `#`, `*` (only allowed as the first rune
  and only when the string contains U+20E3).
- At least one rune is in U+203C–U+3299 or U+1F000–U+1FAFF.
- Table-test it: 👍, ❤️, 👍🏽, 👨‍👩‍👧, 🧑🏻‍❤️‍💋‍🧑🏼, 🇮🇷, 🏳️‍🌈, 1️⃣ and 🏴󠁧󠁢󠁳󠁣󠁴󠁿 pass; "", "a",
  "👍 ", "👍a", "<b>", 17 thumbs up in a row, and a lone U+200D fail.

## 4. Announce it

In `server.go`'s properties: `chat["reactions"] = map[string]any{"maxPerPerson":
chatMaxReactionsPerPerson, "maxKinds": chatMaxReactionKinds}`. Clients show reactions only
when this is present.

## 5. Tests

In a new `chat_reactions_test.go`, using the helpers `chat_test.go` already has (two
users, streams, sending):

- Add, then the message in history, `/changes` and the event carries
  `[{emoji, count: 1, userIds: [me]}]`; `last_seq` went up by one; the conversation's
  `lastActivityMs`, order and the other person's unread count did not change.
- Adding the same emoji twice: second call returns the message, `last_seq` unchanged, no
  event. Removing one you don't have: the same.
- A fourth reaction drops the person's oldest; counts and order are right with two people
  reacting.
- The 21st different emoji is `422`.
- Removing works and sends `message.updated`.
- Refused: an outsider (the usual `404`), a removed group member, a direct message after
  unfriending, a message below the history floor, a message hidden by the caller, a system
  message, a deleted message, an invalid emoji, and a message id from another
  conversation.
- Delete for everyone removes its reactions; deleting a group removes its rows.
- `validChatReaction` table test.

## 6. Docs

- `docs/chat.md`: Product rules (reactions: any emoji, up to 3 per person, 20 kinds, never
  unread or notify), Data (`chat_reactions`), the `ChatMessage.reactions` shape, Limits
  (react 60/minute), and remove "reactions" from "Not in this version". In "Ordering,
  idempotency and sync", one line that a reaction is a message change like an edit.
- `docs/api.md` Chat section: the route.

## Done when

`go test ./...` passes in `services/api`, the docs say the above, and it is committed on
`codex/messages-and-emoji`.
