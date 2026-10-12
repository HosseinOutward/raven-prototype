# Running Raven Text Chat

How chat is deployed, watched, limited, backed up and recovered. The design is in
[chat.md](chat.md); measured capacity is in [chat-testing.md](chat-testing.md).

## What it depends on

The API process and PostgreSQL. Nothing else: LiveKit, Redis (used only by LiveKit) and S3
can be down and chat keeps working. There is no chat-specific service to run.

## Deploying

Chat ships inside the API and the desktop client.

- **Database.** Migration `2026101101_chat` runs when the API starts. It only creates
  tables (`chat_*`, `tree_categories`, `tree_layout_items`) and alters nothing that
  existed, so an older API keeps working against the migrated database.
- **Reverse proxy.** No change. Chat's requests go through the normal API host, and its
  events use `GET /v1/nest-events`, which `infra/homelab/nginx/mimir.conf` already proxies
  unbuffered with a one-hour read timeout.
- **Mixed versions.** A client without chat ignores the `chat` event name, and the server
  does not send chat frames to a client that has not sent the `chat-v1` capability. A
  client with chat hides it when `GET /v1/server/properties` has no `properties.chat`.
- **Rolling back the API** to a version without chat is safe: the tables are left alone.
  Messages written meanwhile are still there when chat comes back.

Configuration:

| Variable | Default | Meaning |
|---|---|---|
| `RAVEN_DB_MAX_OPEN_CONNS` | `20` | Most PostgreSQL connections the API will open. At 50 messages a second from 300 clients, 8 were open and no request waited for one. Requests did wait briefly in two situations: 300 accounts signing in within the same second, and, in one of two restart runs, 300 clients reconnecting at once (55 waits, all served). |

The API also now connects to PostgreSQL with a 5-second connect timeout, and shuts down on
`SIGTERM` by closing event streams and finishing in-flight requests for up to 10 seconds. A
send that was acknowledged before the shutdown is committed; one that was not is retried by
the client with the same id.

## Monitoring

```http
GET /v1/admin/metrics
```

Prometheus text format, for a signed-in admin (`X-Session-ID` of an admin account). There
is no scraper in the homelab today; the endpoint is there to be read by hand or by one
added later. It holds no message content and no user ids.

| Metric | What to read from it |
|---|---|
| `raven_chat_sends_total{result}` | `ok`, `duplicate` (a retry that was already stored), `invalid`, `forbidden`, `not_found`, `error`. A rising `error` is the alarm. |
| `raven_chat_send_duration_ms` | Histogram of the time to handle a send, commit included. |
| `raven_chat_publish_delay_ms` | From commit to the events being queued. Should stay near zero. |
| `raven_stream_write_lag_ms` | How long an event waited in a client's queue before being written. Growth means clients or the network are slow. |
| `raven_chat_fanout_recipients` | People addressed per event. |
| `raven_chat_events_total{type}` | Events published, by type. |
| `raven_chat_rate_limited_total{route}` | Requests refused by a rate limit. Normal use produces none. |
| `raven_chat_changes_requests_total`, `raven_chat_changes_resets_total` | Catch-ups after a gap or reconnect, and those too far behind to patch. |
| `raven_streams_open`, `raven_streams_opened_total`, `raven_streams_closed_total{reason}` | Connected clients. `reason="lagged"` counts clients disconnected because they could not keep up. |
| `raven_db_open_connections`, `raven_db_in_use_connections`, `raven_db_max_open_connections`, `raven_db_wait_count_total`, `raven_db_wait_duration_ms_total` | The connection pool. A growing wait count means the pool is too small or queries are slow. |
| `raven_go_goroutines`, `raven_go_heap_alloc_bytes`, `raven_go_sys_bytes`, `raven_process_uptime_seconds` | The process. Two goroutines per open stream is normal. |

What healthy looked like in the measured steady run (300 clients, 50 messages a second):
0 lagged streams, 0 pool waits, 8 database connections, about 630 goroutines and under
100 MB obtained from the operating system.

## Limits

| Limit | Value | Where |
|---|---|---|
| Message length | 4096 characters and 16 KB | `chatMaxBodyRunes`, `chatMaxBodyBytes` |
| Edit window | 48 hours | `chatEditWindow` |
| Group size | 50 | `chatMaxGroupMembers` |
| History page | 50, at most 100 | `chatHistoryPageDefault`, `chatHistoryPageMax` |
| Catch-up in one answer | 200 changed messages, then the client reloads | `chatChangesLimit` |
| Unread count | counted to 100, shown as "99+" | `chatUnreadCap` |
| Events queued per client | 256, then the client is disconnected and resyncs | `streamFrameBuffer` |
| Send, typing | 20 per 10 seconds per account | `registerChatRoutes` |
| Edit / delete | 30 / 60 per minute per account | `registerChatRoutes` |
| Open a direct message | 60 per minute per account | `registerChatRoutes` |
| Add members / rename / create a group | 60 / 30 / 20 per hour per account | `registerChatRoutes` |

All constants are in `services/api/internal/http/chat.go` except the last buffer, which is
in `events.go`. Rate limits are kept in the API's memory: they reset when it restarts.

## When things go wrong

