# Plan 01 — Answers to a knock

**Written:** 2026-11-01, after Raven 0.1.7. Revised the same day for wording.
**Executor:** Sonnet 5.5, high effort.
**Source:** `docs/ideas/human-features.md` §1 "Answers to a knock".

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`: Go API in `services/api`, desktop app in
`apps/desktop`). A **profile knock** is how one person reaches another. It is sent from a
person's page, chat header or Home row (`useProfileKnock`), shows in the "Reaching you"
list (`PendingList` in `Inbox.tsx`), and can reach the in-call overlay card and a Windows
notification. Today the person knocked on can only **Open** (go to the knocker's page) or
**Dismiss**; the knocker sees "Knock sent", then "Your knock was dismissed" or "expired".

This plan gives the person knocked on four kind, one-tap answers, and makes ignoring
truly silent. The manifesto asks that "Can we talk now?" be easy to answer with "yes, no,
later, or only under this condition", that declining not feel rude, and that ignoring be
acceptable.

## Decisions (Soroush, 2026-11-01; do not revisit)

1. **Four answers** on a pending profile knock: **Coming now**, **Coming in 10 min**,
   **Ask me later…**, **Not today**. They are answers, not a gate. Nest knocks (the ~3 s
   heads-up with no approval) are untouched: answers apply only to knocks on a person.
2. **Every answer says exactly what happens.** Before choosing, the answerer can read what
   the knocker will be told and when they may knock again, as a real clock time. After
   reading, no question is left. No vague words ("this evening", "soon", "later") ever
   stand without a time. See *Wording* below; it is the contract for every label.
3. **Ask me later: the answerer picks an exact time.** The menu lists real clock times
   (In 30 min · 15:02, In 1 hour · 15:32, In 2 hours · 16:32, In 4 hours · 18:32) and
   *Pick a time…* for any time in the next 24 hours. Only the knocker is reminded, once,
   at that time. The knocker cannot knock before it. Raven never re-knocks by itself.
4. **Dismiss becomes silent.** It clears the knock for the answerer only. The knocker
   keeps seeing "No answer yet" until the knock expires, exactly as if nothing was
   pressed. "Not today" is the way to say no on purpose. The knocker never sees
   "Ignored" or "Dismissed".
5. **The knocker learns of an answer** on their knock button (person page, chat header,
   Home row) and as a line in the same "Reaching you" list. Also as an OS notification
   and an overlay line, **only if** their existing Knocks notification switch / overlay
   "Show knocks" switch is on. No new switches.
6. **The answerer can answer from** the inbox and Home, the sidebar's compact row, and
   the in-call overlay card. Not from the Windows toast.

### Behaviour table (executor: use as written)

| Answer | Server `reply` | Server status | `reply_until` | Knocker can knock again |
|---|---|---|---|---|
| Coming now | `coming` | `accepted` | now + 5 min (how long it shows) | at `reply_until` |
| Coming in 10 min | `soon` | `accepted` | now + 10 min | at `reply_until` |
| Ask me later… | `later` | `declined` | the exact time picked (client sends it) | at `reply_until`, with one reminder |
| Not today | `not_today` | `declined` | answerer's next local 04:00 that is ≥ 6 h away (client sends it) | at `reply_until` |
| Dismiss quietly | — | `dismissed` | — | as if pending: after `expires_at` + the 60 s cooldown |

Each instant is shown to each person in **their own** clock. The preset chosen is never
sent; only the instant is. A Later reminder stays for 1 h after `reply_until`, then drops.

### Wording (the contract)

`{name}` is the other person's display name. `{t}` is a time from `formatWhen` (step 6):
"15:32" today, "04:00 tomorrow", "10:00 Wednesday" beyond tomorrow. Never "this
evening", "soon", "in a bit" or a bare "later".

**The answerer's choices.** Each item in the answer menu has a label and, under it, a hint
line in `text-caption text-muted-foreground`. The hint is visible in the menu itself,
not only in a tooltip.

| Label | Hint (what happens) | Toast after choosing |
|---|---|---|
| Coming now | {name} sees that you're on your way. | Told {name} you're coming. |
| Coming in 10 min | {name} sees you'll come at {t}. They can knock again then. | Told {name} you'll come at {t}. |
| Ask me later… | Pick a time. {name} can't knock before it, and Raven reminds them then. | Raven will remind {name} at {t}. |
| Not today | {name} sees you can't today. They can knock again from {t}. | Told {name} not today. |
| Dismiss quietly | Clears it for you. {name} isn't told and sees "No answer yet" until {t}. | (none; the line just goes) |

The *Ask me later…* submenu opens with one heading line, "{name} can knock again at:",
then the times as "In 30 min · {t}", "In 1 hour · {t}", "In 2 hours · {t}",
"In 4 hours · {t}", and "Pick a time…" (a time field; a time earlier than now means
tomorrow, and the field shows the resulting `{t}` live before confirming with
"Ask at {t}"). Times more than 24 h away cannot be picked.

**What the knocker sees.**

| State | Button label | Button description / line in "Reaching you" |
|---|---|---|
| Pending, or dismissed | Knock sent | No answer yet. The knock ends quietly at {t}. |
| Coming now | On the way | {name} is coming now. |
| Coming in 10 min | Coming at {t} | {name} will come at {t}. You can knock again then. |
| Ask me later | Knock at {t} | {name} asked you to knock again at {t}. Raven will remind you then. |
| Later, reminder due | Knock | {name} asked you to knock again now. |
| Not today | Not today | {name} can't today. You can knock again from {t}. |
| Expired (cooldown) | Knock in Ns | Your knock ended without an answer. You can knock again in N s. |

OS notification (Knocks switch on): title `{name}`, body = the line from this table.

**The overlay** has no room for hints, so its labels carry the time themselves:
"Coming now", "Coming at {t}", "Ask again at {t}" (one hour), "Not today". Each has a
`title`/aria-label with the full hint sentence.

## Power Review (manifesto §26)

- **Power created:** the answerer can shape when they are asked again (Not today, Ask me
  later); the knocker gets closure. The answerer gains a private way to ignore.
- **Who is subject:** the knocker, who is told less than before (no "dismissed").
- **Visible / limited / reversible:** every answer is shown to the knocker in plain words
  with an exact time; every lock ends on its own (≤ 36 h, server-enforced).
- **Surveillance:** no new history, counts or "seen". Dismiss is now *less* observable:
  the server masks it from the knocker in every response and pushes no live event to the
  knocker for it. Answers live on the existing knock row only.
- **Social pressure:** the reminder goes to the knocker, never the answerer; Raven never
  re-knocks. Silence still reads "No answer yet". Safest default: no answer needed, ever.

## Before you start

- Load the `raven-ui` skill and read its `references/surfaces.md`, `references/writing.md`
  (including "Answers that affect someone else") and `references/verifying.md`.
- Read `docs/manifesto/raven_design_philosophy_manifesto.md` §9 (Knock and Join).
- If you are in a git worktree, `.claude/skills` and `.env` are gitignored and missing
  there: copy both from `C:\Users\Soroush Taheri\code\raven`, run `bun install` in
  `apps/desktop`, and set `RAVEN_REPO` to your worktree for the skill's scripts.
- `CARGO_TARGET_DIR` is `%USERPROFILE%\rv`, shared by every checkout. Only one Raven dev
  app can run at a time; if one is running, ask the user rather than stopping it.

## Files to read (narrowly: grep the symbol, read the range)

API (`services/api/internal`):
- `http/profile_knocks.go` — whole file (137 lines): `ProfileKnockState`,
  `profileKnockState`, `outgoingProfileKnocks`, `createProfileKnock`.
- `http/domain.go` — `type Knock struct` (~l. 53), `createKnock`/`resolveKnock`
  (~l. 1077–1196), `knocksForUser` (~l. 1644), `expireStaleKnocks`, `canResolveKnock`,
  `knockSelectSQL`, `scanKnocks` (~l. 1847–1910), `publishFriendUpdate` (~l. 715, the
  `events.publishTo` pattern).
- `http/server.go` ~l. 318 — knock routes.
- `http/profile_knocks_test.go` — test helpers to reuse.
- `database/update_migrations.go` — the versioned migration list; `database/chat_seen_migrations.go`
  as a small example of a statements function.

Desktop (`apps/desktop/src`):
- `lib/api.ts` — `Knock`, `KnockStatus`, `ProfileKnockState` (~l. 371), the knock methods (~l. 1025–1045).
- `shells/ravenv1/profileKnock.ts`, `useProfileKnock.ts`, `profileKnock.test.ts`.
- `shells/ravenv1/state.ts` — `PendingItem` (~l. 88), the shell data interface (~l. 168).
- `shells/ravenv1/useRavenShellData.ts` — knock notifications (~l. 70–90), `knockUser` /
  `dismissKnock` (~l. 545–585), `derivePending` (~l. 877).
- `shells/ravenv1/Inbox.tsx` — `pendingSummary`, `pendingTarget`, `PendingList`.
- `lib/notifications.ts` — `newProfileKnocks`, `SeenKnocks`, `notifyKnock`.
- `lib/voiceOverlay.ts` (~l. 60–80), `lib/voiceOverlayHeadsUp.ts`,
  `shells/ravenv1/useVoiceOverlayHeadsUp.ts`, `components/VoiceOverlayWindow.tsx`
  (the knock line, ~l. 430–460), `shells/ravenv1/DeviceDock.tsx` (~l. 210–235).
- `src-tauri/src/overlay.rs` — the `Knock` action variant (~l. 455) and its parse test (~l. 2084).
- `components/ui/dropdown-menu.tsx`, `components/ui/toast.tsx`.
- Grep `apps/desktop/src` for an existing time formatter (`formatTime`, `toLocaleTimeString`,
  `Intl.DateTimeFormat`) and reuse it inside `formatWhen` so times match the rest of the app.

## Steps

### 1. Schema

New file `database/knock_reply_migrations.go` with `knockReplyStatements()` and a new
entry `{version: "2026110101_knock_replies", statements: knockReplyStatements()}` at the
end of the list in `update_migrations.go` (never edit an existing entry):

```sql
ALTER TABLE knocks ADD COLUMN reply TEXT CHECK (reply IN ('coming', 'soon', 'not_today', 'later'))
ALTER TABLE knocks ADD COLUMN reply_until TEXT
```

Both nullable; old rows stay valid on SQLite and Postgres. The `status` CHECK is not
changed: answers reuse `accepted` / `declined` (see the behaviour table).

### 2. API: carry the answer

- `Knock` gains `Reply *string json:"reply,omitempty"` and `ReplyUntil *string
  json:"replyUntil,omitempty"`; add `k.reply, k.reply_until` to `knockSelectSQL` and
  `scanKnocks`.
- `ProfileKnockState` gains `KnockID string json:"knockId"`, `Reply string
  json:"reply,omitempty"`, `ReplyUntil string json:"replyUntil,omitempty"`. `State`
  becomes one of `pending`, `cooldown`, `replied`, `reminder`.

### 3. API: the answer endpoint

`POST /v1/knocks/:id/reply`, body `{"reply": "coming"|"soon"|"not_today"|"later",
"until"?: RFC 3339}`. Route next to accept/decline/dismiss in `server.go`; it sits behind
the same client-version gate as the other knock routes.

- Fold it into `resolveKnock` rather than a second update path: change the signature to
  `resolveKnock(c, status string, reply string, until time.Time)` (zero values for
  accept/decline/dismiss) and have the existing UPDATE also set `reply` and `reply_until`
  (NULL when empty). Keep the `AND status = 'pending'` guard and the 409.
- Validation (trust boundary, return 400 with a plain message):
  - unknown `reply`;
  - the knock is a nest knock (`NestID != nil`) or has no `ToUserID` — answers are only
    for knocks on a person; `canResolveKnock` then requires `ToUserID == actor`;
  - `later`: `until` missing, unparsable, earlier than now + 15 min, or more than 24 h
    away;
  - `not_today`: `until` missing, unparsable, earlier than now + 6 h, or more than 36 h
    away;
  - `coming` / `soon` ignore any `until` and use now + 5 / 10 min.
- Map to status per the table. Return `{"knock": ...}` like the other resolve routes.

### 4. API: what the knocker is told

Rewrite `profileKnockState(knock, now)` around one rule: the knocker's view never
depends on whether the answerer dismissed.

- `pending`, or `dismissed`, while `now < expires_at` → `State: "pending"`,
  `RetryAt = expires_at + 60 s`.
- `pending` / `expired` / `dismissed` after `expires_at` → `State: "cooldown"`,
  `Outcome: "expired"`, `RetryAt = expires_at + 60 s` (drop when passed, as today).
  The cooldown for these starts at `expires_at`, never at `resolved_at`, so dismiss
  timing cannot leak.
- `Reply != nil`: while `now < reply_until` → `State: "replied"`, `RetryAt =
  reply_until`. For `later` only, from `reply_until` until `reply_until + 1 h` →
  `State: "reminder"`, `RetryAt = reply_until` (knocking is allowed). Otherwise drop.
- `accepted` / `declined` with no reply (old clients) → keep today's behaviour
  (accepted drops; declined → 60 s cooldown from `resolved_at`).
- `Outcome` is never `"dismissed"`; set it to `expired` or the status as above.

Replace the two copies of the window SQL in `outgoingProfileKnocks` and
`createProfileKnock` with one shared fragment that also keeps rows where
`k.status = 'dismissed' AND k.expires_at > cutoff` and where
`k.reply_until > now - 1 h`. `createProfileKnock` then refuses while the state is
`pending` (409, as today), `replied` (429 `knock_cooldown`, `Retry-After` to
`reply_until`), and allows a new knock in `reminder` (that is the point of the reminder).
Keep `profileKnockStates`' de-duplication; rank `pending` > `replied` > `reminder` >
`cooldown`.

Mask the history too: in `listKnocks` (`GET /v1/knocks`), for each knock whose
`FromUserID` is the viewer and whose status is `dismissed`, return status `pending`
(before `expires_at`) or `expired` (after), with `ResolvedAt` and `ResolvedByUserID`
cleared. One small helper, `knockSeenBy(knock, viewerID, now)`.

### 5. API: live events reach the right people

Profile knocks stop broadcasting to everyone:
- create, and any answer → `s.events.publishTo(LiveUpdate{...}, []string{from, to})`
  with types `knock.created` / `knock.replied`;
- dismiss of a profile knock → publish **only to the answerer** (`knock.dismissed`), so
  the knocker's client gets no signal at that moment;
- nest knocks keep the current `s.events.publish`.

Check the desktop's live-update handler still refetches home on `knock.replied` (grep
`"knock.` in `apps/desktop/src`); add it if the handler matches by name.

