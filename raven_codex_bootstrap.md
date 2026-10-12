# Raven Desktop MVP — Codex Build Specification

You are Codex working inside a fresh Windows development environment.
Build the first runnable MVP of **Raven**, a desktop-first RTC meeting application.

This file is the source of truth. Do not invent a different product model.
Do not turn this into a web meeting app.
Do not add public registration.
Do not rename **Nest** back to room.

---

## 0. Product Summary

Raven is a **desktop application**, similar in product positioning to VS Code:

- The main user journey is **Download Now**, not "Start in browser".
- There must be **no browser meeting interface**.
- The app must run as a native desktop application on Windows.
- The landing page, if created later, is only for marketing and download.
- The meeting concept is called a **Nest**, not a room.

A **Nest** is a Google Meet-like meeting space:

- Authenticated users can create Nests.
- Users can join Nests they are invited to.
- Users can request to join Nests through shareable links.
- The Nest creator/admin must approve non-invited users before they can enter.
- Users may be connected to multiple Nests at the same time.

---

## 1. Hard Technical Requirements

### Local platform

Assume development happens on **Windows**.

Required local tools:

- Go `1.26.3`
- Bun only for JavaScript/TypeScript package management
- Rust toolchain for Tauri
- Tauri v2
- No npm
- No pnpm
- No yarn

If any generated instruction or script uses npm/pnpm/yarn, replace it with Bun.

### Frontend / Desktop shell

Use:

- **Tauri v2** for the desktop shell
- **React + TypeScript** for the UI
- **Bun** as the JS runtime/package manager
- **shadcn/ui** for UI components
- Tailwind CSS for styling
- No Electron

The app should be desktop-first and should not depend on being opened in a browser.

### Backend / API

Use:

- **Go 1.26.3**
- **Fiber** as the HTTP API framework
- PostgreSQL when database credentials are provided through env vars, with SQLite as the local fallback
- JWT or secure session-token based authentication
- Password hashing with a safe algorithm such as bcrypt or argon2

Important spelling note:

- Use the Go web framework **Fiber**: `github.com/gofiber/fiber/v2`
- Do not use Python Flask/FastAPI.
- Do not use Node/Express/NestJS.

### RTC layer for MVP

The first MVP does **not** need real RTC media transmission yet.

For this iteration, implement:

- Nest domain model
- authentication
- Nest creation
- invitation flow
- join-request/admission flow
- mock participant presence
- RTC policy/control UI placeholders

The RTC policy UI should be designed so LiveKit/Pion can be integrated later.

Do not hard-code the architecture to a browser WebRTC-only assumption.

---

## 2. Repository Layout

Create a clean monorepo structure:

```text
raven/
  apps/
    desktop/                 # Tauri + React + TypeScript + shadcn/ui
  services/
    api/                     # Go Fiber API
  packages/
    shared/                  # shared TypeScript types if useful
  docs/
    architecture.md
    api.md
    development.md
  README.md
```

If the current repository already exists, adapt it without destroying unrelated files.

---

## 3. Desktop App Requirements

Path:

```text
apps/desktop
```

Use Tauri v2 with React and TypeScript.

Use Bun commands only:

```powershell
bun install
bun run dev
bun run tauri dev
bun run build
bun run tauri build
```

Do not generate npm lockfiles.
Do not generate yarn lockfiles.
Do not generate pnpm lockfiles.
The lockfile should be Bun's lockfile.

### shadcn/ui

Use shadcn/ui for the UI foundation.

Install/configure shadcn/ui with Bun-compatible commands.
Use shadcn/ui components where appropriate, including at minimum:

- Button
- Input
- Card
- Dialog
- Badge
- Tabs
- Separator
- Avatar or avatar-like participant display
- Dropdown menu if useful
- Toast/sonner-style notifications if useful

The UI should be clean, serious, and product-like.
Avoid placeholder chaos.
Avoid toy styling.

### Desktop screens

Implement these screens/routes/states:

1. **Login screen**
2. **Nest dashboard**
3. **Create Nest dialog**
4. **Nest details / lobby screen**
5. **Active Nest screen**
6. **Join request waiting state**
7. **Creator admission dialog/panel**
8. **Developer/admin user creation screen or command-triggered local admin panel**

---

## 4. Authentication Requirements

### Login

The first screen shown to a user must be login.

Login requires:

- username
- password

No email login for now.
No OAuth for now.
No magic links for now.

### Registration

Public registration must be blocked in the UI.

Do not add a "Create account" button for normal users.
Do not add a public `/register` page in the desktop UI.

However, developers/admins must have a way to create users.

Implement one of the following, preferably both if simple:

#### Option A — CLI seed/admin command

A developer can create a user from the API service CLI:

```powershell
go run ./cmd/raven-api user create --username soroush --password "change-me" --role admin
```

or an equivalent documented command.

#### Option B — Admin-only API endpoint

Authenticated admin users can create users:

```http
POST /v1/admin/users
```

Request:

```json
{
  "username": "newuser",
  "password": "change-me",
  "role": "user"
}
```

