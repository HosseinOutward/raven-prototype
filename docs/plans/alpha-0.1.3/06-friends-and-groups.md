# Plan 06 — "Friends and groups": one list instead of Messages + Friends, and text nests that follow the live rule

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`, desktop app in `apps/desktop`). Its sidebar is "the
live social map": who is reaching you, which nests are alive in each tree, which friends
are around.

Two items from the v0.1.3 closed alpha:

1. **Testers were confused by repeated, identical rows of the same person.** The sidebar
   has a **Messages** section (direct messages and groups, most recent first) directly
   above a **Friends** section (friends by reachability). A friend you've written to
   appears twice, in rows that look alike but do different things: one opens the chat,
   the other the profile.
2. **In each tree, only live voice nests are listed, but every text nest is.** Soroush
   decided to apply the "only what's alive" rule to text nests too.

Soroush's direction for item 1: fold everything into one **"Friends and groups"** section.
Tell 1:1 and group conversations apart with subtle UI. With a person's chat open, clicking
their name in the header opens their profile. The design below builds on that. It replaces
the separate Messages section he chose on 2026-10-11; his other chat decisions still
stand:

- read status for DMs only;
- unread shown as a neutral count on the row, a dot on tree rows, the rail and the taskbar;
- no sounds, no OS notifications for messages;
- DMs and group adds are friends only.

## Before you start

- Load `raven-ui` and read `references/design-system.md`, `references/surfaces.md`,
  `references/writing.md`, `references/verifying.md`.
- Read `docs/chat.md` for the chat model and invariants.
- If you are in a git worktree, `.claude/skills` and `.env` are gitignored, so they are
  missing there. Copy both from `C:\Users\Soroush Taheri\code\raven`, run `bun install` in
  `apps/desktop`, and set `RAVEN_REPO` to your worktree for the skill's scripts.
- Plan 01 (resizable sidebar) also edits `Sidebar.tsx` (the rail's toggle) and
  `RavenShellV1.tsx`. If it has landed, build on it.
- Only one Raven dev app can run at a time. Check before starting it, and if one is
  running, ask the user rather than stopping it.
- Don't commit, push or release unless the user asks.

## What is true now

- **Sidebar** (`shells/ravenv1/Sidebar.tsx`) contains, in order:
  - Reaching you;
  - `SidebarMessages` (`shells/ravenv1/SidebarChat.tsx`: up to `SHOWN = 6` recent
    conversations via `ConversationRowCompact`, plus "All messages");
  - Trees (each expands to `TreeTextNests` plus live voice nests; `expandable` at line
    244);
  - temporary nests;
  - Friends (reachable by `reachRank`, then an "Offline · N" disclosure);
  - "From your trees" (non-friends, collapsed).
- **The collapsed rail** shows Home, a Messages button with an unread dot, trees, and
  reachable friends.
- **Rows.**
  - `ConversationRowCompact` (`components/chat/ConversationRow.tsx:54`): avatar, name,
    group icon, unread count.
  - `ConversationAvatar` draws a DM as the person's round avatar, a group as a
    rounded-square initials avatar, a text nest as `#`.
  - `PersonRow` (in `Sidebar.tsx`): `PersonAvatar` with presence, name, status caption
    (`personStatus`, for example "In Standup"). It opens the profile.
- **Chat header** (`shells/ravenv1/views/ChatView.tsx` around 197–260): for a DM, a
  `PersonAvatar` with presence, the name, and a `…` menu that includes "Open X's page".
- **Profile** (`views/UserPageView.tsx` around 78–131): the voice-first actions.
  - Join them where they are, Knock (`useProfileKnock`), Message, Remove friend, friend
    requests, shared trees.
- **Chat API.** `chat.openDM(userId)` (`lib/chat/store.ts:559`) asks the server for the
  DM and creates it if needed. `listedConversations` and `textNestsOfTree` are in
  `lib/chat/reducer.ts`. The tree layout order is in `lib/chat/layout.ts`.

## Design

### One section: "Friends and groups"

It replaces both Messages and Friends. "Reaching you", trees, temporary nests and "From
your trees" stay as they are.

- **Friend rows.**
  - Content: `PersonAvatar` (round, with presence dot), name, and on the right the unread
    count if any, otherwise the status caption.
  - Clicking opens the conversation with that friend: `chat.openDM`, then navigate to
    `{ kind: "chat", id }`.
  - Check that an empty DM created this way doesn't show up as an empty conversation in
    All conversations or anywhere else. If it does, filter empty DMs out of listings, or
    only create on first send, whichever the server supports cleanly.
  - Disable the row briefly while opening, and don't double-create.
