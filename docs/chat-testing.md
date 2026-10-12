# Testing Raven Text Chat

What is tested, how to run it, the performance targets, and the results measured on
2026-10-12. The design being tested is in [chat.md](chat.md).

## Running the tests

```powershell
# API: every package, on SQLite (the default; no setup)
cd services\api
go vet ./...
go test ./...

# API: the same HTTP tests on PostgreSQL. Each test gets its own schema in this database
# and drops it afterwards. Use a database you can throw away.
$env:RAVEN_TEST_DATABASE_URL = "postgres://USER:PASSWORD@127.0.0.1:5432/raven_test?sslmode=disable"
go test ./internal/http/...
Remove-Item Env:RAVEN_TEST_DATABASE_URL

# Desktop: unit tests, type check and bundle
cd ..\..\apps\desktop
bun test
bun run build

# UI rules (from the repository root): must print "Clean"
bun .claude/skills/raven-ui/scripts/sweep.ts
```

The PostgreSQL run matters for chat: ordering depends on row locks and `RETURNING`, which
SQLite only imitates. The concurrency tests run on both.

Not run: Go's race detector (`go test -race`). It needs a C compiler, and none is installed
on the machine these results come from.

## What the tests cover

API tests are in `services/api/internal/http/chat_test.go` and `chat_groups_test.go`. They
drive the real HTTP handlers and read the real event stream. Desktop tests are in
`apps/desktop/src/lib/chat/*.test.ts` and `apps/desktop/src/lib/eventStream.test.ts`; they
run the store and its pure functions against a scripted server.

| Area | API tests | Desktop tests |
|---|---|---|
| Sending, retries, duplicates | `TestChatSendReachesEveryDeviceOnceAndRetriesAreHarmless` | store: "a send that gets no answer is retried with the same id…", "a retry of something the server already stored does not create a second message", "the event arriving first does not produce a second copy" |
| Order under concurrency | `TestChatConcurrentSendsAreGaplessAndArriveInOrder` | store: "messages to one conversation go one at a time, in the order they were written" |
| Offline delivery, gaps, reconnect | `TestChatOfflineRecipientCatchesUpFromTheListAndChanges`, `TestChatHistoryPagesAndCatchUp`, `TestSlowStreamIsDisconnectedInsteadOfSilentlyMissingEvents` | reducer: "an event further ahead than the next seq fetches what was missed…", "after a reconnect, an open conversation that moved on asks for its changes", "a sequence that went backwards means the server was rewound…"; store: "a failed catch-up is tried again until it works" |
| Edit | `TestChatEditRules` | reducer: "an edit replaces the message in place", "an older copy arriving late does not undo a newer one" |
| Delete for everyone, remove for me | `TestChatDeleteForEveryoneErasesTheTextAndFollowsTheRules`, `TestChatDeleteForMeIsPrivateAndReachesMyOtherDevices` | reducer: "a message I removed for myself on another device disappears here", "deleting an unread message takes it off the count" |
| Read position, unread, read status | `TestChatReadPositionUnreadCountsAndWhoIsTold`, `TestChatReadStatusIsMutualAndCanBeTurnedOff`, `TestChatInvisibleReaderIsNotRevealedByReadingOrTyping` | reducer: "my read position from another device updates the count…", "at the cap the count is fetched again…"; store: "reading updates the count at once and tells the server once…" |
| Typing | `TestChatInvisibleReaderIsNotRevealedByReadingOrTyping`, `TestChatSendIsRateLimitedPerPersonWithRetryAfter` | reducer: "typing shows until it runs out or the person's message arrives"; store: "typing is reported at most once every few seconds" |
| Replies | `TestChatRepliesQuoteOnlyWhatTheReaderMaySee` | reducer and row rendering |
| Direct messages and friendship | `TestChatDirectMessageNeedsFriendshipAndIsOnePerPair`, `TestChatEndingAFriendshipStopsSendingButKeepsHistory` | |
| Groups | `TestChatGroupIsCreatedWithFriendsOnly`, `TestChatGroupNewMembersSeeOnlyWhatComesAfterTheyJoin`, `TestChatGroupRemovalAndLeavingEndAccessAtOnce`, `TestChatGroupOwnerRenamesModeratesAndDeletes`, `TestChatGroupHasASizeLimit` | text: "what happened to a group, from the reader's side" |
| Text nests, categories, order | `TestTextNestBelongsToTheTreeAndFollowsItsMembership`, `TestDeletingATreeRemovesItsTextNestsAndTheirMessages`, `TestTreeLayoutOrdersVoiceAndTextNestsInCategories` | layout: 8 tests of arranging and moving |
| Manipulated requests | `TestChatOutsidersGetNotFoundOnEveryRoute` (every route as an outsider and with ids from another conversation), plus the removal, reply and friendship tests above | |
| Archive, clear | `TestChatArchiveAndClearAreMineAlone` | reducer: "a new message brings an archived conversation back" |
| Text: validation, formatting, Persian and Arabic, emoji | `TestChatBodyIsValidatedAndUnicodeSurvivesUnchanged` | format: 17 tests ("markup is text, never elements", "direction-changing characters cannot disguise an address", "Persian with its zero-width non-joiner passes through unchanged", …) |
| Sending while things fail | | outbox: 10 tests (what is retried, for how long, what is final, what survives a restart); store: "an ended session is reported and the message is kept as not sent" |
| Long conversations | | reducer: "following the newest messages lets go of the oldest", "paging back in a full window lets go of the newest end"; rows: "no row changes its look when an earlier page arrives", "with history before it, the oldest loaded message waits for the page before it"; store: "one left somewhere back in its history starts over at the newest, in one request" |
| Several sessions | `TestChatSendReachesEveryDeviceOnceAndRetriesAreHarmless`, `TestChatEventsOnlyGoToClientsThatUnderstandThem` | eventStream: 8 tests (one stream shared, reopened after a drop, stopped on an ended session) |
| Sign-out, revoked and expired sessions | `TestStreamEndsWhenItsSessionIsSignedOut`, `TestStreamEndsWhenItsSessionStopsBeingValid` | store: "an ended session during a catch-up is reported once and not retried" |
| Rate limits | `TestChatSendIsRateLimitedPerPersonWithRetryAfter` | outbox: "being told to slow down waits as long as the server asked" |
| Logs hold no message text | `TestChatFailuresAreLoggedWithoutMessageText` | |
| Metrics | `TestAdminMetricsAreForAdminsAndDescribeMessaging` | |

