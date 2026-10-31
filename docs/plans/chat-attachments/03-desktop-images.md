# Plan 03 — Desktop: sending and showing images in chat

You are working on Raven, a Tauri v2 desktop app for voice-first rooms with text chat
(repo `C:\Users\Soroush Taheri\code\raven`, desktop app in `apps/desktop`). Read
`docs/plans/chat-attachments/README.md` first: it has the attachment model, the decisions
and the limits.

This plan needs plans 01 (server) and 02 (Rust image preparation) done and merged into
your checkout. Check first:
- `src-tauri/src/attachments/` exists;
- `services/api/internal/http` has the attachment routes.

If either is missing, stop and tell Soroush.

When you're done, a person can paste, drop or pick images in a conversation, add a
caption, and send. Everyone in the conversation sees the images in the message list with
no jumping, opens them large, and saves them. Unsent images survive a restart like unsent
text does.

Build the attachment parts **by kind**: the wire types, the send pipeline and the media
cache don't know about images. Only the tray thumbnail, the image view and the viewer do.
A later GIF, sticker, video or file is a new renderer and a new prepare step, not a
rewrite. A kind or source this version doesn't know must still show as something (step
6), because a newer Raven will send them to this one.

## Before you start

- Load the `raven-ui` skill and read its `references/design-system.md` and
  `references/writing.md`. Every word and control here follows them.
- `bun test` in `apps/desktop` must pass before and after; also `bun run typecheck` (or
  whatever `package.json` calls it).
- To try it for real you need the Go API running with S3 settings (the local `.env` has
  them) and two accounts. The `raven-ui` skill says how to run and drive the app, and
  memory has notes on driving the WebView over CDP. Only one Raven dev app can run at a
  time: if one is running, ask before stopping it.
- Don't commit, push or release unless asked.

## What is true now

Paths are under `apps/desktop/src`. Line numbers are from 2026-10-30; verify them.

- Wire types: `lib/chat/types.ts`. `ChatMessage` (~40), `ChatMessagePreview`,
  `ChatReplyRef`, `PendingMessage` (~176).
- Endpoints: `lib/chat/chatApi.ts`, through `api.call` (`lib/api.ts` ~1071).
  `request` adds `X-Session-ID` and sets `Content-Type: application/json` only for string
  bodies. The session is a header, not a cookie, so `<img src>` can't load anything that
  needs it.
- Store: `lib/chat/store.ts`. `send` (~412) adds a `PendingMessage`; the sender loop
  (~445) sends one message per conversation at a time with retries
  (`classifySendFailure` in `lib/chat/outbox.ts`). The outbox persists to `localStorage`
  (`saveOutbox` / `loadOutbox`, `version: 1`).
- Reducer: `lib/chat/reducer.ts`. `excerptOf` (~77) builds reply excerpts and previews.
- UI:
  - `components/chat/Composer.tsx`: the textarea, reply and edit bars.
  - `components/chat/MessageRow.tsx`: `MessageRow` ~81, `PendingRow` ~208, the row menu
    with "Copy text".
  - `components/chat/MessageList.tsx`: scroll anchoring.
  - `components/chat/ConversationRow.tsx`: the sidebar preview.
  - `shells/ravenv1/views/ChatView.tsx`: the conversation, which wires them together.
- Server properties: `api.serverProperties()` (`lib/api.ts` ~714), kept as
  `data.serverProperties`; `properties` is `Record<string, unknown>`.
- No dialog plugin: `src-tauri/Cargo.toml` has opener, updater, global-shortcut,
  notification and single-instance.

### What plans 01 and 02 built (reviewed 2026-10-30)

Read `01-server-attachments-handoff.md` and `02-image-preparation-handoff.md` in this
folder for the details. What matters here:

- **Create and upload answer with `{attachment, missingVariants}`.** Upload only the
  variants listed there. Create answers `201` the first time and `200` for a repeat.
- **A `clientUploadId` belongs to one conversation.** Reusing it in another conversation
  gets `422`, so make a new one per attachment, never per file.
- **`attachment_prepare` with bytes:** the options go in the `X-Raven-Attachment` header
  as JSON. Headers must be ASCII, so escape every non-ASCII character in the file name as
  `\uXXXX` (surrogate pairs included) before setting it. Persian names are common here;
  test one.
- **Restore the outbox and await `attachment_sweep` before the first prepare.** The sweep
  deletes every finished handle that isn't in `keep`, including one prepared a moment
  earlier.
- **`animated` is in the prepared result but not on the wire.** The server doesn't take
  it. For now the tray only needs it to show a still preview. Don't send it.
- Error results are `{code}` objects: `unsupported`, `tooLarge`, `damaged`, `io`.
- `attachment_read` returns raw bytes (an `ArrayBuffer` in JS). Upload them as they are,
  with the variant's `contentType`.

## Design

### 1. Types and API

- `types.ts`:
  - `ChatAttachment` as in the README;
  - `attachments?: ChatAttachment[]` on `ChatMessage`;
  - `attachments?: { kind: string }[]` on `ChatMessagePreview` and `ChatReplyRef`.
