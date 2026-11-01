# Hosting your own Raven server

Run Raven for your friends or team on your own machine, and sign in from the official
desktop client by typing your server's address. The server is two Docker images
(`soroushtaheri/raven-api`, `soroushtaheri/raven-admin`) plus PostgreSQL, Redis and
LiveKit from their official images. Profile pictures and chat images are stored on a Docker
volume; no S3 is needed.

## What you need

- A Linux machine (amd64 or arm64) with a public IP address, Docker and Docker Compose v2.
- Three DNS names pointing at it, for example `raven.example.org` (API),
  `rtc.example.org` (calls) and `admin.example.org` (dashboard).
- A reverse proxy on that machine that terminates TLS. The example below uses nginx and
  certbot; any proxy that supports WebSockets and streaming responses works.
- Open to the internet: `443/tcp`, `7881/tcp` and `50002-50100/udp` (call media). Port `80/tcp`
  too if certbot uses it.

## Set up

1. Copy `infra/self-host/compose.yaml`, `.env.example` and `nginx.example.conf` to a folder on
   the server, and rename `.env.example` to `.env`.
2. Edit `.env`. Make each `change-me` a fresh secret (`openssl rand -hex 32`), set
   `LIVEKIT_NODE_IP` to the machine's public IP and `LIVEKIT_URL` to `wss://rtc.example.org`.
3. Start the stack:

   ```bash
   docker compose up -d
   docker compose ps          # every service should become "healthy"
   ```

   Database tables are created and migrated by the API itself on every start.
4. Put the proxy in front. Copy `nginx.example.conf` into nginx's `conf.d`, replace the three
   `example.org` names, create the dashboard password
   (`htpasswd -c /etc/nginx/raven.htpasswd <name>`), reload nginx and run
   `certbot --nginx -d raven.example.org -d rtc.example.org -d admin.example.org`.
   Check `https://raven.example.org/healthz` answers.
5. Create the first administrator and a space (the people's group):

   ```bash
   docker compose run --rm api user create --username alice --password '<a long password>' --role admin
   docker compose run --rm api space create --name "My space" --creator alice
   docker compose run --rm api user create --username bob --password '<password>'
   docker compose run --rm api space add-user --space "My space" --username bob
   ```

6. Install Raven from <https://updates.rvn.bluehour.cloud> (the official client), fill in
   the "Server address" field on the sign-in screen, enter `https://raven.example.org` and sign in.

## The dashboard

`https://admin.example.org` asks for the proxy password first, then for a Raven administrator
sign-in. See `docs/permissions.md` for what roles can do.

## Upgrading

Set `RAVEN_IMAGE_TAG` in `.env` to a release (or keep `latest`), then:

```bash
docker compose pull
docker compose up -d
```

Back up first. Migrations run when the API starts and are not reversible by downgrading the
image. `RAVEN_MINIMUM_CLIENT_VERSION` makes older desktop clients ask their user to update;
raise it only after the new client is out.

## Backups

Two things hold your data: the database and the `raven_media` volume.

```bash
mkdir -p backups
docker compose exec -T postgres pg_dump --username raven --dbname raven --format custom > backups/raven-$(date -u +%Y%m%dT%H%M%SZ).dump
docker run --rm -v "$(basename "$PWD")_raven_media:/media:ro" -v "$PWD/backups:/out" debian:12-slim \
  tar -czf /out/raven-media-$(date -u +%Y%m%d).tar.gz -C /media .
```

(The volume is named `<folder>_raven_media`; check with `docker volume ls`.) Copy the files off
the machine. Restore a dump with `pg_restore --clean --dbname raven` inside the `postgres`
container, and unpack the media archive back into the volume.

## Troubleshooting

- **"Server unreachable" on the sign-in screen**: the proxy or certificate is wrong. Open
  `https://raven.example.org/healthz` in a browser; check `docker compose ps` and the proxy log.
- **Calls connect but nobody hears anyone**: UDP `50002-50100` and TCP `7881` are blocked, or
  `LIVEKIT_NODE_IP` is not the machine's public IP. Behind a home router, forward those ports.
- **Calls never connect**: `LIVEKIT_URL` must be the public `wss://` name of the `rtc` proxy
  block, and the proxy must pass WebSocket upgrades.
- **Everyone appears to come from one address / sign-in throttling hits everybody**: the proxy
  is outside the ranges in `RAVEN_TRUSTED_PROXIES` (default: private ranges). Set it in the
  `api` environment to the proxy's address.
- **Logs**: `docker compose logs -f api`.
