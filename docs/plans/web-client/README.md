# Web client: minimal plan

A small Raven web client, with an optional Capacitor Android wrapper: voice, chat
and watching streams. Written 2026-11-10 and built the same day; calls are not yet checked on a real server. Follow
`docs/AGENTS.MD`.

Scope rule: a feature stays only if it is voice, or comes nearly free from desktop code.

## Scope

- Sign in.
- Trees and their text Nests; DMs and groups. Read and send text. Images in messages show.
- Voice in a voice Nest: join, hear, mute, leave.
- Watch other people's camera and screen shares. Never send video.

## Approach

The browser client is `apps/desktop/web/`, a second Vite entry that
imports desktop's `src/` directly and uses desktop's `package.json` and `node_modules`.
Its optional Capacitor wrapper retains the installed package ID `org.raven.mobile`.
Native mobile development is separate from this web client.

- Every `@tauri-apps/*` import resolves to one stub. Async functions log
  `native call unavailable on web: <name>` and return a rejected promise; sync ones
  throw. Desktop already handles a rejected promise in the places web reaches (links
  fall back to `window.open`; tray, taskbar, sound cues and knock alerts catch it), and no
  desktop module calls Tauri at import time. So there are no stand-in modules.
- `tsc` checks web against the real desktop modules. A new `@tauri-apps` name that
  desktop starts using is missing from the stub and fails the Vite build.

## What changes

### New: `apps/desktop/web/`

| File | Purpose |
|---|---|
| `index.html`, `vite.config.ts`, `tsconfig.json` | Config. `@` → `../src`, the `@tauri-apps/*` alias to the stub, desktop's Tailwind theme scanning `../src` too. The default server is `https://mimir.rvn.bluehour.cloud` unless `VITE_RAVEN_API_URL` names another. |
| `android/` | Capacitor project, only what differs from Capacitor's template: the manifest and two `build.gradle` files. `web:android` unpacks the rest (Gradle wrapper, settings) from the template in `node_modules`. It uses Capacitor's own activity, theme and layout, and desktop's `icon.png` taken at build time. Its `capacitor.config.ts` sits in `apps/desktop/`, because the Capacitor CLI only runs beside `package.json`. |
| `src/App.tsx` | Entry: styles, fonts, theme; desktop's `useRavenShellData`, `useChat` and sign-in screens; the screen stack. |
| `src/tauriStub.ts` | The stub. |
| `src/Lists.tsx` | Home (Trees, Messages), a Tree's Nests, and the header the screens share. |
| `src/Chat.tsx` | Desktop's `MessageList` + `Composer`. |
| `src/Call.tsx` | Video tiles, Mute, Leave. |
| `src/room.ts` | The call's LiveKit room (below). Its API calls name the desktop code they match. |
| `src/room.test.ts` | Track-name and subscription rules. |

### Desktop

- `package.json`: `livekit-client`, `@capacitor/core`, `@capacitor/android`, `@capacitor/app`,
  `@capacitor/cli`; `web:*` scripts.
- `ShellLogin` and `ChoosePassword` move out of `shells/RavenShellV1.tsx` into
  `shells/ravenv1/SignIn.tsx`, without the title bar (desktop draws it around them).
  Importing them from `RavenShellV1.tsx` would pull the whole desktop shell into web.
- Build output goes to `apps/desktop/web/dist`, so nothing new needs ignoring outside
  the web folder.

### Server

No code. Config: `RAVEN_CORS_ALLOWED_ORIGINS=https://capacitor.localhost` (Capacitor's origin);
in production, the API over HTTPS and LiveKit over WSS.

## The call (`room.ts`)

From desktop's `connectMedia` and the Rust audio engine:

1. `data.joinNest` (a `waiting` result shows "Waiting to be let in"), then the `audio`
   token, so the phone is `<userId>#audio`.
2. Connect with auto-subscribe off. Subscribe to other people's `raven-audio-*` tracks, and
   to Camera and ScreenShare tracks from `#video` participants.
3. Publish the mic as `raven-audio-<uuid v4>`, source Microphone. Desktop plays only that name.
4. `joinSession`, `joinNestPresence`, `updatePresence` (`presenceForActiveNest`).
5. Heartbeat every 5 s with the Nest ID.
6. Leave: close the room, `disconnectFromNest`.

When the room disconnects or a heartbeat says `nestActive: false`, leave and show
"Disconnected" with Rejoin. `livekit-client`'s own resume handles short drops.

## Local stack

LiveKit `--dev --node-ip <PC LAN address>` and the API on `127.0.0.1:8977` (6977 is
reserved on this PC), seeded users `admin`, `alice`, `bob`, Tree "Test Tree" with "Voice
Room". The phone (Galaxy S23 FE, Wireless debugging; read the connect port off the phone)
reaches it with `adb reverse tcp:8977 tcp:8977` and `adb reverse tcp:7880 tcp:7880`;
media goes over Wi-Fi. Bob runs in a desktop browser.

The app only talks to HTTPS servers (its page is https, and Android blocks plain http), so
this stack is for the browser build (`bun run web:dev`). Test the phone on a real server.
On a network that drops UDP between devices (seen 2026-11-10), media can't reach a LiveKit on
the PC either.

## Order and checks

Each code step passes `bun run web:build`, desktop's `bun run build` and `bun test`
(baseline 2026-11-10: 796/796).

0. **Toolchain.** Done 2026-11-10: JDK 21 at `~/tools/jdk-21`, SDK at
   `%LOCALAPPDATA%\Android\Sdk`, `JAVA_HOME`/`ANDROID_HOME` set; an empty Capacitor 8.6
   app builds. The system `java` on PATH crashes; Gradle uses `JAVA_HOME`.
1. **Mic test.** A throwaway Capacitor page joins "Voice Room" as alice; alice and bob hear
   each other. Then 2 minutes with the screen off. If audio stops, add a foreground
   service (a plugin plus Android permissions) and retest; if that doesn't fix it, stop
   and rethink.
2. **Chat.** Stub, config, screens. Check: alice and bob exchange
   messages live; an image shows; a link opens.
3. **Call.** `room.ts` and the call screen. Check: they hear each other; a fake `#video`
   camera shows on the phone; Wi-Fi off ends in "Disconnected" and Rejoin works.
4. **By hand with the desktop app** (needs Rust): the phone is heard and listed; desktop's
   screen share shows on the phone.

## Release

`release.ps1 build` also builds the APK (`bun run web:android`, which makes both the debug
and the unsigned release APK), signs it with the Android key on the release PC, and
`publish` puts it beside the installers with a download button. Its version is desktop's,
from `package.json`. Off until `$ReleaseAndroid = $true` in `release.ps1`. See `docs/releasing.md`.

## Not in this plan

Sending images or files, notifications, knocks, friends, settings, reconnect, cancelling a
join, enlarging images, tile layouts, iOS, everything else desktop has.

Known limits, accepted:
- A server-deafened phone also loses video (both run on the `#audio` connection).
- The same account on phone and desktop in one call: desktop takes the call back.
- Entering skips desktop's heads-up countdown to the people inside.
- The session list shows the phone as "Raven Desktop / Linux".
