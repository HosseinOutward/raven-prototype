# Picture in picture for screen shares and camera feeds

## Context

During a call, people want to keep a friend's share or camera in view while working or playing in another app. Today, video only shows on the stage inside Raven's main window.

Browser picture in picture can't do this: `requestPictureInPicture` needs a `<video>` element, Raven's frames are MJPEG in an `<img>`, and Document PiP can't be relied on in WebView2 or WebKitGTK. So each video gets its own small always-on-top Tauri window.

The media engine needs no change. `VideoFrameHub` already fans one stream's JPEGs out to any number of viewers (`stream.rs` `publish`), and the loopback URL works from any webview. A second `<img>` adds no capture, network or JPEG encoding cost.

### Decisions (Soroush, 2026-11-03)

- **Stage tile:** shows a placeholder, "In picture in picture", with **Bring back**. The video never plays twice.
- **Windows:** several at once, one per video.
- **Opening:** only from a button on the tile. No automatic opening.
- **Allowed videos:** others' cameras and shares, plus your own camera. Not your own share.
- **Capture:** the window is hidden from your own shares, screenshots and recordings (`contentProtected`). This works on Windows and macOS only. Linux has no such option.

Not in this plan: automatic opening, speaking ring, audio controls and stream info in the window.

## Design

**Window.** Main opens it through the `WebviewWindow` API, as `lib/tauriWindow.ts` does for Studio:
- Label: `pip-<sanitized key>`
- URL: `/#/pip/<encoded participantId>/<camera|screen>`, or `/#/pip/self/camera` for your own camera. The local participant's id can change between `local` and the real id, so self is looked up by `isLocal`.
- Options: `decorations: false`, `alwaysOnTop: true`, `skipTaskbar: true`, `visibleOnAllWorkspaces: true`, `shadow: true`, `resizable: true`, `focusable: false`, `focus: false`, `contentProtected: true`, title `Raven picture in picture`, minimum 240×135.
- `focusable: false` matches the voice overlay: a click on the window must not take focus away from a game. It has no keyboard focus, so everything it offers is also reachable on the stage (rule 13).

**State.** The window is self-sufficient. It calls `videoCommands.getState()` and `getStreamEndpoint()`, subscribes with `subscribeVideoStateChanged`, and finds its tile through the existing `useNativeMediaTiles`. Name, stream URL, paused state and muted state then match the stage, and the URL follows a new stream id after a rejoin.

**Status of a window.** A pure function `pipStatus(state, tile)` returns one of:
- `live`
- `reconnecting`: `viewerConnected` is false
- `gone`: no tile, camera off, share ended, or no longer receiving (Stop watching). After 5 s of `gone` the window closes itself, so a brief rejoin doesn't close it.

**Ownership in main.** A `usePictureInPicture` hook, composed in `useRavenMediaAdapter`, owns:
- the set of open keys, updated from `tauri://destroyed`
- open and close
- closing any windows left over when the main page loads, with `getAllWebviewWindows`. A reload mid-call closes them instead of recovering them.
- closing every window on a real Leave, but not across the supervisor's rejoin cycle (`activeNestId`/`phase`; read `leaveMediaSession` at line 676 and the rejoin path at lines 851–902 first)
- raising main and showing the call when the window sends `pip-return`

**Your own camera.** `syncLocalPreviewEnabled` turns the local preview off when main is hidden or the Mixer is open, which would freeze the window. It must stay on while your own camera is in a window. In RTC self-preview mode this doesn't apply.

**Placement.** The first window goes bottom right on main's monitor, at 400×225 for a share and 320×180 for a camera. Windows then remember the last position and size in `localStorage`. Windows with no remembered spot stack upward by a default share's height plus the margin, so a camera never hides a share. Windows from a remembered spot step by 24 px. The rect is clamped to a monitor that still exists. The window always has the picture's shape. On Windows `WM_SIZING` holds it during a resize (`src-tauri/src/pip_window.rs`). Elsewhere the size is corrected once the drag settles. It is also corrected when the picture arrives or changes shape, checked once a second.

