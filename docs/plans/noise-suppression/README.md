# Noise suppression tiers: implementation plans

The microphone today has one "Noise suppression" switch, which turns on WebRTC's
classic suppressor inside sonora. That suppressor handles steady noise (fans, hum) but
not keyboards, dogs, dishes or traffic. These plans replace the switch with four
choices:

| Mode | What runs | Added delay | Cost |
|---|---|---|---|
| Off | Nothing | 0 | 0 |
| Standard | sonora's WebRTC NS, as today | 0 (already paid) | negligible |
| Strong | RNNoise via the pure-Rust `nnnoiseless` crate | ~10 ms | ~1–2% of one core, <0.5 MB |
| Studio | DeepFilterNet 3 via `deep_filter` + tract | ~30–40 ms | ~8–20% of one core, ~8 MB model |

The delay and CPU figures are published ones, not measured in Raven. Both plans ask the
session to measure and report the real numbers.

Background and the comparison of alternatives (GTCRN, DTLN, Demucs, DPDFNet…) were
discussed with Soroush on 2026-10-18. GTCRN and the low-latency DeepFilterNet variant
were rejected: 16 kHz-only output for the first, a 36 MB model for the second.

Each plan is written for one Claude session (Opus, medium effort). To start one, give
it one line:

> Read and implement `C:\Users\Soroush Taheri\code\raven\docs\plans\noise-suppression\<file>`.

Use the absolute path. These files are untracked, so a session in a git worktree won't
have them in its own checkout.

| Plan | What | Kind | Size | Depends on |
|---|---|---|---|---|
| [01](01-modes-sonora-split-and-strong.md) | The mode type, splitting sonora around a suppressor stage, Strong, live switching, the UI and persistence | Audio engine + dock + Mixer | L | — |
| [01.5](01.5-voice-detection-cleanup-and-settings.md) | Voice detection for the speaking ring and the muted warning; cleaning up someone else's mic for you; a depth setting; remembering echo cancellation and automatic gain; an open-source licences screen. **Done (A to E), 2026-10-18** | Audio engine + stage logic + Mixer + Settings | L | 01 merged |
| [02](02-studio-and-overrun-fallback.md) | Studio (DeepFilterNet 3), off-thread model loading, the overrun guard and its fallback to Strong | Audio engine + dock + Mixer | M–L | 01 and 01.5 merged |

Run them in order: 01, 01.5, 02. They touch the same files (`suppression.rs`,
`capture.rs`, the mic popover, the Mixer), so never run two at once. 01 ships on its own:
after it, users have Off, Standard and Strong. 01.5 is five independent parts; a session
that runs out of room stops after a finished part and says which are left.

## Decisions (2026-10-18)

Soroush confirmed these on 2026-10-18. Each lives in one place in the code.

1. **New microphones default to Strong.** Discord turns Krisp on by default. RNNoise is
   cheap enough to make that safe. "Defaults are law" (manifesto 7.2), so this is a real
   choice.
2. **Suppression depth is capped at 24 dB** in Strong and Studio, so a little room tone
   stays and silence doesn't sound dead. Plan 01.5 makes this the "Balanced" step of a
   Mixer setting (a little / balanced / as much as possible).
3. **The Studio model is compiled into the app** (`deep_filter`'s `default-model`
   feature, about 8 MB). The alternative, downloading it from the update server on Saye
   the first time Studio is chosen, is noted in plan 02 but not built.
4. **When Studio can't keep up, it falls back to Strong for the rest of that call**,
   tells the user once, and tries Studio again on the next call.
5. **Changing the mode mid-call never reopens the microphone.** The echo-cancellation
   and automatic-gain switches still reopen it, as they do today.

## Follow-ups

Soroush asked on 2026-10-18 for the follow-ups to be built rather than parked. They are
plan 01.5:

- the speaking ring and "talking while muted" warning gated by voice detection;
- a listener cleaning up someone else's noisy mic on their own side;
- a suppression-depth setting;
- echo cancellation and automatic gain remembered across restarts;
- an open-source licences screen.

For voice detection, 01.5 uses WebRTC's RNN VAD from `sonora-agc2`, not the
suppressor's own output. It is already compiled in, cheap enough to run on every
incoming track, and works whatever suppression mode the speaker uses.
