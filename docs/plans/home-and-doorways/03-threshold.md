# 03 Nest threshold

Read first: `README.md` here; `views/NestView.tsx` (`NestThreshold`, from line 126),
`views/shared.tsx` (`DoorwayPage`, `DoorwayHeader`, `DoorwayRow`), `useNestEntry.ts`
(`entry.enter`, `pending`, `cancel`, `requestedNestId`), `useProfileKnock.ts`, `people.ts`
(`reachRank`, `personStatus`), `components/ui/switch.tsx`, `lib/pushToTalk.ts`.
Raven-ui rules 4 and 5 apply: every join still goes through `entry.enter`; the mic and
camera switches show the choice, `*Status === "live"` is what the engine confirmed.

## Goal

Understand in one glance what joining will do, join in one click, and never reach a dead
end.

## Changes

1. **Three chips and one sentence replace the four rows.** A row of toggle chips
   (Microphone, Camera, and Screen when sharing): icon plus short word ("Mic", "Camera",
   "Screen"), pressed state shows the choice (`aria-pressed`), slashed icon when off, no
   hue (graphite). Under it one `text-small text-muted-foreground` summary, built by a
   pure function `joinSummary({...})` in a `.ts` file with a unit test. Shapes (verbatim):
   - "You'll join muted with your camera off."
   - "People will hear you and see you."
   - "People will hear you while you hold {key}."
   Then, always, a second sentence for who sees you: "Members of {tree} will see you
   arrive." / "People invited or let in will see you arrive." Remove the "Who sees you
   here" `DoorwayRow`. `DoorwayRow` stays for other pages.
2. **"Always join muted" stays a switch, per join.** When `alwaysJoinMuted` is on, the
   mic chip is shown pressed-off and can be turned on for this join; the summary says
   "Your setting is to join muted." plus the Settings link. Do not change the preference.
   If toggling needs an engine call that does not exist outside a call, flag it instead
   of faking it (read `media.toggleMic`).
3. **The Join button never swaps.** Countdown renders inside the same button as a label,
   "Joining in {n}…", with a determinate fill (width transition over the countdown,
   not looping); Cancel stays beside it. Respect reduced motion (no fill, label only).
4. **Label with the name, and say when it moves you.** "Join {nest name}". When in another
   call: replace the caption with a `role="status"` note above the button, "You're in
   {other}. Joining here leaves it." (verbatim) and the button reads "Move here".
5. **Notice text** ("People inside get a few seconds' notice before you enter.", "People
   inside have been told you are coming.") moves from `text-subtle` to
   `text-muted-foreground`. Consent copy is not a caption.
6. **Empty room: ask someone.** When nobody is inside and the nest belongs to a tree,
   list up to 3 tree members who are `open` (use `data.getTreeDetails(nest.treeId)` and
   `reachRank`), each a row with avatar, name, and a small secondary Knock button wired
   through `useProfileKnock` (extract a `KnockButton` if one is needed; `HomeView`'s
   `ReachableRow` already does the same). Label the group "Ask someone to join".
   If nobody is open: "Nobody is reachable right now. They'll see it come alive when you
   join." (verbatim). Hide the group when tree details are not loaded.
7. **Closed nest.** Replace the bare line with the line "This {nest} has closed." and two
   buttons: "Back to {tree}" (if tree) and, when the user can manage the tree, "Start a
   new {nest}" (reuse the lobby's create path: navigate to the tree; do not duplicate the
   dialog here). A temporary nest keeps only "Back".
8. **"Not now" becomes "Back"** and calls `onBack`.
9. **Keyboard.** The Join button takes initial focus on mount so Enter joins. Check it
   does not steal focus from an open dialog or the search field when the view is entered
   via the search results.

## Layout

Keep `DoorwayPage` (420px column) but stop vertical shifting: reserve space for the
error and status blocks (min-height) or anchor the column to the top third rather than
`m-auto` for this page only. Prefer the min-height; do not change `DoorwayPage` for the
user page.

## Done when

One summary sentence replaces the rows, joining shows no layout jump, an empty room
offers people to ask, a closed room offers a way back, `bun test` covers `joinSummary`.