| What happens | What people see | What the system does |
|---|---|---|
| A client loses its network | "Reconnecting…" in the conversation header. What they write shows as sending. | The client retries sends with the same id and, on reconnect, refetches the list and catches up open conversations. Nothing is duplicated. |
| The API restarts | The same, for a few seconds. | Streams end; clients reconnect with jitter and catch up. Acknowledged messages are in the database. |
| PostgreSQL is down | Sends stay "sending" and then show "Not sent" after 10 minutes, with **Send again**. | The API answers 500 and logs `chat send: …` (no message text). Clients retry with backoff. |
| A client cannot keep up with its stream | Nothing. | The server disconnects it (`streams_closed_total{reason="lagged"}`); it reconnects and catches up by pulling. |
| A session expires or is revoked | The app's usual signed-out screen. Unsent messages are kept as "Not sent". | The stream is closed by the server; requests answer 401. |
| Someone sends too fast | "You're sending too quickly." The message goes out when the limit allows. | 429 with `Retry-After`, which the client honours. |
| The database is restored from an older backup | Conversations reload and show the restored history. | A client that sees a sequence number go backwards discards what it had for that conversation and reloads it. |
| LiveKit or S3 is down | Chat is unaffected. | |

Degradation is by design in this order: live delivery may slow down or stop, but sending
stays correct (it only needs the API and the database), and catching up by pulling stays
correct.

## Backups

Chat makes the database worth more than it was: messages cannot be recreated. Before chat,
nothing in the homelab backed the database up.

`infra/homelab/backup-raven-db.sh` writes a compressed `pg_dump` (custom format) of the
`raven` database to `/home/soroush/services/raven/backups/`, checks that `pg_restore` can
read it, and deletes dumps older than 14 days. The API keeps running while it works.

Install it the same way as the log pruning script:

1. Copy `infra/homelab/backup-raven-db.sh` to
   `/home/soroush/services/raven/config/deployment/` and make it mode `0755`.
2. Add one user crontab entry:
   `41 0 * * * /home/soroush/services/raven/config/deployment/backup-raven-db.sh >> /home/soroush/services/raven/backups/backup.log 2>&1`

What this gives and does not give:

- **Recovery point: up to 24 hours.** A restore brings back the database as it was at the
  last nightly dump. Messages sent after it are lost on the server. Lowering this needs
  PostgreSQL WAL archiving, which is not set up.
- **The dumps are on the same disk as the database.** They protect against a bad
  migration, a mistaken delete or a corrupted volume, not against losing the disk. Copy
  them off the machine to cover that.
- **Dumps contain message text** in the clear. They are written mode `0600`. Treat a copy
  like the database itself.

### Restoring

On the homelab, from `/home/soroush/services/raven`, with `COMPOSE` standing for
`docker compose --project-name raven --env-file .env -f current/infra/homelab/compose.yaml`:

```bash
# 1. Stop the API so nothing writes during the restore. Clients show "Reconnecting…".
$COMPOSE stop api

# 2. Restore into a fresh database first, and look at it before replacing anything.
$COMPOSE exec -T postgres createdb --username raven raven_restore
$COMPOSE exec -T postgres pg_restore --username raven --dbname raven_restore --no-owner < backups/raven-<stamp>.dump
$COMPOSE exec -T postgres psql --username raven --dbname raven_restore -c "SELECT count(*) FROM chat_messages; SELECT max(version) FROM schema_migrations;"

# 3. Swap it in, keeping the old database under another name until the result is checked.
$COMPOSE exec -T postgres psql --username raven --dbname postgres -c "ALTER DATABASE raven RENAME TO raven_before_restore;"
$COMPOSE exec -T postgres psql --username raven --dbname postgres -c "ALTER DATABASE raven_restore RENAME TO raven;"

# 4. Start the API. It applies any migration newer than the dump.
$COMPOSE start api
```

Clients need nothing: on reconnect each one notices that a conversation's sequence number
went backwards, drops what it had cached for it and reloads. A message a client still
shows as "Not sent" can be sent again by the person.

Drop `raven_before_restore` once the restored service has been checked.

### Restore drill

A backup that has never been restored is a hope. This is the one drill run so far.

**2026-10-12, development machine, PostgreSQL 17.5** (the homelab runs PostgreSQL 16 in
Docker; the drill has **not** been run there, and should be once after the script is
installed).

| Step | Result |
|---|---|
| `pg_dump --format custom` of the development database, which held 20,032 chat messages in 5 conversations | 0.86 MB in 0.3 s |
| `pg_restore --list` on the dump, the check the nightly script makes | Read, 275 entries |
| `pg_restore --no-owner --exit-on-error` into a new empty database | 0.5 s, no errors |
| Row counts of `users`, `trees`, `chat_conversations`, `chat_members`, `chat_messages`, `chat_message_hides`, `tree_layout_items`, `schema_migrations`, compared between the original and the copy | Identical |
| A fingerprint over every message (`id`, `seq`, `changed_seq` and a hash of the text, in order) and over every conversation (`id`, `last_seq`, `status`) | Identical |
| The current API started on the restored copy | Healthy. The copy already recorded both migrations, so there was nothing for it to apply |
| A signed-in account listing its conversations and reading history through that API | Same conversations, sequence numbers and unread counts as before; the newest of 20,001 messages in the longest conversation present |

The copy and the dump were removed afterwards. The dump of a database this size takes
well under a second, so the nightly run does not need a quiet hour.

What the drill did not cover: the Docker path the script uses (`docker compose exec`), the
rename-and-swap of step 3 above on a live deployment, and a running desktop client seeing
the sequence numbers go backwards. The last is covered by a client unit test ("a sequence
that went backwards means the server was rewound: start the window over").
