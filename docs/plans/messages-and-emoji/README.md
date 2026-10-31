# Message notifications, emoji and reactions: implementation plans

Soroush wants three things in text chat (`docs/chat.md`): a sound and a Windows
notification when a message arrives, a proper emoji experience, and emoji reactions,
the way Telegram does them. Written 2026-10-30. Codex implements these; Claude reviews,
fixes and finalizes afterwards.

To start a plan, give Codex one line:

> Read and implement `C:\Users\Soroush Taheri\code\raven\docs\plans\messages-and-emoji\<file>`.

| Plan | What | Depends on |
|---|---|---|
| `01-message-notifications.md` | Go: per-conversation mute. Rust: a message sound. Desktop: when to play it, Windows notifications, settings, Mute in menus | nothing |
| `02-emoji.md` | Desktop: bundled Twemoji font, emoji-only messages without a bubble, an emoji picker in the composer, `:shortcode` suggestions | nothing |
| `03-reactions-server.md` | Go: reactions table, route, wire shape, limits, events | nothing |
| `04-reactions-desktop.md` | Desktop: reacting and showing reactions | 02 and 03 |

Run them in that order, one at a time, on the same branch.

## Where to work (every plan)

- Work on branch `codex/messages-and-emoji`, made from local `main` (it has chat
  attachments, `c3798b0`, which these plans build on). The main checkout at
  `C:\Users\Soroush Taheri\code\raven` is on another branch with uncommitted work: **don't
  touch it.** Plan 01 creates a worktree:

  ```bash
  git -C "C:/Users/Soroush Taheri/code/raven" worktree add -b codex/messages-and-emoji "C:/Users/Soroush Taheri/code/raven-messages-and-emoji" main
  ```

  Then copy `C:\Users\Soroush Taheri\code\raven\.env` into it and run `bun install` in its
  `apps/desktop`. Later plans reuse that worktree.
- These plan files and the UI rules are not in git. Read them by absolute path:
  - `C:\Users\Soroush Taheri\code\raven\.claude\skills\raven-ui\SKILL.md`
  - `C:\Users\Soroush Taheri\code\raven\.claude\skills\raven-ui\references\design-system.md`
  - `C:\Users\Soroush Taheri\code\raven\.claude\skills\raven-ui\references\writing.md`

  Read all three before any plan that changes what a person sees (01, 02, 04). Every word
  in these plans is already written to those rules; use it as given. If you need a word
  the plan doesn't give, follow `writing.md`.
- Follow the code around you: comment density, naming, how errors read, how tests are
  laid out. Don't add libraries the plan doesn't name.
- Checks that must pass at the end of each plan: `bun test` and `bun run build` in
  `apps/desktop`; `go test ./...` in `services/api` when Go changed; when UI changed, the
  UI lint, run against the worktree:
  `RAVEN_REPO="C:/Users/Soroush Taheri/code/raven-messages-and-emoji" bun "C:/Users/Soroush Taheri/code/raven/.claude/skills/raven-ui/scripts/sweep.ts"`
  must print no new findings.
  For Rust, run `cargo test --lib cues` in `apps/desktop/src-tauri` if the build works on
  your machine; if it doesn't, say so and don't change build settings.
- Don't run the desktop app or try things live. Claude does that in review.
- When a plan is done: commit it on the branch with a plain one-line subject saying what a
  person gets (e.g. "Play a sound and show a notification for new messages"). Don't push,
  merge, deploy or release.
- Wire changes go in `docs/chat.md` (and the Chat section of `docs/api.md`) in the same
  commit.

## Decisions (2026-10-30, with Soroush)

**Notifications**
- Direct messages and groups notify; **text nests don't**, unless a person turns them on.
  Any conversation can be muted or turned on from its menu. This is per person, stored on
  the server, so it follows them to their other devices.
- The sound is **on by default** (a new "Messages" switch under Settings › Sounds). Windows
  notifications are **off by default** (a "Messages" switch under Settings › Notifications,
  next to Knocks).
- A notification shows who it's from and the start of the message. A switch, "Show message
  text" (on by default), hides the text.
- Nothing plays or shows while the person is looking at that conversation, in Do not
  disturb, or for a muted conversation. Edits, reactions, system notes and your own
  messages never notify. Messages fetched to fill a gap (after a reconnect) don't notify:
  only live ones do.
- The manifesto says notifications are rare and respect attention, so bursts collapse:
  one sound per 1.5 s, one Windows notification per conversation per 20 s.

**Emoji**
- One emoji set everywhere: **Twemoji**, bundled as a color font (`twemoji-colr-font`,
  COLR/CPAL, 476 KB). A font, not images, so copy, selection and search keep working.
  Apple's set was considered and rejected: its art is Apple's and can't be shipped.
  Twemoji covers Unicode 15.0; the picker offers only what it covers.
- Messages that are only 1 to 3 emoji (already detected by `emojiOnlyCount`) are drawn
  large with no bubble, like Telegram.
- A picker in the composer (search, recents, categories, one skin tone setting) and
  `:shortcode` suggestions while typing.

**Reactions**
- Any emoji, **up to 3 per person per message**. Adding a fourth replaces that person's
  oldest. At most 20 different emoji on one message.
- A quick row of six (👍 ❤️ 😂 😮 😢 🙏) plus the full picker.
- Reactions never notify, never count as unread, and never move a conversation up the
  list. Anyone who can send in a conversation can react, on any visible text message,
  their own included.