Update the "Profile Knocks" section of `docs/api.md`: the answer route, the new state
values and fields, silent dismiss, and the behaviour table.

### 6. Desktop: pure logic (`shells/ravenv1/knockReplies.ts`, new)

- `type KnockReply = "coming" | "soon" | "not_today" | "later"`.
- `formatWhen(at: Date, now: Date): string` — "15:32" when the same local day,
  "04:00 tomorrow" the next day, "10:00 Wednesday" beyond (within 36 h this means at most
  the day after tomorrow). Uses the app's existing time format.
- `laterChoices(now: Date): { label: string; until: Date }[]` — 30 min, 1 h, 2 h, 4 h
  from now, labelled "In 30 min · {t}" etc. via `formatWhen`.
- `pickedTime(hhmm: string, now: Date): Date | null` — the next occurrence of that local
  time (tomorrow if earlier than now); `null` if it is under 15 min or over 24 h away.
- `notTodayUntil(now: Date): Date` — next local 04:00 at least 6 h away.
- `answerCopy(reply, name, until, now)` and `knockerCopy(state, name, now)` returning the
  exact strings of the *Wording* tables, so every surface (inbox, sidebar, overlay,
  notification, button) uses one source. Do not write those strings anywhere else.
- Tests in `knockReplies.test.ts`: `formatWhen` today / tomorrow / weekday across
  midnight; `laterChoices` at 23:00 labels the 1 h choice "00:00 tomorrow";
  `pickedTime` before and after now, and its 15 min / 24 h edges; `notTodayUntil` at
  02:00, 03:59, 10:00 and 23:00; one snapshot-style assertion per row of both wording
  tables.

