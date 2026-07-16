# Raven update infrastructure deployment

## Current deployment boundary

The homelab edge is the existing `edge-nginx` container under `/opt/nginx`, attached to the external Docker network `proxy`. Raven uses a separate Compose project and service directory. The repository provides deployment assets, but preparing these paths does not start Raven services.

Public names:

| Name | Purpose | Origin service |
| --- | --- | --- |
| `updates.rvn.bluehour.cloud` | Minimal public update and compatibility API | `raven-api:6977` |
| `downloads.rvn.bluehour.cloud` | Backend-controlled artifact redirects and short-lived S3 URLs | `raven-api:6977` |
| `ops.rvn.bluehour.cloud` | Private release operations console | `raven-operations:80` |

All three records are proxied by ArvanCloud and point to `84.241.5.42`. Arvan terminates public TLS. Each Raven record explicitly uses `upstream_https=http`; leaving Arvan's upstream mode on `auto` can send HTTPS to an unrelated shared-edge default vhost. The DNS helper updates records with `PUT`, the method accepted by Arvan's record API. Origin HTTP is the accepted closed-alpha boundary. No Raven configuration enables a broad HTTP-to-HTTPS redirect, HSTS, or a redirect affecting another host.

The Raven-only edge vhost and operations Basic Auth file may be installed before the application exists so requests fail closed. That preparation is not an application deployment: no Raven database, `.env`, migration, or container is created or started.

## Deployed closed-alpha state

The first Raven update deployment was completed on 2026-07-12 UTC from the workstation's uncommitted working-tree snapshot `20260712T2205Z-working-tree`. The source archive SHA-256 was `01b6cd66b43ff1d589322e3a3d2fa0230aa9c70f8fbd4d1d0536e771bbb83718`. This is deployment evidence, not a releasable Git identity; the release CLI continues to fail closed until Raven has an intentional initial commit.

The `raven` Compose project now runs healthy `postgres`, `api`, and `operations` services. The existing database was restored before API startup and preserved 3 users, 4 Nests, and 49 historical Nest sessions. Migration `2026071201_update_control` is recorded once and seeded both channels plus `internal`, `friends`, and disposable `staging` cohorts. The pre-migration backup is `/home/soroush/services/raven/secrets/raven-restored-pre-migration-20260712T2205Z.dump`; its SHA-256 is `eb15cff21039cde55ae94b4611274aea1163bf379a4496715605aeb6a8d4b102`.

The normal API vhost, Raven public update/download allowlists, operations vhost, nginx worker-only password-file ACL, Raven log-retention job, and one existing administrator's separate release permission are installed. No release is active or discoverable. The updater private key is not present on the homelab.

## Prepared homelab layout

```text
/home/soroush/services/raven/
  builds/
  build-cache/
  config/deployment/
  config/nginx/
  deployments/
  releases/
  secrets/
```

`secrets` must be mode `0700`. The updater signing private key and password must never be copied into any of these paths.

## Required deployment secrets

Populate `/home/soroush/services/raven/.env` from `infra/homelab/env.example` and set its mode to `0600` before any application deployment. Required values include:

- `POSTGRES_PASSWORD`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `S3_ACCESS_KEY`
- `S3_SECRET_KEY`

The closed-alpha consent contract is `RAVEN_UPDATE_CONSENT_VERSION=closed-alpha-2026-07-12`. The desktop and API must use that exact value. Changing the required delivery data or retention policy requires a new consent version and renewed acceptance.

After the first account exists, bootstrap release permission through the application CLI rather than an environment variable or direct SQL:

```powershell
ssh soroush@homelab "cd /home/soroush/services/raven && docker compose --project-name raven --env-file .env -f current/infra/homelab/compose.yaml run --rm api release-admin grant --username <username>"
```

List or revoke administrators with the same command surface:

```powershell
ssh soroush@homelab "cd /home/soroush/services/raven && docker compose --project-name raven --env-file .env -f current/infra/homelab/compose.yaml run --rm api release-admin list"
ssh soroush@homelab "cd /home/soroush/services/raven && docker compose --project-name raven --env-file .env -f current/infra/homelab/compose.yaml run --rm api release-admin revoke --username <username>"
```

The browser receives none of these values. Release administration uses the account session plus a short-lived operations session.

## Future application deployment

Application deployment is intentionally separate from DNS and directory preparation. When authorized:

1. Read `docs/update-rollback.md` and capture a new snapshot.
2. Transfer an exact committed source archive to `/home/soroush/services/raven/deployments/<commit>/source`, verify its workstation SHA-256, and only then point `/home/soroush/services/raven/current` at that source directory. Do not use GitHub Releases or GitHub Actions.
3. Populate `.env` on the homelab and set mode `0600`.
4. Run `docker compose --project-name raven --env-file .env -f current/infra/homelab/compose.yaml config --quiet` from `/home/soroush/services/raven`. Do not add `--project-directory current`; it moves the relative Docker build context outside Raven.
5. Start only PostgreSQL with `docker compose --project-name raven --env-file .env -f current/infra/homelab/compose.yaml up -d postgres` and wait for it to become healthy. Do not start `api`; opening the API is what applies the project's idempotent migrations.
6. If this deployment restores an existing Raven database, verify the backup hash and restore it now while `api` is stopped. For a custom-format PostgreSQL backup, stream it to `pg_restore --exit-on-error --clean --if-exists --no-owner --no-privileges -U raven -d raven` inside this Compose project's `postgres` service. Confirm expected accounts and server data before continuing. Never restore into an unrelated database or project.
7. Create a new timestamped `pg_dump -Fc` backup of the restored pre-migration database and record its SHA-256. Keep it outside the Compose volume. This is mandatory before any migration that is not purely additive.
8. Start only Raven's application services with `docker compose --project-name raven --env-file .env -f current/infra/homelab/compose.yaml up -d --build api operations`. The API now applies the existing reviewable migration mechanism to the restored database.
9. Confirm API health and operations frontend health on the Docker network, then verify the migration records and expected pre-existing data.
10. Replace only `/opt/nginx/conf.d/raven/raven.conf` with the audited allowlisted update/operations vhost and confirm the generated `.ops.htpasswd` remains mode `0600`.
11. After the database migration and normal API health check succeed, copy `infra/homelab/nginx/mimir.conf` to `/opt/nginx/conf.d/raven/mimir.conf`. This vhost blocks `/v1/ops` and tokenized artifact downloads so neither can bypass its dedicated protected hostname. Do not alter the existing RTC hostname.
12. Run `docker exec edge-nginx nginx -t`.
13. Reload nginx without restarting unrelated containers.
14. Copy `infra/homelab/prune-raven-logs.sh` to `/home/soroush/services/raven/config/deployment/`, make it mode `0755`, and add one user crontab entry: `17 0 * * * /home/soroush/services/raven/config/deployment/prune-raven-logs.sh`. This rotates only `raven-*.access.log` and retains seven days.
15. Verify each hostname through the public Arvan edge.

The release CLI uploads artifacts and registers an inactive draft. It does not deploy services or activate a release.

## Access and origin expectations

The operations hostname is protected by Raven-only nginx Basic Auth before requests reach either the UI or `/v1` API routes. Backend authorization remains mandatory after that gate. High-risk actions require a fresh operations session and typed confirmation. Generate or rotate the edge credential with `infra/homelab/set-ops-edge-credential.ps1`; the plaintext password is held only in a CurrentUser DPAPI file on the workstation. The homelab staging hash is mode `0600`; the live read-only nginx mount keeps the file owner-only and grants read access only to the nginx worker UID through a POSIX ACL. The helper installs nginx's portable `{SHA}` htpasswd form for a cryptographically random 384-bit password; this gate is defense in depth behind TLS and Raven's short-lived, password-reauthenticated release-administrator authorization.

The public update and download hosts expose only health, compatibility, and `/v1/updates` routes. They cannot reach account authentication, Nest APIs, or `/v1/ops`. The normal Raven API remains on its existing `mimir.rvn.bluehour.cloud` vhost and should be updated only after database migration verification.

`downloads.rvn.bluehour.cloud` does not expose the bucket or credentials. The backend validates release policy and returns a short-lived presigned object URL. The object path remains immutable.

## Verification

Before considering an application deployment complete:

```powershell
ssh soroush@homelab "cd /home/soroush/services/raven && docker compose --project-name raven --env-file .env -f current/infra/homelab/compose.yaml ps"
ssh soroush@homelab "docker exec edge-nginx nginx -t"
curl.exe --fail-with-body https://updates.rvn.bluehour.cloud/healthz
curl.exe -I https://ops.rvn.bluehour.cloud/
```

The unauthenticated operations request must return `401`, proving the infrastructure gate covers the UI. Verify the operations container's `/healthz` from the `proxy` network and then sign in through a browser with both Basic Auth and Raven release-administrator authorization. Also check that `mimir.rvn.bluehour.cloud`, `rtc.rvn.bluehour.cloud`, and another existing edge hostname still answer. A successful Raven health check is not proof that shared-edge behavior is unchanged.
