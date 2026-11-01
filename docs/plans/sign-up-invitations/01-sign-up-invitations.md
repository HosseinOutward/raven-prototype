# Sign-up and invitations

## Progress (2026-11-02)
Work is in worktree `.claude/worktrees/sign-up-invites`, branch `claude/sign-up-invites`.
Done and tested: migration, capability, switches, invites API, sign-up, admin panel
(`go test ./...` green, admin tsc + tests green). Left: desktop (api.ts, permissions.ts,
sign-up form in ShellLogin, Invitations settings page), docs, copy this plan into
`docs/plans/sign-up-invitations/`, build + tests + sweep, commit, one `/code-review low`.

First step for the executor: copy this file to
`docs/plans/sign-up-invitations/01-sign-up-invitations.md` and commit it with the work.

## Context

Today the only way into a Raven server is an administrator creating the account by hand
(`adminCreateUser`, or the CLI). The "Raven feature gaps" review lists this as gap 3: the
manifesto's MVP goal is "a small trusted group can use Raven", which needs a way in that isn't
the admin. This plan adds two ways in, each switched on or off by the administrator:

- **Sign-up**: anyone who has the server address can create an account.
- **Invitations**: a person the administrator has allowed makes a single-use code and gives it
  to someone; that someone creates an account with it and lands as the inviter's friend.

Manifesto fit: boundaries are explicit ("Who can invite?" §6.3, answered per user by the admin),
the invitee consents by using the code, nothing is pushed or counted, onboarding stays short.

## Decisions

Soroush's (2026-11-01):
- Admin panel has two server-wide switches: **Sign-up** and **Invitations**.
- Invitation access is granted **per user** (a capability with a server default and per-user
  override, like "Create spaces").
- An invite is a **single-use code**. No deep links.
- Using an invite makes inviter and invitee **friends** at once. No Tree membership.
- Invites **expire after 7 days**; the inviter can revoke earlier.
- **Per-user cap** on open (unused, unexpired, unrevoked) invites, set like the owned-Trees limit.
- Inviters manage invites in a new **Invitations** page in User Settings.

Mine, change them if they're wrong:
- Both switches default **off**; the capability `invites.create` defaults **off**. Applying this
  changes nothing until the admin turns things on.
- The code is shown **once** at creation (like a temporary password); only its SHA-256 is stored.
  The list shows the last 4 characters so the inviter can tell codes apart.
- Invitations off, or the inviter's capability removed, or the inviter suspended: their open
  codes stop working at once (checked when redeemed, not by rewriting rows).
- Failed invite-code attempts are throttled per IP (security against guessing; reuses the login
  throttle). No rate limit on plain open sign-up (Soroush did not pick it).
- Admins can always invite while Invitations is on; with it off nobody can, admins included.

## Design

### Data — one migration `2026110101_sign_up_invites`
New file `services/api/internal/database/invite_migrations.go`, registered in
`update_migrations.go` after `2026103103_chat_seen`.
- `ALTER TABLE server_settings ADD COLUMN sign_up_open BOOLEAN NOT NULL DEFAULT FALSE`, same for
  `invitations_open`. Also `INSERT INTO server_settings (id, updated_at) VALUES (1, …) ON
  CONFLICT(id) DO NOTHING` so the row exists. Check how `profile_media.go` writes the row and
  match it. Must work on SQLite and Postgres (see how `permissions_migrations.go` branches on
  `driver`).
- `account_invites`: `id TEXT PK`, `code_hash TEXT NOT NULL UNIQUE`, `code_hint TEXT NOT NULL`
  (last 4 chars), `created_by_user_id → users ON DELETE CASCADE`, `created_at`, `expires_at`,
  `used_at NULL`, `used_by_user_id NULL → users ON DELETE SET NULL`, `revoked_at NULL`.
  Index `(created_by_user_id, created_at)`.
- Seed `server_capability_defaults` row `invites.create`, `allowed FALSE`, `limit_value NULL`.

**Checksum trap:** `permissionsStatements` loops over `database.Capabilities` to seed defaults,
and migration checksums are verified (`applyUpdateMigration`). Adding `invites.create` to
`Capabilities` would change that old migration's text and break every existing database. Freeze
it: give `permissionsStatements` its own literal list of the original six capabilities, then add
`CapabilityInvitesCreate = "invites.create"` to the constants and to `Capabilities` (shown last).
Add a test that the 2026101201 statements are unchanged (compare to a hard-coded checksum).

