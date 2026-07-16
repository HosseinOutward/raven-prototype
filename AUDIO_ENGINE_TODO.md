# Raven Native Audio Engine — Follow-ups & TODO

Status of the June 2026 rewrite that moved all audio DSP + LiveKit publish/subscribe into
Rust (the "audio sidecar" topology). Everything below is what remains after the initial
implementation landed (compiles, links, 43 Rust unit tests pass, frontend builds).

Legend: 🔴 blocker / correctness · 🟠 important · 🟢 nice-to-have · ✅ done in this pass

---

## 1. Verification (do this first)

- [X] 🔴 **Two-machine end-to-end test.** Build sidecar + app on both machines, redeploy the
      Go API, join one nest. Confirm: outgoing mic audible on the other peer; incoming tracks
      populate; fader/mute change the *transmitted* level in real time; Noise Gate audibly
      gates; High-pass (e.g. 500 Hz) is audible.
- [X] 🟠 Single-machine loopback test (two app instances / a headless second client): publish
      a **test tone**, confirm it appears under Incoming Tracks on the other side and is heard.
- [X] 🟠 Confirm each participant shows **once** in the people/tile list (the `#audio` sidecar
      is folded into its owner) and there is **no double audio**.
- [X] 🟠 Verify the app-audio dropdown lists **Chrome + Firefox** simultaneously and that
      refresh reflects newly-started apps (Bug 1 fix).
- [ ] 🟢 Confirm graceful behavior when the output device is not 48 kHz (mixer uses the
      device default rate; check for pitch/glitch).

## 2. DSP completeness

- [x] ✅ Gain, Mute (live, smooth) · Limiter · **NoiseGate** · **HighPass** · **LowPass** ·
      **Compressor** implemented in `processor.rs`.
- [ ] 🟠 **EQ (multiband peaking)** is still a no-op stub. Implement with a cascade of peaking
      biquads driven by `parameters.eq_bands` (frequency/Q/gain). Reuse the `Biquad` in
      `processor.rs`; add a `peaking_coeffs` helper.
- [ ] 🟢 Add unit tests for NoiseGate (closes below threshold / opens above) and the biquad
      filters (attenuation at/above cutoff).
- [ ] 🟢 Consider a true look-ahead limiter (current Limiter is a hard clamp).

## 3. Microphone processing (NS / EC / AGC)

- [ ] 🔴 **Acoustic echo cancellation is unproven.** It's currently only requested via
      `AudioSourceOptions` on the `NativeAudioSource`, which may not run the full WebRTC APM on
      pushed frames. For reliable AEC, integrate a dedicated APM (pure-Rust `sonora`, or
      `webrtc-audio-processing`) in the capture path and feed the `OutputMixer` signal as the
      render reference, time-aligned with mic capture.
- [ ] 🟠 Verify NS and AGC actually take effect; if `AudioSourceOptions` is insufficient, move
      NS/AGC into the same APM node.
- [ ] 🟢 Expose APM tuning (NS level, AGC target) in the UI if needed.

## 4. Incoming / receive path

- [x] ✅ Incoming track **volume meter** now fed from the engine reader.
- [x] ✅ **Receiver processor chain** (gate/HPF/LPF/compressor/limiter) now runs on incoming
      tracks in the `engine.rs` reader, rebuilt when the chain definition changes.
- [x] ✅ **Shared track metadata** — publishers relay `{sourceType, displayName}` per track via
      LiveKit participant metadata; incoming tracks show the real source type + name and the group
      header uses the owner's username.
- [ ] 🟢 Transmit the actual **app icon** (e.g. the Chrome logo) for app-audio sources. Today the
      receiver shows the precise name ("Chrome") + a category icon, not the real logo — the icon
      data url isn't on `AudioSourceState`, so it'd need capturing at source-create time and adding
      to the shared metadata.
- [ ] 🟠 Per-remote `LiveControls`-style block so receiver gain/mute/chain don't read-lock + clone
      the full `ProcessorChainState` every audio block (current `receiver_snapshot`).
- [ ] 🟢 Apply receiver chain **parameter** updates live (via `set_parameter`) instead of
      rebuilding the chain, to avoid a small click while dragging an incoming-track control.
- [ ] 🟢 Receiver-side safety limiter / clip protection on the mixed output bus.

## 5. Performance & bandwidth

- [ ] 🟠 **Stop the JS room from subscribing to `raven-audio-*` audio.** JS currently downloads
      sidecar audio it never plays (Rust plays it) — wasted bandwidth. Use selective
      subscription / `setSubscribed(false)` for those publications, or disable audio autosubscribe
      on the JS room while keeping video.
- [ ] 🟠 Avoid emitting the full `AudioMixerState` on every meter tick (local *and* remote). Consider
      a lighter `audio-meters` event carrying only meter deltas.
- [ ] 🟢 The output mixer pops per-track under one lock each callback; profile under many peers.
- [ ] 🟢 Replace the simple linear resampler in `engine.rs` (`StereoResampler`) with a higher
      quality one (e.g. `rubato`) if artifacts are audible on non-48 kHz sources.

## 6. Lifecycle & robustness

- [ ] 🟠 **Reconnect / token refresh.** Sidecar token is valid 2h; handle expiry and LiveKit
      reconnects (re-publish current sources on reconnect).
- [ ] 🟠 Handle output/input **device hot-swap** (default device change) for both capture and the
      `OutputMixer` (currently device is chosen once at start).
- [ ] 🟠 Surface engine errors (publish/connect failures) to the UI instead of `eprintln!`.
- [ ] 🟢 The engine holds an Arc cycle (tasks hold the shared state which owns the engine); it's
      broken on `disconnect()`. Confirm no leak across many connect/disconnect cycles.
- [ ] 🟢 Make `connect()` not block the state write lock on the network handshake (move the
      `block_on(Room::connect)` outside the lock).

## 7. Frontend cleanup

- [ ] 🟠 Remove the dead JS audio publish bridge in `LiveKitNest.tsx` (guarded by
      `JS_AUDIO_PUBLISH_DISABLED`) and the now-unused helpers: `publishInstructionToLiveKit`,
      `createPublishedAudioHandle`, `syncRemoteAudioTracksFromLiveKit`, the publish-instruction
      subscription, and the local monitor Web Audio graph.
- [ ] 🟢 Retire the Rust `publisher.rs` placeholder + `AudioTrackPublishInstruction` event path
      now that publishing is engine-driven (keep `stable_webrtc_track_id`).
- [ ] 🟢 Screenshare audio currently still flows through JS; decide whether to route system/app
      audio capture through a Rust source instead for consistency.

## 8. Misc

- [ ] 🟢 The `#audio` sidecar increments LiveKit participant count; make sure presence/session
      counting in the Go API (`session_participants`) isn't skewed by it.
- [ ] 🟢 `friendly_name_from_stem` only capitalizes the exe stem (e.g. "Chrome"); optionally pull
      the real product name from the exe's version info ("Google Chrome").
- [ ] 🟢 Document the two-participant model + `crt-static` requirement in the project README.
