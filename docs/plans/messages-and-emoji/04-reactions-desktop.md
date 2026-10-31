# Plan 04: Reactions in the desktop app

Read `C:\Users\Soroush Taheri\code\raven\docs\plans\messages-and-emoji\README.md` first,
and the three `raven-ui` files it lists. Work in the worktree plan 01 made. Plans 02 (the
`EmojiPicker` component, `lib/emoji/*`) and 03 (the server route and
`ChatMessage.reactions`) must be done on this branch: check that
`apps/desktop/src/components/chat/EmojiPicker.tsx` and
`services/api/internal/http/chat_reactions.go` exist, and stop and say so if not.

When you're done, a person can react to a message from a quick row or the full picker,
see reactions under messages as small chips with counts, see who reacted, and click a
chip to add or take back theirs. Updates arrive live; the UI responds at once and
corrects itself if the server disagrees.

## 1. Types, API, store

- `lib/chat/types.ts`: `export interface ChatReaction { emoji: string; count: number;
  userIds: string[] }`; `ChatMessage.reactions?: ChatReaction[]`.
- `lib/chat/attachments.ts` (or wherever `canSendImages`/`attachmentLimits` read
  `properties.chat`): `reactionLimits(properties) → { maxPerPerson, maxKinds } | null`.
  Null means the server has no reactions: hide every reaction control and draw no chips.
- `chatApi.react(conversationId, messageId, emoji, add) → { message }` (POST
  `.../messages/:messageId/reactions` with `{emoji, add}`).
- Pure function in `lib/chat/reactions.ts` (tested in `reactions.test.ts`):

  ```ts
  /** The reactions after `userId` toggles `emoji`, as the server will make them. */
  export function toggledReactions(reactions: ChatReaction[], userId: string, emoji: string, maxPerPerson: number): ChatReaction[];
  /** "You", "Sara", "Sara and you", "Sara, Omid and you", "Sara, Omid and 3 others". */
  export function reactorsLine(reaction: ChatReaction, userId: string, nameOf: (id: string) => string): string;
  ```

  `toggledReactions`: if the person has it, remove them (drop the reaction at count 0);
  else, if they already hold `maxPerPerson`, first remove them from the reaction where
  they appear and that was added earliest (first in array order; the server corrects it
  if it chose differently), then append them (to an existing reaction, or a new one at the
  end). Counts always equal `userIds.length`.
  `reactorsLine`: "you" is always named last; at most two other names, then "and N
  others" (singular "1 other"). Names isolated from direction is the caller's job (`<bdi>`).

- Reducer: `setReactionsLocally(state, conversationId, messageId, reactions)` replaces a
  loaded message's `reactions` **without** touching `changedSeq`, so any copy from the
  server (response or event) replaces it.
- `ChatStore.react(conversationId, messageId, emoji)`: apply `toggledReactions` locally
  at once, call the API, then `applyOwnMessage` with the answer (as `edit` does). On
  failure: if the stored message's `changedSeq` is still the one it had before, put the
  previous reactions back; then throw so the caller can show the error. `recordEmoji` the
  emoji when it is an add.
- Reducer tests: the optimistic change shows; a server copy with a higher `changedSeq`
  replaces it; a failure restores it; an event arriving mid-flight wins.

## 2. Chips under a message

New `components/chat/Reactions.tsx`, drawn by `MessageRow`
(`components/chat/MessageRow.tsx`) when the message has reactions, is not deleted, and
the server has reactions:

- **Where**: in a bubble, after the text and before `MessageMeta`. For a bare message (an
  image-only one, or an emoji-only one from plan 02), directly under it, outside, aligned
  to the message's side. A row: `mt-1 flex flex-wrap gap-1`, `justify-end` for one's own
  messages.
- **A chip** is a `button`: `h-6 rounded-full px-2 inline-flex items-center gap-1`, the
  emoji at 16 px with `leading-none`, the count in `text-caption tabular-nums`.
  - Yours: `bg-primary/15 text-foreground ring-1 ring-inset ring-primary/40`.
  - Not yours: `bg-foreground/5 text-muted-foreground hover:bg-foreground/10`. On your own
    message's `bg-accent` bubble this still reads; check it against the tokens in
    `design-system.md` and use the nearest token pair that does if these don't.
  - Click toggles your reaction with that emoji. Disabled (no hover, no click) when you
    can't send in the conversation.
  - `aria-pressed` = whether it is yours; `aria-label` like "👍 3, Sara, Omid and you".
  - A `Tooltip` with `reactorsLine(...)`, names in `<bdi>`.
  - `nameOf`: the conversation's `members` first, then the `senderName` of any loaded
    message from that person, then `Someone`.
- Chips keep the order the server sends. A new chip fades and scales in from 95% over
  150 ms; nothing animates when `prefers-reduced-motion` is set. Use the motion utilities
  the design system already uses; if there are none, no animation.
- Pending messages (`PendingRow`) never have reactions.

## 3. Reacting

All reaction controls exist only when `reactionLimits` is not null, the conversation lets
you send, and the message is a non-deleted text message (`kind === "text"`).

**The React button.** In the hover actions (`actions` in `MessageRow`, ~line 153), before
Reply: a `SmilePlus` icon button styled exactly like Reply (`h-7 w-7`, same classes),
`aria-label="React"`, `Tooltip` "React". It opens a `Popover`
(`components/ui/popover`) anchored to it, `side="top"`, aligned to the message's side.
While it is open the hover actions stay visible (as they do for the open menu,
`menuOpen`).

**The reaction popover** has two states:

1. **Quick row** (opens in this state): 👍 ❤️ 😂 😮 😢 🙏 as 36 × 36 buttons, emoji at
   22 px, `rounded-control`, `hover:bg-secondary`; one you already have on the message
   has the "yours" chip colours. Then a 36 × 36 `ChevronDown` button, `aria-label="More
   emoji"`, that switches to the second state. `p-1`, no other chrome.
2. **Full picker**: the `EmojiPicker` from plan 02, `autoFocus`. The popover grows into it
   in place.

Picking any emoji calls `chat.react(...)` and closes the popover. Errors: `toast({ title:
failureText(failure, "Couldn’t react to that."), tone: "error" })`, the way the other
message actions report.

**The message menu** (the `DropdownMenu` that the "More" button and right-click open): at
its top, the same six quick emoji as a row of 32 × 32 items, then a separator, then the
existing items. Picking one reacts and closes the menu. Right-click on a message is how
most people will find reactions, so this row matters. Use Radix `DropdownMenuItem`s laid
out in a flex row so keyboard navigation still works.

**Keyboard**: everything above is reachable by Tab and arrows, and Escape closes it and
returns focus to the button that opened it.

## 4. Elsewhere

- The voice overlay and the conversation list don't show reactions. Nothing else changes.
- `docs/chat.md` Client section: a short paragraph on reactions (optimistic toggle, the
  quick row, the menu row, chips, names).

## Done when

- The README's checks pass, with tests for `toggledReactions`, `reactorsLine`,
  `reactionLimits`, the reducer behaviour above, and `Reactions` rendering (yours vs. not,
  hidden when the server has none), in the style of `Attachments.test.tsx`.
- Committed on `codex/messages-and-emoji`.
- In your summary, list anything you had to decide that this plan didn't cover.
