# Alpha 0.1.4 feedback: implementation plans

These plans come from the closed alpha of v0.1.4. The seven reports were checked against
the code on 2026-10-17, and Soroush made his decisions. Each plan is written for one
Claude session (Opus, medium effort). It is self-contained: the context, what is true in
the code, the design, and how to check the work.

To start a session, give it one line:

> Read and implement `C:\Users\Soroush Taheri\code\raven\docs\plans\alpha-0.1.4\<file>`.

Use the absolute path. These files are untracked, so a session in a git worktree won't
have them in its own checkout.

## The reports, ranked

| Priority | Report | Cause | Plan |
|---|---|---|---|
| P1 | A minimized app: its preview and screen share are broken | The picker reads the minimized title-bar box as the window's size, and that size becomes the share's output size. Nothing handles a window being minimized mid-share. | [01](01-minimized-window-share.md) |
| P1 | A changed profile picture: the overlay shows the old one | Avatar URLs are unversioned almost everywhere, with a 5-minute public cache. Nothing tells other clients about the change. | [02](02-fresh-avatars.md) |
| P1 | Stream info does nothing | Likely a focus handoff from the closing menu that dismisses the popover. Reproduce first. | [03](03-settings-and-popover-fixes.md) A |
| P2 | Custom quality should inherit the preset and keep the aspect ratio | The draft always starts from the default profile. A share only uses W×H as a pixel budget. | 03 E |
| P2 | No success after saving hotkeys | No saved or dirty state. | 03 C |
| P3 | The info tooltip shows when Network activity is clicked | The popover autofocuses the ⓘ button, and the tooltip opens on focus. | 03 B |
| P3 | Device buttons order is in the wrong place | It sits under Audio and video. | 03 D |

Decisions (2026-10-17):

- Starting a share of a minimized app quietly un-minimizes it.
- When the shared app is minimized mid-share, keep the last picture and tell both sides
  that sharing is paused.
- Only the device-button order moves to Appearance.
- The aspect-ratio lock applies to the camera's custom quality too.

| Plan | Kind | Size |
|---|---|---|
| 01 | Video engine (Rust) + dock, tile, picker UI | M |
| 02 | Go API + client avatar URLs | M |
| 03 | UI only | S–M |

## Order and parallel lanes

```
Lane A  media + UI   01 → 03     (both edit MediaTile.tsx, DeviceDock.tsx, VideoPickers.tsx)
Lane B  avatars      02          (Go + lib/api.ts + Avatar; no overlap with lane A)
```

If you can only run one at a time: **01, 03, 02**. 03 is the quickest win, so it can go
first if you want something in testers' hands sooner.

The limits from `../alpha-0.1.3/README.md` still apply:

- one dev app at a time;
- one Rust build at a time (the shared `%USERPROFILE%\rv`);
- copy `.claude/skills` and `.env` into a worktree before starting its session;
- use worktrees for anything run in parallel;
- nothing is committed unless you ask.
