# Raven update emergency runbook

Forward repair is the default. Preserve immutable evidence and audit history.

## Immediate response

1. Open `https://ops.rvn.bluehour.cloud` through the Raven Basic Auth gate and Raven release-administrator session.
2. Pause the release while investigating. Pause preserves stable rollout buckets.
3. Confirm public decision and revalidation routes no longer offer installation when policy requires that behavior.
4. If the artifact or version is unsafe, withdraw the release from new discovery and create an active blocked-version rule with a clear user-facing reason.
5. If the channel itself is unsafe, disable only that channel.
6. Preserve S3 objects, signatures, checksums, SBOMs, provenance, diagnostics, and audit events.

High-risk actions require the backend review flow, reauthentication, and exact typed confirmation. Do not bypass it with SQL or direct object manipulation.

## Decision guide

- **Pause:** temporary investigation; existing rollout percentages and buckets must remain stable.
- **Withdraw:** stop new discovery of a specific release.
- **Supersede:** replace discovery with a newer signed release.
- **Required:** prevent incompatible network communication until the target is installed; never force restart.
- **Block installed range:** treat the installed version as unsafe and keep only update, recovery, settings, diagnostics, local preservation, and sign-out available.
- **Disable channel:** channel-wide emergency only.

Required and blocked policy must not expose an unsigned, incomplete, or incompatible artifact.

## Already downloaded artifacts

Clients revalidate release status before installation. A withdrawn or blocked target must not install. If Raven is in an active Nest, publication, screen share, call flow, or device setup, installation remains deferred and Raven must say why.

## Failed startup and rollback

Automatic rollback is permitted only when all are true:

- the new version fails the early startup health check;
- the previous release is an explicitly approved rollback target;
- it is not blocked;
- it remains protocol-compatible;
- the local migration is recorded as reversible;
- the source release is recorded as rollback-safe.

Otherwise use forward repair or manual recovery. Never roll back merely because a required update failed if its predecessor is blocked or incompatible.

## Infrastructure emergency

Use `docs/update-rollback.md` for DNS, edge, Compose, and database boundaries. Removing Raven services does not justify deleting historical release objects or the database volume. A zone-level TLS rollback requires a separate impact review because other proxied hosts may rely on the same switch.

