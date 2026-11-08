# 04 User page: actions follow the relationship

Read first: `README.md` here; `views/UserPageView.tsx` (whole), `useProfileKnock.ts`,
`knockReplies.ts` (`knockerView`: states and labels), `people.ts` (`friendStanding`,
`personNestAction`), `usePendingActions.ts`, `views/dialogs.tsx` (`AddTreeMemberDialog`),
`lib/permissions.ts` (`treeCan`), `components/ui/dropdown-menu.tsx`.

## Goal

The one big button is the right next step for this person, there is never more than one
primary, and a disabled action says why next to it.

## Primary action table (implement as a pure function `profileActions(...)` in a `.ts` file with a unit test per row)

| State | Primary | Secondary |
|---|---|---|
| Self | Edit your profile | Saved messages (if chat) |
| In a nest you can see | Go to {nest} | Knock |
| Friend, knock available | Knock | Message (if chat) |
| Friend, knock held (`profileKnock.disabled`) | Message (if chat) | the held Knock, disabled |
| Not a friend, shares a tree | Add friend | Knock |
| Not a friend, no shared tree | Add friend | none |
| They asked you | Accept | Decline (ghost) |
| You asked them | none; row "Request sent" with Cancel | none |

When a friend request is incoming, the page shows no Knock or Message (answer first).
"Add friend" uses `data.sendFriendRequest`; Accept and Decline use the existing handlers
with the shared `"friend"` pending key. All primaries are `size="lg"`; the incoming banner
is removed and its content becomes the heading of this state: "{name} asked to be your
friend." above the two buttons (verbatim, `<bdi>` around the name).

## Other changes

1. **The held Knock explains itself.** When Knock is disabled, its `profileKnock.description`
   shows in the first line below the buttons at `text-small text-muted-foreground`, not
   `text-caption text-subtle`. When it is enabled, keep the short caption.
2. **Friend row and overflow.** Remove the one-row `GroupedList` for friend status. A
   friend gets a small "Friends" label next to the presence line in the header meta.
   "Remove friend" moves into a `…` icon button (aria-label "More for {name}") at the
   right of the action row; it opens the existing `ConfirmDialog`. "Request sent" for an
   outgoing request stays a row (it has a Cancel).
3. **Add to a tree.** In the same `…` menu: "Add to a {tree}…" for each tree the viewer can
   `treeCan(details, "members.manage")` in and the person is not already a member of
   (details come from `data.getTreeDetails`; skip trees whose details are not loaded). It
   calls `data.addTreeMember(treeId, person.username)` and toasts "Added to {tree}".
   Hide the item when `person.username` is empty. Failures: swallow, the shell toasts.
4. **Shared trees show life.** Each row gets a `LiveDot` and "{n} in a {nest}" when
   `data.activeNests` has live nests of that tree. Colour stays graphite apart from the dot.
5. **"Why you can see them"** (`visibleBecause`) moves from `text-subtle` to
   `text-muted-foreground` and sits directly under the shared trees list.
6. **Self page.** Under the buttons, one row "Your status" showing the current presence
   label and a ghost "Change" button that opens the same control the dock uses. Read
   `DeviceDock.tsx`/`TopBar.tsx` for it; if there is no reusable control, skip this item
   and note it in the commit message rather than building a second presence picker.

## Done when

Each row of the table renders exactly one primary. A held knock states its reason at normal
text size. Remove friend sits in the menu. `bun test` covers `profileActions`.