- `lib/chat/attachments.ts` (new): reads `properties.chat.attachments` into a typed
  `AttachmentLimits | null`. Missing or malformed means `null`, and `null` means no attach
  button anywhere. Expose it where the composer can see it. Follow how other server
  capabilities reach views; `RavenShellData` is a likely home.
- `chatApi`:
  - `createAttachment(id, description)`;
  - `uploadVariant(id, attachmentId, variant, bytes, contentType)` (raw body: pass the
    `Content-Type` header yourself);
  - `fetchVariant(id, attachmentId, variant): Promise<Blob>`, which needs a small
    `api.callBlob` beside `call`;
  - `send` gains `attachmentIds`.
- Thin wrappers over plan 02's commands in `lib/chat/attachmentPrep.ts`: `prepareBytes`,
  `preparePath`, `readVariant`, `discard`, `sweep`. Turn their error codes into words here
  (step 7).

### 2. The media cache

`lib/chat/media.ts`: `getAttachmentUrl(conversationId, attachmentId, variant)` returns
an object URL.

- It fetches with the session header, dedupes requests in flight, and keeps an LRU of
  about 64 MB by blob size. It revokes evicted URLs.
- Responses are `immutable`, so the WebView's HTTP cache also helps across restarts.
- A hook, `useAttachmentUrl(...)`, returns `{ url, failed, retry }`. Load only when the
  element is near the viewport: an `IntersectionObserver` with a margin of about one
  screen.
- `seedAttachment(attachmentId, variant, blob)`: after your own send, put the local
  preview bytes in the cache, so your image doesn't load twice.

Errors: `404` means the image is gone (deleted, or you can no longer see it). Anything
else can be retried.

### 3. Sending

`PendingMessage` gains `attachments?: PendingAttachment[]`:

```ts
interface PendingAttachment {
  handle: string;              // plan 02's folder
  clientUploadId: string;
  kind: string;
  description: PreparedAttachment;   // what plan 02 returned
  attachmentId?: string;       // once created
  uploaded: string[];          // variants the server has
}
```

Bump the outbox format to `version: 2`. Load `1` as before, with no attachments.
`loadOutbox` must keep the new fields. After loading, call
`attachment_sweep({ keep: handles in the outbox })`.

In the sender loop, a message with attachments goes through these steps. Each is safe to
repeat and records progress on the pending item, so a retry or a restart resumes where it
stopped:

1. For each attachment without `attachmentId`: `createAttachment`. The server returns the
   same attachment for the same `clientUploadId`, so a lost answer is harmless.
2. For each variant the server reports missing: `readVariant` from Rust, then
   `uploadVariant`.
3. `send` with `attachmentIds` in order.
4. On success: seed the media cache with each preview, then `discard` the handles.

Map new failures in `classifySendFailure`:
- `413` and `415` are final, with words from step 7;
- `422` "isn't ready" after a restart means the server purged it (24 h). Restart from
  step 1 once, then fail.

Discarding a failed message also discards its handles. Keep the existing rule: one message
at a time per conversation, in order.

Upload progress: images are small, so a spinner is enough. Put the upload behind one
function (`uploadVariant`), so video can later swap in a resumable upload with progress
without touching the loop.

`ChatStore.send` takes `attachments` as a third argument; `ChatView.send` passes the
tray's prepared items.

### 4. The composer tray

Three ways in, all ending in plan 02's prepare:

- **Paste**: `onPaste` on the textarea; take `clipboardData.files` that are images. If
  there are none, let normal text paste happen.
- **Drop**: anywhere on the conversation (the area `ChatView` renders), use Tauri's
  `getCurrentWebview().onDragDropEvent`. It gives paths, which go to `preparePath`. Show a
  drop overlay while files are over the window, and only when the conversation can take
  them.
  - Check `dragDropEnabled` in `src-tauri/tauri.conf.json`; Tauri's default intercepts
    HTML5 file drops.
  - Make sure nothing else in the app relies on drops.
  - Only the conversation that is open receives the drop.
