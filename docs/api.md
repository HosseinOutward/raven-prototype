# Raven API

Default base URL:

```text
http://127.0.0.1:6977
```

Authenticated routes require:

```http
X-Session-ID: <opaque-session-id>
```

The login response returns the session ID in the `X-Session-ID` response header. Raven account sessions are stateful, stored in the configured Raven database, and use a rolling 30-day expiration.

## Health

```http
GET /healthz
```

## Auth

```http
POST /v1/auth/login
POST /v1/auth/logout
GET  /v1/auth/me
GET  /v1/auth/sessions
DELETE /v1/auth/sessions/:id
```

Login body:

```json
{
  "username": "admin",
  "password": "admin123"
}
```

Active-session records include the device label, operating system, latest IP address, user agent, creation time, last access, expiration, and whether the entry is the current session. Deleting a session immediately invalidates its server-side state.

## Server Properties

```http
GET /v1/server/properties
```

Response:

```json
{
  "name": "Raven",
  "description": "Desktop RTC for private Nests",
  "avatar": "",
  "rtcServerUrl": "ws://127.0.0.1:7880",
  "advertiseUrl": "http://127.0.0.1:6977",
  "properties": {}
}
```

The desktop app lets logged-out users choose the Raven API server URL. The realtime server URL comes from this response.

## Admin Users

Only `admin` users can call these endpoints.

```http
POST /v1/admin/users
GET  /v1/admin/users
```

Create body:

```json
{
  "username": "newuser",
  "password": "change-me",
  "role": "user"
}
```

## Nests

```http
POST /v1/nests
GET  /v1/nests
GET  /v1/nests/:id
POST /v1/nests/:id/livekit-token
POST /v1/nests/:id/join
POST /v1/nests/:id/leave
POST /v1/nests/join-by-code
```

Create body:

```json
{
  "name": "Architecture Review"
}
```

Join by code body:

```json
{
  "code": "ABCDE123",
  "link": "raven://nest/ABCDE123"
}
```

Realtime token response:

```json
{
  "url": "ws://127.0.0.1:7880",
  "token": "<jwt>",
  "sessionName": "raven-nest-<id>",
  "identity": "<user-id>",
  "displayName": "alice"
}
```

Only users with joined Nest membership can request a realtime token.

## Trees

```http
GET    /v1/trees
GET    /v1/trees/search?q=<query>
POST   /v1/trees
GET    /v1/trees/:id
POST   /v1/trees/:id/settings
DELETE /v1/trees/:id
POST   /v1/trees/:id/join
POST   /v1/trees/:id/members
POST   /v1/trees/:id/members/:userId/role
DELETE /v1/trees/:id/members/:userId
GET    /v1/trees/:id/join-requests
POST   /v1/trees/:id/join-requests/:requestId/accept
POST   /v1/trees/:id/join-requests/:requestId/reject
POST   /v1/trees/:id/nests
```

Tree create/settings body:

```json
{
  "name": "Core Group",
  "description": "Trusted group for live work",
  "joinPolicy": "request",
  "visibility": "private"
}
```

`joinPolicy` is `free` or `request`. `visibility` is `public` or `private`.

Delete body:

```json
{
  "confirmation": "Core Group"
}
```

Public Trees can appear in Tree search. Private Trees do not appear in search and can only be accessed through existing membership or owner/moderator-added membership.

## Invitations

```http
POST   /v1/nests/:id/invitations
GET    /v1/nests/:id/invitations
DELETE /v1/nests/:id/invitations/:invitationId
```

Invite body:

```json
{
  "username": "alice"
}
```

## Admission

```http
GET  /v1/nests/:id/join-requests
POST /v1/nests/:id/join-requests/:requestId/accept
POST /v1/nests/:id/join-requests/:requestId/reject
```

## Client Compatibility Gate

Normal Raven communication-service requests require these headers in addition to `X-Session-ID`:

```http
X-Raven-Client-Version: 0.4.2
X-Raven-Protocol-Version: 1
X-Raven-Capabilities: updates-v1,nests-v2
X-Raven-Update-Channel: alpha
X-Raven-Update-Cohort: friends
```

Nest, Tree, presence, friend, knock, invitation, admission, session, and LiveKit-token routes fail closed with HTTP `426` when the client metadata is missing, the protocol is incompatible, a required capability is absent, the installed version is blocked, or a published required release has raised the effective minimum client version.

Authentication, sign-out, session recovery, preferences, server properties, compatibility, update, diagnostics, and release-operations routes remain available so an incompatible client can recover without joining a Nest or establishing Raven media communication.

```http
GET /v1/server/compatibility?clientVersion=0.4.1&protocolVersion=1&capabilities=updates-v1&channel=alpha&cohort=friends
```

