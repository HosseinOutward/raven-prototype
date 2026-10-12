#!/usr/bin/env bash
# Nightly backup of Raven's PostgreSQL database: accounts, trees, nests and every chat
# message. Run from the user crontab on the host; see docs/chat-operations.md for the
# schedule, how to restore, and what a backup does not cover.
#
# The dump is written next to the deployment, not inside a container, so it survives the
# Compose project being removed. It still lives on the same disk as the database: copy it
# off the machine if losing the disk must not lose the messages.
set -euo pipefail

root=${RAVEN_ROOT:-/home/soroush/services/raven}
backups=${RAVEN_BACKUP_DIR:-$root/backups}
keep_days=${RAVEN_BACKUP_KEEP_DAYS:-14}
compose=(docker compose --project-name raven --env-file "$root/.env" -f "$root/current/infra/homelab/compose.yaml")

# Dumps hold message text. Nobody but the owner reads them.
umask 077
mkdir -p "$backups"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$backups/raven-$stamp.dump"
partial="$target.part"
trap 'rm -f "$partial"' EXIT

# Custom format: compressed, and pg_restore can list it and restore it table by table.
# pg_dump reads one consistent snapshot, so the API keeps running while it works.
"${compose[@]}" exec -T postgres pg_dump --username raven --dbname raven --format custom > "$partial"

# A file that pg_restore cannot read is not a backup. Check before it replaces an old one.
test -s "$partial"
"${compose[@]}" exec -T postgres pg_restore --list < "$partial" > /dev/null

mv "$partial" "$target"
trap - EXIT

find "$backups" -type f -name 'raven-*.dump' -mtime +"$keep_days" -delete
echo "backup written: $target ($(du -h "$target" | cut -f1))"
