# Raven Text Chat

Text chat adds three kinds of conversation to Raven:

- **Direct messages** between two friends.
- **Groups** of up to 50 friends, with an owner.
- **Text nests** inside a tree, next to its voice nests. A tree's nests of both kinds can be
  put into named categories and ordered.

The benchmark is Telegram for how messaging behaves, and Discord for how a tree's nests are
grouped and ordered.

Related documents: [chat-testing.md](chat-testing.md) (what is tested and measured, with
results), [chat-operations.md](chat-operations.md) (running it), and the Chat section of
[api.md](api.md).

## Product rules

These were decided with Soroush on 2026-10-11.

| Topic | Rule |
|---|---|
| Layout | The sidebar stays the live map. One **Friends and groups** section (changed on 2026-10-16, replacing a separate Messages section) has a row per friend, which opens your conversation with them, and a row per recent group; a round avatar with presence is a person, a square one a group. "All conversations" opens the full list. An expanded tree lists its live voice nests, its text nests with unread messages and the open one; the rest are in the tree lobby, where categories and order for voice and text nests are managed. |
| Who can write to whom | Friends only, for direct messages and for adding to a group. If a friendship ends, the history stays readable and new messages and edits are refused. Deleting your own messages still works. |
| Read status | Shown to the other person in direct messages only. It is mutual: one setting (Settings › Messages) turns it off in both directions. Groups and text nests never show who has read. Your own read position always syncs across your devices. |
| Unread | A neutral count on the conversation's own row; a plain dot on tree rows, the collapsed rail and the Windows taskbar icon. No sound and no OS notifications. |

Defaults chosen during the build. Each is one constant or one check to change:

- Read status defaults to on. While your presence is Invisible, nobody is shown that you
  have read or that you are typing.
- A message is pending, then sent, then (in a direct message) read. There is no separate
  "delivered".
- You can edit your own text messages for 48 hours. An edited message is marked "edited";
  hovering the mark shows when.
- **Delete for everyone** erases the text on the server and leaves a "Message deleted"
  note. Allowed for: your own messages at any time; tree owners and moderators in text
  nests; the owner in groups. In a direct message you can only delete your own.
- **Remove for me** hides a message on all of your devices and for nobody else.
- Groups: any member adds their own friends, the owner removes people, anyone can leave. If
  the owner leaves, the longest-standing member becomes owner; the last person leaving
  deletes the group. A person added to a group sees messages **from when they were added**.
  Leaving or being removed ends access at once.
- Text nests: every current member of the tree reads the whole history and can write.
  Leaving the tree ends access at once. Deleting the tree deletes its text nests.
- A new incoming message brings an archived conversation back.
- Messages are up to 4096 characters. Formatting is `**bold**`, `*italic*`, `~~struck~~`,
  `` `code` `` and fenced code blocks. A web address written out in full becomes a link.
  There is no `[label](address)` form, because a link whose words differ from where it goes
  is how people are tricked.

Not in this version: attachments, reactions, mentions, search, forwarding, pinning, link
previews, an emoji picker (the system picker works), OS notifications, end-to-end
encryption, auto-delete timers, per-nest permissions, and "last seen".

## Architecture

Chat runs inside the existing API process and its existing database. There is no WebSocket
server, no message broker and no second service.

```text
desktop client ── POST /v1/chat/… ───────────────▶ Go API ──▶ PostgreSQL
      ▲                                              │
      └────── GET /v1/nest-events (SSE, event "chat") ◀┘
```

- **Writes** are ordinary HTTP requests. A send is answered only after its transaction has
  committed.
- **Live delivery** rides the server-sent-event stream the client already holds open for
  the live map (`GET /v1/nest-events`), as a second event name, `chat`. Old clients ignore
  event names they do not know, and the server only sends chat frames to clients that
  advertise the `chat-v1` capability.
- **Correctness does not depend on the stream.** The stream makes delivery fast. What makes
  it complete is a per-conversation sequence number and a pull endpoint: a client that
  missed anything, for any reason, notices the gap and fetches it.

`GET /v1/server/properties` advertises `properties.chat`, so a new client hides chat when
talking to an older server.

