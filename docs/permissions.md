# Accounts, permissions and the admin dashboard

Who may do what in Raven, where that is decided, and how the server's administrator runs
it. There are three layers. Each answers a different question, and none of them stands in
for another.

| Layer | Question | Set by | Stored in |
|---|---|---|---|
| Server role | May this account use the admin dashboard? | An administrator, or the command line | `users.role` |
| Account status and capabilities | May this account use this part of Raven at all? | An administrator | `users.status`, `server_capability_defaults`, `user_capability_overrides` |
| Space role | What may this person do in this space? | The space's owner | `tree_members.role` |

The database and the desktop app say Tree and Nest; the dashboard and this page say space
and room. They are the same things.

## Server role

`admin` or `user`. An administrator can sign in to the dashboard and always has every
capability. Being an administrator gives **nothing inside a space**: an administrator who
is not a member cannot open it in the desktop app. They manage spaces from the dashboard,
where every change is recorded.

The last administrator who can sign in cannot be demoted or suspended, and nobody can
demote, suspend or reset the password of the account they are signed in with.

## Account status

`active` or `suspended`. Suspending an account signs it out everywhere, ends its event
streams, puts it out of any call, and refuses its sign-in until it is reactivated.
Nothing it made is removed: its messages stay and its spaces keep their owner. Accounts
are never deleted.

## Capabilities

What the administrator lets an account do. Each has a server-wide default and an optional
setting per account: follow the default, allow, or don't allow.

| Capability | When off |
|---|---|
| `spaces.create` | Cannot create a space. Allowed, it can carry a limit on how many spaces the account may own. |
| `rooms.join` | Cannot join any voice room or get a LiveKit token. Taking it away ends a call in progress. |
| `rooms.start_adhoc` | Cannot start a temporary room outside a space. Needs `rooms.join`. |
| `messages.read` | Chat is absent: no conversations, no history, no chat events on the stream. |
| `messages.send` | Chat is read-only. Needs `messages.read`. |
| `groups.create` | Cannot create group chats. Needs `messages.read`. |

Every default starts as allowed with no limit, so installing this changes nothing until
an administrator tightens it. A new account simply gets the defaults, which is also what
public sign-up will do when it exists.

The desktop app receives the signed-in account's capabilities with `/v1/auth/me` and
`/v1/home` (`user.capabilities`) and hides what the account cannot do. The server enforces
them regardless (`internal/http/capabilities.go`).

## Space roles

One **owner**, then **moderators**, then **members**, in a strict order. An action aimed
at a person is allowed only against someone below you.

| Action | Member | Moderator | Owner |
|---|---|---|---|
| See the space, join its rooms, chat | yes | yes | yes |
| Leave | yes | yes | no: transfer ownership first |
| Create, rename, arrange and end rooms, text rooms and categories | | yes | yes |
| Add members, answer join requests, invite into rooms | | yes | yes |
| Remove someone, delete their messages | | members only | anyone else |
| Name, description, picture, visibility, join policy | | | yes |
| Make someone a moderator or a member | | | yes |
| Transfer ownership, delete the space | | | yes |

- A space has exactly one owner; the database refuses a second
  (`idx_tree_members_one_owner`). Ownership moves by transfer, and the previous owner
  becomes a moderator.
- Rooms inside a space belong to the space. Its members may enter them and its owner and
  moderators run them. Who created a room does not matter, and nobody from outside the
  space can be invited in.
- A room outside any space (a temporary one) is run by whoever started it.
- Group chats keep their own two roles, owner and member.

All of this is decided in one place, `internal/http/policy.go`. Handlers ask
`authorizeTree`; they do not compare role names. The answer is also sent to the client
with each space as `viewer: { role, permissions }`, which is what the desktop app reads
(`apps/desktop/src/lib/permissions.ts`).

Someone outside a space gets `404` for it, the same as for a space that does not exist.
Someone inside it without the role gets `403`.