- **Group rows.**
  - Content: the rounded-square initials avatar and the name. No presence dot, because a
    group has no presence. Unread count on the right.
  - The square versus round shape is the subtle difference Soroush asked for. It follows
    the skill's rule that state is shape before hue.
  - Drop the extra `Users` icon if the shape reads clearly at sidebar size; keep "group"
    in the accessible name either way.
- **Order.** It is a live map, not an inbox, so rows don't jump when a message arrives:
  1. reachable friends, by `reachRank` then name (as today);
  2. groups that have unread messages or were active recently (by last activity, at most
     about 6);
  3. "Offline · N" disclosure with the remaining friends.
- **Unread is never hidden.** An offline friend with unread messages is lifted out of the
  collapsed disclosure and shown in the list. A DM with someone who is no longer a friend
  shows only while it has unread messages, as a person row without presence.
- **Section header.** The label "Friends and groups" (sentence case) with a `+` that opens
  a small menu: "New group…" (the existing group dialog) and "Add a friend…" (focus the
  title-bar search, `Ctrl K`, which already finds people).
- **Footer.** "All messages" becomes "All conversations" and still opens `MessagesView`
  (archive, previews, older groups).
- **Active state.** A friend's row is active when their DM *or* their profile is open. A
  group row is active when its conversation is open.

### The DM header becomes the person's home

Clicking a friend now opens the chat, so the chat header must keep the voice-first actions
one click from the sidebar. Otherwise Knock and Join get buried a level deeper.

- **Name.** The avatar and name form one button that opens the profile. Give it a hover
  underline and a tooltip such as "Open Sara's profile" (Soroush's request). Remove the
  now-duplicate "Open X's page" from the `…` menu.
- **Subtitle.** Their presence and status (for example "In Standup", "Away"), using the
  same helpers as the sidebar (`personStatus`, `PRESENCE`).
- **Actions.**
  - "Join" (when they're in a nest you can join, through `entry.enter`; never call media
    join directly).
  - "Knock" (reuse `useProfileKnock`, including its disabled and cooldown states and
    help text).
  - Mirror what `UserPageView` offers, without duplicating its logic: move shared pieces
    into a hook or `.ts` helper if needed.
  - In a call, follow the skill's rules: no second Leave.
- **Groups.** The header keeps the member count and the People item.
- **Profile page.** Keeps its Message button, so the two link to each other.

### The collapsed rail

Order: Home, trees, then friends and groups that are reachable or have unread messages.
Friends show presence and an unread dot. Groups use the square avatar with an unread dot.
Keep one "All conversations" button, with an unread dot when anything is unread, so the
full list stays reachable.

### Text nests follow the live rule (item 2)

- In an expanded tree, list:
  - live voice nests (as today);
  - text nests that have unread messages;
  - the text nest that is currently open.
- `expandable` (`Sidebar.tsx:244`) becomes: any of those exist. The tree row's unread dot
  stays.
- Everything else is one click away in the tree lobby (`views/TreeNestsSection.tsx`),
  which lists all nests by category.
- Keep the layout order (`orderTextNests`) for the ones shown.
- Make text and voice rows distinct at a glance. Text nests already have `#`; check that
  voice rows read as voice (the live dot plus avatars), and adjust only if they don't.

## Wording

Follow `references/writing.md`. Tree/Nest nouns come from `data.labels`.

## Checking your work

- `bun run build`, `bun test` (add tests for the ordering, the unread lifting and the
  text-nest visibility rule, kept in `.ts` helpers so they are testable), `sweep.ts`
  should print Clean.
- In the real app, with a second account driven through the API (`references/verifying.md`
  explains how: create the user, make them a friend, send messages through `/v1/chat/…`):
  - friend online and offline, with and without unread;
  - a group with unread;
  - the rail;
  - a tree with only text nests (unread and read) and with a live voice nest;
  - opening a DM from the row (no duplicate or empty conversations listed);
  - header name to profile and back;
  - Knock from the header (the second account sees it via the API);
  - 980×700 and 1920×1080;
  - keyboard: Tab through the rows and header actions.
- Tell the user about any test accounts, friendships and messages you leave in the local
  database.
- Report what you saw with screenshots, and what you couldn't (for example Join from the
  header needs the second person in a call).
