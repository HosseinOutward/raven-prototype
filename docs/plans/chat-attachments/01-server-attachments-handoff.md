# Plan 01 server attachments — reviewer handoff

Date: 2026-10-30. Implemented locally; no commit, push, deployment or release.

## Scope and checkout state

Review against `01-server-attachments.md` and this directory's `README.md`.
The API now supports stored image attachments through create, variant upload,
message claim, authorized fetch and eventual object deletion. Desktop work in
plans 02 and 03 remains separate.

This checkout was already dirty. Existing audio/overlay changes, call-state
changes in `sessions.go` / `sessions_test.go`, the call-state migration, and the
call-state route in `server.go` were present before this task and were preserved.
`server.go` and `database/update_migrations.go` contain both pre-existing changes
and attachment changes; do not attribute their entire diff to this plan.
The plan directory itself was already untracked. Include the new implementation,
tests and this report explicitly when preparing a future commit.

## Implementation map

All API paths below are relative to `services/api/`.

| File | Change |
|---|---|
| `internal/database/chat_attachment_migrations.go` | New migration statements for descriptions, declared variants and durable object purges; open kind/source strings; message id deliberately has no foreign key. |
| `internal/database/update_migrations.go` | Registers `2026103001_chat_attachments`; existing migration statements were not edited. |
| `internal/http/chat_attachments.go` | Wire types, per-kind rules/capabilities, create/upload/fetch routes, joined page loading, summaries, readiness, transactional claims and failed-upload cleanup. |
| `internal/http/chat_attachment_purges.go` | Transactional queue-before-delete, 24-hour expiry, bounded purge drain, 20-attempt stop and request body middleware. |
| `internal/http/chat.go` | Constants, attachment fields and rate-limited routes. |
| `internal/http/chat_validate.go` | Separates caption validation from the empty-text decision, retaining the original text-only validator. |
| `internal/http/chat_messages.go` | Send claims, empty captions, edit rules, page/single-message hydration, reply summaries and delete-for-everyone cleanup. |
| `internal/http/chat_conversations.go` | Batched kind-only previews and purge queuing before group/tree deletion; hidden text nests retain attachments. |
| `internal/http/server.go`, `maintenance.go` | Capabilities, global/body route limits and maintenance integration. |
| `internal/media/store.go`, `store_test.go` | Raises S3 whole-object read bound from 5 MiB to 10 MiB, with a fake S3 HTTP endpoint boundary test. Without this change valid full images could upload but fail to fetch. |
| `internal/http/chat_attachments_test.go` | Ten tests spanning lifecycle/sync, invalid claims, validation, visibility, purge retries, deletion, capabilities/body limits, streaming experiment, concurrent retries/claims and injected upload-update failure cleanup. |
| `go.mod`, `go.sum` | Adds `golang.org/x/image v0.38.0` for header-only WebP decoding. |

Other changed files: `docs/chat.md`, `.env.example`,
`infra/homelab/compose.yaml`, `infra/homelab/nginx/raven.conf`,
`infra/homelab/nginx/mimir.conf`.

## Behavior and invariants to review

- Readiness is generic: all declared variants have keys; no variants means ready.
  Send only sees attachment ids and readiness, and stores attachment-only messages
  as text with an empty caption. Every failed claim rolls back the message,
  preceding claims and sequence increment. Duplicate sends return the stored copy.
- Page hydration uses one joined query for descriptions and variants, including
  visible reply parents. Conversation lists use one separate kind-only batch.
  Events retain attachments while reply references remain viewer-specific.
- Create is idempotent by uploader/client upload id. Upload is immutable and
  retry-safe. Access, uploader ownership, declared variant and unattached status
  are checked before returning an already-uploaded variant.
- Create/upload lock the conversation row without incrementing its sequence.
  This serializes them with send and conversation/tree deletion. Expiry takes
  corresponding conversation locks, then rechecks expiry/claim status.