### 7. Desktop: the knocker's view

- `lib/api.ts`: add `reply` / `replyUntil` to `Knock`, `knockId` / `reply` /
  `replyUntil` and the new `state` values to `ProfileKnockState`, and
  `replyToKnock(id, reply, until?)`.
- `profileKnockPresentation` (and its tests): label and description from `knockerCopy`,
  per the knocker table. Disabled until `retryAt` except in `reminder`. No mention of
  dismissal anywhere. `useProfileKnock`'s ticking timer already re-renders at `retryAt`.
- `useRavenShellData`: after each home load, schedule one `refresh()` at the earliest
  future `replyUntil` / `retryAt` among `home.profileKnocks` (clear on change/unmount;
  skip delays over 24 h) so `replied` flips to `reminder` without user action.
- `state.ts` + `derivePending`: a new `PendingItem` kind `"answer"` per
  `profileKnocks` entry in `replied` or `reminder` state: `{ id: knockId, kind:
  "answer", from, fromId: userId, reply, state, replyUntil }`. Names come from the
  people the shell already holds (find how other items resolve a display name; fall back
  to the username). Put answers after the incoming items.
- `Inbox.tsx`: `pendingSummary` for answers = the knocker-table line; `pendingTarget` →
  the person's page; the action is a single X "Clear" that hides the line on this device
  only (an in-memory `Set` of cleared knock ids in the shell data; the line also goes
  when the state leaves `profileKnocks`). A `reminder` line also has a `Knock` button
  (compact: an icon labelled "Knock on {name}") that calls `knockUser`. Use a distinct
  small badge icon from lucide (e.g. `MessageCircleReply` or `CornerDownLeft`), not the
  hand.
