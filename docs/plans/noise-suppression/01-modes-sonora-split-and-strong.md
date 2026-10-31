# Plan 01: Noise suppression modes, the sonora split, and Strong (RNNoise)

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`, desktop app in `apps/desktop`). All media is native
Rust under `apps/desktop/src-tauri/src/audio`. The microphone is processed by sonora,
a pure-Rust port of WebRTC's audio processing module (APM), then by the user's
processor chain, then sent to LiveKit.

Today the microphone has one "Noise suppression" on/off switch. This plan replaces it
with a mode: **Off / Standard / Strong**. Plan 02 adds **Studio** later. To get there:

1. Split sonora into a *front* stage (high-pass filter, echo cancellation, and WebRTC
   noise suppression for Standard) and a *back* stage (automatic gain). A new
   suppressor stage sits between them.
2. Implement Strong with RNNoise through the `nnnoiseless` crate (BSD-3, pure Rust).
3. Let the mode change mid-call without reopening the microphone.
4. Show the choice in the dock's mic popover and in the Mixer, and remember it across
   restarts.

Read `README.md` in this folder first. Its "Decisions" section lists what Soroush
decided on 2026-10-18, including Strong by default and a 24 dB depth cap.

## Before you start

- Load the `raven-media-engine` skill and read `references/audio-engine.md`,
  `references/mixer-dsp.md` and `references/testing.md`. Load `raven-ui` too, for the
  popover and Mixer changes. Read its `references/writing.md`.
- If you are in a git worktree, `.claude/skills` and `.env` are gitignored, so they are
  missing there. Copy both from `C:\Users\Soroush Taheri\code\raven` and run `bun install`
  in `apps/desktop`.
- Rust builds go through the skill's `scripts/cargo.ps1` or `tauri.ps1`.
  `CARGO_TARGET_DIR` is `%USERPROFILE%\rv`, shared by every checkout, so expect waits if
  another session is building. Only one Raven dev app can run at a time. Check before
  starting it, and if one is running, ask the user rather than stopping it.
- Don't commit, push or release unless the user asks.

## What is true now

All paths are under `apps/desktop`. Line numbers are from 2026-10-18; verify them.

- **The setting.** `WebRtcAudioProcessingSettings { noise_suppression: bool,
  echo_cancellation: bool, auto_gain_control: bool }`, all `true` by default
  (`src-tauri/src/audio/domain.rs:647`). Its TS twin is in `src/lib/audio.ts:110`.
  Presets (`AudioPresetDefinition`, `domain.rs:338`) do not contain it, so nothing on
  disk needs migrating.
- **Changing it reopens the mic.** `CaptureConfigSignature` contains the whole
  `webrtc_processing` struct (`src-tauri/src/audio/capture.rs:371`), and reconcile
  restarts a runtime whose signature changed (`capture.rs:266`). Gain, mute, ceiling and
  the chain instead travel live through `LiveControls` (`capture.rs:83`).
- **One sonora instance does everything.** `WebRtcApmRuntime` (`capture.rs:1315`) builds
  one `AudioProcessing` from `apm_config` (`capture.rs:1466`): HPF when NS or AEC is on,
  AEC3, NS (`NoiseSuppression::default()`, level Moderate ≈ 12 dB), and AGC2
  adaptive-digital. Inside sonora the order is HPF → AEC → NS → AGC2. It runs on 10 ms
  frames at the device's own rate and channel count. NS and AGC only run on
  microphones. A system-audio source gets only AEC.
- **sonora can change NS live.** `AudioProcessing::apply_config` reinitialises only the
  submodules whose config changed. Toggling NS or its level does not reset the echo
  canceller (sonora `audio_processing_impl.rs:220`).
- **Processing runs inside the device callback.** `build_input_stream` → `handle_input_block`
  → `process_source_samples_guarded` → `process_source_samples` (`capture.rs:1107`,
  `1141`, `1154`, `1528`). The Linux PipeWire path calls the same function
  (`capture.rs:2290`), so a stage added there covers every backend. A processing error
  or panic marks the stream failed and the supervisor reopens the device.
- **Resampling.** `StereoResampler` (`src-tauri/src/audio/resample.rs:28`) is a
  windowed-sinc streaming resampler, but it outputs stereo i16 for the publish path. It
  is not usable as-is for a mono f32 round trip.
- **The UI.**
  - Dock mic popover: `MicMenu` in `src/shells/ravenv1/DeviceDock.tsx:1042`. Three
    `SwitchRow`s; noise suppression is at line 1068. It calls
    `media.setMicProcessing`.
  - Mixer: the "Voice processing" `ToolSection` in `src/components/AudioMixerPanel.tsx`
    around line 1855.
  - Adapter: `setMicProcessing` (`src/shells/ravenv1/useRavenMediaAdapter.ts:1093`) and
    `localAudioProcessing` (`:429`).
- **Nothing persists processing choices.** Media settings live in localStorage under
  `MEDIA_SETTINGS_KEY` (`readMediaSettings`, `useRavenMediaAdapter.ts:1320`). They hold
  `selectedMic` and others but not processing. The persisted mic device is applied when
  the mic source is first created, in `ensureDefaultMic` (`:735`).
- **No licence notices exist** anywhere in the app or bundle.

## What to build

### 1. The mode type (wire contract)

- Add `NoiseSuppressionMode { Off, Standard, Strong, Studio }` in `domain.rs`, serde
  `camelCase` (`"off" | "standard" | "strong" | "studio"`). Change
  `WebRtcAudioProcessingSettings::noise_suppression` from `bool` to this enum. Keep the
  struct's name: renaming it touches too much for no user benefit.
- Default: `Strong` (see README). Add `Studio` to the enum now so plan 02 does not change
  the wire again. Until plan 02 lands, the engine treats `Studio` as `Strong` and reports
  that through the runtime state below. The UI does not offer Studio yet.
- Update the TS twin in `src/lib/audio.ts` and every Rust test that builds the struct.
  Several in `capture.rs` and `state.rs` set `noise_suppression: false`.
- **Runtime report.** Add to `AudioSourceRuntimeState` (`domain.rs:186`):
  `noise_suppression: Option<NoiseSuppressionRuntime>` with `active: NoiseSuppressionMode`
  (what is really running) and `fallback: Option<NoiseSuppressionFallback>` (why it
  differs from the choice). For now the only reason is `NotAvailable` (Studio before
  plan 02); plan 02 adds `TooSlow` and `FailedToStart`. The model keeps the user's choice
  and the runtime reports what runs: engine rule 2, and raven-ui rule 4 ("I turned it on"
  vs "it is live"). Never overwrite the choice with the fallback.
- Twin those types in `audio.ts`.

### 2. Split sonora into front and back

In `capture.rs`, replace the single `AudioProcessing` in `WebRtcApmRuntime` with:

- **Front:** HPF (microphone and NS-or-AEC as today, where NS now means any mode other
  than Off) + AEC + WebRTC NS **only when the mode is Standard**. It gets the render
  reference exactly as today. Keep the `RenderCursor` logic untouched.
- **Suppressor stage** (new, section 3): Strong. Pass-through for Off and Standard.
- **Back:** AGC2 alone, with the same adaptive-digital settings. No render reference.
  Build it only for microphones with `auto_gain_control`.

Keep one code path for every mode: always front → suppressor → back, with the
suppressor a no-op when it is not needed. Requirements:

- With Off or Standard, the output must match today's single instance within float
  tolerance. AGC2 already ran after NS inside sonora, so splitting changes nothing
  there. Add a unit test that feeds the same synthetic signal (tone plus noise) through
  the old configuration and the new chain.
- Frames stay 10 ms at the device rate between stages. Do not re-buffer between front
  and back.
- A system-audio source keeps AEC only: no suppressor, no back stage.
- `muted_input` (the "you're talking while muted" meter) is now measured after the back
  stage. That is what it measured before.

### 3. The suppressor stage and Strong

A small trait in a new file, `src-tauri/src/audio/suppression.rs`, so plan 02 can add
Studio beside it:

```rust
trait VoiceSuppressor: Send {
    /// One 480-sample hop of 48 kHz mono, samples in −1.0..1.0. Writes the same length.
    fn process_hop(&mut self, input: &[f32; 480], output: &mut [f32; 480]) -> Result<(), SuppressorError>;
    /// Samples of delay this suppressor adds at 48 kHz (RNNoise: 480).
    fn latency_samples(&self) -> usize;
}
```

Write a `SuppressorStage` that owns the active suppressor and adapts the stream to it:

- **Channels:** average all channels to mono going in and copy the result to every
  channel coming out. Microphones are voice. Processing each channel would double the
  cost for nothing.
- **Rate:** hops are 480 samples at 48 kHz. At a 48 kHz device (the common case), one
  10 ms APM frame is exactly one hop, with no extra buffering. At any other rate (44.1
  kHz, 16 kHz on a Bluetooth headset in hands-free mode, 96 kHz), resample mono to 48 kHz,
  run whole hops through a small FIFO, and resample back.
  - Factor the windowed-sinc kernel out of `StereoResampler` into a mono f32 streaming
    resampler, and keep `StereoResampler` built on it. Don't write a second kernel.
  - The FIFO may need one hop of priming at non-48 kHz rates. Count it in the reported
    latency.
- **Strong = `nnnoiseless`** (`DenoiseState::new()` and
  `process_frame(&mut out, &in) -> f32`).
  - **RNNoise expects samples at 16-bit scale** (±32768), not ±1.0. Scale in and out.
    Getting this wrong makes it suppress almost nothing, and is the most common RNNoise
    integration bug.
  - Ignore the returned voice probability. Plan 01.5 drives the speaking ring from
    sonora's own voice detector, which works in every mode.
- **Depth cap (24 dB):** RNNoise has no attenuation limit. Add the dry signal back at
  −24 dB:
  - `out = denoised + 10^(−24/20) × dry`, where `dry` is delayed by exactly the
    suppressor's latency so it lines up sample for sample. If it doesn't line up, the
    mix comb-filters the voice.
  - Prove the alignment with an impulse test.
  - Put the cap in one constant. Plan 02 passes the same value to DeepFilterNet's own
    limit.
- **Latency:** add the stage's latency to `SourceProcessingConfig::latency_samples` so
  the strip's health (and Stream info) includes it.
- **Errors:** a suppressor error must not kill the microphone. Log it once, switch to
  pass-through (behaving as Standard for the rest of this capture), and report
  `fallback: FailedToStart`. Keep the existing non-finite check after the chain: it
  still guards everything.
- **Mute:** the stage keeps running while muted, as the APM does, so the muted meter
  reflects the cleaned signal (no "you're talking" from keyboard clicks).

### 4. Change the mode live

- Remove the noise suppression mode from `CaptureConfigSignature`. Compare
  echo-cancellation and automatic-gain only, so those switches still reopen the device
  as today.
- Add the mode to `LiveControls` (an `AtomicU8` plus a version counter, like the
  chain). Reconcile sets it next to gain and mute (`capture.rs:260`).
- On the capture thread, before each block, notice a changed version and:
  - call `front.apply_config(...)` to turn WebRTC NS on or off (Standard), which does
    not disturb the echo canceller;
  - swap the suppressor (building an `nnnoiseless` state is cheap, so doing it on the
    capture thread is fine for Strong; plan 02 adds an off-thread hand-off for Studio);
  - fade the old path out and the new one in over 10 ms, so a switch never clicks
    (engine rule 6). Their latencies differ, so a mid-call switch skips or repeats a few
    milliseconds. Hidden under the fade, that is acceptable for a rare user action.
- Report the new `noise_suppression` runtime state through a new
  `CaptureEvent::Suppression(NoiseSuppressionRuntime)`. The event pump writes it into
  `source.runtime` and emits a state snapshot, as `Runtime` does today.
- Update `set_local_webrtc_processing` (`state.rs:571`) if needed, so a mode-only change
  re-publishes nothing it doesn't have to.

### 5. Remember the choice

- Add `noiseSuppression: NoiseSuppressionMode` to the localStorage `MediaSettings`
  (`useRavenMediaAdapter.ts:1320`), validated like the other fields.
- Apply it when the mic source is first created in `ensureDefaultMic`, the same way the
  persisted device is applied. Save it from `setMicProcessing` when the mode changes.
- A missing value means the engine default (Strong).
- Don't persist echo cancellation or automatic gain in this plan. Plan 01.5 does that.

### 6. UI

Follow `raven-ui`:

- Simple surface, deep basement: the popover holds a device list and two or three
  switches.
- Sentence case. Captions use `text-caption text-subtle`.
- The `SelectValue` trap: pass the visible label as children.

**Dock mic popover** (`MicMenu`):

- Replace the "Noise suppression" `SwitchRow` with a row labelled "Noise suppression"
  and a compact `Select`: Off, Standard, Strong. Below it, a one-line caption for the
  selected mode. Starting wording:
  - Off: "Your microphone as it is."
  - Standard: "Steady noise like fans and hum."
  - Strong: "Also keyboards, clicks and room noise."
- If a select row in this popover looks heavier than the switches around it, try the
  segmented control (`components/ui/tabs.tsx`). Choose by looking at both in the real
  app, and say which you chose and why.
- When `runtime.noiseSuppression.active` differs from the choice, the caption says
  what is really running. Plan 01 only needs `FailedToStart`, for example: "Strong
  couldn't start, so Standard is on." Plan 02 adds the Studio cases.
- Keep the "These unlock once your microphone has been turned on" line.

**Mixer** (`AudioMixerPanel.tsx`, the "Voice processing" section):

- Same select and captions in place of the toggle, for microphone strips only.
- This file's callbacks and draft state talk to the engine, so change only what the
  type change forces.

### 7. Licence notices

- Add `THIRD-PARTY-NOTICES.md` (repo root or `apps/desktop/src-tauri`) with the
  licence texts for `nnnoiseless` and RNNoise (BSD-3-Clause).
- Ship it as a Tauri bundle resource.
- Plan 01.5 replaces this hand-written file with a generated one and adds a screen
  for it. Keep this one short.

## Docs to update

- `raven-media-engine` skill:
  - `references/audio-engine.md`: the send path order (front APM → suppressor → back
    APM) and the "Echo cancellation" section (two sonora instances; NS only in Standard).
  - `references/mixer-dsp.md`: the processing settings and the live mode.
  - `SKILL.md`: the pipeline sketch and the file table (`suppression.rs`).
- `docs/architecture.md`, if its media-engine section describes the APM.

## Checking your work

- **Unit tests:**
  - Off and Standard match the old single instance.
  - The suppressor stage produces exactly the input length at 48, 44.1 and 16 kHz, and
    its reported latency matches a measured impulse delay.
  - RNNoise reduces white noise under a tone by a clear margin (assert a number). This
    also catches the ±1.0 scale bug.
  - The dry-mix alignment test.
  - A live mode switch through `LiveControls` takes effect without a new runtime.
  - A suppressor error falls back without failing the stream.
- `scripts/cargo.ps1 test --lib`, `clippy --lib`, `fmt --all`. Then `bun run build`,
  `bun test`, and the `raven-ui` sweep, which should print Clean.
- **Live rig** (`references/testing.md`), with the browser bot in the room:
  1. Join with the default (Strong). The bot receives your mic. Report the mic's
     `latency_samples` and the process's CPU in the call, compared with Standard.
  2. Switch Off → Standard → Strong mid-call. `scripts/mic-sessions.ps1` shows the
     same capture session throughout (no reopen), and the bot logs no unpublish.
  3. Restart the app. The choice is remembered.
  4. Leave. The mic is released, as before.
- **Listening:** the rig cannot judge quality. Record 20 seconds of speech with a fan
  or keyboard in each mode (the Mixer's monitoring, or a WAV dumped from the stage
  behind a debug flag that you remove afterwards). Hand the clips to Soroush to listen
  to, and say so.
- Report measured results, not "should work". Linux and macOS cannot be compiled here.
  `nnnoiseless` is pure Rust, but say that they were not built.
