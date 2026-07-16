# Raven update deployment rollback

This runbook must be reviewed before changing Raven DNS, the homelab edge, or Raven update services. It deliberately separates discovery rollback from artifact deletion. Published artifacts are immutable and are never deleted as part of rollback.

## Safety boundary

Raven owns these names and paths:

- `updates.rvn.bluehour.cloud`
- `downloads.rvn.bluehour.cloud`
- `ops.rvn.bluehour.cloud`
- `/home/soroush/services/raven`
- `/opt/nginx/conf.d/raven/raven.conf`, including a fail-closed vhost installed before the application
- `/opt/nginx/conf.d/raven/mimir.conf`, only after a verified application deployment
- Docker Compose project `raven`

Do not change another vhost, Compose project, Docker network, database, certificate, or DNS record while rolling Raven back. The shared external Docker network is named `proxy`.

## Capture state before a change

From the Windows workstation:

```powershell
New-Item -ItemType Directory -Force .release\snapshots | Out-Null
powershell -ExecutionPolicy Bypass -File infra\dns\arvan-dns.ps1 -Action Snapshot -SnapshotPath .release\snapshots\raven-dns-before.json
ssh soroush@homelab "docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}'"
ssh soroush@homelab "test ! -f /opt/nginx/conf.d/raven/raven.conf || sha256sum /opt/nginx/conf.d/raven/raven.conf"
```

Keep the snapshot until the change and its verification are complete. It contains record metadata but no API secret.

## Pause or withdraw a bad release first

If a release is discoverable, stop discovery before changing infrastructure:

1. Sign in to `https://ops.rvn.bluehour.cloud`.
2. Pause the release if investigation is ongoing, or withdraw it if clients must no longer discover it.
3. For an unsafe installed version, create a blocked-version rule with a compatible, signed repair target.
4. Confirm the public update decision no longer offers the affected artifact.

Never overwrite or delete the artifact. A corrected build receives a new semantic version.

## Roll back DNS

The DNS helper only operates on Raven's three exact record names. Raven's applied record state pins `upstream_https=http` because the shared origin terminates Raven traffic on HTTP; Arvan's `auto` mode must not be restored as a generic default. Restore the exact captured state with:

```powershell
powershell -ExecutionPolicy Bypass -File infra\dns\arvan-dns.ps1 -Action Restore -SnapshotPath .release\snapshots\raven-dns-before.json
```

The restore command refuses snapshots for another zone or record set. Verify authoritative DNS after restoration:

```powershell
powershell -ExecutionPolicy Bypass -File infra\dns\arvan-dns.ps1 -Action Inspect
```

Enabling Arvan edge TLS is a zone-level switch. The Raven bootstrap only turns it on when an active managed certificate already covers `*.rvn.bluehour.cloud`; it does not enable HTTP redirects, HSTS, content rewriting, or origin HTTPS. Do not turn zone TLS off as a routine Raven rollback because other proxied hosts may use it. Disable it only after separately proving that no other hostname depends on it.

## Roll back the homelab application

If the Raven Compose project was started in a later deployment:

```powershell
ssh soroush@homelab "cd /home/soroush/services/raven && docker compose --project-name raven --env-file .env -f current/infra/homelab/compose.yaml down"
```

This leaves the named PostgreSQL volume intact. Do not add `--volumes`.

If a prior Raven image set is recorded in `/home/soroush/services/raven/deployments`, point the `current` link back to the approved deployment, validate, and start it:

```powershell
ssh soroush@homelab "cd /home/soroush/services/raven && docker compose --project-name raven --env-file .env -f current/infra/homelab/compose.yaml config --quiet"
ssh soroush@homelab "cd /home/soroush/services/raven && docker compose --project-name raven --env-file .env -f current/infra/homelab/compose.yaml up -d"
```

Database rollback is not automatic. Prefer forward repair. Restore a database backup only when the migration is known to be backward compatible with the selected application version. Never roll back to a blocked or protocol-incompatible Raven version.

## Remove a Raven edge vhost

Only if `/opt/nginx/conf.d/raven/raven.conf` was installed:

```powershell
ssh soroush@homelab "rm -f /opt/nginx/conf.d/raven/raven.conf /opt/nginx/conf.d/raven/mimir.conf /opt/nginx/conf.d/raven/.ops.htpasswd && docker exec edge-nginx nginx -t && docker exec edge-nginx nginx -s reload"
```

Run the syntax test before reload. Do not restart the shared edge unless reload cannot be completed and the impact has been reviewed.

If Raven edge logging is removed permanently, remove only its user crontab entry:

```powershell
ssh soroush@homelab "{ crontab -l 2>/dev/null | grep -Fv '/home/soroush/services/raven/config/deployment/prune-raven-logs.sh' || true; } | crontab -"
```

## Recovery confirmation

After rollback, verify all of the following:

- Raven release discovery returns no withdrawn release.
- The operations audit shows the pause, withdrawal, block, or supersession and its reason.
- Existing non-Raven hosts still answer through the shared edge.
- Raven's database volume remains present.
- No updater private key or password exists on the homelab.
- Historical S3 objects remain unchanged.