- Notifications: generalise `newProfileKnocks`' seen-set idea to answers — a second
  `SeenKnocks`-style set keyed by `${knockId}:${state}`, `null` on first load so old
  answers never replay. When the Knocks switch is on, notify once per new key with the
  knocker-table line. Reuse `notifyKnock`. Unit-test it next to the existing ones.

### 8. Desktop: the answerer's controls

- `useRavenShellData`: `replyToKnock(knockId, reply, until?)` alongside `dismissKnock`
  (same busy/error/refresh shape); expose it on the shell data interface. On success,
  show the toast from the answerer table.
- One shared `KnockAnswerMenu` component (a `dropdown-menu`) used by every surface below.
  Items in this order, each with its label and hint line from `answerCopy`: Coming now,
  Coming in 10 min, Ask me later… (submenu or second panel per `raven-ui`, with the
  heading line, the four times and Pick a time…), Not today, a separator, Dismiss
  quietly. The hint's `{t}` values are computed when the menu opens. Keyboard-reachable;
  Escape closes; the time field is labelled "Time to knock again".
- Full row (inbox page and Home, `compact = false`): a primary `Coming now` button (its
  tooltip is the hint) and a secondary `Answer…` button that opens `KnockAnswerMenu`.
  The existing `Open` button goes: the row itself already opens the person.