### Results, 2026-10-12

| Suite | Result |
|---|---|
| `go vet ./...`, `gofmt -l` | Clean |
| `go test ./...` on SQLite | Pass. `internal/http` 118 s; 31 of its tests are chat, stream and layout tests |
| `go test ./internal/http/...` on PostgreSQL 17.5 | Pass, 37 s |
| `bun test` | Pass: 197 tests in 27 files, 115 of them in the seven chat and stream files |
| `bun run build` (type check and bundle) | Pass |
| `sweep.ts` | Clean |
| `cargo check` for the desktop shell | Pass (`cargo check --lib`). The only change on the Rust side is one window permission, for the taskbar dot |

The PostgreSQL run found one defect that SQLite had hidden, in code older than chat:
inviting someone to a nest a second time failed with a 500, because an `ON CONFLICT`
update named its columns ambiguously. It is fixed in `server.go` (`inviteUser`).

## Performance

### Targets

Set before measuring, at about ten times the size of the closed alpha.

| Scenario | Load | Must hold |
|---|---|---|
| Steady | 300 connected clients; 150 direct messages, 15 groups of 20, 4 text nests of 150; 50 messages a second for 5 minutes | Send to recipient: p50 ≤ 20 ms, p95 ≤ 75 ms, p99 ≤ 200 ms. No stream dropped, no gap. |
| Burst | The same people; 20 messages a second with 200 a second for 10 seconds | During the burst: p95 ≤ 200 ms, p99 ≤ 500 ms. No stream dropped for falling behind. |
| Fan-out | One text nest with 300 people online; 20 messages a second for 60 seconds | p95 ≤ 100 ms. |
| Reconnect | Every stream cut at once, under 30 messages a second | Each client complete again ≤ 2 s after its stream reopens. |
| Restart | The API process killed and started again, under 30 messages a second | The same, and every client complete ≤ 15 s after the API is back. |
| All of them | | 0 acknowledged messages lost, 0 missing after sync, 0 delivered twice, 0 out of order, 0 sends refused. API memory ≤ 300 MB. No request waiting for a database connection (not applied to Restart, where 300 clients return in the same instant). |
| Through production | 20 clients through ArvanCloud and nginx; 5 messages a second for 2 minutes | p95 < 200 ms. **Not run**: it needs chat deployed. |

