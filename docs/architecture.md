# Raven Architecture

Raven is a desktop-first application. The React UI runs inside Tauri v2 and communicates with a local/dev Go Fiber API over HTTP. RTC media is handled by LiveKit after Raven admission succeeds.

## Components

- `apps/desktop`: Tauri v2 shell, React, TypeScript, Tailwind, and shadcn/ui-style components.
- `services/api`: Go Fiber API with SQLite persistence and LiveKit Go SDK token issuance.
- `apps/operations`: private React release workshop protected by infrastructure Basic Auth and short-lived Raven release-administrator sessions.
- `packages/shared`: shared TypeScript domain types.

## Domain

The primary meeting entity is a **Nest**. A user can belong to multiple active Nests simultaneously. Admission is modeled separately from membership:

- `nest_members` stores creator, moderator, and participant membership.
- `nest_invitations` stores explicit username-based invitations.
- `nest_join_requests` stores approval-needed access requests.

Invited users can join immediately. Uninvited users who enter a Nest code or link wait until a creator or moderator accepts their Join Request.

## RTC

Raven uses LiveKit for realtime media. The API uses LiveKit's Go packages to issue a short-lived LiveKit access token only to users whose Nest membership state is `joined`. The LiveKit session name is derived from the internal Nest id, while the product UI continues to use Nest terminology.

Local development defaults:

```text
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

The desktop app publishes camera, microphone, and display-share tracks through LiveKit and renders remote participant media in the Active Nest screen.

## Desktop update system

The Rust desktop shell owns a persisted update state machine covering discovery, download, verification, deferral, installation, restart, recovery, and constrained rollback. It uses the official Tauri updater plugin and a fixed public key. The private key is workstation-only. React presents the state through Raven settings and a reduced required-or-blocked recovery surface that remains available when signed out or when ordinary service compatibility is denied.

The updater asks the minimal public update routes for an explicit policy decision before invoking Tauri discovery. A locally generated installation identifier is separate from account identity and is one-way hashed for a stable rollout bucket. Alpha enrollment requires acceptance of the versioned delivery-data contract. Aggregate outcomes and detailed diagnostics have separate opt-ins; detailed payloads are redacted in the desktop and again in the backend.

The API's update control module stores channels, cohorts, consented enrollments, releases, platform artifacts, rollout percentages, version blocks, approved rollback targets, short download grants, outcomes, diagnostics, release administrators, short-lived operations sessions, action authorizations, and immutable audits in PostgreSQL. Published required releases dynamically raise the effective minimum client version for the affected channel and cohort. Compatibility middleware blocks Nest and media communication with HTTP 426 while leaving authentication recovery, settings, updater, diagnostics, and sign-out available.

Artifacts use immutable `desktop/{channel}/{version}/{platform}/{architecture}` S3 keys. Public manifests contain Raven grant URLs; the download endpoint revalidates release state and redirects to a short S3 presigned URL without exposing storage credentials. The operations console calls the same backend domain logic as the CLI and requires password reauthentication plus an exact typed phrase for high-risk actions.

The homelab uses one Raven Compose project with PostgreSQL, API, and operations containers on a private Raven network plus the existing `proxy` network. `updates.rvn.bluehour.cloud` exposes only health, compatibility, and public update routes; `downloads.rvn.bluehour.cloud` exposes only guarded artifact downloads; `ops.rvn.bluehour.cloud` is infrastructure-gated; and `mimir.rvn.bluehour.cloud` exposes the normal Raven API while denying operations and artifact-grant routes.