This endpoint must not be public.
Only authenticated admin users can call it.

### User roles

Implement at minimum:

```text
admin
user
```

The initial seed user may be admin.

---

## 5. Nest Domain Model

The meeting entity is called **Nest** everywhere.

Do not use "Room" in the product UI.
Use "room" only if a third-party library forces it internally, and hide that from the user.

### Nest fields

A Nest should have at least:

```text
id
name
slug or joinCode
creatorUserId
createdAt
updatedAt
status
shareableLink
```

Status can be:

```text
active
ended
```

### Nest membership

Represent Nest membership with at least:

```text
nestId
userId
role
state
joinedAt
leftAt
```

Nest role:

```text
creator
moderator
participant
```

Membership state:

```text
invited
joined
left
removed
```

### Join requests

Represent join requests separately:

```text
id
nestId
userId
status
createdAt
resolvedAt
resolvedByUserId
```

Join request status:

```text
pending
accepted
rejected
cancelled
```

---

## 6. Nest Behavior Requirements

### Create Nest

An authenticated user can create a Nest with a custom name.

Example:

```json
{
  "name": "Architecture Review"
}
```

When a Nest is created:

- creator becomes a member with role `creator`
- creator is immediately joined
- a shareable link is generated

### Shareable Nest link

Every Nest must have a shareable link.

For desktop MVP, support a URL-like internal link format such as:

```text
raven://nest/<joinCode>
```

Also expose/copy a fallback HTTP-style link if simpler for MVP:

```text
https://raven.local/nest/<joinCode>
```

The UI must show a copyable share link.

### Invitations

A Nest creator can invite users by username.

If user `alice` is invited to a Nest, then Alice can join immediately without approval.

Invitation request:

```json
{
  "username": "alice"
}
```

### Join via share link

If a logged-in user opens/enters a Nest link and is already invited:

- they can join immediately

If a logged-in user opens/enters a Nest link and is not invited:

- they do **not** enter immediately
- a join request is created
- the user sees a waiting state
- the Nest creator sees the pending request
- the creator can accept or reject

This should behave like Google Meet admission:

```text
Invited user: immediate entry
Uninvited user: creator approval required
```

### Multiple simultaneous Nests

A user may be joined to multiple Nests at the same time.

Do not enforce a rule that a user must leave one Nest before joining another.

The desktop UI should support multiple active Nests conceptually.
For MVP, this can be represented as:

- a sidebar with active Nests
- tabs for joined Nests
- multiple Nest cards with active status

The implementation does not need full simultaneous media mixing yet, but the domain model must not prevent it.

---

## 7. Dashboard Requirements

After login, the user sees the Nest dashboard.

The dashboard must show:

- current user
- create Nest button
- list of Nests created by the user
- list of Nests where the user is invited
- list of Nests where the user is currently joined
- pending join requests that require this user's approval if they are the creator

Dashboard actions:

- create Nest with custom name
- copy Nest share link
- invite user by username
- join invited Nest
- request to join Nest by link/code
- accept join request if creator
- reject join request if creator
- leave Nest

---

## 8. Active Nest UI Requirements

An active Nest screen should show:

- Nest name
- share link
- creator/admin indication
- participant list
- invited users
- pending join requests if current user is creator
- mock audio/video area
- per-participant RTC control panel placeholders

### RTC control placeholders

Per participant, show controls for:

- local volume
- local mute
- receive audio mode: auto / mono / stereo
- receive video quality: auto / low / medium / high
- normalization on/off
- preferred network mode: auto / conserve bandwidth / prioritize quality

These can be UI-only placeholders for now, but state should be represented clearly in the frontend.

Use the three user-facing levels:

```text
Basic
Advanced
Pro
```

The UI should make it clear that these are Raven RTC control levels.

---

## 9. API Service Requirements

Path:

```text
services/api
```

Use Go Fiber.

Suggested package layout:

```text
services/api/
  cmd/
    raven-api/
      main.go
  internal/
    auth/
    config/
    database/
    http/
    users/
    nests/
    invitations/
    admission/
  go.mod
  go.sum
```

### API endpoints

Implement or scaffold these endpoints:

#### Health

```http
GET /healthz
```

#### Auth

```http
POST /v1/auth/login
POST /v1/auth/logout
GET  /v1/auth/me
```

#### Admin users

```http
POST /v1/admin/users
GET  /v1/admin/users
```

Only admin users may call these.

#### Nests

```http
POST /v1/nests
GET  /v1/nests
GET  /v1/nests/:id
POST /v1/nests/:id/join
POST /v1/nests/:id/leave
POST /v1/nests/join-by-code
```

#### Invitations

```http
POST /v1/nests/:id/invitations
GET  /v1/nests/:id/invitations
DELETE /v1/nests/:id/invitations/:invitationId
```

#### Admission / join requests

```http
GET  /v1/nests/:id/join-requests
POST /v1/nests/:id/join-requests/:requestId/accept
POST /v1/nests/:id/join-requests/:requestId/reject
```