## Files

**New**
- `src/components/media/PictureInPictureWindow.tsx`: the view.
  - Black background, `<img>` with `pointer-events-none`, and `startDragging` on mouse down so the whole window drags. A drag region would maximize on a double click.
  - Name chip with `MonitorUp` for shares and `MicOff` as on the tile. No deafened mark: only the stage sets that field.
  - Hover controls in the tile's `bg-black/65` style: **Back to the call** (returns the video and raises Raven) and **Close** (returns the video only).
  - Same pause and "Reconnecting…" text as the tile.
- `src/lib/pictureInPicture.ts`: key, label and route helpers, `pipStatus`, `pipRect`, the open call, the `pip-return` event.
- `src/lib/pictureInPicture.test.ts`: tests for the above.
- `src/shells/ravenv1/usePictureInPicture.ts`: the hook.
- `docs/plans/picture-in-picture.md`: this plan, copied into the repo.

**Edit**
- `src/lib/route.ts` and `src/main.tsx`: the `pip` route.
- `src/styles.css`: `body[data-raven-window="pip"]`, with no minimum size and a black background.
- `src/components/media/MediaTile.tsx`:
  - New props `inPictureInPicture`, `onPictureInPicture`, `onBringBack`.
  - A `PictureInPicture2` tile action, shown only when there is a stream to show.
  - The placeholder branch, with no `<img>`, and Fit and Full screen hidden.
  - Move `sharePausedText` to `stageState.ts` so both views use it. Component files export components only.
- `src/components/media/LiveMediaStage.tsx` and `src/shells/ravenv1/views/NestView.tsx`: pass the props through. No handler for your own share.
- `src/shells/ravenv1/useRavenMediaAdapter.ts`: compose the hook, add the local preview condition, expose it on the adapter state.
- `src-tauri/capabilities/default.json`: add `pip-*` to `windows`, plus `core:window:allow-set-position`, `core:window:allow-set-size` and `core:window:allow-start-resize-dragging`.
- `src-tauri/src/tray.rs`: a small command that wraps `show_main_window`, registered in `lib.rs`. Check it exists on every platform (line 849).
- `src-tauri/src/video/capture.rs`, Windows `list_windows`: skip windows with Raven's own process id and the PiP title. Otherwise the share picker lists them as black thumbnails.
- `.claude/skills/raven-media-engine/references/video-engine.md` and `.claude/skills/raven-ui/references/surfaces.md`: a short section each.

## Risks to check early

Check these on the first build. All of them depend on `focusable: false` on an undecorated window.
- Undecorated resize works. Tauri's built-in resize borders should cover it. If not, add a corner grip using `startResizeDragging`.
- Drag and hover controls work without activating the window.
- **Back to the call** can bring main forward. Windows may only flash the taskbar button instead. Report it if so.

## Verification

1. Run `bun test` for the route, `pipStatus` and `pipRect`, then `bun run build`, a cargo check, and `bun .claude/skills/raven-ui/scripts/sweep.ts`.
2. Run one live pass at the end, using the rig in `raven-media-engine/references/testing.md` with a second participant:
   - Open a share and a camera at once. Compare per-stream stats: shown fps should match the stage, with one JPEG encode per stream.
   - Click the window over another app. Focus stays there.
   - Drag, resize and hover. Close and Bring back both restore the stage tile.
   - Rejoin mid-call: the window survives and the picture returns.
   - Remote stops sharing: the window closes within about 5 s of the tile going away. If the sharer is killed rather than leaving, LiveKit takes about 20 s to drop them first. Stop watching closes it too. Leave closes all windows.
   - Own camera with main hidden to tray: the picture keeps moving.
   - Share your whole display: the second participant does not see the window, and the picker doesn't list it.
3. State what could not be checked: Linux and macOS can't be built on this machine. Always-on-top on Wayland and capture exclusion on Linux are expected gaps.
