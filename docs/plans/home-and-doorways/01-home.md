# 01 Home: your places

Read first: `README.md` here; `apps/desktop/src/shells/ravenv1/views/HomeView.tsx`,
`views/shared.tsx` (`LiveNestCard`), `views/index.tsx` (how `HomeView` gets its props),
`atoms.tsx` (`EmptyState`, `GroupedList`, `SectionLabel`, `PersonAvatar`, `LiveDot`,
`UnreadDot`), `useChat.ts` (`useChatState`, `useTreeChatSummaries`), `lib/chat/types.ts`
(`ConversationSummary`), `Sidebar.tsx` lines 243-330 (how live nests and unread are
derived per tree: reuse, don't recompute differently), `RavenShellV1.tsx` (`navigate`).

## Goal

Home is never a dead end. It answers "what is alive, what is waiting for me, where can I
go", in that order, and each section appears only when it has something.

## Sections, top to bottom

1. **Pick up** (only if the last visited place still exists and is not where you are):
   one row. Nest: "Back to Lounge" with the tree name and who is inside now. Tree: the
   tree name. Opens that view. Never joins.
2. **Reaching you**: unchanged (`PendingList`).
3. **Live now**: unchanged cards.
4. **Unread**: conversations (direct messages and groups, not archived, not `nest`/`saved`
   kinds) with `unreadCount > 0`, newest first, at most 5. Row: avatar, name, unread
   count. Opens the chat. Needs a `chat` prop on `HomeView`: pass it from `views/index.tsx`
   the way other views get it; hide the section when `chat` is null.
5. **Your {trees}** (`data.trees`): one `GroupedList` row per tree: avatar, name, then a
   short state line, then cues. Order: has live nests, then has unread text nests, then
   last visited, then name. State line: "2 in a nest" (people inside, from
   `data.activeNests` filtered by `treeId`), else nothing. Cues: `LiveDot` if live,
   `UnreadDot` if unread. Do **not** show member counts: `Tree` has none and
   `data.getTreeDetails` is only loaded for opened trees.
   A "New {tree}" icon button sits in the section label's `action` when the user can
   create spaces (reuse the sidebar's `NameDialog` flow already in this file).
6. **Open to talk**, **Friend requests you sent**: unchanged, last.

If sections 1-4 and 6 are empty but trees exist, Home is just the trees list plus one
line under the label: "Nobody is in a {nest} right now." (verbatim, nouns from
`data.labels`).

## First run (no trees at all)

Replace the current `EmptyState` with three doors in one `GroupedList`:

- "Start a {tree}" (if `createSpaces`): "A private home for people you trust." → `NameDialog`.
- "Find a public {tree}": → `focusGlobalSearch`.
- "Ask a friend to add you": value `Your username is @{username}`, control: a secondary
  "Copy" button that copies `@username` and shows a toast "Copied". Verbatim. Hide if
  `data.user` has no username.

## Last visited (new, small)

`ravenv1/lastVisited.ts` (pure, no React): `readLastVisited(userId)` and
`writeLastVisited(userId, place)`, key `raven.lastVisited.<userId>`, value
`{kind:"nest"|"tree", id}`, every access in try/catch (storage can throw), unknown shape
returns null. `lastVisited.test.ts` covers round trip, bad JSON, throwing storage (use the
`localStorage` stand-in pattern from `mediaSettings.test.ts`). Record it from
`RavenShellV1.tsx` in one `useEffect` on `view` for `nest` and `tree` views only. Edit
the test file when no call is active (Vite reloads on test edits).

## Also

- `LiveNestCard` (`views/shared.tsx`): the card and its "Join…" button open the same
  threshold, so drop the separate `onJoin` prop and wire the button to `onOpen`. Keep it
  a real `Button` (keyboard reachable). Update both callers (Home, TreeLobbyView).
- Sidebar server row: give it `aria-label="Home, {serverName}"` and a Tooltip "Home", to
  match the collapsed rail's "Home" label. No new icon.

## Done when

Home with trees and nothing live shows the trees list, not an empty state. First-run shows
three doors. Clicking a live card or its Join goes to the same place with one handler.
Unread section hidden without chat. `bun test` includes `lastVisited.test.ts`.
