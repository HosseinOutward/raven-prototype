# Raven desktop update threat model

## Protected assets

- Tauri updater private key and password
- committed updater public key
- immutable desktop artifacts and their hashes
- release policy, audit history, and rollout state
- S3, database, Arvan API, account, and operations sessions
- user control over download, restart, installation, diagnostics, and consent

## Trust boundaries

The Windows workstation builds Windows, signs both targets, generates metadata, and uploads. The homelab receives only an exact committed source archive and returns an unsigned Linux AppImage. Arvan terminates public TLS. The Go backend authorizes policy and returns short-lived artifact URLs. S3 stores private immutable objects. The operations browser has neither infrastructure nor signing credentials.

## Threats and controls

| Threat | Control |
| --- | --- |
| Compromised homelab replaces Linux output | Workstation pins the Git archive hash, signs only after return, records builder/toolchain provenance, and verifies the signature locally. Review of build provenance remains necessary because signing a compromised output would still authorize it. |
| Private signing key exfiltration | User-only workstation ACL, DPAPI password, encrypted offline copies, no homelab/S3/backend copy, environment lifetime limited to signing. |
| Artifact overwrite or partial release | Versioned keys, conditional S3 PutObject, complete preflight, HEAD metadata check, full GET hash verification, two-platform draft validation, no automatic activation. |
| S3 credential exposure to clients | Credentials stay in workstation/backend process environments; clients receive only short-lived opaque grant redirects and presigned GET URLs. |
| Operations API bypass | `ops.rvn` requires nginx Basic Auth for UI and `/v1`; backend additionally requires account and short operations sessions. `mimir.rvn` blocks `/v1/ops`; public update hosts allowlist update routes only. |
| Download token leakage | Dedicated download hostname, exact route, GET-only behavior, no nginx access log for the tokenized route, short token and presign lifetimes, no-store responses. |
| Rollout manipulation | Stable installation hash bucket, immutable audit events, fresh authorization and typed confirmation for high-risk actions. |
| Downgrade to unsafe client | Block rules, compatibility policy, approved rollback target, local schema and migration reversibility checks. |
| Update interrupts communication | Download and install orchestration checks active Nest, media publication, sharing, call flow, and device setup; no silent installation or forced restart. |
| Diagnostics leak secrets | Separate opt-in, preview, automatic redaction, field allowlists, rate limits, and 14-day detailed retention. |
| Shared edge change harms another workload | Exact Raven files and hostnames, nginx syntax test before reload, no broad redirect or HSTS, shared-host verification, documented rollback. |

## Residual closed-alpha risks

- Windows installers are not Authenticode-signed.
- The workstation remains a high-value signing and build target.
- Origin traffic from Arvan to the homelab is HTTP.
- Basic Auth is a second gate, not phishing-resistant infrastructure identity.
- The Ubuntu 22.04 container pins the base image and toolchains, but upstream package registries and apt snapshots are not yet fully hermetic.
- Arvan edge retention and security settings require production review.

Public production requires hardened origin authentication/TLS, stronger operations access control, reproducible dependency mirrors or snapshots, workstation hardening, key ceremony, monitoring, and incident exercises.

