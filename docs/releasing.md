# Releasing Raven

Raven's desktop app updates itself with Tauri's signed updater. There is no update
server and no dashboard: one file on Saye, `latest.json`, says which version is current,
and one script, `release.ps1`, builds, signs and publishes.

```
release.ps1 (this PC)                    Saye: ~/services/raven/releases/     a friend's Raven
  build Windows (here)                     0.1.0/Raven_0.1.0_x64-setup.exe     reads latest.json,
  build Linux (Docker in WSL)   scp ──►    0.1.0/Raven_0.1.0_amd64.AppImage    says "update available",
  sign and verify both (here)              0.1.0/latest.json                   downloads and restarts
  write latest.json last                   latest.json                         when the person asks
```

The files are served at `https://updates.rvn.bluehour.cloud`.

## Releasing a version

1. Set the same version in `apps/desktop/package.json`,
   `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml` and
   `packages/shared/package.json`.
2. Optionally write `release-notes-<version>.md`. The app shows it as "What's new".
3. Regenerate the licence notices and commit them with the version:

   ```powershell
   cd apps\desktop; bun scripts/third-party-notices.ts
   ```

   The installer bundles `src-tauri/THIRD-PARTY-NOTICES.md` and Settings › About shows it.
   `release.ps1` does not run the script yet.
4. Commit.
5. Build and sign both installers:

   ```powershell
   .\release.ps1 build -Version 0.1.1
   ```

   They land in `.release\0.1.1\`. These are the files to send a friend for a first
   install. Try them yourself before the next step.
6. Publish:

   ```powershell
   .\release.ps1 publish -Version 0.1.1
   ```

   This uploads the installers, checks their hashes on Saye, switches `latest.json`, then
   downloads everything back through the public address and compares it with what was
   built. Every Raven that is open notices within six hours, or at once with **Settings →
   Updates → Check now**.

`.\release.ps1 status` shows what is on the server and what is being offered.

A fresh install signs in to `https://mimir.rvn.bluehour.cloud` by default; `-ApiUrl` on
`build` changes that.

## Server images

People who host their own Raven server run it from Docker Hub images
(`soroushtaheri/raven-api`, `soroushtaheri/raven-admin`; guide: `docs/self-hosting.md`).
Publish them when the API or admin dashboard changed in a release:

```powershell
.\release.ps1 images -Version X.Y.Z            # :X.Y.Z and :latest, linux/amd64 + linux/arm64
.\release.ps1 images -Version X.Y.Z -DryRun     # builds both platforms, pushes nothing
```

It builds the last commit with buildx in WSL (clean tree required; `-NoLatest` skips
`:latest`). Run `docker login` inside WSL once; the password stays in WSL's Docker config.
It prints each pushed image's digest. Paste `infra/self-host/DOCKERHUB.md` into the
Docker Hub repository pages when it changes.

## What a friend sees

Raven checks about ten seconds after it starts and every six hours. When a newer version
exists, "Update available" appears in the title bar and in Settings → Updates. Nothing is
downloaded until they press **Download**, and nothing restarts until they press **Restart
to update**. Raven refuses to restart during a call.

## When a release is bad

The usual fix is to ship the next version.

To stop a bad version spreading in the meantime, point `latest.json` back at an older one:

```powershell
.\release.ps1 repoint -Version 0.1.0
```

Raven only installs versions newer than the one it is running, so this downgrades nobody.
Someone already on the bad version reinstalls the older installer by hand; `repoint`
prints its links. The newest five versions are kept on Saye for this.

A published version never changes. If a build was wrong, bump the version.

## Making old versions update

When a server change breaks older clients, raise `RAVEN_MINIMUM_CLIENT_VERSION` in
`~/services/raven/.env` on Saye and recreate the `api` container. Older clients then get
a "Raven needs an update" screen with the update controls, instead of failing in odd ways.
That is the only server-side update setting.

## Why it is safe

- Raven installs nothing unless its signature matches the public key built into the app
  (`apps/desktop/src-tauri/updater/raven-updater.key.pub`). A cut-off or altered download
  fails that check and is thrown away.
- A failed check, download or install leaves the running version untouched. The app then
  offers the installer as a plain download.
- Installers are uploaded and hash-checked before `latest.json` moves, and `latest.json`
  is swapped by a rename, so a client never reads a half-published release.
- The signing key (`%USERPROFILE%\.raven\updater\raven-updater.key`, password in the
  DPAPI file beside it) never leaves this PC. Saye only stores files. If the key is lost,
  existing installs can no longer be updated and everyone reinstalls by hand, so keep a
  backup of that folder somewhere safe.

## One-time setup on the release PC

- The usual desktop build tools (see `development.md`), and `ssh saye` working.
- Docker inside the WSL distro (`Ubuntu` by default; `-WslDistro` picks another), with
  your user in the `docker` group:

  ```bash
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker $USER
  ```

  Then restart WSL (`wsl --shutdown`). If Docker Hub is unreachable, add a registry mirror
  to `/etc/docker/daemon.json`, as on Saye.

The Linux build runs in a pinned Ubuntu 22.04 image
(`infra/release/Dockerfile.linux-appimage`), so the AppImage works on Ubuntu 22.04,
Debian 12 and anything newer. The first build takes a while; later ones reuse
`~/raven-build/cache` inside WSL.

## Rehearsing an update

To watch an update happen without publishing a real version, publish into a scratch
folder and point a debug build at it:

```powershell
.\release.ps1 build   -Version 0.1.1 -AllowDirty -Scratch test
.\release.ps1 publish -Version 0.1.1 -Scratch test
$env:RAVEN_UPDATE_ENDPOINT = "https://updates.rvn.bluehour.cloud/test/latest.json"
bun run tauri dev
```

Only debug builds read `RAVEN_UPDATE_ENDPOINT`. Delete
`~/services/raven/releases/test` on Saye afterwards.

## On Saye

- Compose service `releases` (`infra/homelab/compose.yaml`): a stock nginx that serves
  `~/services/raven/releases` read-only, using `infra/homelab/releases-nginx.conf`.
- Edge vhost `infra/homelab/nginx/raven.conf` → `/opt/nginx/conf.d/raven/raven.conf`:
  `updates.rvn.bluehour.cloud` proxies to that container.
- `latest.json` is served with `Cache-Control: no-cache`; versioned files are cacheable.

### Deploying the API and these services

Run from `~/services/raven` on Saye. The Compose project needs its name and env file:

```bash
docker compose -p raven --env-file .env -f current/infra/homelab/compose.yaml <command>
```

1. Back up the database first (`infra/homelab/backup-raven-db.sh`). The API applies its
   migrations when it starts.
2. Copy the committed source to `deployments/<commit>/source` and point `current` at it.
3. `up -d --build api releases`.
4. Copy changed files from `infra/homelab/nginx/` to `/opt/nginx/conf.d/raven/`, then
   `docker exec edge-nginx nginx -t && docker exec edge-nginx nginx -s reload`.
5. From the release PC, check `https://mimir.rvn.bluehour.cloud/healthz` and
   `https://updates.rvn.bluehour.cloud/healthz`. Public names cannot be tested from Saye
   itself.

`.env` needs `POSTGRES_PASSWORD`, `RAVEN_VERSION`, `RAVEN_MINIMUM_CLIENT_VERSION`, the
`LIVEKIT_*` values and the `S3_*` values (profile pictures); see
`infra/homelab/env.example`. LiveKit, its ports and `rtc.conf` are unchanged by releases.
