# Exit and export: download your data, delete your account

Manifesto §5.5 (right to exit) and §22 (data export is never paid): a person can take a
copy of their data at any time, and can leave for good. Two features, one Settings page.

Executor: Sonnet. Evaluator: Opus. Load the `raven-ui` skill (and its
`references/writing.md`) before any UI work. **The copy in this plan is part of the spec:
use it word for word.** If a sentence turns out to be untrue for the code, stop and flag
it; don't reword it yourself.

## Decisions (settled with Soroush, 2026-11-02)

1. **Export is its own action.** Anyone can download their data at any time, deleting or
   not. The delete flow only points to it.
2. **Export holds everything the person can see:** profile, settings, friends, trees,
   call history (join/leave times only; calls are never recorded), and every conversation
   they can still read, everyone's text included, plus the files **they** uploaded.
   Messages they hid with "delete for me" and messages before their `visible_from_seq`
   are left out. Files other people sent are listed by name, not included.
3. **Format:** one `.zip`: `README.txt`, `account.json`, `friends.json`, `trees.json`,
   `calls.json`, `conversations/<slug>.txt` (readable transcript) +
   `conversations/<slug>.json`, `files/<attachment-id>-<name>`.
4. **Deletion is immediate.** Password + typing their username. No grace period.
5. **The person chooses what happens to their messages:** erase all of them (like
   "delete for everyone" today, marker stays) or leave them for the people they talked
   with, shown as from "Deleted account". No default; they must pick.
6. **Owned trees block deletion.** The person hands each one over (existing transfer)
   or deletes it first. Same rule as today: a tree always has an owner.
7. **The only active admin can't delete their account** (reuse `requireAnotherAdmin`'s
   rule). They make someone else admin first.
8. **The username stays reserved** (confirmed by Soroush): a freed name would let a
   stranger take "ava" and send Ava's friends a friend request.