"Send to recipient" is measured from just before the sender's request leaves to the moment
a recipient's client has the message from its stream, for every recipient of every
message. p50, p95 and p99 are computed separately over all of those. The 75 ms budget on
one machine leaves 125 ms of the 200 ms requirement for the two network legs.

### The harness

`services/api/cmd/raven-chatbench` is a client, not a shortcut. It talks to a running API
over HTTP the way the desktop app does: signs users in, makes them friends, opens an event
stream for each, sends, and follows the client's sync rules (apply events in order, fetch
changes on a gap, refetch and catch up after every reconnect, retry a failed send with the
same id). At the end it reads every conversation's history from the server and compares
it with what each simulated client holds:

- **acknowledged but lost**: a send the server answered `201` to that is not in history;
- **missing after sync**: a message some client that should have it does not have;
- **delivered twice**: a message a client's stream handed it more than once;
- **out of order**: an event with a sequence number at or below one already applied.

It exits non-zero if any target is missed.

### Reproducing

Use a database you can throw away; the harness creates users and does not remove them.

```powershell
cd services\api
go build -o $env:TEMP\raven-api.exe .\cmd\raven-api
go build -o $env:TEMP\raven-chatbench.exe .\cmd\raven-chatbench

# 1. An API on a scratch database, on its own port.
$env:DATABASE_URL = "postgres://USER:PASSWORD@127.0.0.1:5432/raven_bench?sslmode=disable"
$env:RAVEN_API_ADDR = "127.0.0.1:6988"
& $env:TEMP\raven-api.exe user create --username benchadmin --display-name "Bench admin" --password "CHOOSE-ONE" --role admin
Start-Process $env:TEMP\raven-api.exe -WindowStyle Hidden

# 2. The scenarios. Each prints its numbers and PASS or FAIL.
$env:RAVEN_BENCH_ADMIN_PASSWORD = "CHOOSE-ONE"
foreach ($scenario in "steady", "burst", "fanout", "reconnect") {
  & $env:TEMP\raven-chatbench.exe -api http://127.0.0.1:6988 -admin-user benchadmin -scenario $scenario -out "$scenario.json"
}

# 3. Restart: start it, and when it prints ">>> restart the API now <<<", kill the API
#    process (Stop-Process, no graceful shutdown) and start it again.
& $env:TEMP\raven-chatbench.exe -api http://127.0.0.1:6988 -admin-user benchadmin -scenario restart -out restart.json
```

`-scenario smoke` is a 20-second run with 20 users for checking the setup. `-users`,
`-rate`, `-duration` and the other flags (`-h`) change a scenario's size.

### Results, 2026-10-12

Environment: one Windows 11 machine, AMD Ryzen 9 9950X (16 cores), 62 GB RAM. API built
with Go 1.26.4, PostgreSQL 17.5 with default settings, harness, API and database all on
that machine over loopback. The API's pool was at its default of 20 connections.

These numbers contain no network. They show what the server and the protocol cost, and
that they leave most of the 200 ms for the network. They are not a measurement of what a
person in another city will see.

| Scenario | Messages | Deliveries timed | p50 | p95 | p99 | max | Target | |
|---|---|---|---|---|---|---|---|---|
| Steady, send to recipient | 15,500 | 559,458 | 2.7 ms | 10.9 ms | 47.0 ms | 152.3 ms | 20 / 75 / 200 ms | Pass |
| Steady, send to acknowledgement | 15,500 | 15,001 | 2.2 ms | 11.4 ms | 48.5 ms | 152.3 ms | | |
| Burst, during the 200/s burst | 2,800 | 70,166 | 2.3 ms | 19.2 ms | 70.5 ms | 95.5 ms | – / 200 / 500 ms | Pass |
| Fan-out to 300 | 1,400 | 360,300 | 4.4 ms | 24.1 ms | 48.3 ms | 101.3 ms | – / 100 ms | Pass |
| Reconnect, stream open to complete | 2,100 | 300 clients | 5.8 ms | 12.4 ms | 21.5 ms | 41.2 ms | p95 ≤ 2 s | Pass |
| Restart, stream open to complete | 3,000 | 300 clients | 5.1 ms | 16.1 ms | 39.3 ms | 58.4 ms | p95 ≤ 2 s; everyone ≤ 15 s | Pass |