### Capability (`services/api/internal/http/capabilities.go`)
- `UserCapabilities` gains `CreateInvites bool` (`createInvites`) and `MaxOpenInvites *int`
  (`maxOpenInvites`, nil = no limit). Wire `set`, `allCapabilities`, `normalize` (no limit when
  not allowed), and `admin_users.go` effective map (~line 219).
- In `capabilitiesFor`, for every role including admin: if `invitations_open` is false, force
  `CreateInvites=false, MaxOpenInvites=nil`. One small query on `server_settings`. This keeps a
  single flag for the client and for enforcement.
- `normalizeCapabilityLimit` (`admin.go`): allow a limit on `invites.create` too (1–100 with its
  own message "A limit on open invites must be between 1 and 100, or left empty for none.").
  Make the "which capabilities take a limit" check a small helper used by both the defaults and
  the per-user override path (`adminSetUserCapabilities`).
- Errors: `errCapabilityInvites` "Your account can’t invite people.", `errInviteLimit` "You
  already have as many open invites as you are allowed."

### Server switches
- `GET/POST /v1/admin/settings/accounts` in `admin.go` → `{signUpOpen, invitationsOpen}`. POST
  audits `settings.accounts_changed` with the diff; if `invitationsOpen` changed, call
  `capabilitiesChangedForEveryone()` plus `publishToUser` for admins (that helper skips admins),
  so open clients refetch `/auth/me`.
- `getServerProperties` (`server.go:354`) adds `properties.accounts = {signUp, invitations}` so
  the sign-in screen knows what to offer before anyone is signed in.

### Invites API — new file `services/api/internal/http/invites.go`
Routes on the `service` group in `server.go` (requires sign-in and compatible client):
- `GET /v1/invites` → caller's invites, newest first, last 30 days plus all open ones:
  `{id, hint, createdAt, expiresAt, state: open|used|expired|revoked, usedBy?: {id, username,
  displayName}}`.
- `POST /v1/invites` → requires `CreateInvites`; counts open invites against `MaxOpenInvites`
  inside the insert transaction; returns `{invite, code}` (code only here). Audit
  `invite.created`.
- `DELETE /v1/invites/:id` → own, open invites only; sets `revoked_at`. Audit `invite.revoked`.
- Code: 10 symbols of Crockford base32 from `crypto/rand`, shown as `XXXXX-XXXXX`.
  `normalizeInviteCode` uppercases, drops spaces and dashes, maps `O→0, I/L→1`. Hash =
  hex SHA-256 of the normalized code.

### Sign-up — public route `POST /v1/auth/sign-up` next to `/auth/login`
Body `{username, displayName, password, inviteCode}`.
1. Code given → `invitations_open` must be true, else 403 "Invitations are turned off on this
   server." No code → `sign_up_open` must be true, else 403 "This server isn’t taking new
   accounts. Ask whoever runs it for an invite." (reasonCode `sign_up_closed`).
2. Validate with existing `ValidateNewUsername`, `ValidatePassword`, `normalizeDisplayName`.
3. One transaction: claim the invite with a conditional `UPDATE … SET used_at, used_by_user_id
   WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`, then
   confirm the inviter is active and still has `CreateInvites`
   (`capabilitiesForUserID(tx, …)`); insert the user; insert both friendship rows (same SQL as
   `domain.go:760`). Any failure on the code → 400 "That invite code doesn’t work. It may be
   used, expired or withdrawn." and `loginThrottle.failed(ip, "invite")`; check
   `blockedFor(ip, "invite")` before step 3 and answer with `tooManySignInAttempts`.
4. After commit: audit `user.signed_up` (`{via: "invite"|"open", invitedBy}`; actor = the new
   user), `publishFriendUpdate` to the inviter, start a session and return `{user}` exactly like
   login.

