# Plan 01: Sound and Windows notifications for new messages

Read `C:\Users\Soroush Taheri\code\raven\docs\plans\messages-and-emoji\README.md` first
(where to work, checks, decisions). This plan creates the worktree.

When you're done:
- A new message from someone else, in a conversation that notifies, plays a soft
  "message" sound unless the person is looking at that conversation.
- If Raven is in the background and the person turned on Windows notifications, one shows:
  who it's from and the start of the message.
- Each conversation's menu has **Mute notifications** / **Turn on notifications**. Direct
  messages and groups start on; text nests start off. The choice syncs across devices.

## What is there now

- Knock notifications (commit `937befd`) are the model to copy:
  - `apps/desktop/src-tauri/src/notifications.rs`: `notify_knock` shows a toast only when
    the main window isn't shown + unminimized + focused.
  - `apps/desktop/src/lib/notifications.ts`: per-device settings in `localStorage`
    (`raven.notificationSettings`), `notificationCommands`.
  - `apps/desktop/src/components/NotificationSettings.tsx`: Settings › Notifications.
  - `apps/desktop/src/shells/ravenv1/useRavenShellData.ts` (~line 75): the knock effect.
    It skips everything when `home.presence?.state === "dnd"`.
- Sound cues: `apps/desktop/src-tauri/src/audio/cues.rs` (enum `SoundCue`, `CueGroup`,
  `SoundCueSettings`, `notes()`, tests with an `ALL` array), TS mirror in
  `apps/desktop/src/lib/audio.ts` (`SoundCue`, `SoundCueSettings`) and
  `apps/desktop/src/lib/soundCues.ts` (defaults, `normalizeSoundCueSettings`). The Sounds
  section is in `apps/desktop/src/shells/ravenv1/UserSettings.tsx` (~line 316).
- Chat: `ChatStore.handleEvent` in `apps/desktop/src/lib/chat/store.ts` receives live
  stream events; `useChat.ts` builds the store and has `useWindowActive()`. The open
  conversation is the shell view `{ kind: "chat"; id }` (`shells/ravenv1/state.ts`);
  check how a text nest is opened and treat it the same way.
- Server: per-person conversation state lives in `chat_members` (`archived_at` etc.).
  `setChatArchived` in `services/api/internal/http/chat_conversations.go` is the exact
  pattern for a per-person switch: update the row, publish `conversation.changed` to the
  person's own devices, return the conversation.

## 1. Server: per-conversation notification setting

