# Plan 01 — Server: attachments on chat messages

You are working on Raven, a Tauri v2 desktop app for voice-first rooms with text chat
(repo `C:\Users\Soroush Taheri\code\raven`). This plan is the Go API in `services/api`.
Read `docs/plans/chat-attachments/README.md` first: it has the attachment model, the
decisions and the limits. Then read `docs/chat.md`, which explains how chat keeps order,
avoids duplicates and syncs. Everything here must keep those guarantees.

When you're done, the API can take an image as an attachment on a message, serve it to
the people who may read that message, and delete it when the message is deleted for
everyone. Nothing in the desktop app changes; plan 03 does that.

The model is generic on purpose: `kind` and `source` are open strings, variants are
named, and the send step only takes attachment ids. Don't write anything that assumes an
attachment is an image except the image checks, which live in one place (step 4).

## Before you start

- `go test ./...` in `services/api` must pass before and after. Tests run on SQLite; the
  same SQL must work on PostgreSQL (see how `chat_migrations.go` does it).
- The local `.env` has S3 settings, used by `media.NewStoreFromEnv`. Tests use the
  in-memory store in `internal/http/profile_media_test.go` (`memoryProfileMedia`).
- Don't commit, push or deploy unless asked.

## What is true now

Paths are under `services/api/internal`. Line numbers are from 2026-10-30; verify them.

- Schema: `database/chat_migrations.go`. `chat_messages.kind` has no `CHECK` on purpose.
  Migrations are listed in `database/update_migrations.go` (`migrateVersioned`), each with
  a version and a checksum. Add a new entry; never edit an applied one.
- Sending: `http/chat_messages.go`. `sendChatMessage` (~194) parses
  `{clientMessageId, body, replyToMessageId}`, normalizes the body
  (`normalizeChatBody` in `chat_validate.go`, which refuses an empty body), takes the
  conversation lock, and calls `storeChatMessage` (~264). That takes the next seq first
  (`chatNextSeq`, which is the row lock), checks access, finds a duplicate by
  `clientMessageId`, inserts, and publishes `message.created`.
- Reading: `chatMessageSelectSQL` and `scanChatMessage` build the wire `ChatMessage`
  (`http/chat.go`). History is `listChatMessages`, catch-up is `listChatChanges`.
  Conversation previews are `ChatMessagePreview` (`chat.go` ~113) with an excerpt from
  `chatExcerpt` (`chat_validate.go` ~88).
- Editing: `editChatMessage` (~403) updates `body`.
- Deleting for everyone: `deleteChatMessageForEveryone` (~515) blanks `body` and sets
  `deleted_at`. Hides (`hideChatMessage`) and clears only move the reader's floor or add a
  hide row.
- Deleting conversations: `chatDeleteConversationTx` and `deleteChatForTreeTx`
  (`chat_conversations.go` ~790 and ~818) delete rows. `chatHideTextNestTx` keeps them.