### Why not WebSocket, Redis or a queue

The requirement is ordered, gap-free, duplicate-free delivery under 200 ms. Each piece of
extra infrastructure was considered against that:

- The client only ever *sends* through requests it needs an answer to (was it stored? what
  is its number?), which is what HTTP is. The server-to-client direction already exists and
  already passes the reverse proxy and the CDN. A WebSocket would add a second connection
  type to operate without removing the need for the pull endpoint.
- Raven's API is one process. A broker (Redis, NATS) exists to carry events between
  processes. With one process, an in-memory fan-out is the same thing without the hop. If
  the API is ever run as several replicas, the broker goes in one place:
  `eventBroker.publishChat`.
- Durability comes from PostgreSQL. A queue in front of it would add a second place a
  message can be while "sent".

The measured results in [chat-testing.md](chat-testing.md) are the evidence that this is
enough.

## Ordering, idempotency and sync

Every handler in the chat files follows six rules. Each has a test.

1. **A gapless counter per conversation.** `chat_conversations.last_seq` counts every
   change to a conversation's content: a new message, an edit, a delete for everyone, a
   membership or rename note. A change is one transaction whose **first statement** is
   `UPDATE chat_conversations SET last_seq = last_seq + 1 … WHERE id = ? AND status =
   'active' RETURNING last_seq`. That statement takes the row lock, which serializes changes
   to one conversation while leaving different conversations independent.
2. **One committed increment is exactly one event.** A request that turns out to change
   nothing (a resend, an identical edit, a second delete) rolls back, so the counter never
   moves without something for clients to receive.
3. **Permission is decided inside that transaction** (`chatAccessFor`, one function for all
   three kinds). A message is accepted only if its sender was allowed at that point in the
   order: a send racing a removal either lands before it or is refused.
4. **A send is acknowledged after commit, and is safe to repeat.** The client invents a
   `clientMessageId` and uses it for every attempt. The server looks it up inside the
   locked transaction and inserts with `ON CONFLICT DO NOTHING`, so a retry returns the
   first result (`200` instead of `201`) and never a second message.
5. **Events are addressed, never broadcast.** The audience is read inside the transaction,
   with each recipient's history floor and hidden messages. A recipient who may not see the
   content gets a `conversation.bump` (the sequence number, no message). Handlers hold an
   in-process lock per conversation from before `BEGIN` until after publishing, so events
   leave in commit order.
6. **A watermark only ever understates.** Any response that says "this is current as of
   sequence N" reads `last_seq` *before* reading the rows, and returns it as `asOfSeq`.

A message carries two numbers: `seq`, where it was created (the order and the paging key;
timestamps are never used for order), and `changedSeq`, where it last changed.

### What the client does with them

The client keeps, per conversation, a window of loaded messages and `syncedSeq`: the
sequence number up to which it knows it has seen every change.

- Messages are stored by id. An incoming copy replaces the stored one when its `changedSeq`
  is not older. Receiving the same event twice changes nothing.
- An event whose `seq` is `syncedSeq + 1` advances it. A higher one means something was
  missed: the client calls `GET …/changes?after=<syncedSeq>` and applies the answer.
- A history page lowers `syncedSeq` to `min(syncedSeq, page.asOfSeq)`, which triggers the
  same catch-up if anything happened while the page was in flight.
- The answer to the client's own `POST` updates the message but is never treated as proof
  that nothing else happened before it.
- After **every** stream open, the first included, the client refetches the conversation
  list, then catches up the conversations whose windows are loaded. A list `lastSeq` lower
  than the local one (a database restored from backup) resets that conversation.
- A stream whose client cannot keep up is **disconnected by the server** rather than
  silently dropped from. Its reconnect runs the full sync, so nothing is missed quietly.

Together: an acknowledged message is in PostgreSQL; every client either receives its event
or sees a hole in the numbering and fills it; a repeat is recognised by id on the server and
by id on the client. That is the whole argument for no loss, no duplicates and one order.

### Sending

The client shows a message the moment it is written and sends it in the background, one at
a time per conversation so they keep the order they were written in.

