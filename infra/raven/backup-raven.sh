#!/bin/sh
# Nightly backup on the Raven host: a pg_dump (custom format, verified with pg_restore
# --list) and a tarball of the media folder, kept 14 days in /srv/raven/backups.
# This is on the same machine as the data. It protects against a bad change or a deleted
# row, not against losing the host or its disk. Copy /srv/raven/backups elsewhere for that.
set -eu
umask 077
backup_dir=/srv/raven/backups
mkdir -p "$backup_dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$backup_dir/raven-$stamp.dump"
media="$backup_dir/raven-media-$stamp.tar.gz"
trap 'rm -f "$target.part" "$media.part"' EXIT HUP INT TERM
docker exec raven-postgres-1 pg_dump -U raven -d raven -Fc > "$target.part"
test -s "$target.part"
docker exec -i raven-postgres-1 pg_restore --list < "$target.part" > /dev/null
mv "$target.part" "$target"
tar -C /srv/raven/media -czf "$media.part" .
mv "$media.part" "$media"
trap - EXIT HUP INT TERM
find "$backup_dir" -type f \( -name 'raven-*.dump' -o -name 'raven-media-*.tar.gz' \) -mtime +14 -delete
printf 'Raven backup completed: %s %s\n' "$target" "$media"
