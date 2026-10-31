# Voice overlay redesign: implementation plans

Soroush didn't like the voice overlay (`apps/desktop/src/components/VoiceOverlayWindow.tsx`)
and asked for a redesign, with features Discord's overlay doesn't have. The ideas and
mockups were worked out with him on 2026-10-26. These plans are the result. Each plan is
written for one Claude session (Opus, medium effort) and is self-contained: context, what
is true in the code, the design, and how to check the work.

To start a session, give it one line:

> Read and implement `C:\Users\Soroush Taheri\code\raven\docs\plans\voice-overlay\<file>`.

Use the absolute path. These files are untracked, so a session in a git worktree won't
have them in its own checkout. `prototype.html` in this folder is the clickable mockup
Soroush approved. Open it in a browser to see the card, its views and its hover controls.

## What was wrong

- The window is a fixed 280×360 (or 320×112) box. With two people in the call most of it
  is empty, and a transparent window on Windows still takes clicks across its whole
  rectangle, so there is an invisible patch over the game that can't be clicked through.
- Two awkward states: when idle, a 48px gap at the top where the header goes; on hover, a
  heavy header and a frosted panel.
- Clicking the overlay to drag it takes focus from the game, and dragging is all the
  overlay can do.
- Your own mute state is a 14px icon on a row like everyone else's. The one thing you need
  to know without looking ("can they hear me?") is the hardest thing to see.
- `deafened` is always `false` (`lib/voiceOverlay.ts`), the camera icon is drawn in
  `text-primary`, and "camera on" is shown at all, which the UI rules say not to draw.
  Horizontal mode drops names entirely.

## The design Soroush chose

**One card, one spot.** Everything about the call is in one card in one place on the
screen. You are a row in the same card (the footer of a column, the first avatar of a
row, behind a hairline), never a separate element somewhere else.

- **One speaking indicator:** the aqua ring around the avatar (`live`). The name gets
  brighter while the person talks. No audio waves, no second cue.
