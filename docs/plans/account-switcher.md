# Account switcher (several server + user sign-ins)

Executor: Sonnet 5.5, high effort. Before coding, load the repo's `raven-ui` skill for the
UI and wording.

## Context

Raven keeps exactly one sign-in: one server URL (`raven.apiServerUrl`) and one session id
(`raven.sessionId`) in `localStorage` (`apps/desktop/src/lib/api.ts:4-6`). Using another server
or account means signing out and in again; Settings even says "To use a different server, sign
out first." (`UserSettings.tsx:547`). We want an account switcher: a list of saved
server + user sign-ins, switch between them in one click, add a new one without losing the
current one. Sign out stays and lives beside it.

### Decisions (Soroush, 2026-11-01)

- The switcher lives in the **dock account menu** (bottom-left avatar, `DeviceDock.tsx:499-550`),
  next to the existing Sign out.
- **Sign out** ends the active account, drops it from the list, and lands on the **sign-in
  screen**, which lists the remaining saved accounts to pick from. It does not auto-switch.
- **Switching while in a call asks first**: a confirm dialog, "Switching leaves <Nest>."
- **Only the active account is connected.** No badges, unread or knocks for other accounts.

### Non-goals

No server changes. No background connections. No avatars fetched from non-active servers
(initials only). No reordering or renaming of saved accounts. Sign out behaviour during a call
is unchanged.

## Design

**One invariant:** the saved-accounts list holds only live sessions. Whatever ends the active
session (sign out, a 401 / expiry) drops that account from the list.

**Switching reloads the page.** Per-server state is spread across module singletons (event
stream hub in `lib/eventStream.ts`, avatar versions, chat state in `useChat`, seen knocks,
server properties, the compatibility gate in `ApiClient.updateRequired`). `logout`
(`useRavenShellData.ts:468-483`) already shows how much must be reset by hand. A reload after
writing the new active pointers resets all of it in one place. The call is left first, so the
native engine is idle; `crashRecovery.rememberActiveNest(null)` is called so the reload does
not try to rejoin.

The existing keys `raven.apiServerUrl` and `raven.sessionId` stay as the *active* pointers, so
existing installs need no migration: the current sign-in is saved to the list the first time
home loads.

### 1. `apps/desktop/src/lib/accounts.ts` (new, pure, tested)

```ts
export type SavedAccount = {
  serverUrl: string;   // normalized, as normalizeApiServerUrl returns it
  sessionId: string;
  userId: string;
  username: string;
  displayName: string;
  serverName: string;
  lastUsedAt: number;
};
```

Storage key `raven.accounts` (JSON array). Functions take the list and return a new one:

- `readAccounts(storage)`: parse, drop malformed entries (missing strings), never throw.
- `writeAccounts(storage, list)`.
- `upsertAccount(list, entry)`: identity is `serverUrl + userId`; replaces a match, else
  appends. Returns `{ list, replacedSessionId }` (the old session id when it differed) so the
  caller can best-effort sign the old session out.
- `removeBySession(list, serverUrl, sessionId)`.
- `sortForMenu(list, activeServerUrl, activeSessionId)`: active first, then `lastUsedAt` desc.

Wrap storage access in try/catch like `crashRecovery.ts` does.

### 2. `apps/desktop/src/lib/api.ts` (`ApiClient`, ~line 482)

`ApiClient` already owns these keys, so the account store hooks in here:

- `setSessionId` (line 525): besides today's write, if a saved account has the old
  `(baseUrl, sessionId)`, update its `sessionId`. The server rotates ids via the
  `X-Session-ID` response header (lines 648, 1098), so this keeps saved entries valid.
- `clearSession` (line 530): before clearing, remove the saved account matching
  `(baseUrl, sessionId)` when `sessionId` is non-empty. This covers sign out and expiry
  (`sessionExpired`, `useRavenShellData.ts:372`). `selectApiServer` also calls it, but on the
  sign-in screen there is no session, so nothing is dropped.
- `savedAccounts()`: `sortForMenu(readAccounts(...))`.
- `rememberAccount(user: { id, username, displayName }, serverName)`: upsert the active
  `(baseUrl, sessionId)` with `lastUsedAt = Date.now()`. If `replacedSessionId` comes back,
  fire `signOutSaved` for it (same user signed in again; the old session should not linger).
- `activateAccount(account)`: write `API_SERVER_URL_KEY` and `SESSION_ID_KEY` to storage and
  bump its `lastUsedAt`. In-memory fields don't matter; the caller reloads.
- `beginAddAccount()`: remove only `SESSION_ID_KEY` from storage (the account stays saved).
  Caller reloads into the sign-in screen.
- `signOutSaved(account)`: best effort `fetch(\`${account.serverUrl}/v1/auth/logout\`,
  { method: "POST", headers: X-Session-ID + the same client headers `request` adds })`, errors
  swallowed; then remove it from the list. Reuse the header helpers already used at
  lines 632-636 / 1091 (`desktopOS`, `addClientCompatibilityHeaders`).

### 3. `apps/desktop/src/shells/ravenv1/useRavenShellData.ts` + `state.ts`

- After a successful home load in `refresh` (line 159), call
  `api.rememberAccount(nextHome.user, serverProperties.name)` (use the properties just fetched;
  return them from `refreshServerProperties` if needed rather than reading stale state).