1. Migration `2026103101_chat_notify` (register it in
   `services/api/internal/database/update_migrations.go` after `2026103001_chat_attachments`;
   put the statements next to the other chat ones):
   `ALTER TABLE chat_members ADD COLUMN notify TEXT NOT NULL DEFAULT ''`.
   Values: `''` (the default for the conversation's kind), `'on'`, `'off'`. Must work on
   SQLite and PostgreSQL.
2. `ChatConversation` gets `Notify string \`json:"notify"\`` with the stored value, where
   `''` is sent as `"default"`. Fill it wherever the summary is read (list, single get).
3. Route `POST /v1/chat/conversations/:id/notifications`, body `{"mode": "default" | "on" |
   "off"}`, anything else `400`. Same shape as `setChatArchived`: access check, update the
   caller's `chat_members` row, publish `conversation.changed` to the caller only, return
   the conversation. No sequence number, no rate limiter beyond what archive has.
4. Announce it: in `server.go`'s properties, `chat["notifications"] = true`.
5. Tests next to the archive tests: default is `"default"`, each mode round-trips, a bad
   mode is `400`, an outsider gets the same `404` as for a missing conversation, a second
   session of the same person receives `conversation.changed`, nobody else does.
6. Docs: `docs/chat.md` (Data: the column; Product rules: replace "No sound and no OS
   notifications" with the rules in the README; remove "OS notifications" from "Not in
   this version"), `docs/api.md` Chat section: the route.

## 2. Rust: the message sound

In `cues.rs`:

- Add `SoundCue::Message` ("A message arrived in a conversation you aren't looking at"),
  a new `CueGroup::Message`, and `messages: bool` in `SoundCueSettings` (serde camelCase
  `messages`, default `true`). `allows()` maps the group to `self.messages`.
- `plays_outside_call` includes `Message`. `plays_while_deafened` stays false for it (in a
  call while deafened it is dropped, like every non-microphone cue).
- `min_interval` for `CueGroup::Message`: 1500 ms.
- Its notes. This exact recipe, chosen to sit apart from the others: higher than people
  joining, a fifth instead of unmute's fourth, warmer than the share cues, quicker than
  everything but the microphone:

  ```rust
  const F5: f32 = 698.46;
  const C6: f32 = 1046.50;
  // A quick rising fifth, warm and light: something new to read.
  SoundCue::Message => vec![
      note(0.0, F5, 110.0, 45.0, 0.72, BELL),
      note(70.0, C6, 280.0, 110.0, 0.9, BELL),
  ],
  ```

- Add `Message` to the tests' `ALL` array (its size becomes 9). The existing tests then
  check it is short, soft, click-free, finite and distinct from the rest; they must pass
  without loosening any threshold. If "distinct" fails, tell Soroush rather than changing
  the notes.

TS mirror: `"message"` in the `SoundCue` union in `lib/audio.ts`, `messages: boolean` in
`SoundCueSettings`, default `true` in `DEFAULT_SOUND_CUE_SETTINGS`, handled in
`normalizeSoundCueSettings`, tests updated.

## 3. Rust: a generic background notification

In `notifications.rs`, rename `platform::notify_knock` to `platform::notify` (same body)
and add a command `notify_message(app, title, body)` that calls it. Keep the
`notify_knock` command working. Register `notify_message` wherever `notify_knock` is
registered in `lib.rs`. `notificationCommands.notifyMessage(title, body)` in
`lib/notifications.ts`.

## 4. Desktop: settings

`lib/notifications.ts`: `NotificationSettings` becomes
`{ knocks: boolean; messages: boolean; messageText: boolean }`, defaults
`{ knocks: false, messages: false, messageText: true }`. Loading treats anything missing
or not a boolean as its default (so `messageText` is true for people who saved settings
before this). Update its tests.

`NotificationSettings.tsx`, under Knocks:

| Row | Description |
|---|---|
| **Messages** | Show a Windows notification for new messages while Raven is in the background. Muted conversations and Do not disturb stay quiet. |
| **Show message text** | Include the start of the message. Off shows only who it’s from. |

"Show message text" is `disabled` while Messages is off (the Sounds section does this with
`disabled={off}`; do the same).

Sounds section in `UserSettings.tsx`, a row after Knocks:

| Row | Description |
|---|---|
| **Messages** | When a message arrives in a conversation you aren’t looking at. Muted conversations and Do not disturb stay quiet. |

## 5. Desktop: deciding when to notify

**Store hook.** In `ChatStore`, add `onIncoming(listener: (message: ChatMessage) => void):
() => void`. In `handleEvent`, *before* applying, note whether the event is a
`message.created` whose `message` is not already in the conversation's loaded messages
(by id); after applying, if so, call the listeners. Only live events reach `handleEvent`,
so catch-up fetches never notify. Unit-test: a new message calls the listener once; the
same event twice calls it once; `message.updated` doesn't.

**Pure rules** in a new `lib/chat/notify.ts` (unit-tested in `notify.test.ts`):

```ts
export type NotifyMode = "default" | "on" | "off";
/** Direct messages and groups notify unless muted; text nests only when turned on. */
export function notifies(kind: ChatKind, mode: NotifyMode | undefined): boolean;
/** The mode to send so the conversation ends up `on`: "default" when that is the kind's default. */
export function modeFor(kind: ChatKind, on: boolean): NotifyMode;
/** Title and body of a Windows notification. */
export function notificationText(message: ChatMessage, conversation: ChatConversation, withText: boolean): { title: string; body: string };
```

`notificationText`:
- Direct message: title = sender name. Body = the message's text, or when `withText` is
  false, `Sent you a message`.
- Group or text nest: title = conversation name. Body = `Sara: <text>`, or when
  `withText` is false, `Sara sent a message`.
- The text: plain words from `parseMessage` (no `**` or backticks), the first non-empty
  line, whitespace collapsed, cut at 120 characters with `…`. With no caption, use the
  words the conversation list already uses for attachments ("Photo", "2 photos",
  "Attachment"); find that helper in `lib/chat` and reuse it, don't write a second one.
- Names go in as plain text (the toast isn't HTML).

**The hook** `useMessageNotifications(chat, data, view)` in
`shells/ravenv1/useMessageNotifications.ts`, called once where `useChat` is used
(`RavenShellV1.tsx`). It subscribes with `chat.onIncoming` and, for each message:

1. Skip if the sender is the signed-in person, `kind !== "text"`, or the message is
   deleted.
2. Find the conversation summary in the store. The first message of a brand-new
   conversation can arrive before the store has its summary: then wait for it (listen to
   store changes until it appears, at most 5 s; give up silently after that) and decide
   with it. A friend's first message must notify, so test this case. Skip if
   `!notifies(summary.kind, summary.notify)`.
3. Skip if presence is Do not disturb (same check as knocks).
4. Skip if the person is looking at it: window active (`useWindowActive()`; read it
   through a ref so the subscription isn't recreated) **and** the current view is this
   conversation.
5. `audioCommands.playSoundCue("message")`. The native side decides volume, the Messages
   switch, deafen and the 1.5 s spacing.
6. If `loadNotificationSettings().messages`, and no Windows notification was shown for this
   conversation in the last 20 s (a `Map<conversationId, time>` in a ref), call
   `notificationCommands.notifyMessage(...)` with `notificationText(...)`. Record the time
   only when it resolves `true` (Rust returns `false` when Raven is in front). Errors are
   swallowed like the knock code does.

## 6. Desktop: muting from the menus

- `chatApi.setNotify(conversationId, mode)` → the conversation; `ChatConversation.notify`
  in `lib/chat/types.ts` (optional, older servers don't send it).
- `ChatStore.setNotify(conversationId, on: boolean)`: sends `modeFor(kind, on)`, applies
  the returned summary the way `setArchived` does.
- Conversation menu in `views/ChatView.tsx` (the `DropdownMenu` with Archive, ~line 287),
  right after Archive: **Mute notifications** (icon `BellOff`) when `notifies(...)` is
  true, **Turn on notifications** (icon `Bell`) when it is false. Same item styling and
  error reporting as Archive (`report("Couldn’t change that.")`). Shown only when the
  server announces `properties.chat.notifications`.
- If the friend and group rows in the sidebar or the conversation list have a menu with
  Archive, add the same item there. Don't create a menu where there is none.
- A muted direct message or group (explicitly `off`) shows `BellOff` at `h-3 w-3
  text-subtle`, `aria-label="Muted"`, right after the name in its row
  (`components/chat/ConversationRow.tsx` and the friend/group rows in
  `shells/ravenv1/SidebarChat.tsx`). Text nests never show it (off is their normal).

## Done when

- The checks in the README pass, and new tests cover: the migration and route (Go), the
  cue (Rust, if it builds), settings loading, `notifies`, `modeFor`,
  `notificationText`, and `onIncoming`.
- `docs/chat.md` and `docs/api.md` describe the setting, the sound and the notification.
- Committed on `codex/messages-and-emoji`.
