# Closed Alpha Compatibility Check

**Updated:** 2026-08-18  
**Targets:** Windows x64 and Linux x86-64  
**Verdict:** suitable for a controlled candidate smoke test after the manual checks below. Windows builds locally. Linux source paths now fail safely when runtime media dependencies are absent; native Linux behavior remains to be tested on the Debian/XFCE `homelab` environment.

## Current feature matrix

| Capability | Windows | Linux | Candidate status |
|---|---|---|---|
| Server selection and login | Shared React/Go flow | Same flow | Ready for provisioned accounts; use HTTPS outside a private network. |
| Nest entry | Existing membership flow | Same API | Ready for pre-provisioned testers. Link/code joining is intentionally deferred. |
| Microphone | CPAL capture and native LiveKit publication | Same architecture | Confirmed-state UI and join-muted behavior are fixed; test permissions and device switching. |
| Camera | Windows camera backends | V4L2 through `nokhwa` | Failed capture/publication now stays visibly off; test real and virtual cameras. |
| Deafen/output | Receiver-local mute/subscription and CPAL output | Same | Linux selected outputs are now validated instead of silently falling back. |
| Screen share | Windows Graphics Capture | xdg-desktop-portal, PipeWire, and GStreamer | Runtime readiness is reported. Test portal selection, cancellation, and stop/restart. |
| Mixer | Rust-owned local/remote channels, meters, DSP, and presets | Same; per-app audio remains unavailable | Automated state tests pass; test sustained multi-track use and non-default output. |

## Automated checks

| Check | Result |
|---|---|
| Frontend type-check/build | Passed; Vite still reports the existing approximately 645 kB main-chunk warning. |
| Frontend tests | 40 passed. |
| Rust tests | 78 passed. |
| Rust Clippy | Completed with the existing warning set. |
| Rust formatting | Changed media files are formatted; the whole-tree check still includes the pre-existing import-order issue in `src/lib.rs`. |
| Go API | No Go source changed in this fix pass; the preceding audit’s `go test ./...` and `go vet ./...` passed. |

## Linux manual checks on Debian/XFCE

1. Start Raven from the actual AppImage inside the XFCE graphical session and confirm the capability message reports any missing PipeWire, portal, or GStreamer component.
2. Join with Always Join Muted enabled and a microphone retained from a previous Nest; verify no audio is heard before an explicit unmute.
3. Deny or cancel microphone, camera, and portal capture. Each control must stay off and provide a retryable error.
4. Test display and window sharing, stop/restart, and sharing with system audio.
5. Select and test two speakers. Confirm remote audio and the test tone both use the selected output; unplug or remove it and confirm Raven reports the failure rather than using another output silently.
6. Run two-way voice/camera plus the mixer for 30 minutes, including deafen, device switching, and reconnect.

## Windows manual checks

Run the same two-client media matrix on Windows 11, including permission denial, a physical and virtual device where available, monitor/window sharing, non-default output, deafen, and a 30-minute mixer session. Install and update using the signed candidate artifact rather than only the development build.

The existing release workflow can continue to build the Linux update revision on `homelab`; successful packaging is not a substitute for the graphical and hardware checks above.