- New state `savedAccounts` (refreshed alongside `apiServerHistory`, and after logout).
- New actions on `RavenShellData` (`state.ts:~106-127`):
  - `switchAccount(account)`: `api.activateAccount(account)`, `rememberActiveNest(null)`,
    `window.location.reload()`.
  - `addAccount()`: `api.beginAddAccount()`, `rememberActiveNest(null)`, reload.
  - `forgetAccount(account)`: `await api.signOutSaved(account)`, refresh `savedAccounts`.
- `logout` stays as is (its `clearSession` now drops the account). It already lands on the
  sign-in screen.

Leaving the call is not done here: the dock owns `media` and the confirm dialog.

### 4. `apps/desktop/src/shells/ravenv1/DeviceDock.tsx` (account menu, lines 516-549)

Below the presence section, replace the tail of the menu with:

- Separator, `DropdownMenuLabel` "Accounts".
- One row per saved account (`data.savedAccounts`), active first with a `Check`:
  - Avatar: active account uses today's `api.userAvatarUrl`; others `Avatar name=...` only.
  - Line 1: display name (fall back to username).
  - Line 2 (caption, muted): `@username · Server name`, then the host in `rv-mono`
    (reuse `hostOf` from `RavenShellV1.tsx`; move it to a shared lib file if it is not
    exported). Full URL in the row's `title`.
  - Selecting a non-active row: if `media.activeNestId`, open the switch confirm; else
    `data.switchAccount(account)`.
  - Non-active rows get a small trailing "Sign out" icon button (`LogOut`, labelled
    "Sign out of <name> on <server>") calling `data.forgetAccount`. Keep it keyboard reachable;
    if a nested button inside `DropdownMenuItem` fights Radix focus, use a hover-revealed
    secondary item instead. Follow `raven-ui`.
- "Add an account" item (`UserPlus`): same in-call confirm, then `data.addAccount()`.
- Separator, then the existing "Settings" and "Sign out" items unchanged (Sign out label
  stays; it signs out the active account).

Confirm dialog: a second `ConfirmDialog` beside the leave one (line 614), driven by a
`pendingSwitch: { kind: "switch", account } | { kind: "add" } | null` state:
title `Switch to <name>?` (or `Add an account?`), description
`Switching leaves <leaveName>. You can join again from <server name> later.` (wording per
`raven-ui`), confirm "Switch", cancel "Stay", `focusCancel`. On confirm:
`await media.leaveMediaSession()` (the same call `runCallAction("leave")` makes, line 175),
then run the switch / add. If leaving throws, show the error and do not switch.

### 5. Sign-in screen: `ShellLogin` in `apps/desktop/src/shells/RavenShellV1.tsx` (line 597)

- New prop `savedAccounts` + `onSwitchAccount`. When the list is non-empty, show a
  "Saved accounts" block above the form: the same row layout as the dock (no sign-out
  button needed here, but allowed), each row a button calling `onSwitchAccount`.
- This covers: after Sign out (pick another account), after "Add an account" (go back to
  the one you came from), and after an expiry.
- Pass them from the `ShellLogin` call site (line 301).

### 6. Settings copy

`UserSettings.tsx:547`: replace "To use a different server, sign out first." with a hint that
points to the account menu, e.g. "To use another server or account, add it from your account
menu." (final wording per `raven-ui`).

## Files

New: `apps/desktop/src/lib/accounts.ts`, `apps/desktop/src/lib/accounts.test.ts`.
Changed: `apps/desktop/src/lib/api.ts`, `apps/desktop/src/shells/ravenv1/useRavenShellData.ts`,
`apps/desktop/src/shells/ravenv1/state.ts`, `apps/desktop/src/shells/ravenv1/DeviceDock.tsx`,
`apps/desktop/src/shells/RavenShellV1.tsx`, `apps/desktop/src/shells/ravenv1/UserSettings.tsx`.

Read narrowly: the line ranges above, `lib/crashRecovery.ts` (whole, 60 lines), the
`ConfirmDialog` export in `components/ui/dialog.tsx`.

## Verification

1. `bun test` in `apps/desktop`. New `accounts.test.ts` (pattern: `lib/eventStream.test.ts`,
   in-memory `localStorage` stub) covers: malformed storage, upsert replace vs append and
   `replacedSessionId`, `removeBySession`, menu ordering. Add `ApiClient` cases: `setSessionId`
   rotation updates the saved entry; `clearSession` drops only the matching entry and nothing
   when the session is empty.
2. `bunx tsc --noEmit` (or the repo's usual typecheck) in `apps/desktop`.
3. Once, at the end, live in `bun run tauri dev` (Go API + LiveKit up, see the live-testing
   memory), with two local accounts (two test users on the local server, or local + a second
   local API on another port):
   - Existing sign-in appears in the menu after first load (migration).
   - Add an account → sign-in screen with the first account listed → sign in → both listed.
   - Switch both ways; Home shows the right server and user; no stale chat or presence.
   - In a call: switch → confirm → call left, switched, no rejoin after reload.
   - Sign out → sign-in screen lists the remaining account.
   - Sign out a non-active account from the menu → it disappears.
   One screenshot of the open menu for the record.
4. `/code-review low` at the end.
