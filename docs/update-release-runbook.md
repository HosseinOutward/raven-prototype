# Raven desktop release runbook

The workstation release orchestrator is `release.ps1`. A successful full run builds both supported targets, signs and verifies them locally, creates checksums, SBOMs, and provenance, uploads immutable objects, verifies each uploaded object, and registers an inactive backend draft. It never publishes or activates a rollout.

## Prerequisites

- Windows workstation with Git, Go, Bun, Rust, MSVC build tools, and SSH access to `soroush@homelab`.
- A committed, clean Git worktree. Untracked files also block release.
- One semantic version declared identically in:
  - `apps/desktop/package.json`
  - `apps/desktop/src-tauri/tauri.conf.json`
  - `apps/desktop/src-tauri/Cargo.toml`
  - `apps/operations/package.json`
  - `packages/shared/package.json`
- The Raven updater private key at `%USERPROFILE%\.raven\updater\raven-updater.key`.
- Its CurrentUser DPAPI password at `%USERPROFILE%\.raven\updater\raven-updater.password.dpapi`.
- S3 credentials in an ignored environment file. The repository `.env` is the default; use `-S3EnvFile` to select another.
- A Raven account session through `RAVEN_ACCOUNT_SESSION_ID` or `-AccountSessionFile`.
- Either a still-valid short operations session through `RAVEN_OPS_SESSION` or `-OpsSessionFile`, or the release administrator's password through `RAVEN_OPS_ACCOUNT_PASSWORD` or `-OpsPasswordFile`. The full release command mints the short operations session only at draft-registration time so a long build does not expire it.

DPAPI files are bound to the current Windows account and workstation. Create one without echoing the secret:

```powershell
$secret = Read-Host "Secret" -AsSecureString
$blob = ConvertFrom-SecureString -SecureString $secret
[IO.File]::WriteAllText("$env:USERPROFILE\.raven\release-admin-password.dpapi", $blob, (New-Object Text.UTF8Encoding($false)))
```

Restrict the parent directory to the current user. Never commit session or password files.

## One-command release

Update all version declarations, write release notes, commit, and then run:

```powershell
.\release.ps1 release `
  -Version 0.2.0 `
  -Channel alpha `
  -Classification optional `
  -NotesFile .\release-notes-0.2.0.md `
  -ClientProtocolVersion 1 `
  -LocalDataSchemaVersion 1 `
  -AccountSessionFile "$env:USERPROFILE\.raven\account-session.dpapi" `
  -OpsPasswordFile "$env:USERPROFILE\.raven\release-admin-password.dpapi"
```

Use `-LocalMigrationReversible -RollbackSafe` only after proving the local migration remains backward-readable and the prior release is an approved, unblocked, protocol-compatible rollback target. The CLI rejects `-RollbackSafe` without `-LocalMigrationReversible`.

For server compatibility bounds:

```powershell
-MinimumServerVersion 0.2.0 -MaximumServerVersion 0.4.0 -RequiredCapabilities nest-presence-v1
```

Stable releases reject prerelease semantic versions. The closed-alpha default is `alpha`.

## Staged commands

Operators can resume or inspect individual fail-closed stages:

```powershell
.\release.ps1 prepare -Version 0.2.0 -Channel alpha -NotesFile .\release-notes-0.2.0.md
.\release.ps1 test-release -Version 0.2.0 -Channel alpha
.\release.ps1 build-windows -Version 0.2.0 -Channel alpha
.\release.ps1 build-linux -Version 0.2.0 -Channel alpha
.\release.ps1 validate -Version 0.2.0 -Channel alpha
.\release.ps1 upload -Version 0.2.0 -Channel alpha
.\release.ps1 register-draft -Version 0.2.0 -Channel alpha -AccountSessionFile <path> -OpsPasswordFile <path>
.\release.ps1 inspect -Version 0.2.0 -Channel alpha -AccountSessionFile <path> -OpsSessionFile <path>
```

`build-all` runs release tests, both builds, and local validation. `test` runs tests for the release tooling itself.

## Exact build and trust flow

1. `prepare` verifies semantic versioning, declaration agreement, a clean worktree, and a committed HEAD.
2. Tests cover the Go API, desktop and operations TypeScript, and Rust library.
3. Windows NSIS is built locally.
4. The tested frontend output is added to a `git archive` of the exact HEAD.
5. The archive hash and commit are pinned into a Raven-only remote build directory.
6. Linux AppImage builds in the digest-pinned Ubuntu 22.04 container from `infra/release/Dockerfile.linux-appimage`.
7. Extraction and dynamic-linkage smoke checks run in pinned Ubuntu 22.04, Ubuntu 24.04, and Debian 12 containers.
8. The unsigned AppImage returns to the workstation. The updater private key never leaves the workstation.
9. Both updater artifacts are signed with Tauri and verified against the public key embedded in the desktop configuration.
10. Each target gets an artifact checksum file, CycloneDX SBOM, and provenance document.

## Immutable storage

Every file uses this prefix:

```text
desktop/<channel>/<version>/<platform>/x86_64/
```

The artifact, `.sig`, `.sha256`, `.cdx.json`, and `.provenance.json` are separate objects. The official AWS SDK for Go performs a conditional `PutObject` with `If-None-Match: *`. Before uploading, every expected key must be absent. After each upload, the CLI verifies HEAD size and SHA-256 metadata, then downloads the complete object and verifies its SHA-256 again.

If a multi-object upload fails after any object is stored, the CLI records the partial keys and stops. It does not delete or overwrite them. Burn that version and prepare a new semantic version.

## Draft registration and activation

Registration includes both platforms and all exact hashes, including `checksumObjectKey`, `checksumSha256`, SBOM metadata, provenance metadata, local data schema version, migration reversibility, and rollback safety. The idempotency key is stable for the channel, version, and Git commit.

The backend must return a release in `draft` state. The CLI rejects any other response. If registration returns a conflict after a response was lost, the CLI lists releases and recovers only one inactive draft whose version, channel, commit, release policy, and complete artifact metadata exactly match the request. Any missing, ambiguous, non-draft, or mismatched result fails closed.

Publishing to `internal`, expanding `friends`, pausing, withdrawing, superseding, requiring, or blocking happens later through the protected operations console.

## Local cleanup

```powershell
.\release.ps1 clean -Version 0.2.0 -Channel alpha
```

Cleaning an uploaded or registered release requires `-Force` and removes only ignored local staging. It never deletes S3 objects or backend records.