- Access: `chatAccessFor` (`chat_access.go`) gives `CanSend`, `CanManage`,
  `VisibleFromSeq` (the reader's floor), `Kind`, `TreeID`.
- Objects: `media.Store` (`media/store.go`) with `Put`, `Get` (reads the whole object),
  `Delete`. The server holds one as `s.profileMedia`. Profile images
  (`http/profile_media.go`) show the checks to copy: `stdhttp.DetectContentType` must
  agree with the declared type, and an allowlist of types.
- `fiberConfig` (`http/server.go` ~220) sets a global `BodyLimit` of 512 KB + 64 KB.
- `/v1/server/properties` (`server.go` ~366) announces `chat` limits under `properties`.
- `startMaintenance` (`http/maintenance.go`) runs `runMaintenance` every 10 s.
- Rate limits: `s.chatLimiter(name, count, window)` on each route in
  `registerChatRoutes` (`chat.go` ~163).

## Design

### 1. Schema

A new migration, `2026103001_chat_attachments`, in its own file
(`database/chat_attachment_migrations.go`):

```sql
CREATE TABLE IF NOT EXISTS chat_attachments (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  -- NULL until a message claims it. Not a foreign key, for the same reason
  -- reply_to_message_id isn't: bulk deletes must not depend on order.
  message_id TEXT,
  uploader_id TEXT NOT NULL REFERENCES users(id),
  client_upload_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,          -- no CHECK: new kinds need no rebuild
  source TEXT NOT NULL,        -- no CHECK: 'stored' now, 'peer' later
  content_type TEXT NOT NULL DEFAULT '',
  size_bytes BIGINT NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  width INTEGER, height INTEGER, duration_ms BIGINT,
  placeholder TEXT NOT NULL DEFAULT '',
  meta_json TEXT,
  created_at TEXT NOT NULL,
  attached_at TEXT,
  UNIQUE (uploader_id, client_upload_id)
);
CREATE INDEX ... ON chat_attachments(message_id);
CREATE INDEX ... ON chat_attachments(conversation_id, attached_at);

CREATE TABLE IF NOT EXISTS chat_attachment_variants (
  attachment_id TEXT NOT NULL REFERENCES chat_attachments(id) ON DELETE CASCADE,
  variant TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  object_key TEXT,             -- NULL until uploaded
  uploaded_at TEXT,
  PRIMARY KEY (attachment_id, variant)
);

CREATE TABLE IF NOT EXISTS chat_object_purges (
  object_key TEXT PRIMARY KEY,
  queued_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
```

Write a comment above each table, in the style of `chat_migrations.go`, saying what it is
for and why (for example why `message_id` isn't a foreign key, and that variants are
declared at create time and filled in by uploads).

An attachment is **ready** when every declared variant has an `object_key`. A `peer`
attachment, later, declares no variants and is ready at once. Write it as a helper,
`chatAttachmentReady`, so that rule lives in one place.

### 2. The wire shape

Add `Attachments []ChatAttachment \`json:"attachments,omitempty"\`` to `ChatMessage`, with
`ChatAttachment` as in the README (`meta` is `json.RawMessage`). A deleted message has no
attachments. Load them for a page of messages with **one** query
(`WHERE message_id IN (...) ORDER BY message_id, position`), not one per message: add a
`withChatAttachments(q, messages)` step after `queryChatMessages` and after
`loadChatMessage`, and use it everywhere a `ChatMessage` goes out (history, changes, send
response, events, edit, delete).

`ChatMessagePreview` gains `Attachments []ChatAttachmentSummary \`json:"attachments,omitempty"\``
with only `kind`, so the conversation list can say "Photo" without loading descriptions.
Reply references (`ChatReplyRef`) gain the same summary, so a reply to an image can say
"Photo". Keep the excerpt rule as it is: an image with no caption has an empty excerpt.

### 3. Routes

All under the existing `conversation` group in `registerChatRoutes`, through `chatRoute`
and with limiters:

| Route | Limiter |
|---|---|
| `POST /attachments` | `attach` 60 per minute |
| `PUT /attachments/:attachmentId/variants/:variant` | `upload` 120 per minute |
| `GET /attachments/:attachmentId/variants/:variant` | none |

**Create.** Body:
`{clientUploadId, kind, source, contentType, size, name?, width?, height?, placeholder?, variants: [{variant, contentType, size}]}`.
Check:
- the caller may send in this conversation (`access.CanSend`, same error as a send);
- `kind` and `source` are ones this server accepts (now only `image` / `stored`); others
  get `422` with "This server can't take that kind of attachment.";
- per-kind rules in one table keyed by kind (step 4);
- `clientUploadId` looks like a `clientMessageId` (reuse `validClientMessageID`).

A repeat with the same `(uploader, clientUploadId)` returns the existing attachment,
whatever its state, so a client can resume. Answer with the attachment plus
`missingVariants: []string`.

**Upload.** Raw body. The variant must be declared, the attachment must be the caller's and
not yet attached. Check the body: its length equals the declared size, it is at most the
kind's limit for that variant, and the detected type equals the declared type. Store it
under `chat-attachments/<conversationId>/<attachmentId>/<variant>-<random id><ext>`. Put
the prefix in an env var like `RAVEN_MEDIA_PREFIX` (`RAVEN_CHAT_MEDIA_PREFIX`, default
`chat-attachments`). Record the key in the same request.

A second PUT of a variant that already has a key returns `200` with nothing changed, so a
retry is safe. Write the object first, then the row; if the row update fails, delete the
object. Answer with the attachment and `missingVariants`.

**Fetch.** The caller must be able to read the message the attachment belongs to:
- read access to the conversation;
- the message's `seq` is at or above their `VisibleFromSeq`;
- they haven't hidden it;
- it isn't deleted.

An unattached attachment is visible only to its uploader. Anything else answers `404`,
the same as a missing one. That matches the rest of chat, which never says whether
something exists.

Headers:
- `Content-Type` from the variant row;
- `Cache-Control: private, max-age=31536000, immutable` (the object never changes);
- an `ETag` from the object key, as `avatarETag` does;
- `X-Content-Type-Options: nosniff`.

**Send.** `sendChatMessage` accepts `attachmentIds: string[]`, at most `maxPerMessage`.
The body may be empty when there is at least one attachment. Split `normalizeChatBody` so
the "Write a message first." check is the caller's decision.

In `storeChatMessage`, after the duplicate check and inside the same transaction, each id
must:
- belong to this conversation and this sender;
- be unattached and ready;
- not repeat in the list.

Then set `message_id`, `position` (its index) and `attached_at`. If any check fails,
answer `422` with "That attachment isn't ready to send." and change nothing.

A duplicate send (same `clientMessageId`) returns the stored message with its
attachments, as now. Store attachment-only messages with `kind = 'text'` and an empty
body. A new kind is not needed, and the excerpt rule above covers the list.

**Edit.** A message with attachments may be edited to an empty body. One without may not,
as now. Attachments can't change.

### 4. Per-kind rules

One Go map from kind to its rules, so a later kind is one entry:

```go
type chatAttachmentRules struct {
    variants     map[string]chatVariantRule // allowed variant names; which are required
    contentTypes []string                   // allowed for every variant
    maxPixels    int64
    maxSide      int
    needsSize    bool                       // width and height required
}
```

`image`:
- variants `full` (required, ≤ 10 MB) and `preview` (required, ≤ 512 KB);
- types JPEG, PNG, GIF, WebP;
- width and height required, at most 16 384 per side and 100 megapixels.

On upload, read the image header with `image.DecodeConfig`. Register the decoders with
blank imports of `image/jpeg`, `image/png`, `image/gif` and `golang.org/x/image/webp`.
Check its size: for `full` it must equal the declared width and height (allow a 90°
swap), and `preview` must not be larger than `full`. Never decode whole images on the
server.

Use the limits from the README, as constants next to `chatMaxBodyRunes`.

### 5. Body size

The global `BodyLimit` is about 576 KB. Raise it to the largest variant limit plus 64 KB.
Then add a middleware on the `v1` group: when the route isn't the attachment PUT, reject
a `Content-Length` over 1 MB with `413`. Fasthttp has already read the body by then, so
this keeps handlers from parsing big bodies but doesn't save memory. Write that down in
`docs/chat.md` under Limits as a known limit. If `StreamRequestBody` can do better without
touching every handler, try it, and say what you found.

In `infra/homelab/nginx/raven.conf` (~56), raise `client_max_body_size` for the API from
`1m` to `12m`. Only in the repo: changing Saye is a deploy step.

### 6. Deleting and purging

Write `chatQueuePurgesTx(tx, where string, args...)`. It inserts the object keys of
matching attachments' variants into `chat_object_purges` (`ON CONFLICT DO NOTHING`), then
deletes those attachment rows (variants cascade). Call it:

- in `deleteChatMessageForEveryone`, for that message, before the update;
- in `chatDeleteConversationTx` and `deleteChatForTreeTx`, for the conversation(s),
  **before** the statement that deletes the conversation (the cascade would otherwise
  drop the rows with their keys);
- in a new maintenance step for unattached attachments created more than 24 hours ago.

`chatHideTextNestTx` keeps everything, as it does for messages.

A second maintenance step, `drainChatObjectPurges`, deletes up to 100 queued keys per
run through `Store.Delete`. On success it removes the row; on failure it bumps `attempts`
and logs the key, never message content. After 20 failed attempts it logs once and stops
retrying that key. Add both steps to `runMaintenance` with log lines like the others. The
drain does no work when the queue is empty, so the 10-second interval is fine.

Grep for every other `DELETE FROM chat_messages` and `DELETE FROM chat_conversations`,
and for user or tree deletion paths, to be sure none of them drops attachment rows
without queuing their keys.

### 7. Events and sync

- `message.created` and `message.updated` carry attachments in the message, like every
  other copy. `publishChatMessage` strips `ReplyTo` for the event; keep `Attachments`.
- A delete for everyone already sends `message.updated`; the message now arrives without
  attachments, and that is how clients learn they're gone.
- Creating and uploading attachments sends no events: nobody else can see them yet.

### 8. Capabilities

Under `properties.chat`, add:

```json
"attachments": {
  "version": 1,
  "kinds": { "image": { "variants": { "full": 10485760, "preview": 524288 }, "maxPixels": 100000000, "maxSide": 16384 } },
  "sources": ["stored"],
  "maxPerMessage": 10
}
```

Build it from the rules map in step 4, so the two can't drift. A client that doesn't see
`attachments` must not offer to attach. When the store is `UnavailableStore`, leave
`attachments` out entirely.

## Tests

In a new `http/chat_attachments_test.go`, using the in-memory store:

- Create → upload both variants → send: the message has the attachment, in order, with
  its description. History, changes and the event all carry it.
- Create twice with the same `clientUploadId`: one attachment. Upload a variant twice: one
  object.
- Send with an attachment that is not ready, belongs to another conversation, belongs to
  another person, or is already attached: `422`, and the seq does not advance (compare
  the conversation's `last_seq`).
- A message with only an attachment and no body is accepted; one with neither isn't.
- Upload checks: wrong size, wrong type (a PNG declared as JPEG), over the limit,
  dimensions that don't match, undeclared variant, someone else's attachment.
- Fetch rules:
  - a member can fetch;
  - someone below their floor after Clear can't;
  - someone who hid the message can't;
  - after delete for everyone nobody can;
  - a non-member gets `404`;
  - the uploader can fetch before sending, nobody else can.
- Purging:
  - delete for everyone queues the keys;
  - deleting a group queues them;
  - deleting a text nest doesn't;
  - an unattached upload older than 24 h is queued;
  - the drain deletes the objects and the rows, and keeps retrying on failure.
- Previews and reply references carry the attachment summary.
- `/v1/server/properties` has `chat.attachments`, and doesn't when the store is
  unavailable.
- Body limit: a 2 MB JSON body to a chat route gets `413`; a 2 MB variant PUT doesn't.

Run the whole suite on SQLite. If a PostgreSQL test target exists (look at
`docs/chat-testing.md`), run that too.

## Docs

In `docs/chat.md`:
- the Data section: the three tables and why `message_id` isn't a foreign key;
- the routes;
- the Limits section: the new limits, the body-limit note;
- the acceptance criteria table: a row for attachments (send, fetch rules, purge).

## Done when

- `go test ./...` passes.
- `docs/chat.md` describes the attachment routes, tables, limits and purge.
- The nginx file in the repo has the new body limit.
- You've written a short summary for Soroush, saying:
  - what you checked against PostgreSQL and what you didn't;
  - what you found about `StreamRequestBody`;
  - that Saye and the CDN still need the body-size change at deploy time.
