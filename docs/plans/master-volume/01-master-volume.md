# Plan 01 — Master volume: one fader for everything you hear

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`, desktop app in `apps/desktop`). This plan adds a
master volume: one fader that sets how loud everything Raven plays is. It covers every
incoming microphone, screen-share audio, app audio and Raven's own sound cues. It never
changes what anyone else hears.

## Why, and the rules that keep it clear

The Mixer has a fader per incoming track, plus Auto-level, which moves the microphone
faders to even people out. There is no way to turn all of Raven up or down. Today that
means the Windows volume, which also changes every other app.

Decided with Soroush (2026-10-31):

- **Each control does one job.**
  - **Per-track faders** set the balance between sources; **Auto-level** moves the
    microphone faders for you.
  - **Master volume** sets how loud all of it is.
  - **Deafen** ("Stop hearing people") is the on/off switch.

  Nothing moves another control. Turning the master down must never make Auto-level push
  people up, and must never put anyone on Manual.
- **It covers every source** Raven plays: mics, screen-share audio, app audio and sound
  cues, in a call or out of one. It does not touch what you send.
- **Auto-level's −23 LUFS target stays fixed and is not shown to users.** A target setting
  would be a second "make it louder" control next to this one. If testers later want
  "voices vs. shared audio", that is a separate group-fader layer (see Not in this plan).

## Before you start

- Load `raven-media-engine` (read `references/audio-engine.md`, `references/mixer-dsp.md`,
  `references/testing.md`) and `raven-ui` (`references/design-system.md`,
  `references/writing.md`).
- This plan builds on Auto-level, which is uncommitted on branch `claude/auto-level`.
  - The Mixer's "What you hear" section gets its `action` slot and Auto-level switch
    there.
  - Start after Auto-level is committed, or on top of that branch. Ask Soroush which if
    it is not obvious.
- Rust builds go through `.claude/skills/raven-media-engine/scripts/cargo.ps1`.
  `CARGO_TARGET_DIR` is `%USERPROFILE%\rv`, shared by every checkout.
- Only one Raven dev app can run at a time. If the installed Raven is open, ask before the
  live test.
- In a git worktree, copy `.claude/skills` and `.env` from the main checkout, and run
  `bun install` in `apps/desktop`.
- Don't commit, push or release unless asked.

## What is true now

Paths are under `apps/desktop`. Line numbers are from 2026-10-31; verify them.

**The output bus** (`src-tauri/src/audio/playback.rs`):
- `MixBus` (~300) holds the tracks, the cue voices, `sample_rate` and `muted`
  (an `AtomicBool`).
- `BusRenderer::render` (~346) runs inside the device callback:
  1. It sums the tracks.
  2. It mixes the cues that go silent with deafen (`mix_into(out, false)`).
  3. It ramps `master_gain` toward 0 or 1 with `apply_master_gain`, using
     `MASTER_RAMP_MS` = 6.
  4. It mixes the cues that are heard while deafened (`mix_into(out, true)`, e.g. your
     own mute toggle).
  5. It runs the bus limiter (`limit_bus`).
  6. It pushes the result to the echo canceller's reference (`self.reference.push_stereo`).

  "Master gain" there is only deafen, a 0/1 ramp.

**Deafen:**
- `AudioOutput::set_muted` (~585) stores the flag.
- The `audio_set_output_muted` command (`state.rs` ~1888) calls it and writes
  `session.output_muted`.
- The frontend calls `audioCommands.setOutputMuted` (`lib/audio.ts` ~503) from
  `useRavenMediaAdapter.ts` (~748, ~1085).

**Cues outside a call** don't use the bus:
- `play_cue_decision` (~640) renders `CueDecision::Detached(gain)` cues onto a one-off
  stream (`play_detached`).
- The speaker test tone uses `play_tones` (~1143), also on a one-off stream.

**Sound-cue settings** are a model to copy for a remembered output setting:
- The cue volume (0–1, default 0.7) lives in the app's media settings.
- `useRavenMediaAdapter.ts` handles it through `readMediaSettings` / `saveMediaSettings`,
  with `type MediaSettings` at ~1503.
- An effect pushes it to the engine with `audioCommands.setSoundCueSettings`.

**UI:**
- The dock's hear button has a "Speaker settings" menu, `OutputMenu` in
  `shells/ravenv1/DeviceDock.tsx` (~1228). It shows a device list and
  "Play a test sound".
- The Mixer's "What you hear" section is in `components/AudioMixerPanel.tsx` (~648). It
  shows one strip per person, with the Auto-level switch in the section's `action`.

**There is no meter for the whole bus.** Strips have pre-fader and post-fader meters
only.

## The design

### Engine

1. **One volume, held by `AudioOutput`, not only the bus.** Out-of-call cues and the test
   tone need it too.
   - Store it as linear gain in an `AtomicU32` (`f32` bits), set by
     `AudioOutput::set_volume_db(db)`.
   - Clamp to `OUTPUT_VOLUME_MIN_DB = −40` … `OUTPUT_VOLUME_MAX_DB = +6`; default 0 dB.
   - Put the constants and the clamp in `safety.rs`, next to `clamp_channel_gain`.
2. **In the bus, a second ramped stage after deafen, before the limiter.** The new
   order is:
   1. Tracks.
   2. Cues that are silenced by deafen.
   3. The deafen ramp (unchanged).
   4. Cues heard while deafened.
   5. **The volume ramp.**
   6. The limiter.
   7. The echo-canceller reference.

   Notes:
   - The volume ramp is linear per sample toward the new target over
     `VOLUME_RAMP_MS = 30`, so a fader drag never zips or clicks.
   - It covers both cue groups.
   - The limiter stays last, so +6 dB can never clip; it only leans on the limiter.
   - The canceller's reference stays "exactly what reached the speaker", now after the
     volume. Echo cancellation needs that. Check the existing reference test still
     holds.
3. **Detached cues and the test tone** multiply their gain by the same volume.
   - The test tone then plays at the level Raven will actually play, which is the point
     of the test.
   - Read the atomic when the sound starts. A drag during a 300 ms cue doesn't need to
     follow.
4. **A bus meter.**
   - `render` keeps the block's peak and sum of squares after the volume, before the
     limiter, in two atomics.
   - A reader swaps them out. Use `fetch_max` on the bits for the peak, which works for
     non-negative `f32`, and a CAS-add or a small `try_lock` for the sum. Nothing may
     block the callback.
   - Expose it as `session.output_meter: AudioMeterState`, the same shape strips use.
   - It is refreshed every 120 ms by the existing meter emit (`audio-meter-changed`).
     Read where that event is built and add the bus there. Don't add a new timer if one
     already runs; if none runs outside a call, the meter may read silent then, which is
     correct.
5. **Model and commands.**
   - `domain.rs`: `AudioSessionState` gains `output_volume_db: f32` and
     `output_meter: AudioMeterState`, next to `output_muted`.
   - `state.rs`: a command `audio_set_output_volume(volume_db)`, a copy of
     `audio_set_output_muted`. It calls `output.set_volume_db`, writes the session and
     emits `AUDIO_STATE_CHANGED_EVENT`. Register it in `src-tauri/src/lib.rs`.
   - `reset_after_disconnect` must keep the volume, as it keeps `output_muted`.
   - It must work with no call running: the engine applies it to detached cues.
6. **Auto-level is untouched.**
   - It measures each person before their fader, and the volume comes after the mix.
     There is nothing to change, but add a test (below) so it stays that way.
   - The command is not a track gain, so it can't put anyone on hold.

### Frontend

7. **`lib/audio.ts`:**
   - Add `outputVolumeDb` and `outputMeter` to the session type, and an
     `audioCommands.setOutputVolume(volumeDb)` wrapper.
8. **`useRavenMediaAdapter.ts`:**
   - Add `outputVolumeDb` to `MediaSettings`; normalise it with a clamp and fall back
     to 0.
   - Keep it in state and save it with `saveMediaSettings`, like `soundCues`.
   - Push it to the engine on mount and on change, with an effect like the cue-settings
     effect.
   - Expose `outputVolumeDb` and `setOutputVolume(db)` on the adapter state.
   - During a drag, send live values with the same draft-and-commit pattern the Mixer
     faders use. Save to settings only on commit.

### UI (load `raven-ui`)

9. **Mixer, "What you hear": an "Everything you hear" strip, first in the row,** with a
   divider before the people.
   - **Fader:** reuse the strip fader with the −40…+6 range. Check whether the fader
     component takes a range; if it is hard-wired to −60…+12, add a prop rather than a
     second fader.
   - **Meter:** shows `outputMeter`, the whole bus after the master.
   - **Value:** dB, as on the other strips. Double-click returns to 0, if the strips
     already do that.
   - **Its M button is deafen itself:** the same state and the same command as the dock
     button, so there is only one "hear nothing" switch.
   - **No Auto-level line.** Auto-level is for people only.
   - **Hint:** the section description gains one sentence: "Everything you hear sets how
     loud Raven is. The faders beside it set the balance between people." Fit it to the
     existing Auto-level wording rather than stacking two descriptions.
10. **Dock, "Speaker settings" menu: a "Volume" slider** between the device list and
    "Play a test sound".
    - It shows the same dB value.
    - It moves live, as the Mixer fader does, and saves on release.
    - Keyboard: arrows move 1 dB, Page Up/Down 6 dB, Home is −40 and End is +6. Follow
      whatever the existing sliders in the app do (the cue volume in `UserSettings.tsx`)
      if it differs.
11. **Words** follow `raven-ui`'s `writing.md`:
    - Use "Volume" in the dock and "Everything you hear" in the Mixer.
    - Never call it "Master" in the UI.
    - Sentence case. Text no smaller than 12 px.

## Tests

**Rust, `playback.rs`:**
- At −12 dB the bus output is 12 dB lower than at 0 dB, for tracks and for both cue
  groups, measured after the ramp has settled.
- Deafen still silences tracks and deafen-silenced cues at any volume. Your own
  mute-toggle cue is still heard, scaled by the volume.
- A step from 0 to −40 dB moves smoothly over about 30 ms, with no sample-to-sample jump
  larger than the old deafen ramp allows.
- +6 dB on a full-scale track never exceeds the limiter ceiling.
- The echo-canceller reference equals the speaker output at a non-zero volume.
- The bus meter reads about −12 dB lower at −12 dB.

**Rust, `state.rs`:**
- The volume clamps to −40…+6.
- It survives `reset_after_disconnect`.
- Setting it changes no strip gain and no Auto-level status.

**Bun:**
- `MediaSettings` normalisation: a missing value gives 0, values outside the range
  clamp, and a non-number gives 0.

**Checks:**
- `cargo.ps1 test --lib`, `cargo.ps1 clippy --lib` (no new warnings in `audio/`), and
  `bun test` plus `tsc --noEmit` in `apps/desktop`.

## Live test (`references/testing.md`)

Use `scripts/voice-bot.py` (two bots taking turns) and read the state with an `eval` of
`audio_get_state`:

1. **Volume steps.** Note `session.outputMeter`, set the volume to −12 dB, and note it
   again. It should read 12 ± 0.5 dB lower. Do the same at +6 dB.
2. **Auto-level is untouched.** With Auto-level on, move the volume from 0 to −20 dB and
   back. The bots' faders, `speechLoudnessDb` and statuses do not change.
3. **Deafen.** Deafen at −12 dB, then undeafen. It comes back at −12 dB, not 0.
4. **Out of a call.** At −20 dB, "Play a test sound" is clearly quieter. Measure with
   `scripts/mic-sessions.ps1` or by ear, and say which you used.
5. **Remembered.** Restart the app. The dock slider and the Mixer strip show −20 dB, and
   the bus plays at it.
6. **Screenshots** of the Mixer strip and the dock menu. Send them to Soroush.

Afterwards:
- Set the volume back to 0.
- Restore anything the rig changed, such as `raven.apiServerUrl`.
- Shut down with `app.ps1 down` and `stack.ps1 down`.

## Docs

- `references/audio-engine.md`, under Playback: add the volume stage to the bus order.
- `references/mixer-dsp.md`: a short "Master volume" section. Cover the range, where it
  sits relative to deafen, the limiter and the echo-canceller reference, that it covers
  cues and the test tone, and that it never touches strips or Auto-level.

## Not in this plan

- **Group faders ("Voices" / "Shared audio")** between the per-track faders and the
  master. Add them only if testers keep balancing shares against voices by hand. A
  "Voices: Softer / Normal / Louder" choice for Auto-level would live there, not as a
  LUFS target.
- **Volume hotkeys** (up, down) in `MediaHotkeySettings.tsx`.
- **A volume control on the voice overlay.**
- **Per-device volumes.** One volume for all speakers for now.