The response contains `status`, `reasonCode`, a user-facing `message`, effective minimum and recommended client versions, protocol version, required and missing capabilities, and an optional grace-period end. Effective minimum and recommended versions are derived from both server configuration and currently published release policy. Publishing, pausing, withdrawing, or requiring a release changes this response without an API redeploy.

## Update Enrollment and Discovery

All public update responses use `Cache-Control: no-store`.

```http
GET /v1/updates/policy
```

The enrollment policy discloses the required delivery data, optional outcome and diagnostic reporting, retention periods, and the exact consent contract. The closed-alpha consent version is:

```text
closed-alpha-2026-07-12
```

```http
POST /v1/updates/decision
Content-Type: application/json
```

```json
{
  "currentVersion": "0.4.1",
  "target": "windows",
  "arch": "x86_64",
  "channel": "alpha",
  "cohort": "friends",
  "installationId": "locally-generated-random-id",
  "consentAccepted": true,
  "consentVersion": "closed-alpha-2026-07-12",
  "serverVersion": "0.4.0",
  "protocolVersion": 1,
  "capabilities": ["updates-v1"]
}
```

The installation identifier is hashed before storage. The stored digest produces a stable 0-9999 rollout bucket. Withdrawing consent by sending `consentAccepted: false`, or sending a non-current consent version, removes an existing enrollment digest and returns `consent_required`.

Decision values are:

- `update_available`
- `no_update`
- `ineligible`
- `consent_required`
- `channel_disabled`
- `incompatible`
- `blocked`
- `release_unavailable`
- `rollback_available`
- `rollback_refused`

The response includes the exact consent version, classification, reason code, calm user-facing message, stable rollout bucket, eligibility, effective compatibility, release policy, selected platform artifact, and any matching version block. An eligible artifact has a short Raven download URL, not S3 credentials or a raw long-lived object URL.

The standard Tauri updater endpoint is:

```http
GET /v1/updates/check/:target/:arch/:currentVersion
X-Raven-Update-Channel: alpha
X-Raven-Update-Cohort: friends
X-Raven-Installation-ID: locally-generated-random-id
X-Raven-Consent-Version: closed-alpha-2026-07-12
X-Raven-Protocol-Version: 1
X-Raven-Capabilities: updates-v1
```

It returns HTTP `204` when there is no installable release. Otherwise it returns Tauri's `version`, `notes`, `pub_date`, `url`, and `signature` fields plus:

```json
{
  "releaseId": "release-id",
  "classification": "recommended",
  "size": 104857600,
  "sha256": "hex-encoded-sha256",
  "decision": "update_available",
  "reasonCode": "recommended_update_available",
  "message": "A Raven update is available.",
  "compatibility": {},
  "localDataSchemaVersion": 2,
  "localMigrationReversible": true,
  "rollbackSafe": true,
  "approvedRollbackReleaseId": "previous-release-id"
}
```

Before installing an already downloaded release, revalidate it:

```http
POST /v1/updates/releases/:releaseId/revalidate
```

The request body is the same client context used by `/decision`. A paused, withdrawn, superseded, newly blocked, no-longer-compatible, or no-longer-eligible release returns a non-installable decision and no download grant.

After an early startup-health failure, request the constrained server-approved rollback:

```http
POST /v1/updates/releases/:failedReleaseId/rollback
GET  /v1/updates/releases/:failedReleaseId/rollback-check/:target/:arch/:currentVersion
```

The POST accepts the normal client context and returns a full decision. The GET uses the same headers as the normal Tauri check and returns HTTP `204` or an exact Tauri-compatible approved rollback target. Rollback is refused unless the failed source release declares both `rollbackSafe` and `localMigrationReversible`, the target is the explicitly approved older release, the target is verified, its protocol is compatible, its local schema is safe, and its version is not blocked.

Eligible manifest URLs have this shape:

```text
https://downloads.rvn.bluehour.cloud/v1/updates/artifacts/:artifactId/download?token=<short-opaque-grant>
```

The download handler validates the opaque grant, release revision, release/channel state, version blocks, and approved rollback rules on every request before returning a temporary redirect to a short S3 presigned URL. Pausing, withdrawing, blocking, superseding, changing rollout policy, or disabling the channel invalidates an older grant.

## Consented Update Reporting

```http
POST /v1/updates/outcomes
POST /v1/updates/diagnostics
```

Aggregate outcome body:

```json
{
  "consent": true,
  "eventId": "locally-generated-event-id",
  "releaseId": "optional-release-id",
  "fromVersion": "0.4.1",
  "toVersion": "0.4.2",
  "platform": "windows",
  "architecture": "x86_64",
  "stage": "installation",
  "outcome": "failure",
  "errorCategory": "installer_exit"
}
```

