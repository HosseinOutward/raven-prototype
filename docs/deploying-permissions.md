# Deploying the permissions work

For whoever rolls out the 2026-10-12 permissions change. It covers only what that change
touched. The model itself is in [permissions.md](permissions.md). It first went to
production with Raven 0.1.0.

## What ships

| Piece | Where | Deploy unit |
|---|---|---|
| API: policy layer, capabilities, account lifecycle, admin API, audit log | `services/api` | `api` compose service (rebuild) |
| Admin dashboard | `apps/admin` | new `admin` compose service (`infra/homelab/admin.Dockerfile`, `admin-nginx.conf`) |
| Edge | `infra/homelab/nginx/raven.conf` (new `admin.rvn.bluehour.cloud` vhost), `nginx/mimir.conf` (`/v1/admin/` → 404) | copy to `/opt/nginx/conf.d/raven/`, reload |
| DNS | `infra/dns/arvan-dns.ps1` now lists `admin.rvn` | new proxied record, origin protocol HTTP |
| Desktop client | `apps/desktop` | a normal desktop release, **after** the API |

## Order

1. **Database dump first.** The migration is not purely additive.
2. DNS record for `admin.rvn`.
3. Edge password file `/opt/nginx/conf.d/raven/.admin.htpasswd` (user `raven-admin`; command in
   permissions.md). The vhost refuses to load without the file, so create it before copying
   the nginx config.
4. `up -d --build api admin`.
5. Copy both nginx files, `nginx -t`, reload.
6. Release the desktop client.

## The migration

`2026101201_accounts_permissions` runs when the new API starts. It:

- adds `users.status`, `status_reason`, `must_change_password`, `password_changed_at`;
- creates `server_capability_defaults` (seeded all-allowed), `user_capability_overrides`,
  `admin_audit_events` (immutable by trigger);
- **rewrites `tree_members.role`** so each tree has one owner (creator if they were an
  owner, else longest-standing; other owners become moderators; an ownerless tree gets its
  longest-standing moderator or member), then adds the unique index
  `idx_tree_members_one_owner`.

Before deploying, check production for trees with several owners so nobody is surprised:

```sql
SELECT t.name, COUNT(*) FROM tree_members m JOIN trees t ON t.id = m.tree_id
WHERE m.role = 'owner' AND m.state = 'joined' GROUP BY t.name HAVING COUNT(*) <> 1;
```

It has run cleanly on the local PostgreSQL 17 dev database and in the test suite on both
engines. There is no down migration: roll back by restoring the dump.

## Configuration

- `RAVEN_TRUSTED_PROXIES` is new and set in `compose.yaml` to Docker's private ranges. It
  makes the API read the client address from `X-Forwarded-For`, which sign-in throttling
  and the session list depend on. Check after deploy that a session's address is the
  person's, not the edge's; if ArvanCloud's address shows instead, the edge needs
  `real_ip` configuration for the CDN, which this change does not include.
- No new secrets. No CORS change: the dashboard is same-origin with the API it calls.
- LiveKit: the API now calls `RemoveParticipant` and `DeleteRoom`. It uses the existing
  `LIVEKIT_URL` / key / secret; `LIVEKIT_URL` must be reachable from the `api` container
  for HTTP as well as being what clients are told.

## Things that change for people on deploy

- Tree settings, picture and roles become owner-only (moderators had them).
- Rooms in a tree are for its members only: no join requests or invites from outside.
- CLI and dashboard passwords need 10+ characters; new usernames must be lowercase.
- The desktop's server-picture upload is gone; it is in the dashboard. An **old** desktop
  client that tries it gets 404 from `mimir.rvn`, and gets 400 if it tries to assign the
  `owner` role. Everything else in an old client keeps working.
- A **new** desktop client needs the new API: it reads `viewer.permissions`, and against an
  old server an owner would see no management controls. Hence API first. Raise
  `RAVEN_MINIMUM_CLIENT_VERSION` only if you want to force the old client out.

## After deploy

- `https://admin.rvn.bluehour.cloud` asks for the edge password, then a Raven admin sign-in.
- `https://mimir.rvn.bluehour.cloud/v1/admin/overview` answers 404.
- In the dashboard: Overview loads, Settings → Default permissions shows six rows, the
  audit log records a test change.
- Remove a test member from a tree while they are in a call: they are dropped within a few
  seconds. If not, look for `livekit:` lines in the API log.
- If no admin can sign in: `docker compose run --rm api user set-role --username <name> --role admin`
  and `user reset-password --username <name>`.

## Not done

- No `real_ip` handling for the CDN at the edge (see Configuration).
- No script for the edge password; it is the one `htpasswd` command.
- The dashboard has not been looked at on a phone-sized screen.