9. **Not in a call.** Deleting is refused while the person is in a call ("Leave the call
   first."). Keeps LiveKit cleanup out of scope.

Non-goals: grace period, admin-initiated deletion, importing an export into another
server, deleting desktop-local data (mixer, hotkeys, logs stay on the computer), and
rewriting past `admin_audit_events` rows.

## The tombstone (why rows are not deleted)

`users.id` is referenced without cascade by `trees`, `nests`, `chat_conversations`,
`chat_messages.sender_id`, `chat_attachments.uploader_id`, `nest_invitations`,
`*.resolved_by_user_id`, and audit/capability tables. So the `users` row stays as a
tombstone; everything personal goes.

Migration (new `internal/database/account_deletion_migrations.go`, registered the same
way as `knockReplyStatements` in `database.go`, both drivers):

```sql
ALTER TABLE users ADD COLUMN deleted_at TEXT
```

A deleted account: `status = 'suspended'`, `status_reason = 'deleted'` (the CHECK
constraint can't gain a value on SQLite, and every existing `status = 'active'` check
then already shuts them out), `deleted_at` set, `password_hash` = an unusable random
value, `avatar_object_key = ''`, `user_preferences.display_name = 'Deleted account'`
(other fields reset to defaults), username unchanged (reserved).

## Server (Go, `services/api`)

Read first: `internal/http/accounts.go` (`changePassword`: password check + throttle),
`internal/http/server.go:264-360` (routes), `internal/http/chat_messages.go:614-720`
(`deleteChatMessageForEveryone`: seq allocation, `chatQueuePurgesTx`, publish),
`internal/http/chat_conversations.go` (`removeChatMember` leave path, group owner
handover), `internal/http/domain.go:900-980` (leave/transfer tree),
`internal/http/admin_users.go:340-475` (`requireAnotherAdmin`, suspend/reactivate),
`internal/http/chat_attachment_purges.go`, `internal/http/audit.go`,
`internal/media/store.go`.

New file `internal/http/account_exit.go`, routes on `authenticated`:

- `GET /v1/account/export` → streams the zip (`archive/zip` over
  `c.Context().SetBodyStreamWriter`), `Content-Disposition: attachment;
  filename="raven-<username>-<YYYY-MM-DD>.zip"`. Rate limit: 3 per hour per user (reuse
  the `chatLimiter` pattern). Build from the same access rules the app uses
  (`chatAccessFor`, `visible_from_seq`, `chat_message_hides`); do not write new
  visibility logic. Never include password hashes, session tokens, other people's
  emails or preferences, or audit rows.
- `GET /v1/account/deletion` → `{ "ownedTrees": [{id,name}], "onlyAdmin": bool,
  "inCall": bool }`. The UI uses it to show blockers before asking for a password.
- `POST /v1/account/delete` body `{ "password", "confirmUsername", "messages":
  "erase"|"keep" }`. Order: validate payload (messages must be one of the two, username
  must match exactly) → password check with the same throttle key style as
  `changePassword` → re-check blockers (409 with the copy below) → **one transaction**:
  - `messages = erase`: for every message they sent that is not deleted, do what
    `deleteChatMessageForEveryone` does (extract its body into a `...Tx` helper and call
    it from both places; one new `changed_seq` per conversation is fine). Also delete
    their reactions and queue purges of their attachments.
  - `messages = keep`: leave messages, attachments and reactions in place.
  - Both: leave every chat conversation through the existing leave core (group owner
    handover as today; DMs set `state = 'left'`), remove tree and nest memberships,
    friendships, friend requests, knocks, invites they created, presence, preferences,
    capability overrides, `auth_sessions`; queue the avatar object for purge; write the
    tombstone fields; audit `account.deleted` with `entityLabel = "Deleted account"` and
    `detail = {"messages": "erase"|"keep"}`.
  - After commit: publish the same events the individual leave/remove/unfriend actions
    publish so other people's clients update live; clear the requester's session
    cookie. Return 204.

Other server changes:
- Sign-in, search, friend requests, knocks, invites: confirm deleted accounts are
  excluded (status not active). Add the check where missing.
- Sending into a DM whose other member is deleted: refuse with
  `"This account was deleted. You can still read your conversation."`
- Admin: user list/detail expose `deleted: true`; suspend, reactivate, password reset,
  edit and capabilities return 409 `"This account was deleted and can't be changed."`

## Desktop (`apps/desktop`)

Read first: `src/shells/ravenv1/UserSettings.tsx` (categories at lines ~51-73),
`src/shells/ravenv1/SettingsScaffold.tsx`, `src/lib/accounts.ts`
(`removeBySession`), `src/lib/api.ts` (request helper + headers), the tree delete
confirm in `src/shells/ravenv1/views/TreeSettingsView.tsx` (destructive pattern), the
`ConfirmDialog` primitive, and `src-tauri/src/lib.rs:245` (dialog plugin already
registered).

- New category `id: "data"`, label **"Your data"**, after `"sessions"`, in new
  `src/shells/ravenv1/YourDataSettings.tsx`.
- Saving the zip: new Tauri command `save_export_file` that receives the bytes as a raw
  IPC body (`tauri::ipc::Request`, filename in a header), opens
  `tauri_plugin_dialog`'s save dialog with that default name in the Downloads folder,
  and writes the file. Returns the saved path or `null` if cancelled. JS fetches the zip
  with the normal API helper as an `ArrayBuffer`.
- After a successful delete: remove the account from the switcher list, go to the
  sign-in screen and show the notice below once.
- Use `data.labels` for tree/nest words. `{trees}` below = plural label lowercased.
  `{host}` = the server host as the switcher shows it.

## Copy (word for word)

### Section 1: Download your data

- Heading: **Download your data**
- Body: "A single .zip file with your profile, settings and friends, the {trees} you
  belong to, and every conversation you can still read, including the files you sent.
  Each conversation comes as plain text you can read anywhere, and as JSON for moving to
  another app."
- Line: "Calls are never recorded. Your copy only lists when you joined and left them."
- Privacy line: "Your copy includes other people's messages too. Keep it somewhere
  private."
- Button: **Download my data** · busy: **Preparing your copy…**
- Saved toast: "Saved your data to {filename}."
- Save dialog cancelled: nothing.
- Error: "Couldn't prepare your copy. Nothing was saved." then the server text, then
  "Try again in a minute."
- Rate limited: "You've downloaded 3 copies this hour. Try again at {HH:mm}." (time from
  `Retry-After`, reader's clock)

### Section 2: Delete your account

- Heading: **Delete your account**
- Body: "Deleting your account on {host} removes your profile, friends, settings and
  memberships for good. It can't be undone, not even by an administrator."
- Line: "Want to keep anything? Download your data first."
- Button (destructive): **Delete account…**

Blockers, shown in place of the button when `GET /v1/account/deletion` reports them:
- Owned trees: "You own {n} {trees}. Give each one to someone else, or delete it,
  before you delete your account." Then one row per tree with **Open settings**.
- Only admin: "You're the only administrator on this server. Make someone else an
  administrator first, in the admin dashboard."
- In a call: "Leave the call first."

### The delete dialog

- Title: **Delete your account?**
- Label above the choice: "Your messages:"
- Option A: **Erase my messages** · hint: "Everything you wrote and every file you sent
  is removed. People see "Message deleted" where your words were."
- Option B: **Leave them for the people I talked with** · hint: "Your messages and files
  stay in their conversations, shown as from "Deleted account". Nobody can reply to you
  or reach you."
- Nothing is preselected.
- Heading: "What happens right away:"
  - "You're signed out of Raven on every device."
  - "Your profile, picture, friends and settings are deleted."
  - "You leave every {tree}, group and conversation."
  - "Your username {username} stays reserved, so nobody can use it to pose as you."
- Fields: **Password**, and **Type {username} to confirm**
- Buttons: **Cancel** and destructive **Delete my account**, enabled only when a message
  choice is picked, the username matches exactly and the password is not empty. Busy:
  **Deleting…**
- Wrong password: "That isn't your password. Your account wasn't deleted."
- Any other failure: "Couldn't delete your account. Nothing was changed." then the
  server text.

### After deleting

- Sign-in screen notice: "Your account on {host} is deleted. You're signed out
  everywhere."

### What other people see

- Name: "Deleted account", no picture.
- DM composer replaced by: "This account was deleted. You can still read your
  conversation."

### README.txt in the zip

```
Your Raven data from {host}, downloaded {YYYY-MM-DD HH:mm UTC}.

account.json        Your profile and settings.
friends.json        Your friends and open friend requests.
trees.json          The {trees} you belong to and your role in each.
calls.json          When you joined and left calls. Calls are never recorded.
conversations/      Every conversation you can read, as .txt and .json.
files/              The files you sent.

Files other people sent are listed in the conversations by name but not included.
This copy contains other people's messages. Keep it private.
```

## Tests

Go (`internal/http/account_exit_test.go`, use the existing `dbtest` helpers):
1. Export: zip has the listed entries; includes another member's message in a shared
   group; excludes a hidden message, messages before `visible_from_seq`, other people's
   files, and any password hash; includes the caller's uploaded file bytes.
2. Delete `erase`: their messages read back with empty body + `deleted_at`, their
   attachments queued for purge, reactions gone; other people's messages untouched.
3. Delete `keep`: messages intact, sender reads as "Deleted account".
4. Blockers: owner of a tree → 409; only admin → 409; in a call → 409; wrong password
   → 403 and nothing changed; username mismatch → 400.
5. After delete: login fails, sessions gone, search doesn't find them, a DM send to
   them is refused, admin reactivate returns 409, username can't be re-registered.

Desktop: unit test for the export filename helper and the dialog's enable rule
(`bun test` on a pure function, no component test needed).

## Acceptance

- `go test ./...` in `services/api` and `bun test` + `bun run typecheck` in
  `apps/desktop` pass.
- One live run at the end (see `reference_raven_live_call_testing` memory for bringing
  up API + app): download a copy and open it; delete a test account with each message
  choice and check a friend's view.
- Every string above appears exactly once and as written.

## Evaluator checks

Copy matches the spec; no visibility logic duplicated in export; delete is one
transaction with events published after commit; erase path reuses the extracted
`deleteChatMessageForEveryone` helper; no new dependency besides `archive/zip`
(stdlib).