- **Pick**: an attach button in the composer (lucide `ImagePlus`, `aria-label` "Add
  images") opens a hidden `<input type="file" accept="image/*" multiple>`; files go as
  bytes to `prepareBytes`.

The tray sits above the textarea, like the reply bar:

- One thumbnail per item, from the `preview` variant read back from Rust as an object URL.
- While preparing, the thumbnail shows the placeholder or a quiet spinner. On error it
  says why, in words (step 7).
- A remove button per item; removing discards its handle.
- At most `maxPerMessage` items. Over that, say so once and keep the first ones.
- A "Full quality" switch for the whole tray, off by default. Turning it on re-prepares
  the items in `full` mode. Say in its description what it means: larger files, not
  resized, location still removed.

The textarea is the caption. Enter sends when every item is ready and either text or at
least one image is there. Escape with a tray and no text clears the tray, after the reply
bar.

While editing a message, the tray and the attach button are hidden: edits change text
only.

Leaving the conversation with a tray: keep it per conversation for the session (a draft),
like the text draft if the composer has one. Look at how it handles text drafts and match
it.

### 5. Showing images

In `MessageRow`, above the body, render `message.attachments` through a renderer map:

```ts
const attachmentRenderers: Record<string, AttachmentRenderer> = { image: ImageAttachments };
```

Group consecutive attachments of the same kind and hand each group to its renderer.

`ImageAttachments`:
- One image: fit it in a box at most 400 CSS px wide and 320 tall, keeping its aspect
  ratio, sized from `width`/`height` **before** it loads. That is what keeps
  `MessageList` from jumping.
- Two or more: a grid of up to two columns, cells cropped with `object-cover`, at the
  same maximum width.
- Until the image loads, show the ThumbHash. Decode it with the `thumbhash` npm package
  into a data URL, memoized per attachment. If it fails, show a muted box with a retry
  button. If it's gone (`404`), show "This image is no longer available."
- Load the `preview` variant in the list and `full` only in the viewer.
- `alt` text: "Image from {sender}", with "{n} of {total}" when there are several. The
  caption, if any, is the message body as now.
- Clicking or pressing Enter opens the viewer.

A message with images and no caption has no empty text bubble: the row shows only the
images, with time and status where the bubble would put them. A pending message shows its
images from the local previews, with the same sizes, so it doesn't jump when the server
copy replaces it.

### 6. Unknown kinds

A kind with no renderer, or a source this version can't fetch (anything but `stored`),
renders one quiet line with an icon: "Sent from a newer version of Raven. Update to see
it." Write a test for this. A newer Raven will send gifs, stickers, videos, files and peer
transfers to older versions.

### 7. Words

Draft wording; check it against `writing.md`.

- Attach button: "Add images"
- Drop overlay: "Drop to add to the message"
- Errors from preparing:
  - `unsupported`: "Raven can only send images for now."
  - `tooLarge`: "That image is too large to send."
  - `damaged`: "That image couldn't be read."
- Errors from sending:
  - `413`: "That image is too large for this server."
  - `415`: "This server can't take that kind of image."
- List and reply excerpts when there's no caption: "Photo", "2 photos". With a caption,
  the caption. Put this in `excerptOf`'s neighbourhood (`lib/chat/format.ts` or the
  reducer). For an unknown kind: "Attachment".
- Viewer: "Save image…", "Copy image", "Close".

### 8. The viewer

A full-window overlay, using the project's `Dialog`:

- The `full` variant on a dark backdrop, fitted to the window. The placeholder or
  `preview` shows while `full` loads.
- With several images in the message: left and right arrows (buttons and keys) and
  "2 of 4".
- Escape closes. Focus returns to the image that opened it.
- **Save image…**: add `tauri-plugin-dialog`, both the Rust and JS parts, for the save
  picker. Suggest the attachment's `name`, or `raven-image-<date>.<ext>`. Write the bytes
  through a small Rust command `attachment_save({ path, bytes })` rather than adding the
  fs plugin. Ask Soroush before adding the plugin if you'd rather use something else.
- **Copy image**: `navigator.clipboard.write` with a PNG `ClipboardItem`. WebView2 takes
  PNG only, so convert through a canvas when the image isn't PNG.

Add "Save image…" to the row menu for messages with one image too. "Copy text" stays and
appears only when there is text.

### 9. Previews and notifications

`ConversationRow` and reply quotes use the excerpt rule from step 7. Anything that shows a
message's text outside the list must use the same rule, so an image message never shows
as blank: a notification, the taskbar, a search.

## Tests

Client unit tests (`bun test`):

- Outbox: version 1 loads; version 2 round-trips attachments; sweep is called with the
  right handles.
- Sender loop, with a fake API like `store.test.ts` uses:
  - create → upload → send in order;
  - a lost create answer is retried and finds the same attachment;
  - an upload failure retries only the missing variant;
  - a restart in the middle resumes;
  - `422` after purge restarts once;
  - `413` fails with words.
- Media cache: dedupes in flight, evicts and revokes, seeding skips the fetch.
- Excerpts: "Photo", "2 photos", caption wins, unknown kind.
- Renderer map: an unknown kind renders the update line.
- Image box sizing from width and height (a pure function, test it directly).

## Check it in the app

With the API and two accounts:

1. Paste a screenshot, drop a phone photo, pick two more. Send with a caption. The other
   account sees them without the list jumping. Opening one shows it full size.
2. Turn off the network mid-send (or stop the API), restart Raven, bring it back: the
   message sends once.
3. Delete for everyone: the images disappear for both, and fetching the old URL gives
   `404`.
4. Reply to an image-only message: the quote says "Photo".
5. A phone photo with GPS: save it from the viewer and check it has no location
   (`exiftool`, or the file's Properties → Details on Windows).

Take screenshots of the tray, a single image, a grid and the viewer, and send them to
Soroush.

## Done when

- Tests and typecheck pass.
- The app checks above pass, or your summary says which didn't and why.
- `docs/chat.md`'s Client section mentions the attachment flow and the media cache.