### Authorization rules

Implement clear authorization rules:

- unauthenticated users cannot access Nests
- only authenticated users can create Nests
- only creator/moderator can invite users
- invited users can join immediately
- uninvited users require acceptance by creator/moderator
- only creator/moderator can accept/reject join requests
- users can leave a Nest they joined
- users can be joined to multiple Nests at once

---

## 10. Database Requirements

Use PostgreSQL for configured backend storage. The API must read database connection settings from env vars or `.env`; SQLite remains available only as a local fallback when no PostgreSQL settings are present.

Create migrations or auto-migrate code for these tables:

```text
users
sessions or auth_tokens
nests
nest_members
nest_invitations
nest_join_requests
```

Minimum `users` fields:

```text
id
username
password_hash
role
created_at
updated_at
```

Username must be unique.

Minimum `nests` fields:

```text
id
name
join_code
creator_user_id
status
created_at
updated_at
```

`join_code` must be unique and suitable for share links.

---

## 11. Frontend/API Integration

The desktop frontend should communicate with the local/dev API.

For MVP, API base URL may be:

```text
http://127.0.0.1:6977
```

Make this configurable using an environment variable or config file.

The frontend should include typed API client functions for:

- login
- get current user
- create Nest
- list Nests
- invite user
- join Nest
- join by code/link
- leave Nest
- list join requests
- accept join request
- reject join request
- admin create user

Use TypeScript types for request/response DTOs.

---

## 12. Developer Experience

The root README must include Windows-first setup instructions.

Include commands for:

### API

```powershell
cd services/api
go mod tidy
go run ./cmd/raven-api
```

### Desktop

```powershell
cd apps/desktop
bun install
bun run tauri dev
```

### Creating first admin user

Document the actual implemented way to create the first admin user.

Example target command:

```powershell
cd services/api
go run ./cmd/raven-api user create --username admin --password "admin123" --role admin
```

If a different command is implemented, document the exact command.

---

## 13. Important Naming Rules

Use these names consistently:

```text
Raven        app name
Nest         meeting room concept
Nests        plural
Creator      user who created the Nest
Invitation   explicit username-based invite
Join Request approval-needed request from uninvited user
Admission    creator/moderator accept/reject process
```

Avoid these user-facing names:

```text
Room
Rooms
Meeting room
Server
Guild
Channel
Workspace
Space
Module
```

Internal code can use technical words where unavoidable, but the product language must be Nest.

---

## 14. Acceptance Criteria

The task is complete only if all of the following are true:

1. A Windows developer can start the Go Fiber API.
2. A Windows developer can start the Tauri desktop app using Bun.
3. The UI uses shadcn/ui components.
4. The login screen is the first normal-user screen.
5. Public registration is not visible in the UI.
6. There is a developer/admin way to create users.
7. Logged-in users can create a Nest with a custom name.
8. Every Nest has a shareable link/code.
9. Creators can invite users by username.
10. Invited users can join immediately.
11. Uninvited users using a link must wait for creator approval.
12. Creator can accept/reject pending join requests.
13. A user can be joined to multiple Nests at the same time in the domain model and UI representation.
14. The product UI says Nest/Nests, not Room/Rooms.
15. The active Nest UI includes per-participant RTC control placeholders.
16. The codebase avoids npm, pnpm, yarn, Electron, Express, Flask, FastAPI, and public registration.

---

## 15. Implementation Order

Implement in this order:

1. Create monorepo structure.
2. Build Go Fiber API skeleton.
3. Add database support with PostgreSQL via env configuration and SQLite fallback, plus migrations/auto-migration.
4. Add user model, password hashing, login, auth middleware.
5. Add admin/developer user creation.
6. Add Nest model and create/list endpoints.
7. Add invitation model and endpoints.
8. Add join request/admission model and endpoints.
9. Add Tauri + React + TypeScript + Bun desktop app.
10. Configure Tailwind and shadcn/ui.
11. Build login screen.
12. Build Nest dashboard.
13. Build create Nest flow.
14. Build invite/join/admission flows.
15. Build active Nest UI with mock participants and RTC control placeholders.
16. Write README and docs.
17. Run formatting and basic tests/builds.

---

## 16. Do Not Do

Do not do any of the following:

- Do not create an Electron app.
- Do not create a browser-first meeting app.
- Do not create public registration.
- Do not use npm, pnpm, or yarn.
- Do not use Express/NestJS/Node backend.
- Do not use Python backend.
- Do not call Nests "rooms" in the UI.
- Do not build a plugin system.
- Do not add Spaces/Modules/Workspaces abstractions.
- Do not implement real RTC media before the Nest/auth/admission model is working.
- Do not require users to leave one Nest before joining another.

---

## 17. Final Output Expected From Codex

When finished, provide:

1. Summary of what was created.
2. Exact commands to run API on Windows.
3. Exact commands to run desktop app on Windows.
4. Exact command or endpoint to create the first admin user.
5. Any known limitations.
6. Files changed/created.
