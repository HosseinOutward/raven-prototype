# 02 Tree lobby

Read first: `README.md` here; `views/TreeLobbyView.tsx` (whole), `views/TreeNestsSection.tsx`
(`TreeNestsSection`, `VoiceNestRow`, `TextNestRow`, rows at the bottom), `views/shared.tsx`
(`ViewHeader`, `LiveNestCard`), `lib/permissions.ts` (`treeCan`), `atoms.tsx`
(`AvatarStack`, `LiveDot`, `EmptyState`, `GroupedList`), `views/dialogs.tsx`
(`NameDialog`, `AddTreeMemberDialog`). Plan 01 must be done (single-target card).

## Goal

The lobby shows what is alive in the group in the order its owners chose, makes creation
and inviting findable, and keeps members visible at every window size.

## Changes

1. **One "New" menu** replaces the "New nest" button and its hidden siblings.
   `DropdownMenu` in the header: "Voice {nest}", "Text {nest}" (only when `chat`),
   "Category" (only when `chat`). Button label "New", icon `Plus`. `Arrange {nests}` stays
   in the `…` menu with Add a person and settings.
2. **Fix the permission gate.** Header actions are computed per capability, not from
   `canManage` alone: "New" needs `rooms.manage`; "Add a person" needs `members.manage`
   (`canManageMembers`) and appears in the `…` menu for those users even without
   `rooms.manage`. A user with neither keeps only the settings icon. Add a unit test for
   the capability → items mapping (extract it as a pure function in a `.ts` file).
3. **Live rooms stay in place.** In `TreeNestsSection`, stop removing live voice nests
   from their category (`isLive` filter). A live `VoiceNestRow` grows in place: a second
   line with `AvatarStack` (max 4, size `sm`) and the names sentence, and a real "Join…"
   `Button` (size `xs`) at the end, same handler as the row (opens the threshold). Remove
   the "Live now" strip from `TreeLobbyView` and `LiveNestCard`'s use there. Keep the
   strip only when `chat` is null (no category list), as today's fallback renders rooms
   in a plain list.
4. **Members.** Under 1100px viewport, drop the column and put an `AvatarStack` of the
   members who are in a nest or open to talk, plus "{n} members", in the header subtitle
   as a button that opens a `Popover` containing the same `MemberRow` list. At 1100px and
   up keep the column. Group the column: "Here now" (in a nest), "Around" (open, around,
   focused), "Offline" (collapsed by default, count in the label). Drop the per-row
   `Tooltip` that repeats name and presence.
5. **Header subtitle**: "Private · 5 members" or "Public · 5 members", then
   " · 2 in {nests}" when anyone is inside a nest (verbatim shape; nouns from `labels`).
6. **New tree setup card.** When the tree has no nests of any kind and the user can manage,
   replace the generic `EmptyState` with a card of up to three rows (each a done/undone
   state with a button): "Invite people" (opens `AddTreeMemberDialog`, done when
   `members.length > 1`), "Add a voice {nest}" (opens the create dialog), "Add a text
   {nest}" (only with `chat`). Members who cannot manage keep the current empty text.
7. **Empty category copy**: "Nothing here yet. Use Arrange to move something in." stays,
   but only shown to managers; others do not see empty categories (already the case when
   `!canManage`, keep it).

## Not doing

Message previews on text rows: `ConversationSummary` may not carry the last message. Read
`lib/chat/types.ts`; add it only if the field exists, else leave for later.

## Done when

A user with `members.manage` only can add a person. A live room does not leave its
category. At 980×700 the members are reachable from the header. A fresh tree shows the
setup card. `bun test` passes the new permission test.
