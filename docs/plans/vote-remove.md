# Vote to remove from a call

## Context

Owners and moderators can remove someone from a whole space, and that also ends their call. Nobody can take a person out of one call without touching their membership, and server administrators have no power inside spaces, by design. This adds a collective decision for that gap, like the kick vote in Counter-Strike or Rainbow Six Siege.

It fits the manifesto: section 20 accepts "Kick and ban" and section 7.3 separates community governance from moderation. Section 7.5 requires the power to be visible, so the person being voted on sees the vote.

### Decisions (Soroush, 2026-11-04)

- **Threshold:** more than half of everyone eligible to vote. Not voting counts as no.
- **Consequence:** out of this call, and unable to come back to this room for a fixed 15 minutes. The time does not end early if the call empties.
- **Roles:** everyone is equal. Owners and moderators can be voted out, and their votes count the same.
- **Visibility:** the target sees the vote while it runs.

### Choices made in this plan

- **Who can start:** anyone connected to the call. It needs at least two eligible voters besides the target, so at least three people in the call.
- **Eligible voters:** everyone connected when the vote starts, except the target. The list is frozen, so people joining later cannot tip the result. Someone who leaves mid-vote stays on the list and their missing ballot counts as no.
- **The starter's ballot** is an automatic yes.
- **Window:** 30 seconds. Ballots are final. The vote ends early as soon as the result is certain.
- **Ballots are private.** Everyone sees who started the vote and the running tally, never who voted how. Ballots exist only in memory and are never logged.
- **Leaving does not dodge it.** If the target leaves or rejoins mid-vote, the vote continues, and if it passes the 15 minutes apply.
- **Limits:** one vote per call at a time. The same target cannot be voted on again for 5 minutes after any vote. Someone whose vote failed cannot start another in that room for 3 minutes.
- **Nobody can lift the 15 minutes.** A moderator overriding it would undo the point of a collective decision.
- **No record is kept** beyond the end time on the membership. Votes are not an audit event.

Not in this plan: votes in text rooms, removal from a space by vote, longer bans, configurable thresholds or times, a per-space off switch.

## Design

### Server (`services/api/internal`)

**Schema.** New `database/call_vote_migrations.go`, registered in `update_migrations.go` the way `callStateStatements` is:

```sql
ALTER TABLE nest_members ADD COLUMN removed_until TEXT;
```

Store it in the same format as `database.Now()`. The `ON CONFLICT ... DO UPDATE` clauses on `nest_members` in `tree_ops.go`, `domain.go` and `server.go` must not touch it, so leaving and rejoining a space does not clear it. Test this.

**Enforcement.** `requireNestEntry` (`http/policy.go`) refuses while `removed_until` is in the future. The media token, session join and presence join all go through it, so this one check covers them. The refusal is a `403` with the message "You were voted out of this call. You can come back in N minutes." Creating a knock on that room is refused the same way, so a removed person cannot keep ringing everyone.

**Vote state.** New `http/call_votes.go`. Votes are in memory on `Server`, keyed by nest id, behind one mutex, like `eventBroker`. A vote lasts seconds, so a restart that loses one is acceptable; `removed_until` is what survives.

The counting is a small struct with no clock or network, so it can be tested directly:

```go
type callVote struct {
	id, nestID, targetID, starterID string
	voters  map[string]bool // frozen eligible list
	ballots map[string]bool
	endsAt  time.Time
}
// needed = len(voters)/2 + 1
// passed once yes >= needed; failed once yes + unvoted < needed, or at endsAt
```

The two cooldown maps live beside it and are read lazily, with expired entries dropped on access. `time.AfterFunc` ends a vote at `endsAt`. The window is a field on the vote manager so tests can shorten it.

**Routes** in `http/server.go`:

- `POST /nests/:id/votes` with `{ targetUserId }`. Eligible voters come from `activeParticipants` of `activeSessionForNest`. Returns `403` if the caller is not connected, `409` with a message for an open vote, a cooldown, or too few people.
- `POST /nests/:id/votes/:voteId/ballot` with `{ yes }`. Only eligible voters, once each.
- `GET /nests/:id/votes/current`. For eligible voters and the target only, so a client that reconnects mid-vote can catch up.

