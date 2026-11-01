# Raven admin dashboard

Raven is a voice-first place to hang out with your friends: calls, screen and camera
sharing, and chat, in a native desktop app. This image is the **admin dashboard** for a
self-hosted Raven server: accounts, their permissions, spaces and server settings. It cannot
read messages or enter calls.

It needs the API image, `soroushtaheri/raven-api`, on the same server.

## Quick start

Full guide, reverse-proxy example and backups:
<https://github.com/raven-collective/raven-prototype/blob/main/docs/self-hosting.md>

The dashboard comes up with the rest of the stack (`docker compose up -d` in `infra/self-host/`).
Sign in with an account that has the `admin` role, created with the API image:

```bash
docker compose run --rm api user create --username alice --password '...' --role admin
```

## How it is served

- Static files only (nginx), port `80`. Health check: `GET /healthz`.
- The dashboard calls the API on **its own origin**. Your reverse proxy must serve the
  dashboard and pass `/v1/admin/`, `/v1/auth/` and `/v1/media/` to the API on the same host.
  `infra/self-host/nginx.example.conf` has a ready server block.
- Put a second password in front of it at the proxy (`auth_basic` in the example). Signing in
  and every permission check still happen in the API.
- Sends strict security headers (no framing, same-origin only content security policy).
- Built for `linux/amd64` and `linux/arm64`. Tags: `X.Y.Z` (a release) and `latest`. Use the
  same tag as `raven-api`.

## Environment

None. All settings belong to the API and the reverse proxy.
