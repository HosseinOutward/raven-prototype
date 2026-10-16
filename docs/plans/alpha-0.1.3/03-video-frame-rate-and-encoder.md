# Plan 03 — Why video frame rate is lower than requested, which encoder runs, and per-stream stats

You are working on Raven, a Tauri v2 desktop app for voice-first rooms (repo
`C:\Users\Soroush Taheri\code\raven`, desktop app in `apps/desktop`). All media is native
Rust. The video engine is in `apps/desktop/src-tauri/src/video`. Remote video reaches the
WebView as MJPEG over a loopback HTTP server, rendered by `<img>` tags.

In the v0.1.3 closed alpha, testers saw a screen share's actual FPS come out lower than
requested. Soroush also asked for a setting to choose dedicated or integrated GPU
encoding. He believes hardware encoding already happens: when he shares, his dedicated
GPU goes from about 0% to about 6% and its fans spin up, while CPU rises 4–5%. The code
suggests otherwise (see below). This plan:

1. finds and fixes the causes of the low FPS, with measurements;
2. reports truthfully which encoder and decoder are used;
3. adds per-stream receive stats that plan 04 will show on each watched tile.

**Not** in this plan: building a hardware encoder or a GPU picker. If the evidence shows
encoding is software and CPU-limited, write up the options for Soroush instead.

## Before you start

- Load the `raven-media-engine` skill and read `references/video-engine.md`,
  `references/webrtc-livekit.md` and `references/testing.md`.
- If you are in a git worktree, `.claude/skills` and `.env` are gitignored, so they are
  missing there. Copy both from `C:\Users\Soroush Taheri\code\raven` and run `bun install`
  in `apps/desktop`.
- `CARGO_TARGET_DIR` is `%USERPROFILE%\rv`, shared by every checkout. Only one Raven dev
  app can run at a time. Check before starting it, and if one is running, ask the user
  rather than stopping it.
- Don't commit, push or release unless the user asks.

## Findings so far (verify each before relying on it)

**A. The sender throws away frames.** `video/capture.rs:60–100`,
`ProfiledVideoFrameSink::should_forward`:

- It forwards a frame only if `now - last >= interval`, then sets `last = now`.
- Windows Graphics Capture delivers frames at the display refresh rate, with jitter.
- At 60 Hz with 30 fps requested, a frame arriving at 33.2 ms (just under 33.33) is
  dropped and the next comes at 50 ms. The output lands well under 30 (estimated 20–25).
- At 60 fps on a 60 Hz display it loses a large share of frames.
- It wraps every source (`capture.rs:307`), cameras included.
- Fix with deadline scheduling: advance `next_due` by the interval, accept a frame within
  a tolerance of the deadline, and never let the deadline fall more than one interval
  behind (no burst catch-up).
- Prove it with unit tests that simulate 60 Hz and 144 Hz sources with ±2 ms jitter at
  15, 30 and 60 fps targets.

**B. The receive-side display gate has the same bug.** `video/stream.rs:308`
(`VideoFramePublisher::wants_frame`) uses the same "elapsed < interval → drop" pattern on
decoded frames. Fix it with the same helper.

**C. Receivers see a low cap by default.** `video/domain.rs:481`
(`VideoPresentationSettings::limits_for`) caps how fast a remote share is *shown*:

- 10 fps on Efficiency, 15 on Balanced (the default), 30 on Quality.
- The profile is chosen in Settings › Audio and video (`UserSettings.tsx` around line
  320) and applied in `useRavenMediaAdapter.ts:326`.
- So a share sent at 30 or 60 fps is shown at 15 unless the viewer changes a setting they
  may not know exists.
- Rethink the share caps: a share should be shown at the frame rate it arrives at, within
  what the JPEG path can sustain (for example up to 30 on Balanced and up to 60 on
  Quality).
- Decide from measurements, and update the Settings copy if its meaning changes.

**D. The JPEG path is probably slower than it needs to be.** `stream.rs:380–400`
(`encode_frame`):

- It uses `mozjpeg::Compress::new` with mozjpeg's default profile (trellis quantisation,
  optimised scans). That is built for small files, not speed.
- A share is JPEG-encoded at its received size, downscaled only if it is larger than
  1920×1080 (`fit_dimensions` never upscales), at q92. Encoding is gated by
  `encoder_busy`, so a slow encode silently lowers the shown frame rate.
