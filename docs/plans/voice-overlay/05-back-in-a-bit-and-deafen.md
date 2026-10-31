# Plan 05 — "Back in a bit" and deafen, shared through the server

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`). The Go API is `services/api`; the desktop app is
`apps/desktop`. Read `docs/plans/voice-overlay/README.md` first.

Two pieces of per-person call state that everyone in the call should see, and that Raven
can't share today:

- **Back in a bit:** a marker you set (from the overlay, plan 03, and from the app) when
  you step away: a cutscene, food, the door. Others see "Back in a bit" on your avatar.
  It has **no time and no duration**, ever (`raven-ui` rule 9, presence is consent).
- **Deafened:** whether someone has turned off their sound. Today a client knows only its
  own deafen state; others can't tell that you can't hear them.

This plan is independent of plans 01–04 (README lane B) and can run beside them in its
own worktree. Plan 03 shows the overlay button once this is in.

## Before you start

- Load `raven-ui` (this adds a per-person state to the voice room and tiles; read rule 6
  and rule 9, `references/surfaces.md`, `references/writing.md`) and
  `raven-media-engine` (deafen lives in the media adapter).
- Read `services/api` enough to follow one existing session change end to end: for
  example `joinCallSession` → `broadcastSessionUpdate` → how the desktop client refetches
  `GET /nests/:id/session` (`useRavenShellData.ts`, `lib/apiEvents`).
- Build and app rules as in plan 01; the Go API must be running for the app (see
  `reference_raven_live_call_testing` in memory). Don't commit, push or deploy unless
  asked. Deploying the API to Saye is a separate step the user decides on (`saye` skill).

## What is true now

Line numbers are from 2026-10-26; verify them.

- `ParticipantSummary` (`services/api/internal/http/sessions.go` ~line 15) has
  `userId`, `username`, `displayName`, `joinedAt`. Participants are rows in
  `session_participants` (`internal/database/database.go` ~line 437; migrations live in
  Go in that package).
- Routes for a nest's call are in `internal/http/server.go` (~line 328–342), for example
  `POST /nests/:id/session/join`. `broadcastSessionUpdate(nestID, sessionID, type)`
  (`events.go` ~line 370) tells clients to refresh.
- Clients heartbeat every 5 s (`heartbeatNestActivity`).
- The desktop's `media.localDeafened` / `toggleDeafen` (`useRavenMediaAdapter.ts`) are
  local only. The overlay snapshot's `deafened` is local only (plan 02).
- The voice room (`components/media/LiveMediaStage.tsx`, `VoiceRoom`/`VoiceStrip`) and
  `MediaTile.tsx` show muted and connection captions per person.

## Design

### Server

- Add `away` and `deafened` (both boolean, default false) to `session_participants`,
  with a migration that old databases run once.
- New route: `POST /nests/:id/session/state` with `{ away?: boolean, deafened?: boolean }`.
  It updates the caller's open participation in that nest's current session only (404 or
  409 if they're not in it; match how the other session routes answer). It never touches
  anyone else's row. Then `broadcastSessionUpdate(..., "participant.state")`.
- Return both fields on `ParticipantSummary` (always present). A new participation starts
  with both false, so rejoining clears Back in a bit.
- Tests next to `sessions_test.go`: setting, clearing, someone not in the call,
  rejoining resets, and the broadcast.
- Old clients ignore the new fields; nothing needs the minimum-client-version gate.

### Client

- `lib/api.ts`: the two fields on the participant type (optional, so an old server reads
  as "not supported") and a `setCallState(nestId, patch)` method.
- **Support check:** the server supports this when the session's participants carry the
  `away` field. Expose that as a boolean where the dock and stage can read it, and send
  it to the overlay as `awaySupported` on the snapshot (plan 03 added the field; add it
  here if 03 hasn't run, Rust and TypeScript, `#[serde(default)]`).
- **Deafened:** the media adapter sends `deafened` when it changes during a call and once
  after joining. Debounce quick toggles to the last value (about 300 ms). A failure is
  silent: it's a courtesy to others, not something the user must act on.
- **Back in a bit:** a `setAway(away)` on the media adapter (or the shell data, wherever
  the other session calls are). It clears itself, sending `away: false`, when you unmute
  or when you talk with the mic on (use the local speaking signal the dock already has),
  and when you leave the call.
- **Where you set it in the app:** the overlay (plan 03) and one place in the main
  window. Look at the dock's call chip first; if it has a menu, add "Back in a bit" there.
  Don't add a new dock button (rule 7). If there's no natural place, ask the user.

### What people see

Per rule 6, the state must read in both the voice room and tiles, and only when worth
noticing:

- **Deafened:** the slashed headphones in `destructive`, where muted shows today. A
  deafened person is also muted in practice; show deafened, not both.
- **Back in a bit:** "Back in a bit" as the person's caption in `muted-foreground`, and
  their avatar slightly quieter (not dimmed text; use the existing idle look if there is
  one). No clock, no "for 5 minutes", no time since.
- **Yourself:** while you're Back in a bit, your own place in the room says so too, so you
  know others see it.
- Overlay: fill `away` and `deafened` per participant in `buildVoiceOverlaySnapshot` from
  the session summary. Plan 02 already shows them by priority.

## Checking your work

1. `go test ./...` in `services/api`; `bun run build`, `bun test`, the `raven-ui` sweep
   in `apps/desktop`.
2. With the API and two clients in one call (`reference_raven_live_call_testing`): deafen
   on one, the other's voice room, tiles and overlay show it, and undeafening clears it;
   Back in a bit from the app (and from the overlay if plan 03 is in) shows on the other
   client; it clears on unmute, on talking, and on leaving; rejoining starts clear.
3. Against an older API without the route, the button stays hidden and nothing errors.
4. Report what you saw and what you couldn't check. Say plainly that the API change needs
   deploying to Saye before friends see it, and that it's the user's call when.