- MIME sniffing, declared size and image header dimensions are checked. Full
  accepts swapped dimensions for rotation; preview must fit the full rectangle
  in either orientation. No complete image decoding is performed.
- Fetch checks membership, floor, hide and deletion before serving bytes or a
  conditional 304. Pending uploads are uploader-only. Fetch uses private immutable
  caching, key-derived ETags and nosniff.
- Every physical message/conversation deletion path found by repository search
  goes through the updated group/tree helpers. `deleteTreeCore` calls the tree
  helper before deleting trees. No physical user deletion path was found.
- Object keys are queued in the transaction that removes their attachment rows.
  Hides, Clear and text-nest deletion do not remove them. Failed uploads attempt
  immediate object deletion after rollback, falling back to the durable queue.
  Purge drain processes at most 100 keys and leaves attempts=20 rows for attention.

## Verification

Baseline `go test ./...` passed before implementation.

| Check | Result |
|---|---|
| `go test ./... -count=1` on SQLite | Pass; HTTP 151.814 s, media 0.601 s. |
| `go test ./internal/http/... -count=1` on local PostgreSQL 17 | Pass; final full run 69.318 s. |
| Focused attachment/concurrency/failure tests on both databases | Pass. Includes real transactions, immutable retry races, competing claims, and DB-trigger failure after object Put. |
| Focused attachments/metrics after final logging/counter adjustments | Pass on SQLite (19.874 s). |
| Group/tree deletion tests after removing redundant lock statements | Pass on SQLite (4.701 s). |
| `go vet ./...` | Pass. |
| `gofmt -l` on changed Go files | Clean. |
| `git diff --check` on task files | Clean. |
| Compose YAML parse and attachment-prefix environment wiring | Pass. |

PostgreSQL used the local DATABASE_URL without printing credentials, through the
existing `RAVEN_TEST_DATABASE_URL` harness. Each test creates a fresh isolated
schema and drops it afterwards; tests do not mutate the application's schema.
Both database runs exercise the new migration and the same attachment SQL,
including purge INSERT SELECT / ON CONFLICT, locking, rollback and cascades.
No production database, prior production-data clone, live S3 service, race-detector
run, desktop integration, attachment load benchmark, nginx runtime or CDN path was
validated. Object tests use the in-memory store and a local fake S3 HTTP endpoint.

## Streaming, deployment and remaining review considerations

The focused `TestChatAttachmentStreamRequestBodyExperiment` enables Fiber streaming
with a 1 KiB BodyLimit, then observes an existing `c.Body()` handler buffer a 2 MiB
stream and return 200. Streaming therefore is not a safe drop-in memory bound for
these handlers. It remains disabled. The 10 MiB + 64 KiB global limit bounds raw
buffering; the ordinary 1 MiB `/v1` check occurs after buffering and before parsing.
The middleware also checks buffered size for requests without a declared length.

The plan names `nginx/raven.conf`, but that file proxies only the admin API.
The actual desktop API hostname is routed by `nginx/mimir.conf`; both repository
configs now allow 12 MiB. Saye's running nginx and the ArvanCloud CDN still need
the corresponding body-size configuration/verification at deployment. Neither was
contacted or changed. `RAVEN_CHAT_MEDIA_PREFIX` defaults to `chat-attachments` and is
wired through the example environment and Compose.

Upload holds the conversation's DB row lock while calling object storage, favoring
correct serialization with delete/expiry and concurrent retries. Review its latency
impact for busy conversations; no attachment load benchmark was run. The API reads
complete objects through the existing Store interface. As with the planned
object-first write, process death between S3 Put and persisting the object key can
leave an unreferenced object; there is no bucket reconciliation job in this scope.
Private immutable browser caches can retain previously authorized bytes after a
later hide/delete; fresh server requests enforce current permissions.

Before release, decide minimum-client compatibility as described in the plan
README: existing desktop versions can render empty attachment-only messages.
No version policy was changed here.