| Scenario | Lost | Missing after sync | Twice | Out of order | Streams cut | Learned by catching up | Send retries | Refused |
|---|---|---|---|---|---|---|---|---|
| Steady | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Burst | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Fan-out | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Reconnect | 0 | 0 | 0 | 0 | 300 (on purpose) | 1,023 | 0 | 0 |
| Restart | 0 | 0 | 0 | 0 | 314 (the kill) | 710 | 17 | 0 |

In the restart run the API process was killed at 01:52:19.022 and was listening again at
01:52:20.690. The 17 sends that were in flight or refused in between were retried with
the same id and stored once each. Every client was complete 2.9 s after the API returned.
A first restart run the same night gave the same picture (19 retries, complete after
3.0 s), with 55 requests briefly waiting for a database connection as the 300 clients
returned; in the second run none waited.

Server during the steady run: 300 streams open, 626 goroutines, 8 database connections
open with no request waiting for one, 22 MB of heap in use, 80 MB obtained from the
operating system. No stream was disconnected for falling behind in any scenario, and no
request was rate limited. The highest memory figure in any scenario was 113 MB.

Things worth knowing about these numbers:

- **The tail varies from run to run, and its cause was not traced.** The steady p99 of
  47 ms and maximum of 152 ms are far above the median of 2.7 ms. The server's own
  metrics showed events waiting under a millisecond to be written to streams, so the time
  is not spent in fan-out; beyond that it was not investigated, because every figure is
  inside its target. An earlier run of the same scenario the same night gave p95 23 ms
  and p99 63 ms; this one gave 10.9 and 47. Other work was happening on the machine
  during both. Treat p95 as "about 10 to 25 ms" on this hardware.
- **Requests waited for a database connection only while the harness was setting up**
  (300 accounts created and signed in at once) and, in one restart run, in the instant
  all 300 clients came back. In the other four scenarios none waited while messages were
  being measured.
- **300 is where it was tested, not where it breaks.** No scenario was pushed until it
  failed, so the ceiling is unknown.

## Checks in the running app, 2026-10-12

Done in the real desktop app (`tauri dev`, Windows 11) against the local API and
PostgreSQL, signed in as one account, with a second and third account acting through the
API. Clicks were sent as synthetic events at first and, once that turned out to hide a
defect (below), as real mouse and keyboard input.