**When a vote passes,** in this order: set `removed_until`, call `disconnectUserFromNest(nestID, userID, "disconnected", false)` so membership stays, then `kickFromCall`. Do not use `evictFromNest`, which also withdraws invitations.

**Events.** Add `Vote *CallVoteUpdate` to `LiveUpdate` (`http/events.go`) and send type `call.vote` with `publishTo` to the eligible voters and the target only, never `publishNest`, which reaches the whole space. Payload: `id, nestId, targetId, targetName, starterId, starterName, yes, needed, total, remainingMs, outcome` where `outcome` is `open`, `passed` or `failed`. Never ballots.

### Desktop UI (`apps/desktop/src`)

Read the `raven-ui` skill first.

- **`lib/api.ts`, `lib/eventStream.ts`:** the three calls and the `call.vote` event. Check how `apiEvents.test.ts` treats event types.
- **`shells/ravenv1/useRavenShellData.ts`:** hold the current vote, fetch `votes/current` on joining and when the stream reconnects, and pass it to the stage. When the viewer is the target and the outcome is `passed`, leave the call through the path already used when a person is removed from a space. Find it here first. The rejoin logic from the blank-window work must not retry after this `403`.
- **New `components/media/CallVotePill.tsx`,** rendered in `LiveMediaStage.tsx` in the same top-centre spot and with the same look as the share notice, moved down if both show. Tile changes must not re-render it needlessly.
  - Voter who has not voted: "Sara started a vote to remove Alex from this call", tally "2 of 3 needed", countdown, Yes and No buttons.
  - Voter who has voted: the same without buttons.
  - Target: "People are voting on removing you from this call. Sara started it." with the tally and countdown, no buttons.
  - Use `role="status"`, and announce the start only, not each tick.
- **Starting a vote:** a person menu on `VoiceRoom` and `VoiceStrip` people and on `MediaTile`, with "Vote to remove from call…", opening a confirm dialog that says what happens: "If more than half of the people here agree, Alex leaves this call and can't come back for 15 minutes." Hidden on yourself and with fewer than three people. `plans/server-mute.md` also adds stage controls per person: whichever is built first makes the menu and the other reuses it.
- **After it ends:** a short notice with the outcome. The target sees "You were voted out of this call. You can come back in 15 minutes."

### Docs

- `docs/permissions.md`: a section on votes, and a line in "Losing access takes effect at once".
- `.claude/skills/raven-ui/SKILL.md`, rule 9: a line naming this as an exception. It is on the stage because no single person holds the power, and it keeps the confirm.

## Compatibility

- **Old clients** must ignore the unknown `call.vote` event; confirm in `eventStream.ts`. They see no vote, so their ballot counts as no, which only makes passing harder. If voted out they are still disconnected by LiveKit, and rejoining shows the `403` message. No minimum version bump.
- **New client on an old API:** starting a vote gets a `404`; show "This server doesn't support votes yet."

## Known limits

- Eligibility uses the session records, which can briefly list someone whose app stopped reporting. They count as no until they drop off.
- In a small call a pair can remove a third person. That is the rule as decided.
- Someone in the room can rejoin from another account if they have one. Accounts are not this feature's concern.

## Verification

Go tests in new `http/call_votes_test.go`:

- Counting: thresholds for 2, 3, 4 and 5 voters, early pass, early fail, expiry.
- Routes: starter not connected, target not connected, too few people, second vote refused, both cooldowns, ineligible ballot, double ballot, late joiner cannot vote.
- A pass: target is out of the session, membership stays `joined`, token, session join, presence join and knock return `403`, and all work again after `removed_until`. Leaving and rejoining the space does not clear it. The target leaving mid-vote does not stop it.
- Events go only to voters and the target, and never contain ballots.

Then `bun test` for the pill states, and one live call at the end with three accounts following `reference_raven_live_call_testing`: start, vote, pass, rejoin refused, and a failed vote.
