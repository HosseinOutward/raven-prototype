# Plan 02 — A changed profile picture shows everywhere, at once

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`). The desktop app is in `apps/desktop` (React in
`src`). The Go API is in `services/api`.

The v0.1.4 closed alpha reported: **"changed profile picture > overlay shows the previous
one."** The voice overlay is only where it was noticed. The cause is everywhere, and other
people are affected as well.

## Before you start

- Load `raven-ui` (the change shows in many views) and read
  `references/verifying.md`. The voice overlay window is natively sized; don't change its
  layout.
- The server is deployed on Saye behind ArvanCloud. If you need to check how the CDN
  treats `/v1/media/*`, load the `saye` skill. Don't deploy unless the user asks.
- If you are in a git worktree, `.claude/skills` and `.env` are gitignored, so they are
  missing there. Copy both from `C:\Users\Soroush Taheri\code\raven` and run `bun install`
  in `apps/desktop`.
- Only one Raven dev app can run at a time. Check before starting it, and if one is
  running, ask the user rather than stopping it.
- Don't commit, push or release unless the user asks.

## What is true now

Line numbers are from 2026-10-17; verify them.

- **The server caches avatars for five minutes.**
  `services/api/internal/http/profile_media.go:32` `sendStoredAvatar` serves
  `GET /v1/media/users/:id/avatar` with `Cache-Control: public, max-age=300`, whether or
  not the URL carries a `?v=`.
- **Each upload stores a new object key**, `users.avatar_object_key`
  (`profile_media.go:56`, `replaceAvatarKey`). The upload responds with a versioned route,
  `userAvatarRoute(id, now)` (`profile_media.go:148, 163`).
- **The client builds avatar URLs in one place**, `api.userAvatarUrl(userId, version = "")`
  (`apps/desktop/src/lib/api.ts:493`). Only two callers pass a version: the dock's own
  avatar (`shells/ravenv1/DeviceDock.tsx:375`) and the Profile page
  (`shells/ravenv1/UserSettings.tsx:219`), both with `data.user.updatedAt`. That is why
  *your own* picture updates there and nowhere else.
- **Every other caller is unversioned.** These include:
  - the voice overlay snapshot (`lib/voiceOverlay.ts:200`);
  - the stage (`components/media/LiveMediaStage.tsx:462, 530, 572`);
  - tiles (`MediaTile.tsx:154`);
  - chat (`components/chat/*`);
  - the inbox, search, knock toasts, the person page;
  - `AvatarStack` and `PersonAvatar` in `shells/ravenv1/atoms.tsx`.

  A mounted `<img>` never re-fetches. Even after the cache expires, a view keeps the old
  picture until it remounts.
- **Other people are affected.** Nothing tells another client that someone's picture
  changed, so they see the old one for at least five minutes, and in live views until
  something remounts.
- **The voice overlay is a separate WebView with its own cache.** It takes `avatarUrl`
  from the snapshot the main window sends (`components/VoiceOverlayWindow.tsx:278`).
- **There is a live event stream.** `services/api/internal/http/events.go`: `LiveUpdate`
  (line 70) has `Type`, `TreeID` and `ActorID`. There are `publishTo` audiences
  (`publishTreeTo`, `publishToUser`), and the client consumes it in
  `shells/ravenv1/useRavenShellData.ts` (around line 409) via `lib/eventStream.ts`.

## Design

Two parts, so that the first load is always right and live views update on their own.

1. **Revalidation for unversioned URLs (server).**
   - Serve unversioned avatar URLs with `Cache-Control: no-cache` and an `ETag` derived
     from the object key, and answer `If-None-Match` with 304. Any fresh load is then
     correct and costs one small request.
   - Serve URLs that carry `?v=` as `public, max-age=31536000, immutable`.
   - Do the same for tree and server avatars. They have the same shape.
   - Check that ArvanCloud passes `ETag` and 304 through for `/v1/media/*`, or that it
     doesn't cache those paths. If it rewrites caching, say so; fixing CDN rules needs the
     user's go-ahead.
2. **A version that changes when the picture changes (live).**
   - On a user avatar upload, publish a `LiveUpdate` (for example `profile.avatar`) with
     `ActorID` set to the user. Send it to everyone who can see them: members of the
     trees they share, and their friends. Reuse the existing audience helpers, and keep
     it to people who can already see this user.
   - Add a version field to the update, or reuse `At`.
   - On the client, keep a small avatar-version map (`userId → version`) in a `.ts`
     module, not a component file. Have `api.userAvatarUrl(id)` read it when no version
     is passed, so every existing caller gets fresh URLs without being edited.
   - React views must re-render when the map changes: a tiny external store plus
     `useSyncExternalStore` in `Avatar`, or a hook the callers already pass through. Pick
     the smallest change that makes mounted `<img>`s switch.
   - Your own upload bumps your entry locally, right away.
   - The overlay snapshot is built in the main window from `api.userAvatarUrl`, so it
     picks up the version as long as the snapshot is re-sent when the URL changes. Check
     that the snapshot isn't deduplicated in a way that hides this.
   - Do the same for tree avatars if it falls out naturally. Say so if you leave them.

Wire contract note: a new `LiveUpdate` type and new cache headers are additions, not
changes. Older clients ignore an unknown event type; check that `eventStream.ts` does.
Don't change existing payloads.

## Checking your work

- Go tests for the cache headers (unversioned gets `no-cache` and an `ETag`, a matching
  `If-None-Match` gets 304, versioned gets immutable), and for the event's audience.
- `bun run build`, `bun test` (a test for the version map and `userAvatarUrl`), and
  `sweep.ts` should print Clean.
- In the real app, with the voice overlay on and a call open:
  - Change your picture. Without restarting, it updates in the dock, the stage, the
    overlay and your chat messages. Screenshot the overlay.
  - With a second signed-in client (the browser test bot from `raven-media-engine`'s
    testing reference, or a second account if one exists), the other person sees the new
    picture within a second or two, in the sidebar, the stage and chat. If you can't run
    a second client, say so plainly. Don't imply it was checked.
- Report what you saw and, separately, what you could not check (the CDN, a second
  person).
