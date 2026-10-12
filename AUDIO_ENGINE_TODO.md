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
      device default rate; check for pitch/glitch). *Readers now re-request each track at the
      new rate when the speaker changes; needs a listen test on a 44.1 kHz device.*

## 2. DSP completeness

- [x] ✅ Gain, Mute (live, smooth) · Limiter · **NoiseGate** · **HighPass** · **LowPass** ·
      **Compressor** implemented in `processor.rs`.
- [x] ✅ **EQ (multiband peaking)** — cascade of peaking biquads from `parameters.eq_bands`;
      a new EQ starts with four flat bands, edited as `band<n>.frequencyHz|gainDb|q`.
- [x] ✅ Unit tests for the gate (opens for speech, closes on noise, no flutter near the
      threshold, hold across word gaps), EQ and limiter.
- [x] ✅ Look-ahead limiter (`dynamics.rs`, 1.5 ms) for the Limiter processor, the per-channel
      safety limiter and — as a block limiter — the playback mix bus. No more hard clipping.
- [x] ✅ Gate rebuilt on a level envelope with hysteresis and hold.
- [x] ✅ Processor edits (values, enable, add/remove/reorder) and the safety ceiling are applied
      to the running capture; nothing but a device / voice-processing change reopens the device.
- [x] ✅ Fader and mute ramp instead of stepping (send and receive).

## 3. Microphone processing (NS / EC / AGC)

- [ ] 🔴 **Acoustic echo cancellation needs a listening test.** `sonora` runs in the capture
      path and is now fed the played audio as one continuous stream at the speaker's own rate
      (each canceller keeps a cursor into `RenderReference`); before, it was handed "the latest
      samples" per frame, which repeats and skips audio. Verify on speakers with two machines.
- [x] ✅ NS / AGC / AEC run only in `sonora`; the `AudioSourceOptions` flags on the LiveKit
      source are off so nothing is processed twice.
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
- [x] ✅ Receiver chain setting changes are applied in place (`sync_state`); only a different set
      of processors rebuilds the chain.
- [x] ✅ Limiter on the mixed output bus, master output mute (deafen), and a per-track playout
      buffer with a target and a cap, so receive latency no longer ratchets upward.
- [x] ✅ Receiver strip settings are remembered across unsubscribe / reconnect, and a source keeps
      one track identity across mute, republish and reconnect.

## 5. Performance & bandwidth

- [ ] 🟠 **Stop the JS room from subscribing to `raven-audio-*` audio.** JS currently downloads
      sidecar audio it never plays (Rust plays it) — wasted bandwidth. Use selective
      subscription / `setSubscribed(false)` for those publications, or disable audio autosubscribe
      on the JS room while keeping video.
- [ ] 🟠 Avoid emitting the full `AudioMixerState` on every meter tick (local *and* remote). Consider
      a lighter `audio-meters` event carrying only meter deltas.
- [ ] 🟢 The output mixer pops per-track under one lock each callback; profile under many peers.
- [x] ✅ Windowed-sinc resampler (`resample.rs`) replaces linear interpolation for non-48 kHz
      sources; published audio is always 48 kHz in exact 10 ms frames on LiveKit's direct path.

## 6. Lifecycle & robustness

- [x] ✅ **Reconnect.** A lost room is reported with its cause; the app rejoins with fresh tokens
      and backoff (not after a duplicate sign-in or a removal), and reconcile republishes whatever
      LiveKit did not restore. Needs a pulled-cable test.
- [x] ✅ **Device hot-swap.** Output and capture follow the system default, fall back to it when the
      chosen device disappears (keeping the choice) and return when it comes back; the speaker is
      opened in its own channel layout / sample format.
- [x] ✅ Playback, capture and connection problems are reported through session / runtime state.
- [ ] 🟢 The engine holds an Arc cycle (tasks hold the shared state which owns the engine); it's
      broken on `disconnect()`. Confirm no leak across many connect/disconnect cycles.
- [x] ✅ No network or device work runs under the state lock or on the UI thread: commands are
      async and the engine + capture live behind a separate `ops` lock (`AudioRuntime`).

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