| Outcome | What happens |
|---|---|
| No answer, a 5xx, or 408 | Retried after 1, 2, 4, 8, 15, then every 30 seconds, for 10 minutes. |
| 429 | Retried after the `Retry-After` the server sent. |
| 401 | Sending stops and the app's usual signed-out path runs. |
| Any other 4xx | Marked "Not sent" with the server's reason, and **Send again** / **Discard**. |

Unsent messages are kept per account in local storage. After a restart they come back
marked "Not sent" and wait for the person: they may be hours old, so nothing is resent on
its own. Signing out on purpose forgets them.

### Per-person state

What is private to one person is state, not a log entry: `read_seq` (only moves forward,
never past `last_seq`), `shared_read_seq` (what a direct-message peer may see),
`hide_rev` (bumped by "remove for me"), `visible_from_seq` (the history floor) and
`archived_at`. History and catch-up responses carry `me: {readSeq, hideRev,
visibleFromSeq}`, so a second device notices a change made on the first without refetching
the list.

Unread is a count, capped at 100 and shown as "99+", of other people's visible, undeleted
text messages after `read_seq`. A conversation is marked read only while the window is
focused, the conversation is open and its newest messages are in view.

## Data

One migration, `2026101101_chat`, creates tables only and alters nothing that existed. The
SQL runs on PostgreSQL (production) and SQLite (local use and the default test run).

| Table | Holds |
|---|---|
| `chat_conversations` | One row per direct message, group or text nest: kind, tree, name, `last_seq`, `last_message_seq`, `last_activity_ms`, status. `dm_key` is unique, so two friends have exactly one direct message. |
| `chat_members` | Membership and per-person state. Authoritative for direct messages and groups. For text nests access always comes from `tree_members`, and the row only holds the person's read position, hides and archive flag. |
| `chat_messages` | `seq`, `changed_seq`, sender, `client_message_id`, kind (`text` or `system`), body, reply target, edit and delete marks. Unique on `(conversation_id, seq)` and on `(conversation_id, sender_id, client_message_id)`. |
| `chat_message_hides` | "Remove for me": person, message. |
| `chat_user_settings` | `share_read_status`. |
| `tree_categories`, `tree_layout_items` | Categories of a tree and the category and position of each voice and text nest. An overlay: the `nests` table is unchanged. |

Ids are 32 hexadecimal characters and timestamps are RFC 3339 text, like the rest of
Raven's schema. Deleting a group, a text nest or a tree first marks the conversation
`deleted`, so a send racing the delete gets `404`, then removes its rows.

## Realtime

Chat events arrive on `GET /v1/nest-events` as SSE event `chat` with a JSON body:

| `type` | Meaning | Sent to |
|---|---|---|
| `message.created` | A new message. | Everyone who may see it. |
| `message.updated` | An edit or a delete for everyone. | Everyone who may see it. |
| `conversation.bump` | The conversation changed at `seq`, without the content. | People who may not see that message. |
| `message.hidden` | You removed a message for yourself. | Your own devices. |
| `conversation.read` | A read position moved. | Your own devices (with the new unread count), and a direct-message peer when read status is shared. |
| `conversation.changed` | Name, members or your role changed; refetch the summary. | Members. |
| `conversation.removed` | You no longer have this conversation. | The people affected. |
| `typing` | Someone is typing. Never stored, not sent while Invisible. | The other members. |
| `settings.changed` | Your read-status setting changed. | Your own devices. |

The stream is closed by the server when its session signs out or is revoked, re-checks its
session every five minutes, and ends cleanly on shutdown. The client reconnects with jitter
so a restart does not bring every client back in the same instant.

## Client

- `apps/desktop/src/lib/eventStream.ts`: one shared stream for the shell and chat.
- `apps/desktop/src/lib/chat/`: a store with no framework in it, read through
  `useSyncExternalStore`, built from pure functions (`reducer.ts` for state, `outbox.ts`
  for sending, `format.ts` for text, `layout.ts` for arranging). A new message re-renders
  one row and the open conversation, not the shell.
- The message list is virtualized (`react-virtuoso`) over a sliding window of at most 600
  loaded messages. Older pages load on scroll; a replied-to message can be jumped to.
