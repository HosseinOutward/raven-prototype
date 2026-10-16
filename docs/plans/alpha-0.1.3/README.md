# Alpha 0.1.3 feedback: implementation plans

These plans come from the closed alpha of v0.1.3 (about 8 hours of calls). The feedback
was assessed against the code on 2026-10-16, and Soroush made his decisions. Each plan is
written for one Claude session (Opus, medium effort). It is self-contained: the context,
what is true in the code, the design, and how to check the work.

To start a session, give it one line:

> Read and implement `C:\Users\Soroush Taheri\code\raven\docs\plans\alpha-0.1.3\<file>`.

Use the absolute path. These files are untracked, so a session in a git worktree won't
have them in its own checkout.

## The plans

| Plan | Items from the alpha list | Kind | Size |
|---|---|---|---|
| [01](01-sidebar-frame-and-quick-fixes.md) | Resize sidebar · collapse/expand placement · overlay broken avatar · "Add a source" dropdown layout | UI | S |
| [02](02-release-mic-on-leave.md) | Sound card still capturing after leaving | Audio engine | S–M |
| [03](03-video-frame-rate-and-encoder.md) | Actual fps lower than requested · which encoder and GPU are used · per-stream stats (engine side of "share specs") | Video engine | M |
| [04](04-watch-screen-shares.md) | Opt-in Watch, several streams at once · Don't watch cameras · share specs for the viewer (UI) | Engine + stage UI | M–L |
| [05](05-voice-room-sources-and-motion.md) | A separate entry per extra audio source · join and leave animation | Stage UI | M |
| [06](06-friends-and-groups.md) | Friends vs Messages confusion · text nests vs voice nests in the sidebar | Sidebar UI | M–L |
| [07](07-dock-arrangement-and-leave-confirmation.md) | Rearrange dock buttons · optional leave confirmation | Dock UI | M |
| [08](08-knock-notifications.md) | Windows notifications for profile knocks (off by default) | Shell + small Rust | S–M |

Parked by Soroush: spatial audio; notifications for messages; a hardware encoder or GPU
picker (plan 03 gathers the evidence first).

## Order and parallel lanes

Plans in the same lane edit the same files, so run them one after another. Different
lanes can run at the same time.

```
Lane A  media    02 → 03 → 04 → 05      (Rust + stage; 04 needs 03's stats command)
Lane B  sidebar  01 → 06                (both edit Sidebar.tsx and RavenShellV1.tsx)
Lane C  shell    07 → 08                (both add to UserSettings.tsx)
```

If you can only run one at a time, this order puts the most-felt fixes first:
**02, 01, 03, 06, 04, 07, 08, 05**.

## What limits parallel sessions on this machine

- **One app at a time.** Only one Raven dev app can run (single-instance plugin, CDP port
  9223). Each plan tells its session to check before starting the app and to ask you if
  another one is running. Expect the live checks to take turns.
- **One Rust build at a time.** `CARGO_TARGET_DIR` is `%USERPROFILE%\rv`, shared by every
  checkout. Two Rust-building sessions block each other on Cargo's lock. Lane A is the
  Rust lane; plan 08 adds at most a small command.
- **Worktrees miss gitignored files.** `.claude/skills` (the `raven-ui` and
  `raven-media-engine` skills) and `.env` are gitignored, so a fresh worktree lacks them.
  The plans tell the session to copy them in. Better: copy them *before* starting the
  session, so the skills are discovered when it starts.
  - Run from the worktree root, in PowerShell:
    `Copy-Item -Recurse "C:\Users\Soroush Taheri\code\raven\.claude\skills" .claude\skills; Copy-Item "C:\Users\Soroush Taheri\code\raven\.env" .`
- **Same checkout.** Two sessions in the same checkout (no worktree) step on each other:
  `tauri dev` hot-reloads the other session's edits and rebuilds on its Rust changes.
  Use worktrees for anything run in parallel.
- **Nothing is committed.** Each plan says to leave work uncommitted unless you ask. With
  worktrees, tell each session to commit on its branch when you're happy, then merge.