Accepted stages are `check`, `download`, `verification`, `installation`, `startup`, and `rollback`. Accepted outcomes are `success`, `failure`, `deferred`, and `cancelled`. Event IDs are one-way hashed and retained for deduplication for 30 days. Only daily aggregates are exposed to operators.

Detailed diagnostic body:

```json
{
  "consent": true,
  "releaseId": "optional-release-id",
  "payload": {
    "endpointStatus": "reachable",
    "verification": "signature_valid",
    "lastError": "installer_exit"
  }
}
```

Detailed diagnostics are limited to 256 KiB and retained for 14 days. Authorization, cookies, tokens, credentials, account and session identifiers, IP addresses, Windows and Unix home-directory usernames, credential-bearing URLs, and sensitive URL query parameters are redacted before storage. Sending `consent: false` is a successful HTTP `204` no-op and writes nothing for either endpoint.

## Release Operations API

Release operations require a normal Raven account session, an active `release_administrators` grant, and a short password-reauthenticated operations session.

```http
POST /v1/ops/session
X-Session-ID: <account-session>
Content-Type: application/json

{"password":"current-account-password"}
```

The response returns `opsSessionToken` and a 15-minute expiry. Subsequent routes require both:

```http
X-Session-ID: <account-session>
X-Raven-Ops-Session: <short-ops-session>
```

Session creation and high-risk action reauthorization are independently rate-limited by IP address and account. Passwords and tokens are never logged or stored in plaintext.

Release routes:

```http
GET  /v1/ops/releases
POST /v1/ops/releases
GET  /v1/ops/releases/:id
POST /v1/ops/releases/:id/validate
POST /v1/ops/releases/:id/publish
POST /v1/ops/releases/:id/pause
POST /v1/ops/releases/:id/resume
POST /v1/ops/releases/:id/withdraw
POST /v1/ops/releases/:id/supersede
POST /v1/ops/releases/:id/required
POST /v1/ops/releases/:id/rollback-target
POST /v1/ops/releases/:id/rollouts
```

Policy, audit, and reporting routes:

```http
GET  /v1/ops/channels
POST /v1/ops/channels/:name/enable
POST /v1/ops/channels/:name/disable
GET  /v1/ops/cohorts
GET  /v1/ops/version-blocks
POST /v1/ops/version-blocks
POST /v1/ops/version-blocks/:id/deactivate
GET  /v1/ops/audit
GET  /v1/ops/outcomes
GET  /v1/ops/diagnostics
```

Release lifecycle states are `draft`, `validated`, `internal`, `rolling_out`, `paused`, `fully_released`, `withdrawn`, and `superseded`. Artifact registration does not publish a release. Validation requires one verified Windows x86_64 artifact and one verified Linux x86_64 artifact, with strict S3 metadata hashes for the installer/update, checksum sidecar, SBOM, and provenance objects under the immutable path:

```text
desktop/{channel}/{version}/{platform}/{architecture}/...
```

Release drafts include `localDataSchemaVersion`, `localMigrationReversible`, and `rollbackSafe`. `rollbackSafe` cannot be true unless migration reversibility is also true.

All lifecycle and policy mutations write an immutable audit event with actor, timestamp, previous state, new state, reason, correlation ID, and optional idempotency key. Clients may send:

```http
X-Request-ID: <correlation-id>
X-Idempotency-Key: <operation-id>
```

High-risk actions require a second five-minute authorization:

```http
POST /v1/ops/authorize-action

{
  "password": "current-account-password",
  "action": "disable_channel",
  "subject": "alpha"
}
```

The response supplies the exact typed confirmation. The mutation must include the returned token in `X-Raven-Action-Authorization`, the exact `confirmation`, and a non-empty `reason`. Supported high-risk phrases are equivalent to:

```text
PUBLISH 0.4.2 AS REQUIRED
WITHDRAW 0.4.2
BLOCK < 0.4.2
UNBLOCK < 0.4.2
DISABLE alpha
```

Action authorizations are single-use. Required releases and blocked-version recovery targets bypass rollout percentages only after artifact and compatibility validation.

## Release Administrator CLI

Grant, inspect, or revoke the separate release-administrator permission from the API service directory:

```powershell
go run ./cmd/raven-api release-admin grant --username alice
go run ./cmd/raven-api release-admin list
go run ./cmd/raven-api release-admin revoke --username alice
```

Named internal/staging cohort membership cannot be self-selected by a public client. With the installation owner's explicit consent, an operator can assign a locally generated installation identifier. Raven hashes it before storage and does not print it:

```powershell
go run ./cmd/raven-api release-admin assign-cohort --installation-id "<consented-local-installation-id>" --cohort internal --reason "Maintainer closed-alpha enrollment"
```

Normal release operation does not require direct SQL or S3 manipulation.
