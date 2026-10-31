# Plan 02 — The one card

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`, desktop app in `apps/desktop`). Read
`docs/plans/voice-overlay/README.md` first, then open `docs/plans/voice-overlay/prototype.html`
in a browser: it is the clickable mockup Soroush approved on 2026-10-26. This plan builds
that card for real.

Plan 01 must be done first: it made the window size itself to the card, anchor to an
edge, go click-through, and send `voice-overlay-interaction-changed`. Check that it
landed (`overlay_set_content_size` exists in `src-tauri/src/overlay.rs`). If it hasn't,
stop and tell the user.

## Before you start

- Load `raven-ui`; read `references/design-system.md` (tokens, motion) and
  `references/writing.md`. Load `raven-media-engine` before reading the media adapter.
- Build and app rules as in plan 01 (shared `%USERPROFILE%\rv`, one dev app, worktree
  setup). Don't commit unless asked.

## What is true now

Paths are under `apps/desktop`. Line numbers are from 2026-10-26; verify them.

- `src/components/VoiceOverlayWindow.tsx` renders the overlay (after plan 01, without the
  header). Rows show a 32 px avatar with the speaking ring (`.raven-overlay-speaking` and
  `speakingGlowStyle`), the name in an optional pill (`NAME_BACKGROUND_CLASS`) and up to
  four icons: muted, deafened, camera (in `text-primary`), screen.
- The snapshot is built in the main window by `buildVoiceOverlaySnapshot`
  (`src/lib/voiceOverlay.ts`) from an effect in `src/shells/ravenv1/DeviceDock.tsx`
  (~line 309), and sent with `overlay_update_snapshot`. Rust stores it in a typed struct
  (`VoiceOverlaySnapshot`, `VoiceOverlayParticipant` in `overlay.rs`) and re-emits it to
  the overlay. **Fields missing from the Rust struct are dropped.**
- `deafened` is hard-coded `false`. The local value exists: `media.localDeafened`.
- Talking while muted is already detected for the dock: `useTalkingWhileMuted(...)` in
  `DeviceDock.tsx` (~line 590), with `useMutedHint` showing it once per mute for 6 s.
- Connection quality per person exists on the video side (`VideoConnectionQuality` in
  `lib/video.ts`, used by `MediaTile.tsx` and `LiveMediaStage.tsx`'s
  `ConnectionCaption` as "Weak connection" / "Connection lost"). Find where those read it
  from `media.videoState` and use the same source.
- Your own reconnecting: `media.reconnecting` (`useRavenMediaAdapter.ts`).
- Participant order today is the session's participant order, then speakers first in
  horizontal mode (`visibleHorizontalVoiceOverlayParticipants`).

## Design

### The card

One card holds the whole call. Use the prototype for proportions; the Raven tokens for
colour.

**Column** (side of the screen):

```
╭───────────────────────────╮
│ (◯) Mina                  │   ← speaking: aqua ring on the avatar, name brighter
│ (●) Arash                 │
│ (●) Kaveh        ▂▄ weak  │   ← one trailing status, only when worth noticing
│ (●) Nazanin          🎙̸  │
│ ───────────────────────── │   ← hairline
│ (●) You     🎙̸ You're muted│   ← you: always the last row of the same card
╰───────────────────────────╯
```

**Row** (top or bottom edge): you first, a short vertical hairline, then everyone else,
left to right. Speakers widen to show their name when the Names setting says so.

- **One speaking cue:** the aqua ring (`live`) and the name going from
  `muted-foreground` to `foreground`. No waves, no second indicator. Keep
  `speakingGlowStyle` for the ring's strength.
- **Statuses, one per row, in this order of priority:** connection lost, deafened,
  muted, weak connection, Back in a bit (plan 05 fills that in). Cut channels are a red
  slashed icon (`destructive`), connection problems `warning`, Back in a bit plain
  `muted-foreground` words. Drop camera and screen icons (rule 6: not worth noticing next
  to a voice row). Keep the fields in the snapshot.
- **Your row says things in words**, because it's the one you most need to read at a
  glance:
  - muted: the red slashed mic (no words);
  - talking while muted: "You're muted" in words, using the same once-per-mute, 6-second
    rule as the dock (reuse its signal; send it in the snapshot as `localMutedHint`);
  - deafened: slashed headphones and "Deafened";
  - reconnecting: "Reconnecting…" in `warning`, then on a second line or as the row's
    caption: "They can't hear you." This one **always** shows, whatever the switches say
    (README decision 3);
  - your own weak connection: "Weak connection".
- **Order:** stable, by when people joined the call (the session's `joinedAt`), not by
  who is talking, in the Everyone view.
- **Not in a call:** when shown by the hotkey outside a call, the card is one line in
  `muted-foreground`: "Not in a call". Use `data.labels` wording if you have it in the
  snapshot (`locationLabel`); "call" otherwise.

### Views

Setting `view`: `"everyone"` (default) | `"talkersFirst"` | `"onlyTalking"`.

- **Everyone:** every participant as a row, stable order, you last.
- **Talkers first:** people talking (and lingering, below) as full rows at the top, in
  the order they started talking. Everyone else folds into one line of small avatars
  (Small size's avatar) with their status as a small badge on the avatar. You stay as the
  last row.
- **Only talking:** only people talking or lingering, then you. When nobody is, the card
  is your row plus one line in `muted-foreground`: "4 others here" (never "0": with
  nobody else, no line at all).

**Keep a name after they stop talking** (`lingerSeconds`: 3 default, 6, or 0 for off):
someone who stops talking stays in their place in Talkers first and Only talking for that
long, their name fading back to `muted-foreground`. In Everyone, it just delays the
name dimming. Talking again within the window cancels the fade.

**Names** (`names`: `"always"` default | `"whileTalking"` | `"never"`; replaces
`showNames`, which loads as `always`/`never`): whether a row shows its name. With
`never`, rows are avatars only and the card narrows; your row's words (muted, reconnecting)
still show, because they're a warning, not a name.

### Look

- **Background** (`background`, renamed from `nameBackground`, same values; old files
  load): the card's fill. Light ≈ black at 55%, Strong ≈ black at 80%, Off = no fill.
  With Off, give text a soft dark text shadow so it stays readable over a bright game.
  This is the one exception to "no shadows" in the overlay, for legibility only.
- **Size** (from plan 01): Small 12 px text / 20 px avatars, Medium 13 / 24, Large
  15 / 30. Never below 12 px. Register any new text size in `lib/utils.ts` (`raven-ui`
  trap).
- **When nobody is talking** (`quietFade`: `"none"` default | `"some"` | `"lots"`): after
  4 seconds with nobody talking, the card fades to 80% or 45% opacity. Someone talking,
  interaction starting or any heads-up line brings it back to full at once. Fade out over
  ~600 ms, back in over ~120 ms. With reduced motion, jump.
- **While interactive** (plan 01's event): the card gets the Strong fill whatever the
  setting, and a hairline outline, so it's clear it will take clicks. Plan 03 adds the
  controls.

### Joins and leaves

Switch `showJoinsAndLeaves` (on). Work it out in the overlay by comparing snapshots of the
same `nestId`; reset when the nest changes or the call ends, and don't announce the people
already there when the overlay first gets a snapshot, or your own arrival.

- Someone arriving: their row slides in (`animate-pop-in` or the shared sheet curve) and
  shows "joined" as a caption for 2.5 s.
- Someone leaving: their row stays 2 s with "left" in `muted-foreground`, then folds
  away.
- With the switch off, rows still animate in and out briefly, with no caption.

### Other switches this plan adds

- `mutedHint` (on): "You're muted" when you talk while muted.
- `showWeakConnections` (on): other people's weak or lost connection, and your own weak
  connection. Never hides your "Reconnecting…".
- `showOnJoin` (off): show the overlay when you join a call, and hide it again when you
  leave, but only if it was this setting that showed it. Do this in `DeviceDock.tsx` with
  `voiceOverlayCommands.show()` / `hide()` on the change of `media.phase` to and from
  `connected`.

### Snapshot changes

Add to `VoiceOverlayParticipant` (Rust and TypeScript, `#[serde(default)]`):
`connectionQuality` (`"good" | "poor" | "lost" | "unknown"`), `joinedAt` (string or
null). Fill `deafened` for the local participant from `media.localDeafened` (other
people's stay `false` until plan 05).

Add to `VoiceOverlaySnapshot`: `reconnecting` (bool), `localMutedHint` (bool).

Add every new setting to the Rust settings struct, view and patch, with defaults and the
legacy-file migration, and to `lib/voiceOverlay.ts`. Extend the Rust tests.

### Settings rows

Add to Settings › Voice overlay, in the README's groups: Show when I join a call; View;
Keep a name after they stop talking; Names; Background (renamed); When nobody is talking;
Tell me when I talk while muted; Show weak connections; Show people joining and leaving.
Use the wording in the README table; hints only where the row needs one (View: "Talkers
first lists who's talking and folds the rest into a row.").

### Where the code goes

Keep `VoiceOverlayWindow.tsx` for components. Put the pure logic (which rows to show for
a view, lingering, status priority, the join/leave diff) in a `.ts` file, for example
`src/lib/voiceOverlayView.ts`, with `bun test` tests. Delete what becomes unused
(`visibleHorizontalVoiceOverlayParticipants`, `NAME_BACKGROUND_CLASS`, the horizontal
`+N`).

## Checking your work

1. `bun run build`, `bun test`, the `raven-ui` sweep, `cargo test` for `overlay.rs`.
2. In the real app with a second participant (tone bot or second account): each view
   with people talking, lingering names, joins and leaves, your muted state and the
   "You're muted" nudge (talk while muted), deafen, each Size, Background and quiet fade,
   column and row, Show when I join a call. Screenshot the card in each view over a
   bright and a dark window.
3. Reconnecting: force it as `reference_raven_live_call_testing` describes (or drop the
   network briefly) and check your row says it with every switch off.
4. Report what you saw and what you couldn't check (other people's weak connection is
   hard to force; say so if you couldn't).

## As built (2026-10-29)

Built and checked in the dev app by injecting snapshots (`overlay_update_snapshot`) and
settings (`overlay_update_settings`). Where the build differs from the text above, this wins:

- **Logic lives in `src/lib/voiceOverlayView.ts`** (tests in `voiceOverlayView.test.ts`):
  `rowStatus`, `advanceTalkState`/`isTalkActive` (lingering), `selectCardRows` (the three
  views), `showsName`, `localSaying`, `diffRoster`, `quietOpacity`. Removed
  `visibleHorizontalVoiceOverlayParticipants`, `NAME_BACKGROUND_CLASS` and the horizontal `+N`.
- **Settings on the wire:** `names` (`always`/`whileTalking`/`never`), `background`, `view`,
  `lingerSeconds` (0, 3, 6; anything else loads as 3), `quietFade`, `mutedHint`,
  `showWeakConnections`, `showJoinsAndLeaves`, `showOnJoin`. Old files load: `showNames:false`
  becomes `names: never`, `nameBackground` becomes `background`.
- **`overlay_show` now returns a bool**: true when that call made the overlay appear. Show
  when I join a call (in `DeviceDock.tsx`) only hides again on leaving if it got `true`.
- **The "You're muted" hook moved** from `DockDeviceControls` up to `DeviceDock`, so the dock
  callout and the overlay's `localMutedHint` read one signal.
- **Row shape:** you first, a short hairline, then others; only people who are talking (or
  lingering) widen to show a name, whatever Names says except `never`. Statuses are small
  badges on the avatar. Your row's name is "You".
- **Lingering:** the ring stops with the voice; the name stays bright and the person keeps their
  full row for the linger time, then folds into the avatar line (Talkers first) or into
  "N others here" (Only talking). Talking again inside the window keeps their place.
- **Joins and leaves:** the first connected snapshot of a nest is the baseline; nothing is
  announced while you are reconnecting. A leaver stays 2 s with "left" (or 0 s without
  the switch), then pops out. Arrivals get `animate-pop-in` and "joined" for 2.5 s.
- **Quiet fade** only applies in a call; talking, any heads-up (reconnecting, your words,
  joins and leaves) or interaction brings the card back to full at once (120 ms in, 600 ms out).
- Weak connection uses lucide `WifiLow`, lost `WifiOff`, in `warning`; muted and deafened in
  `destructive`.

Seen in the app: Everyone, Talkers first and Only talking; Column and Row; Small, Medium,
Large; Background Light, Strong, Off; names Always, While talking, Never; lingering then
folding; joined and left captions then gone; the quiet fade opacity (0.8 and 0.45 after about
7 s of quiet, back to 1 the moment someone talks); "You're muted", Deafened, and
"Reconnecting… / They can't hear you." with every switch off; "Not in a call".

Not checked: Show when I join a call (needs a real call, and the dev app was signed out);
the Settings panel on screen; the bright-window text shadow for Background Off (the screenshots
show the overlay alone); the interactive Strong fill and outline; other people's real weak or
lost connection (injected only); a second monitor or a scale other than 100%.
