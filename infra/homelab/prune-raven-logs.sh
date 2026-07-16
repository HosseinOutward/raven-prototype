#!/usr/bin/env bash
set -euo pipefail

docker run --rm \
  --entrypoint sh \
  --volume /opt/nginx/logs:/logs \
  nginx:1.30-alpine@sha256:0d3b80406a13a767339fbe2f41406d6c7da727ab89cf8fae399e81f780f814d1 \
  -eu -c '
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    for file in /logs/raven-*.access.log; do
      test -f "$file" || continue
      test -s "$file" || continue
      cp "$file" "$file.$stamp"
      : > "$file"
      gzip "$file.$stamp"
    done
    find /logs -type f -name "raven-*.access.log.*.gz" -mtime +6 -delete
  '