- Compact row (sidebar): replace the X with one icon button, aria-label
  "Answer {name}", opening `KnockAnswerMenu`.
- Only profile knocks (`!item.knock.nestId`) get answers; nest knock rows keep Open /
  Dismiss exactly as now.

### 9. Overlay

- Answerer: `lib/voiceOverlay.ts` action gains
  `{ kind: "knockReply"; knockId: string; reply: KnockReply; until?: string }`;
  `overlay.rs` gains the matching `KnockReply { knock_id, reply, until: Option<String> }`
  variant (camelCase serde, same as `Knock`) plus a parse test like the one at ~l. 2084.
  `VoiceOverlayWindow.tsx`: when interaction is on, a profile-knock line shows the four
  overlay labels from *Wording* ("Coming now", "Coming at {t}", "Ask again at {t}" with
  the one-hour choice, "Not today"), each with the full hint as `title` and aria-label,
  next to the existing open/dismiss. Compute `{t}` when the line renders and refresh it
  each minute. `DeviceDock.tsx`'s overlay action handler calls
  `dataRef.current.replyToKnock(...)` the same way it calls `dismissKnock`.
- Knocker: when "Show knocks" is on, answers become heads-up lines (the knocker-table
  line) via a new `answerCandidates` next to `knockCandidates` in
  `voiceOverlayHeadsUp.ts`, with their own id prefix (`answer:`). They behave like
  message lines (no server dismiss); opening one goes to the person's page. Read how
  message lines are dismissed and opened and follow that path; do not route them through
  `dismissKnock`.

### 10. Compatibility

No minimum-client-version bump. Old clients see `replied` / `reminder` as an unknown
state and fall back to their cooldown label until `retryAt` (acceptable); their Dismiss
simply becomes silent. Confirm by reading the 0.1.7 `profileKnockPresentation` (the
current file before your edit).

## Done when

- `go test ./...` in `services/api` passes, with new tests in `profile_knocks_test.go`:
  each answer's status, `reply_until` and the sender's state; validation 400s (bad reply,
  nest knock, `until` out of bounds for `later` and `not_today`) and 403 for a
  non-target; silent dismiss gives the sender `pending` then `expired` cooldown from
  `expires_at`; `GET /v1/knocks` masks dismiss for the sender only; `later` → `reminder`
  after `until` and gone after 1 h; sending is refused during `replied` and allowed
  during `reminder`.
- `bun test` (or the repo's test command for `apps/desktop`) passes, including
  `knockReplies.test.ts`, updated `profileKnock.test.ts` and the notifications test;
  `bun run typecheck` (or `tsc --noEmit`) is clean.
- `cargo test` for the overlay parse test passes.
- A wording check: grep the diff for "evening", "soon", "in a bit", "dismissed"; none
  may appear in user-facing strings.
- One live check at the end, with two local accounts (see the `raven-ui` verifying
  reference and memory `reference_raven_live_call_testing`): A knocks B; B opens the
  answer menu (screenshot it, hints visible), answers each option in turn from inbox,
  sidebar and (in a call) the overlay; A's button and line show the exact time and A's
  OS notification fires only with the switch on; B dismisses and A still sees "No answer
  yet". One screenshot of the menu and one of A's answer line.
- Commit on the current branch with a message describing the feature. Do not push or
  deploy; the API deploy is Soroush's call.

## Not in this plan

"Say why you're knocking", porch light, quiet hours, answers on nest knocks, actions on
the Windows toast, any history or counts of answers.