- **Views** (a setting): **Everyone** (default; a stable roster, order never changes),
  **Talkers first** (speakers get full rows on top, quiet people fold into a row of small
  avatars), **Only talking** (Discord's "who said that"; you stay in the card).
- **Keep a name after they stop talking:** Off, 3 or 6 seconds. Works with every view.
- **Shape follows the edge:** a row along the top or bottom of the screen, a column at the
  sides. Column or Row can be forced.
- **Click-through by default, never takes focus.** How you interact is a setting:
  **Never**, **When I point at it** (default, after a short rest on the card),
  **While I hold a key** (hold the show/hide key; a quick tap still shows or hides).
- **Controls under your row while interacting:** Mute, Deafen, Back in a bit. Scroll on a
  person to change their volume, for you only.
- **Heads-up lines, each with its own switch:** "You're muted" when you talk while muted;
  weak connections (yours and other people's; your own "Reconnecting" always shows);
  people joining and leaving; knocks; messages from text rooms in the tree you're calling
  in (off by default).
- **Back in a bit:** a marker everyone in the call sees on your avatar, with no time or
  duration. It clears itself when you talk or unmute.

Dropped on purpose: "lean in" (Soroush didn't want it); talk-time stats, "who talks most"
and durations (presence is consent, not telemetry); the ambitious ideas (screen-share
peek, position per game, live captions), parked for later.

## Decisions (2026-10-26)

1. Pointing at the card makes it clickable only after the pointer **rests on it for about
   300 ms**. Passing over it does nothing, so games with a cursor (strategy games, MOBAs)
   don't lose clicks to it.
2. Hold-to-interact uses **the same key as show and hide**: a quick tap shows or hides,
   holding makes it clickable.
3. **Your own "Reconnecting" always shows**, even with "Show weak connections" off. Other
   people's weak connections follow the switch.
4. **Back in a bit and other people's deafen state go through the server** as their own
   plan (05). Your own deafen is known locally and is fixed in plan 02.
5. The old "Name background" setting becomes the card's **Background** with the same
   three values, so saved settings carry over. The old "Layout" setting becomes **Shape**:
   saved `vertical` → Column, `horizontal` → Row, and new installs get **Follow edge**.
6. **Every feature that can be switched off has a switch** in Settings › Voice overlay.
   The final layout of that section is below; each plan adds its own rows.

## The Voice overlay settings section, when all plans are done

| Group | Row | Values (default first) | Plan |
|---|---|---|---|
| Showing the overlay | Overlay | on / off | exists |
| | Show and hide | hotkey, default Alt+F8 | exists |
| | Show when I join a call | off / on | 02 |
| Who it shows | View | Everyone / Talkers first / Only talking | 02 |
| | Keep a name after they stop talking | 3 seconds / 6 seconds / Off | 02 |
| | Names | Always / While talking / Never | 02 (replaces "Show names") |
| Look | Shape | Follow edge / Column / Row | 01 (replaces "Layout") |
| | Size | Medium / Small / Large | 01 |
| | Background | Light / Strong / Off | 02 (renames "Name background") |
| | When nobody is talking | Stay as it is / Fade a little / Fade a lot | 02 |
| Using the overlay | Interact | When I point at it / While I hold the key / Never | 01 |
| | Buttons on the overlay | Mute, Deafen, Back in a bit (each on/off) | 03 |
| | Scroll on a person to change their volume | on / off | 03 |
| Heads-up | Tell me when I talk while muted | on / off | 02 |
| | Show weak connections | on / off | 02 |
| | Show people joining and leaving | on / off | 02 |
| | Show knocks | on / off | 04 |
| | Show messages | Off / From this tree | 04 |

Wording follows `raven-ui` › `references/writing.md`; "tree" comes from `data.labels`.

## The plans

| Plan | What | Kind | Size |
|---|---|---|---|
| [01](01-native-window.md) | Size to content, anchor and snap to edges, click-through, never take focus, interaction modes, Shape, Size | Rust (`overlay.rs`) + a thin layer in the overlay window | L |
| [02](02-one-card.md) | The card itself: views, rows, you, statuses, joins and leaves, muted nudge, the snapshot fields it needs | React + `lib/voiceOverlay.ts` + the snapshot struct in Rust | L |
| [03](03-interact-controls.md) | Mute, Deafen, Back in a bit buttons, scroll for volume, the action channel to the main window | React + Rust event + `DeviceDock.tsx` | M |
| [04](04-heads-up.md) | Knocks and text-room messages in the card | React + `DeviceDock.tsx` / chat hooks | S–M |
| [05](05-back-in-a-bit-and-deafen.md) | Back in a bit and deafen shared through the server, shown in the app's voice room and tiles | Go API + client API + stage UI | M |

## Order and parallel lanes

```
Lane A  overlay   01 → 02 → 03 → 04     (all edit VoiceOverlayWindow.tsx, voiceOverlay.ts, overlay.rs)
Lane B  server    05                    (Go + lib/api.ts + LiveMediaStage/MediaTile; no overlap with 01–02)
```

03's Back in a bit button needs 05. If 05 hasn't landed when 03 runs, 03 builds the
button behind a check for the server field and leaves it hidden; 05 then turns it on.

If you can only run one at a time: **01, 02, 05, 03, 04**.

## Known limits (tell Soroush; don't try to work around them)

- **Exclusive-fullscreen games don't show any normal window**, the overlay included. The
  overlay works over borderless-windowed and windowed games. Same as today.
- **Games that lock and hide the cursor** (most shooters) keep it locked while they have
  focus, and the overlay never takes focus. You can't point at the card there, in either
  interaction mode, without alt-tabbing. Discord gets around this by injecting into the
  game, which Raven doesn't do. Everything that doesn't need a click (the card, heads-up
  lines, the muted nudge) still works.
- The overlay is Windows only, as today (`overlay_supported()`).

## Rules that apply to every plan

- Load `raven-ui` before touching anything the user sees. Its boundary "do not change the
  overlay's text sizes or row heights without changing the Rust side" is lifted by these
  plans **only** for the changes they describe, which come with the Rust side.
- Changing the overlay wire contract (`lib/voiceOverlay.ts`, the commands and structs in
  `src-tauri/src/overlay.rs`) is approved for what these plans describe. The snapshot is
  stored and re-emitted by Rust as a typed struct: **a field added in TypeScript but not
  in `VoiceOverlaySnapshot`/`VoiceOverlayParticipant` in Rust is silently dropped.** Add
  both, with `#[serde(default)]`.
- Settings are saved by Rust to `voice-overlay-settings.json`. Every new field has a
  default, and old files must load (there is a test for legacy settings; extend it).
- Motion: brief and soft (`raven-ui` rule 12). Rows arriving, leaving and reordering
  animate; nothing pulses, blinks or loops. Reduced motion turns it off.
- Only one Raven dev app and one Rust build at a time (the shared `%USERPROFILE%\rv`).
  Copy `.claude/skills` and `.env` into a worktree before starting a session there.
- Nothing is committed, pushed or released unless Soroush asks.