| Checked | Seen |
|---|---|
| Send, receive, formatting, links, code blocks | Messages appear at once; bold, italic, struck, inline code, fenced code and a written-out address render; punctuation after an address is not part of the link. |
| Persian, mixed direction, emoji | Persian lines run right to left with ZWNJ joining correctly; mixed lines keep their order; Persian digits render; one to three emoji alone are drawn larger. |
| Edit and delete arriving from the other person | The message changes in place and shows "edited"; a deleted one becomes "Message deleted". |
| Edit, reply, delete for everyone, remove for me, from the app | Each works, with a confirmation before the two removals. The other account's history shows the edit and the deletion, and still shows the message removed for one side only. |
| Read ticks and the setting | One tick when sent, two when the other person has read. With "Show when you've read messages" off, the other account is told nothing; back on, it is. |
| Typing | "… is typing…" appears and goes. |
| Unread | A count on the conversation's row and in the Messages list; a dot on a collapsed tree row and on the rail; "99+" past 99. Opening the conversation clears it and shows a "New messages" line. |
| Taskbar dot | The two Tauri calls that set and clear the overlay icon succeed. **The taskbar itself was not looked at.** |
| Groups | Create with one friend, add another, both post. The added person's history starts at "added", without the two earlier messages. Removing a member: the group disappears from their list and their next send gets 404. |
| A direct message after the friendship ended | The message box is replaced by "You and … are not friends at the moment. What was said stays here, but new messages can't be sent." Seen on a conversation with no messages in it; that history stays readable is covered by the API test. |
| Text nests and categories | Created from the lobby menu; nests moved into categories by dragging and by keyboard (Space, arrows, Space); the saved order is what another member's client is given. |
| Server stopped mid-conversation | The header says "Reconnecting…"; two messages written meanwhile show "Sending…". After the API was started again both were stored once, in the order written. |
| 20,000 messages in one conversation | Opens at the newest. Scrolling back to the first message took 83 s of scripted paging (400 pages of 50) with no task over 50 ms. Heap after garbage collection: 20.7 MB at the top, 18.5 MB in another conversation afterwards. The page held about 700 to 940 elements throughout. |
| Scrolling a long conversation with the mouse wheel | Measured with `.claude/skills/raven-ui/scripts/scrollprobe.ts`, which sends real wheel input and compares where every row is from one painted frame to the next. Upward at three speeds (a wheel, a touchpad's small steps, and fast enough to outrun loading), across more than 40 page loads and past the point where the loaded window lets go of its far end; downward through pages fetched again; in a room opened at its first unread message; and to the very beginning of a conversation. No frame moved the wrong way in any of them. |
| Leaving a conversation while far back in it, and returning | It opens at the newest messages. Reaching the end of a window further back no longer drags the view on to the newest by itself. |
| Selecting and copying | Dragging across a message selects its text and copying yields it; "Copy text" in the message menu works. |
| Window sizes | 980×700, 1280×820 and 1920×1080: nothing clipped; the reading column stays centred and does not stretch. |
| Both vocabularies | "New text nest", "Arrange nests" with Tree and Nest; "New text room", "Arrange rooms" with Space and Room. |
| Console | No errors from the app. Only the browser's own network errors from the moment the API was stopped on purpose. |

Two defects were found this way and fixed:

1. **A dialog opened from a `…` menu left the whole window unclickable after it closed,**
   and typing went to the menu button instead of the dialog's field. Two copies of Radix's
   layer and focus code were installed (an older `react-dropdown-menu` beside a newer
   `react-dialog`), each keeping its own record of the page's state. It affected dialogs
   that existed before chat as well ("Add a person"). Fixed by updating
   `@radix-ui/react-dropdown-menu` so one copy is installed, and by making `Dialog` start
   in its first field.
2. The empty message box showed a scrollbar. Fixed in `Composer.tsx`.

A third was reported by Soroush after trying the 20,000-message room, and the first
round of checks had missed it because it scrolled by setting the position instead of
turning the wheel:

3. **Scrolling up through a long conversation, the page slipped back down by 68 pixels
   each time an earlier page of 50 arrived.** The oldest loaded message was drawn as if
   it began the conversation, with a day heading and the sender's name. When the page
   before it arrived it lost both, became 68 pixels shorter, and everything under it
   moved up. Fixed by not drawing the oldest loaded message until the one before it is
   known, so that no row's look depends on what happens to be loaded
   (`lib/chat/rows.ts`, with tests). Changed alongside it: row heights are applied in
   the frame they are measured instead of a frame later (the measurements suggested a
   taller row could sit 20 to 48 pixels out of place for one frame; that was not
   confirmed on screen); the "Loading earlier messages…" line no longer takes and gives
   back space; the next page is requested 25 rows before the edge instead of at it; and
   a conversation reopened after being left far back no longer walks forward page by
   page to the newest.

## Not verified

- **Latency through the production path** (ArvanCloud and nginx). Needs a deploy.
- **A second real desktop client.** The other accounts acted through the API. Two windows
  of the app side by side were not tried.
- **Linux.** Everything above was on Windows. The taskbar dot is Windows-only by design.
- **The taskbar dot's appearance.**
- **The race detector**, as noted above.
- **The backup script on the homelab**, and a restore there. A restore was drilled on the
  development machine; see [chat-operations.md](chat-operations.md).
- **Load beyond 300 clients**, and runs longer than five minutes.
