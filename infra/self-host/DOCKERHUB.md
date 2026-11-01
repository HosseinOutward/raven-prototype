# Raven server

Raven is a voice-first place to hang out with your friends: calls, screen and camera
sharing, and chat, in a native desktop app. This repository is the **API**
(`soroushtaheri/raven-api`). The admin dashboard is `soroushtaheri/raven-admin`. Run them
with PostgreSQL, Redis and LiveKit, then sign in from the official desktop client by entering
your server's address.

## Quick start

Full guide, reverse-proxy example and backups:
<https://github.com/raven-collective/raven-prototype/blob/main/docs/self-hosting.md>

```bash
# compose.yaml, .env.example and nginx.example.conf are in infra/self-host/
cp .env.example .env      # fill in the secrets, public IP and LiveKit URL
docker compose up -d
docker compose run --rm api user create --username alice --password '...' --role admin
```

## Images

| Image | Contents |
|---|---|
| `soroushtaheri/raven-api` | Go API on port 6977 |
| `soroushtaheri/raven-admin` | Static admin dashboard (nginx, port 80) |

Both are built for `linux/amd64` and `linux/arm64`. Tags: `X.Y.Z` (a release) and `latest`.

## Environment (api)

| Variable | Meaning |
|---|---|
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_SSLMODE` | Database connection (with `RAVEN_DATABASE_DRIVER=postgres`) |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Public LiveKit address and key pair |
| `RAVEN_MEDIA_DIR` | Directory for profile and chat images (mount a volume; default in compose `/var/lib/raven/media`) |
| `RAVEN_MINIMUM_CLIENT_VERSION` | Older desktop clients are asked to update |
| `RAVEN_SERVER_NAME`, `RAVEN_SERVER_DESCRIPTION` | Shown on the sign-in screen |
| `RAVEN_TRUSTED_PROXIES` | Proxy addresses (CIDR list) whose `X-Forwarded-For` is believed |
| `RAVEN_API_ADDR` | Listen address, default `0.0.0.0:6977` in compose |

The API listens on plain HTTP: put a TLS-terminating reverse proxy in front.