### Losing access takes effect at once

Being removed from a space, leaving it, being suspended, losing `rooms.join`, a room being
ended and a space being deleted all end the call as well as the access: the server closes
the person's place in the call and asks LiveKit to disconnect them, because a media token
already issued would otherwise keep working for hours. Tokens, sessions and presence are
re-checked against membership every time.

## Passwords and sign-in

- A password someone chooses is at least 10 characters and at most 72 bytes.
- An account made or reset by an administrator gets a temporary password, shown once. The
  account must replace it at first sign-in and can do nothing else until then.
- Changing a password signs the account out on its other devices.
- Repeated failed sign-ins are slowed down: 8 failures for one name from one address in 10
  minutes, or 40 from one address, and that address waits. Only failures count.
- New usernames are 3 to 32 lowercase letters, digits, dots, dashes or underscores, unique
  ignoring case. Signing in ignores case.

## The admin dashboard

`apps/admin` is a small web app for the administrator: users, their permissions, spaces
with their members and rooms, default permissions, the server picture and the audit log.
It cannot read messages or enter calls, and the admin API has no route that could.

It talks to `/v1/admin/*` on its own origin. Run it locally with the API on its default
port:

```powershell
cd apps\admin
bun install
bun run dev      # http://127.0.0.1:1440, proxies /v1 to 127.0.0.1:6977
bun test
bun run build
```

Set `RAVEN_ADMIN_API_URL` to point the dev proxy at another API.

### Audit log

`admin_audit_events` records every change made through the dashboard or the command line,
and every transfer of a space's ownership: who, what, to what, and when. Rows cannot be
updated or deleted; triggers refuse both. Passwords, session ids and message text are
never written to it.

### Deployment

The dashboard is the `admin` service in `infra/homelab/compose.yaml`, served at
`admin.rvn.bluehour.cloud` by the edge (`infra/homelab/nginx/raven.conf`). It has two
locks: the edge asks for a password before serving anything, and the dashboard then needs
a Raven administrator to sign in. The edge passes only `/v1/admin/`, `/v1/auth/` and
`/v1/media/` to the API on that host. On the public API host (`mimir.rvn`) the admin API
answers `404`.

First deployment:

1. Add the proxied DNS record `admin.rvn` (`infra/dns/arvan-dns.ps1` lists it), with the
   origin protocol set to HTTP like the others.
2. Create the edge password file on the server. The password is typed at the prompt, not
   on the command line:
   ```bash
   docker run --rm -it httpd:2.4-alpine htpasswd -nB raven-admin | sudo tee /opt/nginx/conf.d/raven/.admin.htpasswd
   ```
3. Take a database dump (`infra/homelab/backup-raven-db.sh`). Starting the new API applies
   migration `2026101201_accounts_permissions`, which also settles every space on one
   owner: where there were several, the creator stays if they were one of them, otherwise
   the longest-standing, and the rest become moderators.
4. `docker compose ... up -d --build api admin`, copy the nginx files, then
   `docker exec edge-nginx nginx -t` and reload.
5. Sign in at the dashboard and review Settings → Default permissions.

The API reads the client's address from `X-Forwarded-For` only when the request comes
from an address in `RAVEN_TRUSTED_PROXIES`, which compose sets to Docker's private ranges.
Without it every sign-in would appear to come from the proxy.

### When nobody can sign in to the dashboard

The command line is the way back in. On the server, in the compose project:

```bash
docker compose run --rm api user set-role --username <name> --role admin
docker compose run --rm api user reset-password --username <name>
```

`reset-password` prints a temporary password once. Both are recorded in the audit log with
the actor `cli`.

## Tests

`internal/http/permissions_test.go` covers the role table, rank, leaving and transfer,
every capability on and off, suspension, the forced password change, sign-in throttling,
call eviction, event scoping and each admin route as an administrator and as someone who
is not. `internal/database/permissions_migrations_test.go` covers the one-owner
migration.