- Measure the encode time per frame. Then try the fastest settings (turn off trellis,
  optimised coding and progressive, or use `set_fastest_defaults` if the crate exposes
  it). Loopback bandwidth doesn't matter.
- Also measure the I420→RGB conversion and resize cost.

**E. The encoder is software VP8 on Windows.**

- webrtc-sys 0.3.34 (`~/.cargo/registry/src/*/webrtc-sys-0.3.34/build.rs`) compiles no
  hardware encoder on Windows: NVENC is Linux-only and the Windows path is commented out.
- `TrackPublishOptions` defaults to VP8 with `video_encoder: VideoEncoderBackend::Auto`
  (livekit 0.7.45, `room/options.rs:136`), and Raven doesn't override either
  (`video/engine.rs:664`).
- The GPU load Soroush sees is most likely Windows Graphics Capture itself.
  `windows-capture` creates a D3D11 hardware device, and every frame is copied from a GPU
  texture to a CPU buffer (`capture.rs` around line 729: `frame.buffer()` then
  `packed_to_i420`). The WebView composites the self-preview `<img>` on the GPU too.
- Confirm this with evidence; don't argue it:
  1. Add `encoder_implementation` and `power_efficient_encoder` (outbound RTP stats) and
     `decoder_implementation` (inbound) to the quality report. libwebrtc 0.3.36
     `stats.rs` has all three.
  2. Show the encoder in the dock's network popover line (`networkActivity.ts:103`
     `screenShareQualityNotice`, shown in `DeviceDock.tsx:1058`). For example:
     "Encoder: libvpx (software)".
  3. During a share, look at Task Manager (or `Get-Counter "\GPU Engine(*)\Utilization Percentage"`)
     and say which GPU engines are busy: 3D, Copy or Video Encode.
- Also record the outbound `quality_limitation_reason` while sharing at 1080p30 and 720p60
  (`HighMotion`). If it says "cpu", software encoding is a real limit.

**F. A static screen sends fewer frames.** Windows Graphics Capture sends nothing when the
screen doesn't change, so a low "actual fps" on a still screen is expected.

- Measure with moving content (a video playing, or a moving window).
- Consider whether the dock line should say so instead of looking like a fault.

## Per-stream receive stats (for plan 04)

Today `measure_video_quality_report` (`video/engine.rs:235`) measures only the *first*
published and the *first* subscribed screen share.

Add a per-stream report for every subscribed remote video track (shares and cameras),
keyed by the same stream id the tiles use (`remote_stream_id`, the publication SID). It
should include:

- resolution
- fps received/decoded
- fps shown (count frames actually delivered by the publisher)
- bitrate (from the `bytes_received` delta between polls)
- packet loss, jitter, frames dropped
- codec (`mime_type`)
- `decoder_implementation`

Rules for it:

- Expose it as a new command (for example `video_get_stream_stats`) with its twin types
  in `src/lib/video.ts`. Plan 04 builds the UI ("Stream info" on each watched tile), so
  only build the command, its types and a test or CDP check here.
- If the sender's requested profile can be learned on the receiving side (publication
  dimensions or track metadata), include it. If not, leave it out and say why.
- The command must be cheap when called every 1–2 s while a popover is open, and must
  never block the video thread.

## Measuring

Use one machine:

- Share a screen (or a window playing a video) and set self-preview to RTC
  (`SelfPreviewMode::Rtc`, see the video reference). The viewer then subscribes to your
  own share through the SFU, so you measure the full path.
- Record each stage's fps for 1080p30 and 720p60 shares, before and after:
  1. capture callback rate
  2. forwarded by the sink
  3. encoded (`frames_encoded` delta)
  4. decoded
  5. shown
- Note CPU usage and the encoder in use.
- Sharing captures the real screen. Tell the user before you start a share, and avoid
  sharing anything private.

## Docs to update

Update `references/video-engine.md` (the presentation table, frame gating, encoder facts)
and `references/webrtc-livekit.md` ("Video specifics") in `.claude/skills/raven-media-engine`.

## Report to Soroush

- The stage-by-stage fps table, before and after.
- Which encoder and decoder run, and which GPU engines show load.
- A short explanation of the GPU observation.
- If encoding is software and CPU-limited, the realistic options with rough cost:
  - wait for upstream;
  - patch webrtc-sys to enable NVENC on Windows (NVIDIA only, H.264, CUDA headers at
    build time);
  - write a Media Foundation encoder (Intel, AMD and NVIDIA, and the only way to choose a
    GPU).

  Don't implement any of them.
