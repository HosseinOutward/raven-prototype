# Plan 02: Studio (DeepFilterNet 3) and the overrun fallback

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`, desktop app in `apps/desktop`). All media is native
Rust under `apps/desktop/src-tauri/src/audio`.

Plan 01 (`01-modes-sonora-split-and-strong.md` in this folder) must be merged first. It
added:

- the `NoiseSuppressionMode` enum (Off / Standard / Strong / Studio);
- a suppressor stage between two sonora instances, behind the `VoiceSuppressor` trait in
  `src-tauri/src/audio/suppression.rs`;
- RNNoise as Strong, and live mode switching through `LiveControls`;
- the `noise_suppression` runtime report.

Plan 01.5 (`01.5-voice-detection-cleanup-and-settings.md`) must be merged too. It
added:

- the depth setting (Gentle / Balanced / Full) carried live through `LiveControls`;
- listener-side cleanup on receiver strips;
- voice detection for the speaking ring;
- the generated `THIRD-PARTY-NOTICES.md`.

Until now the engine treated Studio as Strong and reported `fallback: NotAvailable`.

This plan makes **Studio** real with DeepFilterNet 3 (MIT/Apache-2.0, full-band
48 kHz), and adds an **overrun guard**:

- If the model can't keep up on this computer, Raven switches to Strong instead of
  glitching.
- It tells the user, and tries Studio again on the next call.

Read `README.md` in this folder first. Its "Decisions" section covers what Soroush
decided on 2026-10-18: the model compiled in, the fallback lasting one call, and a 24 dB
depth cap.

## Before you start

- Load `raven-media-engine` (read `references/audio-engine.md` and
  `references/testing.md`) and `raven-ui` (read `references/writing.md`).
- Read plan 01 and the code it produced: `suppression.rs`, the stage wiring in
  `capture.rs`, and the runtime report in `domain.rs` and `src/lib/audio.ts`. Verify
  everything below against that code. Plan 01's session may have named things
  differently.
- Worktree, build and dev-app notes are the same as plan 01: copy `.claude/skills` and
  `.env`, build through `scripts/cargo.ps1`, one dev app at a time, don't commit unless
  asked.

## What is true about DeepFilterNet (checked 2026-10-18)

- **Not on crates.io in a usable version.** crates.io's `deep_filter` is 0.2.5 from 2022.
  The repo (`github.com/Rikorose/DeepFilterNet`, `libDF/`) is at `0.5.7-pre`; its last
  commit was in September 2024 and its last release, v0.5.6, in 2023.
  - Depend on it by **git with a pinned `rev`**, or vendor `libDF` into the repo. It is
    effectively unmaintained, so you are adopting it. Prefer vendoring if the git
    dependency drags in more than the inference path. Say which you chose and why.
- **Features:** `tract` (inference through sonos/tract, pure Rust: tract-core,
  tract-onnx, tract-pulse, tract-hir `^0.21.4`) and `default-model`, which
  `include_bytes!`s `models/DeepFilterNet3_onnx.tar.gz` (7.98 MB). Turn off the default
  `vorbis` and `flac` features.
  - It brings `ndarray ^0.15`, `rustfft`, `realfft`, `flate2` and `tar`. Raven doesn't
    use ndarray today. Check for version clashes with `rustfft` (sonora has its own
    FFT crate).
- **API:**
  - `DfTract::new(DfParams::default(), &RuntimeParams)` loads and optimises the model.
    This is slow (expect tens to hundreds of ms) and must never run on the audio
    callback.
  - `process(noisy: ArrayView2<f32>, enh: ArrayViewMut2<f32>) -> Result<f32>` takes one
    hop of `[n_ch, 480]` at 48 kHz and returns the local SNR estimate.
  - `set_atten_lim(db)` and `set_pf_beta(beta)` change behaviour live. `RuntimeParams`
    holds `n_ch`, `atten_lim_db`, `post_filter_beta` and thresholds.
- **Latency:** 20 ms window, 10 ms hop, two frames of look-ahead. The paper gives
  40 ms algorithmic latency. Read `lookahead` and `hop_size` from the `DfTract` instance
  and **measure the real delay with an impulse**. Report that number as the suppressor's
  `latency_samples`. Don't hard-code 40 ms.
- **Inside `process`:**
  - It allocates every hop (`spec_buf.clone()`, tract tensors).
  - It outputs zeros after five near-silent hops.
  - It calls `log::warn!` on input above 0.9999. Make sure that cannot flood Raven's
    logs from the audio thread: filter the `df` target, or clamp just below 1.0 before
    calling it.
- **Cost:** a real-time factor of 0.19 on one thread of a 2017 i5-8250U; another study
  measured ~0.08. Expect roughly 1–2 ms per 10 ms hop on a current desktop, more on
  older laptops. This is why the guard exists.

## What to build

### 1. Studio suppressor

- `StudioSuppressor` in `suppression.rs` implements `VoiceSuppressor`. It wraps
  `DfTract` with `n_ch = 1` (the stage already gives mono 48 kHz hops).
- It uses DeepFilterNet's own attenuation limit, driven by plan 01.5's depth setting:
  Gentle 12 dB, Balanced 24 dB, Full 100 (no limit).
  - Read the depth from `LiveControls` and apply changes with `set_atten_lim` on the
    capture thread, so changing depth never rebuilds the model.
  - Post-filter off at first. Mention it to Soroush as a tuning option.
- Listener-side cleanup (plan 01.5, part B) stays on Strong. Studio is too heavy to run
  once per person.
- **Check `DfTract: Send`.** The suppressor lives in `SourceProcessingConfig`, which
  moves into the cpal callback.
  - If `DfTract` is not `Send`, stop and report before working around it. The likely
    fix (building it on the capture thread) changes the hand-off design below.

### 2. Off-thread model loading and hand-off

The model is never built on the audio callback:

- **At capture start**, when the chosen mode is Studio, build the model before opening
  the stream, on the thread that sets up the capture runtime (`start_adapter_for_source`
  and its helpers). Check this doesn't make joining a call noticeably slower. If it adds
  more than about 150 ms, start the capture on Strong and hand Studio over as in the
  next point.
- **On a mid-call switch to Studio:**
  - Reconcile (or the command) starts a short-lived builder thread.
  - The thread builds the model and puts the boxed suppressor into a mailbox on
    `LiveControls`: a `Mutex<Option<Box<dyn VoiceSuppressor>>>` plus a version.
  - The capture thread takes it with `try_lock` (engine rule 10: the audio thread never
    waits) and swaps it in with the 10 ms crossfade from plan 01.
  - Until it arrives, the previous mode keeps running and the runtime reports
    `active: <previous>` with `fallback: Starting`. Add that variant.
- **Switching away from Studio before the model arrives:** drop the late result. The
  mailbox version tells you it is stale.
- **Build failure:** run Strong, report `fallback: FailedToStart`, and log the error
  once.

### 3. The overrun guard

Measure the suppressor's own work on the audio thread. Reading `Instant::now()` around
each `process_hop` costs nothing worth worrying about. Put the decision in a pure,
unit-testable type:

```rust
struct OverrunGuard { /* ring of recent hop costs */ }
impl OverrunGuard {
    fn record(&mut self, cost: Duration) -> GuardVerdict; // Keep | FallBack
}
```

- **Budget:** one hop is 10 ms of audio, and the whole callback must finish inside the
  device period. Starting thresholds (constants in one place, tune them on the rig):
  - ignore the first 100 hops (1 s), because tract's first runs are slow;
  - fall back if the **mean** cost over the last 200 hops (2 s) exceeds **5 ms**
    (50% of real time);
  - or if **3 hops within 200** take longer than **10 ms**.
- **On `FallBack`:**
  - swap to a Strong suppressor that was built alongside Studio, so no allocation is
    needed at that moment;
  - crossfade, and report `active: Strong, fallback: TooSlow`;
  - stay on Strong until the capture runtime ends (Leave, device reopen);
  - the next call starts Studio again, and the user's choice in the model stays Studio.
- **Model errors:** a `process` error, a panic caught by the existing guard, or
  non-finite output from DeepFilterNet also falls back to Strong
  (`fallback: FailedToStart`) instead of failing the stream. The existing
  stream-failure path is for real device problems.
- **Health report:** put the measured mean cost into the strip's health
  (`processor_cpu_estimate`, or a new field if that one means something else). Stream
  info can then show what the suppressor costs, not a guess.

### 4. Size and build hygiene

- Put Studio behind a cargo feature, `studio-noise-suppression`, on by default. Linux
  and macOS builds can then turn it off if tract fails to build there. Without the
  feature, Studio reports `fallback: NotAvailable` (plan 01's behaviour).
- Report the release installer size before and after
  (`target/.../bundle/nsis/*-setup.exe`). The 0.1.0 installer was about 21 MB, and the
  model alone adds about 8 MB.
  - If the increase is well beyond 8 MB plus a few MB for tract, find out why before
    finishing.
  - Downloading the model on first use instead (from `updates.rvn.bluehour.cloud`,
    verified by hash) is the fallback design if Soroush finds the size too much. Don't
    build it.
- Re-run plan 01.5's notices script (`apps/desktop/scripts/third-party-notices.ts`), so
  DeepFilterNet and tract (both MIT or Apache-2.0) appear in `THIRD-PARTY-NOTICES.md`
  and the licences screen.

### 5. UI

Follow `raven-ui`. This adds a fourth option and the states around it.

**Dock mic popover and Mixer:**

- Add **Studio** to the select. Caption: "Removes the most noise. Adds a slight delay
  and uses more of your computer." Being honest about the cost is the point.
- When the choice is Studio but something else is running, the caption says so:
  - Starting: "Starting Studio…" with no spinner loop (raven-ui rule 12).
  - TooSlow: "Studio was too heavy for this computer, so Strong is on for this call."
  - FailedToStart: "Studio couldn't start, so Strong is on."
  - NotAvailable (built without the feature): "Studio isn't available in this build."
- **One toast** when `TooSlow` happens mid-call, worded like the caption. It says that
  you are still being heard, so nobody wonders whether they went silent. No toast for
  `Starting`.
- **Colour:**
  - Fallback captions use `text-muted-foreground`, not `warning`: nothing is broken
    and you are still audible.
  - Use `warning` only for `FailedToStart` if it repeats across calls (you don't track
    that, so: never, in this plan).
  - Never `live` (raven-ui rule 1).
- If Stream info already lists processing or latency, add the suppressor's measured
  latency and cost there. Otherwise leave it for later.

## Docs to update

- `raven-media-engine`:
  - `references/audio-engine.md`: Studio, the hand-off, the guard and its thresholds,
    the measured latency.
  - `references/mixer-dsp.md`: the modes table.
  - `SKILL.md`: the dependency list in "Maintaining this skill". Add `deep_filter` with
    its pinned revision, and tract.
- `docs/architecture.md`, if plan 01 added the suppressor there.

## Checking your work

- **Unit tests:**
  - Studio's reported latency matches a measured impulse delay.
  - Studio reduces noise under a tone by a clear margin, and by more than Strong does on
    the same input.
  - `OverrunGuard`: warm-up is ignored; the mean threshold trips at 5 ms; the spike rule
    trips at 3 over 10 ms; a single spike does not.
  - The mailbox hand-off: a stale build is dropped, and a failed build falls back.
  - A fallback never changes the user's chosen mode in the model.
- `scripts/cargo.ps1 test --lib`, `clippy --lib`, `fmt --all`; `bun run build`,
  `bun test`, and the `raven-ui` sweep should print Clean.
- **Live rig, with the browser bot:**
  1. Choose Studio before joining, then join. Report:
     - how much longer the join takes;
     - the suppressor's mean and worst hop cost over a minute;
     - the mic's total `latency_samples`;
     - process CPU, compared with Strong and Standard.
  2. Switch Strong → Studio → Strong mid-call. The capture session stays the same, the
     runtime goes through `Starting`, and there is no audible click (listen to the bot
     side, or say you couldn't).
  3. Force a fallback: temporarily lower the mean threshold far below the measured cost
     behind a debug-only constant, then remove it. The toast and caption appear once,
     Strong takes over without a gap in the bot's stats, and the next call starts on
     Studio.
  4. Leave. The mic is released.
- Record the same 20-second speech-with-noise clip as plan 01 in Studio, and hand it to
  Soroush with the Strong clip for comparison.
- Report measured numbers, not "should work". Linux and macOS cannot be compiled here.
  Say so, and note that the cargo feature exists for exactly that risk.