Refactors this needs (do them, don't duplicate):
- Split `CreateUserWithDisplayName` (`server.go:662`) into `insertUser(tx, …) (User, error)` plus
  the existing wrapper that opens and commits its own transaction.
- Split the session-starting tail of `login` (`server.go:~527–560`, from `capabilitiesFor` to the
  JSON response) into `startSession(c, user) error`; login and sign-up both call it.

### Admin panel (`apps/admin`)
- `types.ts`: add `"invites.create"` to the capability union; account settings type.
- `api.ts`: `getAccountSettings`, `setAccountSettings`.
- `lib/format.ts`: label `"invites.create": { title: "Invite people", description: "Make
  single-use invite codes for friends. Needs Invitations turned on in Settings. A limit caps
  open invites." }`; effective-limit text for it like spaces.
- `SettingsView.tsx`: new first `Section` "Who can join" with two switches — "Sign-up: anyone
  with the server address can create an account." and "Invitations: people you allow can invite
  friends with a single-use code." Generalize the `spaces.create`-only limit input to any
  capability that takes a limit (same in `UserView.tsx:336`).
- `UserView.tsx`: show "Invited by @name" when present (add `invitedBy` to `adminUserDetail` in
  `admin_users.go` via `account_invites.used_by_user_id`).

### Desktop (`apps/desktop`) — load the `raven-ui` skill before UI work
- `lib/api.ts`: `UserCapabilities` gains `createInvites`, `maxOpenInvites`; server properties
  type gains `accounts`; add `signUp(...)` (same response handling as `login`), `listInvites`,
  `createInvite`, `revokeInvite`.
- Sign-in screen (`ShellLogin`, `shells/RavenShellV1.tsx:597`): when the server offers sign-up or
  invitations, a quiet "Create an account" link switches the card to a create form: Invite code
  (shown when invitations are on; required unless sign-up is open; label "Invite code (optional)"
  when both), Display name, Username, Password. Title "Join {server}". Server errors show in the
  existing alert line. Success signs the person in through the same path as `onLogin` (add an
  `onSignUp` prop wired next to `data.login`). Keep the server-address block shared by both modes.
- New Settings category `invitations` ("Invitations", account group in `UserSettings.tsx`
  `GROUPS`), shown only when `user.capabilities.createInvites`. Page: one-line explanation,
  "Make an invite" button (disabled with the reason when at the cap: "You have N open invites,
  the most you can have."). A new code is shown once with a "Copy message" button that copies:
  `Join me on Raven.\nServer: {apiServerUrl}\nInvite code: {code}\nIt works once, until
  {date}.` Below, the list: open ones with hint, expiry and "Withdraw"; used ones "Joined as
  {displayName}"; expired/withdrawn greyed. Refetch on `account.changed`; if the category
  disappears while open, fall back to Profile.

### Docs
- `docs/permissions.md`: add `invites.create` to the capability table and a short "Sign-up and
  invitations" section (switches, redemption rules).
- `docs/api.md`: the new endpoints and `properties.accounts`.

## Files to read first
`services/api/internal/http/{server.go (routes, login, CreateUserWithDisplayName,
getServerProperties), capabilities.go, admin.go, admin_users.go, accounts.go, domain.go:740-790,
dbtest_test.go, permissions_test.go}`, `services/api/internal/database/{update_migrations.go,
permissions_migrations.go}`, `apps/admin/src/{types.ts, api.ts, lib/format.ts,
views/SettingsView.tsx, views/UserView.tsx}`, `apps/desktop/src/lib/api.ts`,
`apps/desktop/src/shells/RavenShellV1.tsx` (ShellLogin and where it's rendered ~301),
`apps/desktop/src/shells/ravenv1/UserSettings.tsx`. Grep, don't read whole files.

## Verification
1. `go test ./...` in `services/api`. New tests (pattern of `permissions_test.go` /
   `dbtest_test.go`):
   - sign-up closed → 403; open → account created, session cookie set, capabilities = defaults.
   - invite: create (cap off → 403; switch off → 403; limit hit → 403), redeem → friends both
     ways, invite used; second redeem fails; expired fails; revoked fails; inviter suspended or
     capability removed → fails; repeated bad codes → 429.
   - admin toggling invitations off clears `createInvites` for an admin and a user.
   - 2026101201 migration checksum unchanged; fresh DB seeds `invites.create` as not allowed.
2. `bun test` (or the repo's runner) for `apps/admin` and `apps/desktop` unit tests; add a test
   for the copy-message helper and `normalizeInviteCode`-equivalent formatting if any lives in TS.
3. Typecheck both apps.
4. Once, at the end: run API + admin + desktop (`docs/development.md`, `raven-ui` skill), turn
   on both switches, grant `invites.create` to a test user, make an invite, sign up a second
   account with it in the desktop app, confirm both see each other in Friends. Screenshot the
   create-account form and the Invitations page.
5. One `/code-review low`.
