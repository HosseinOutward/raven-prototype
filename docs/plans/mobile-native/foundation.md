# MobileNative (native Android) foundation

Status, 2026-11-11: implemented for foreground calls. It builds an arm64 debug APK.
On a phone (Samsung SM-S711B, Android 16) it cold-starts, renders sign-in, fits the
viewport and respects system bars. Calling, authentication, permission flows and
audio routing on a device are still unverified; see
[device qualification](#device-qualification).

MobileNative is the native Android app. "mobile" alone still names the separate
Capacitor `web:*` client, which is unchanged.

## Separation from desktop

Desktop is the default and primary app. Shared code carries no platform tag or
check; the platform is chosen once, at a boundary:

- **Rust:** Tauri's built-in `mobile` cfg marks the native app. Desktop-only code is
  `#[cfg(not(mobile))]`, MobileNative-only code `#[cfg(mobile)]`, and shared code is
  untagged. The plugin crate and Cargo target tables use `target_os = "android"`. Engines ask
  `src/media_eligibility.rs` whether media may run; on desktop its checks are
  constants. The camera backend is chosen by tagged match arms in `video/capture.rs`:
  nokhwa on desktop, `mobile_native/camera.rs` (CameraX) on MobileNative. Most remaining
  tags sit in `lib.rs`, where the app is assembled.
- **Frontend:** `isAndroid` (`src/mobileNative/platform.ts`, from Tauri's `TAURI_ENV_PLATFORM`)
  selects the shell in `App.tsx`. `useRavenMediaAdapter` takes an optional `CallHost`
  (`src/lib/callHost.ts`): desktop's default does nothing beyond the engines, and MobileNative's
  (`src/mobileNative/callHost.ts`) owns calls and OS permissions. The call
  supervisor delegates those steps to it and never branches on the platform. The one
  target check in a shared view hides microphone monitoring in the mixer.
- **UI:** `src/mobileNative/` holds the MobileNative shell and everything only it
  uses. It reuses shared views and design primitives until a screen needs its own
  mobile design; that screen then moves into this folder. Shared views get no
  platform conditionals.

## Ownership

- The regular `apps/desktop` Vite entry and Rust crate build the MobileNative app.
  `src/mobileNative/useMobileNativeApp.ts` composes the same data, media, Nest entry and
  chat owners as the desktop shell, with its own Back-stack navigation. Only one shell
  renders, and its navigation never unmounts the call owner.
- `scripts/mobile-native.ts` runs through the existing `.env`-loading wrapper, skips the
  desktop MSVC and signing setup, and supports Gradle's re-entry into the wrapper.
  It generates the ignored `src-tauri/gen/android` project through Tauri. All
  authored Kotlin, Gradle, resources and manifest inputs live in
  `src-tauri/plugins/raven-mobile-native`. Launcher icons are generated from the desktop
  `icons/icon.png` into ignored output; the plugin's adaptive icon XML insets that
  foreground into the launcher mask.
- The build target is chosen at composition (`isAndroid`), not from screen
  width or user agent. The MobileNative shell reuses sign-in and feature views, keeps call
  controls on screen while a call is active, handles system Back, and keeps the
  server compatibility check without the desktop updater.
- The `raven-mobile-native` plugin owns OS permission requests, communication audio focus,
  Activity lifecycle and CameraX. The existing Rust engines
  still own capture processing, mixing, publication, subscription and video
  presentation. There is no browser media fallback and no separate Android room.
- Kotlin keeps no permission state. Rust calls Tauri's built-in `checkPermissions` and
  `requestPermissions` and maps the result into the MobileNative state snapshot, which
  the call host reads: prompt is `notRequested`, prompt with rationale is `denied`,
  denied is `requiresSettings`. Requests are serialized because Tauri Android keeps one
  pending permission callback. Queries never prompt; explicit capture actions do. The
  pre-join microphone and camera chips only ask for OS permission
  (`requestCapture` resolves on permission alone). A denied microphone still allows a
  receive-only call, and the shell offers the app settings page. Microphone monitoring
  is unsupported on Android (the native `supports_monitoring` capability), so the mixer
  hides it. The camera button asks for permission before listing cameras, because
  CameraX may list none until granted.
- Camera frames travel through JNI into the existing capture and sink pipeline.
  There is no Rust worker: the CameraX analyzer thread reads CameraX's direct RGBA plane
  buffer in place over JNI, and `KEEP_ONLY_LATEST` drops frames while it is busy.
  `mobile_native/camera.rs` converts them with the shared `packed_to_i420` and reports
  observed dimensions and measured frame rate. Front-facing cameras are listed first.
  Stopping a camera drains the analyzer executor with a marker task, so the main thread
  never blocks, before Rust frees the callback handle; if draining fails, the handle is
  kept rather than freeing memory a callback may still use.
- Plugin calls are async (`run_mobile_plugin_async`), except camera start, stop and
  list, which the video engine calls synchronously.

## Foreground lifecycle

`useRavenMediaAdapter` remains the one call supervisor. LiveKit roles, admission,
entry defaults, session/presence and reconnect rules are shared with desktop.
A foreground service keeps audio calls running in the background. Heartbeat and rejoin
still run in the WebView, which Android may throttle while the app is away, so presence
could lapse during a long background call. If the heartbeat drops, the follow-up is
moving that ownership into Rust.

`mobile_native/media.rs` turns OS events into media eligibility
(`mobile_native/gate.rs` holds the host-tested state machine). Its state lock is never held across device or network
work. A terminal stop advances the epoch before waiting for engine locks. Each lifecycle,
focus or permission change stops output and reconciles the engines against eligibility,
without involving JavaScript; connecting or activating a call requires an open one. Stops and begins are
serialized, so an old shutdown cannot disconnect a new call or release its audio
focus. Audio needs an active call and focus. Camera capture also needs the foreground,
the current epoch and OS permission (`camera_current`, `require_camera`). A running
camera drops frames once its call's epoch has ended or the app is backgrounded.

Activity stop with a call keeps the call and its audio running (`Backgrounded`); Kotlin
unbinds the camera and refuses to bind CameraX unless the Activity is at least STARTED,
and Rust releases the camera. A camera that is still on restarts when the app returns.
Swipe-away or Activity destroy ends the call (`BackgroundTerminal`): Rust closes
microphone and playback eligibility, disconnects media and releases focus. On return, React cancels the old join or reconnect and reconciles
server state, and it recognizes a stopped epoch even if JavaScript missed both
lifecycle events. Server presence cleanup relies on timeout while the WebView is
suspended.

Permission dialogs do not count as Activity stop. Audio focus loss keeps the call.
Permanent loss to a media app leaves the call running alongside it. Transient loss (a phone
call, an assistant) pauses call audio: playback (gated in `OutputMixer::start`, stopped by
reconcile) and capture stop while desired settings and publication intent are kept, and
audio resumes automatically when focus returns. Starting a call while focus is denied (a
phone call is active) still fails. Mute, deafen and server moderation keep their meanings.

## Native startup and packaging

Kotlin initializes WebRTC from the Application context, then enters Rust through
JNI, which keeps Android's application class loader. No Activity reference is kept
as WebRTC's application context.

The plugin's `build.rs` uses the same locked `webrtc-sys-build` archive as the SDK. It
stages the JAR, the JNI companion and the NDK C++ runtime under ignored
`src-tauri/target/mobile-native`, at the paths `scripts/mobile-native.ts` gives it. The patched JAR loads `lkjingle_peerconnection_so`, so
the companion is packaged as `liblkjingle_peerconnection_so.so`. Gradle reads these
paths from `ravenWebrtcJar` and `ravenNativeLibs`; no binaries are checked in. JNI
classes and invoke arguments have R8 keep rules. Native libraries use 16 KB ELF
alignment, set in the app's `build.rs`.

Desktop tray, updater and window setup are compiled only for desktop. The API sidecar
code and the audio sidecar participant are shared; the API sidecar starts only when
`RAVEN_DESKTOP_API_MODE` is `sidecar` or `local`, which Android never sets. The
`macos-private-api` Tauri feature stays enabled on every target because Tauri
validates it against the shared configuration; it has no effect on Android.

## Inputs and commands

Tested toolchain: Rust 1.99.1 with `aarch64-linux-android`, JDK 17, SDK platform 36,
build tools 35.0.0, NDK 27.2.12479018 (the default `scripts/mobile-native.ts` selects
under the SDK), Gradle 8.14.3. The Tauri CLI version is locked in `bun.lock`. App ID `app.raven.mobile` (kept
until release; changing it installs a separate app),
minimum API 26, target API 36.

The entry accepts `ANDROID_HOME` or `ANDROID_SDK_ROOT` and an explicit `JAVA_HOME`.
It selects the pinned NDK in that SDK unless `NDK_HOME` or `ANDROID_NDK_HOME`
selects the same revision; both names are forwarded because Tauri and the locked
SDK read different ones. Rust must be on PATH.

From `apps/desktop`:

```sh
bun install --frozen-lockfile
bun run mobile-native:init
bun run mobile-native:check   # frontend tests, then the arm64 debug APK build
```

Set `RAVEN_MOBILE_NATIVE_API_URL` or `VITE_RAVEN_API_URL` to an API address
the phone can reach; the script passes it to Vite in place of the desktop URL. The
wrapper `scripts/tauri.ts` loads the repository `.env` into `process.env` by plain
assignment, so a nonempty `.env` value wins over the same variable set in the shell;
edit or clear it there. Release builds require an `https:` URL; debug builds keep the
http rules below.

The APK is written under
`src-tauri/gen/android/app/build/outputs/apk/universal/debug/`. Despite the
`universal` name it contains arm64 only, and it is debug signed.

Release builds allow cleartext only to the loopback frame service
(`127.0.0.1`/`localhost`); debug builds also allow a LAN API. HTTPS certificate
validation is unchanged.

## Device qualification

Still to verify on a phone:

- Calls, authentication, persistence, live updates, compatibility, logout,
  revocation and account or server changes in the installed WebView.
- Two-way audio and video with a desktop peer, remote camera and share
  presentation, mute, deafen, moderation, cancellation and device release.
- Microphone and camera denial, returning from settings, revocation, focus
  interruption, and background audio, camera release and restart on return, and swipe-away teardown.
- LAN and real servers, ICE reachability, TURN, and dev versus bundled origins.
- Sustained CPU, heat and battery, Studio performance, and a 16 KB-page device.
- Desktop startup and calls on Windows and macOS, including macOS linking.

Android device lists come from cpal/Oboe and are identified by name, so duplicate
names are possible, and choosing an output may not change the route while
`MODE_IN_COMMUNICATION` is set. Real earpiece, speaker and Bluetooth routing needs
`AudioManager.setCommunicationDevice` plugin commands, which are out of scope for now.

Not in this step: screen and playback capture, full audio route
selection, PiP, full feature parity, push, distribution, URI-aware file workflows
and iOS.
