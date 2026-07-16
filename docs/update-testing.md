# Raven update test procedure

## Release tooling

```powershell
.\release.ps1 test
```

This covers semantic version validation, staging-path containment, DPAPI round trips, SHA-256, exact draft metadata, safe conflict recovery for an identical inactive draft, rejection of mismatched recovery metadata, signing with the embedded Raven identity, rejection of a changed artifact, the official AWS SDK immutable S3 helper, and the Rust signature verifier.

Prove the current repository cannot release an uncommitted state:

```powershell
.\release.ps1 prepare -Version 0.1.0 -Channel alpha
```

It must fail when there is no committed HEAD, when the worktree is dirty, or when version declarations disagree.

## Application suites

The release pipeline runs:

```powershell
cd services\api
go test ./...

cd ..\..\apps\desktop
bun install --frozen-lockfile
bun run test
bun run build

cd ..\operations
bun install --frozen-lockfile
bun run test
bun run build

cd ..\desktop\src-tauri
cargo test --locked --lib
```

## Disposable staging release

Use a new prerelease semantic version and the `staging` cohort. Do not reuse a production-like version or object prefix.

1. Build and register an inactive alpha draft.
2. Validate both platform artifacts and metadata in operations.
3. Publish only to `staging` or `internal` at a small percentage.
4. Confirm stable bucket membership while expanding the percentage.
5. Pause, resume, withdraw, supersede, disable the channel, and block a disposable installed range.
6. Confirm a downloaded release is revalidated before installation.
7. Confirm required and blocked policy prevents service connectivity without forcing restart.

## Fault cases

Exercise with disposable artifacts and data:

- wrong artifact SHA-256;
- changed or invalid `.sig`;
- missing checksum, SBOM, provenance, Windows artifact, or Linux artifact;
- interrupted and partial S3 upload;
- offline and unavailable backend;
- insufficient staging disk space;
- active Nest deferral and install on normal close;
- failed post-update startup;
- approved rollback and refusal of blocked/incompatible rollback;
- consent disabled, aggregate enabled, diagnostics disabled/enabled;
- secret, token, account, IP, and home-path redaction.

The S3 failure test uses a new disposable version. Never delete or overwrite historical release objects to make a test pass.

## Platform practical checks

The remote Linux build extracts the AppImage and checks bundled executable linkage in digest-pinned Ubuntu 22.04, Ubuntu 24.04, and Debian 12 containers. Before a closed-alpha rollout, also install an old Windows build and update to the new NSIS artifact, then run an old Linux AppImage and update to the new AppImage on actual desktop sessions.

Record the commit, version, artifact hashes, target OS versions, result, and any redacted coarse error. Do not record user identity or unrelated device data.

## 2026-07-12 verification evidence

- Go formatting, vet, and all API tests passed, including PostgreSQL-backed migration rehearsal against a disposable clone.
- The clone preserved 3 users and 4 Nests, applied the update migration once, and seeded 2 channels and 3 cohorts.
- Desktop Bun tests passed 14/14; the production frontend build passed.
- Rust formatting, check, and tests passed 64/64, including updater fixed vectors, redaction, state transition, main-window authorization, staging containment, retries, and endpoint/key identity.
- Operations tests passed 4/4 and the production frontend build passed.
- Release tooling passed 24 assertions; the S3 helper and signature verifier suites passed.
- A live private S3 object at `desktop/staging/system-validation/20260712T2150Z/probe.txt` was uploaded with SHA-256 metadata, downloaded and rehashed in full, and refused a duplicate conditional write.
- Public TLS, update policy, compatibility, download allowlisting, normal-API isolation, operations Basic Auth, database migration, consent enrollment/withdrawal cleanup, and a no-release Tauri check returning 204 were verified through Arvan.
- The release preparation command refused the repository because it has no committed HEAD. Consequently, no release draft was registered and the practical Windows old-to-new and Linux AppImage old-to-new update tests remain blocked until the repository is intentionally committed and a disposable signed staging release can be built.
