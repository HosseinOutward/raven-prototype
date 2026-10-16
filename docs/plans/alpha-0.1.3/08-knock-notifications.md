# Plan 08 — Windows notifications for profile knocks (off by default)

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`, desktop app in `apps/desktop`). A **profile knock**
is how one person reaches another ("Sara wants to reach you"). It is sent from someone's
profile page (`useProfileKnock`) and appears in the sidebar's "Reaching you" section and
in the inbox.

From the v0.1.3 closed alpha: testers wanted OS notifications for messages and knocks.
Soroush decided:

- **Only profile knocks for now, off by default.** Message notifications are parked for a
  later plan.
- Until then, unread messages stay silent: no sounds, no OS notifications (his
  2026-10-11 decision).

So build knock notifications in a way the later message notifications can join, without
building them now.

## Before you start

- Load `raven-ui` and read `references/surfaces.md`, `references/writing.md`,
  `references/verifying.md`.
- If you are in a git worktree, `.claude/skills` and `.env` are gitignored, so they are
  missing there. Copy both from `C:\Users\Soroush Taheri\code\raven`, run `bun install` in
  `apps/desktop`, and set `RAVEN_REPO` to your worktree for the skill's scripts.
- `CARGO_TARGET_DIR` is `%USERPROFILE%\rv`, shared by every checkout. Only one Raven dev
  app can run at a time. Check before starting it, and if one is running, ask the user
  rather than stopping it.
- Plan 07 also adds a section to `UserSettings.tsx`. If it has landed, build on it.
- Don't commit, push or release unless the user asks.

## What is true now

- **How knocks arrive.** The event stream (`lib/eventStream.ts`, `subscribeNestUpdates`
  in `shells/ravenv1/useRavenShellData.ts:398`) triggers a home refresh, and knocks
  arrive in `home.pendingKnocks`.
  - `useRavenShellData.ts:801–842` turns them into pending items.
  - Incoming only: `knock.fromUserId !== me`.
  - The context reads "knocked on <nest>" when `nestName` is set, otherwise "wants to
    reach you".
- **Which knocks count.** Check in the Go API (`services/api`, search for knock) how a
  profile knock differs from a knock tied to a nest, and notify only for the profile kind
  Soroush meant. If the distinction is unclear, ask.
- **The plugin is already there.** `tauri-plugin-notification` is registered
  (`src-tauri/src/lib.rs:214`), and the tray already sends one notification through
  `NotificationExt` (`src-tauri/src/tray.rs:837`). There is no JS notification package in
  `package.json`. Prefer a small Rust command that reuses the tray's pattern over adding
  the npm package and a capability.
- **Where the window can be.** Closing the main window hides it to the tray
  (`tray.rs:224`).
- **Settings categories** are in `shells/ravenv1/UserSettings.tsx:44–63`.
- **Storage.** Per-device preferences live in `localStorage` (pattern:
  `raven.mediaSettings` in `useRavenMediaAdapter.ts:67`). Don't add fields to
  `/v1/preferences`, which is a wire contract with the Go API.

## What to build

- **Setting.**
  - A new Settings category, "Notifications", in the app group. It is the place the
    parked message notifications will join later.
  - It holds one switch: "Knocks" with a hint such as "Show a Windows notification when
    someone knocks on you while Raven is in the background." Off by default.
  - Word it through `references/writing.md`.
  - On Linux and macOS, the same switch should work if the plugin supports it. Don't claim
    it was tested there.
- **When to notify.** The setting is on, a *new* incoming profile knock appears, and
  Raven's main window is not focused (hidden to the tray, minimized, or behind another
  app).
  - Never for knocks that already existed at startup or sign-in (track seen knock ids and
    seed them on first load, so a restart doesn't replay old knocks).
  - Never twice for the same knock.
- **Presence.** If presence is "Do not disturb" or an equivalent (check `PRESENCE` in
  `shells/ravenv1/state.ts`), don't notify. Say in the hint that Do not disturb silences
  it, if that state exists.
- **Content.** Title: the person's name. Body: "wants to reach you" in the app's wording.
  No other details.
- **Clicking the notification.**
  - Make it bring Raven to the front and open that person's page (or wherever "Reaching
    you" leads) if the plugin lets you handle activation on Windows.
  - If it doesn't (desktop activation callbacks are limited in tauri-plugin-notification
    v2), clicking should at least bring Raven forward through the app's registered
    identity. Report exactly what happens.
- **Timing.** The notification must not wait on anything slow. The home refresh already
  happens; diff the knocks there.
- **Sign-out.** It clears the seen-knock state.

## Checking your work

- `bun run build`, `bun test` (unit-test the "which knocks are new" diff, including
  startup seeding and repeated refreshes, in a `.ts` helper), `sweep.ts` should print
  Clean; Rust tests if you add a command.
- In the real app, with a second account driven through the API (`references/verifying.md`
  explains creating a user, making them a friend and acting through the API):
  - send a profile knock while Raven is hidden to the tray: a notification appears;
  - send one while Raven is focused: none appears;
  - with the setting off: none;
  - restart Raven with a pending knock: no replay;
  - click the notification: report what happens.
- Note that in `tauri dev` Windows may attribute toasts to a different app identity than
  the installed build. If attribution or clicking differs from what an installed build
  would do, say so and don't guess.
- Tell the user about any test accounts or knocks you leave in the local database. Report
  what you saw and what you couldn't.
