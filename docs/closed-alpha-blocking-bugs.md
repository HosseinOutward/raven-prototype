# Closed Alpha Bug Status

**Updated:** 2026-08-18  
**Scope:** onboarding/login, Nest entry, voice, camera, deafen, screen sharing, and mixer

## Alpha decision

Items 1–3 from the initial audit are accepted limitations for this invite-only variant:

- Candidate accounts will be provisioned by the operator; a complete onboarding UI is deferred.
- Link/code joining is intentionally absent from this variant.
- Nest membership and disconnect lifecycle changes are deferred with the joining workflow.

These limitations should be stated to testers, but they are not blockers for the close-friends alpha.

## Fixed for candidate media testing

### 4. Always Join Muted now covers retained microphones

Every existing microphone source is unpublished and muted before the native audio sidecar connects. A source retained from an earlier Nest can no longer be briefly republished unmuted. A regression test covers the retained-source case.

### 5. Media controls now represent confirmed native state

Mic, camera, and screen-share indicators require all of the following: an enabled source, requested publication, a published track, and a running native capture runtime. Native capture and LiveKit publication reconciliation now return command errors instead of only logging or storing them. The errored state is still emitted so the UI can show a retryable message and remain visibly off.

A camera or screen share chosen before joining is a separate, third state: the source exists but the engine opens no device until there is a call. The dock shows it as an outline ("ready"), never as the filled "live" indicator, and the same control turns it off again. Before this, the choice was invisible and could not be undone outside a call.

This needs a two-client manual check for camera/microphone permission denial and a rejected or interrupted LiveKit publication.

### 6. Linux media support is checked at runtime

Linux no longer claims system audio and screen sharing solely because it was compiled for Linux. Readiness now checks the PipeWire tools/session used by system audio and the desktop-session/GStreamer PipeWire support used by screen sharing. Unsupported functions are omitted from the native capability report, with an actionable reason surfaced in the desktop UI.

Portal approval/cancellation and the XFCE portal backend still require testing on the Debian candidate environment.

### 7. Linux speaker selection no longer silently falls back

Speaker enumeration now uses CPAL’s playback namespace end to end. A selected speaker is validated against the playback backend and rejected if it cannot be resolved. Linux system-audio capture separately maps the selected playback name to its PipeWire sink and reports an error when no mapping exists.

Test this with two outputs on Linux, including a virtual sink if available.

## Remaining rollout decision

Production Nest events still need an operator decision. The SSE endpoint has no heartbeat or explicit proxy-buffering opt-out, while the production proxy may buffer the stream. This can delay participant/presence changes or cause periodic reconnects. Either fix this before rollout or explicitly include a two-client deployed latency test and accept reconnect-based refresh for the first alpha.

Login throttling, stronger password policy, HTTPS enforcement for public servers, and SQLite concurrency hardening remain security/reliability follow-ups. They become blockers if the alpha API is exposed beyond the trusted private environment.

## Automated evidence

- Frontend type-check and production build passed.
- Frontend suite passed: 40 tests.
- Rust suite passed: 78 tests.
- Rust Clippy completed with the repository’s existing warnings and no new failure.
- Native Linux hardware/runtime behavior was intentionally left for manual testing.