- Message text is never treated as HTML. Each line gets its own direction (`dir="auto"`),
  names are isolated with `<bdi>`, bidirectional control characters are stripped from web
  addresses, and Vazirmatn is bundled as the Persian and Arabic fallback behind Geist.

## Limits and safety

- Per-account rate limits, with `Retry-After`: send 20 per 10 s, typing 20 per 10 s, edit
  30 per minute, delete 60 per minute, open a direct message 60 per minute, add members 60
  per hour, rename 30 per hour, create a group 20 per hour.
- A message is at most 4096 characters and 16 KB. Invalid UTF-8, NUL and control
  characters are refused. ZWNJ and other joiners are kept.
- A reply must point at a message in the same conversation that the sender may see.
- Someone who is not in a conversation gets the same `404` for every route as for a
  conversation that does not exist.
- Message text never reaches a log line or an error string. A failing chat request logs
  its operation and the database error, which names the statement and not the values.

## Acceptance criteria

Each requirement, and what shows it is met. "Go" is the API test suite, "client" the desktop
unit tests, "bench" the load harness, "app" a check in the running desktop app. Details and
results are in [chat-testing.md](chat-testing.md).

| Requirement | Shown by |
|---|---|
| Direct messages and groups; create, list, archive, delete | Go: one direct message per pair, group lifecycle, archive, clear, delete. App. |
| End-to-end delivery p95 under 200 ms; p50, p95, p99 measured separately | Bench steady run. The path through the production proxy and CDN is **not yet measured** (needs a deploy). |
| Edit with status and time | Go: owner only, 48-hour window, event. Client reducer. App. |
| Delete for me and for everyone, with defined permissions | Go: who may delete what, per kind; a hide reaches a second device. App. |
| No acknowledged message is lost | Go: acknowledged means committed. Bench: 0 lost in every scenario, including a killed API. |
| No duplicates on send, retry, reconnect or several devices | Go: a resend returns the first result and does not advance the counter. Client outbox and reducer. Bench: 0 delivered twice. |
| One consistent order | Go: concurrent senders produce gapless numbers on SQLite and PostgreSQL. Bench: 0 out of order. |
| Offline delivery; reconnect without gaps | Go: catch-up through list and changes. Client sync tests. Bench reconnect and restart. |
| History with paging | Go: before, after, around; floors and hides respected. App: 20,000 messages. |
| Optimistic sending: pending, sent, failed, retry | Client outbox tests. App: API stopped and restarted mid-conversation. |
| Delivery and read status; unread counts; mark read across devices | Go: clamping, mutual setting, Invisible. Client arithmetic. App. |
| Typing and presence | Go: audience, Invisible, rate limit. App. |
| Group membership with immediate effect | Go: add, remove, leave, owner handover, history floor. App: a removed member gets 404 at once. |
| Authorization against manipulated requests | Go: every route as an outsider, as a removed member and with ids from another conversation. |
| Replies | Go and client, including a deleted original. App. |
| Formatting, links, emoji, Persian and Arabic, mixed direction | Client tokenizer tests. Go body validation. App screenshots. |
| Text selection and copy | App. |
| Long conversations without freezes or memory growth | Client window-trim test. App: 20,000 messages, heap before and after. |
| List, previews and unread update live; several sessions agree | Go: two streams for one person. Client reducer. App. |
| Network loss, server restart, expired sign-in | Client stream and outbox tests. Go: stream ends on revoke. Bench restart. App. |
| Rate limits that do not hurt normal use | Go: 429 with `Retry-After`. Bench: no 429 in the steady run. |
| No message content in logs | Go: log output captured during forced failures. |
| Durable storage with backup and recovery | Backup script and restore drill in [chat-operations.md](chat-operations.md). |
| Burst traffic | Bench burst. |
| Defined and verified performance targets | The table in [chat-testing.md](chat-testing.md). |
| Monitoring | Go: metrics endpoint. Metric list in [chat-operations.md](chat-operations.md). |
| Fits Raven; no unjustified infrastructure | No new service. Two client libraries and one font. The UI lint (`sweep.ts`) is clean. |
