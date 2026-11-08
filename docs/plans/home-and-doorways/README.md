# Home and doorways: navigation and flow refinement

Users get lost between Home, a tree's lobby, a nest's threshold and a person's page. Home
is empty most of the time, joining takes three steps, and several pages end in a dead end.
This is a UX pass; the visual language ("Quiet signal") does not change.

Executor: Sonnet, one fresh session per plan. Evaluator: Opus. Load the `raven-ui` skill
(and `references/writing.md`) before any markup. **Copy marked "verbatim" is part of the
spec.** If a sentence is untrue for the code, stop and flag it; do not reword it.
Order: 01 → 02 → 03 → 04. 02, 03 and 04 are independent of each other after 01.

## Decisions (settled with Soroush, 2026-11-08)

1. **Home becomes "your places"**, not "who is reachable". It lists the person's trees, so
   it is never blank once they belong somewhere. Live, pending and unread still lead.
2. **Last visited is remembered on this device only** (`localStorage`, per account). No
   server change.
3. **No default rooms when a tree is created.** A new tree shows a setup card instead.
4. **No pre-join mic test.** It would open a device outside a call (raven-ui rule 4) and
   needs a Rust change. Parked.
5. **The threshold stays a page**, not a sheet, so it keeps history and deep links.
6. **One target per card.** A live-nest card opens the threshold; its Join button is the
   same destination, so the card is a single click target.

## What the critique found (so each plan can be checked against it)

- Home repeats the sidebar's "Reaching you" and live nests, so it is empty exactly when
  the sidebar is. The empty state says "Open one of your trees" without listing them.
- `LiveNestCard` has two targets (card, "Join…") that both go to `{kind:"nest"}`.
- Dead ends: closed nest, empty nest, quiet Home, a disabled Knock whose reason is 12px
  `text-subtle` below the button.
- Creation is hidden in a `…` menu under a primary that says only "New nest".
- Consent copy ("People inside get a few seconds' notice", "You can see X because…") is the
  lowest-contrast text on the page.
- Lobby: live nests leave their category (arrangement is wrong while a room is live);
  members drop below all rooms under a 1100px viewport (`min-[1100px]` is a viewport
  query); "Add a person" is gated on `rooms.manage` though `canManageMembers` exists.
- Threshold: "Who sees you here" is styled as a fourth setting with no control; the
  countdown swaps the button for a non-button; "always join muted" removes the switch.
- User page: Knock is primary whatever the relationship; two primaries compete when a
  friend request arrives; Remove friend is a small ghost button inside a row.

## Boundaries

Presentation and client navigation only. No new server endpoints. Wire only handlers that
already exist on `RavenShellData` (`knockUser`, `addTreeMember`, `sendFriendRequest`,
`acceptFriendRequest`, …). `AudioMixerPanel.tsx`, `DeviceDock.tsx` and `RavenShellV1.tsx`
effects stay as they are, except the one hook in 01 that records last visited.

## Checking

Per plan: `bun run build`, `bun test`, `bun .claude/skills/raven-ui/scripts/sweep.ts`
("Clean"). After the last plan, drive the real app once (see `raven-ui` →
`references/verifying.md`) at 980×700 and 1280×820 and report what was seen and what
could not be (anything needing a second person).
