# Chat attachments: implementation plans

Soroush wants images in text chat (`apps/desktop/src/shells/ravenv1/views/ChatView.tsx`),
compressed the way Telegram does it. GIFs, stickers, videos, files and peer-to-peer file
transfer (nothing stored on the server) come later. These plans build **images only**, on a
model made for all of those, so none of them has to undo this work. Written 2026-10-30.

Each plan is for one Claude session (Opus, medium effort) and is self-contained. To start
one, give it a single line:

> Read and implement `C:\Users\Soroush Taheri\code\raven\docs\plans\chat-attachments\<file>`.

Use the absolute path. These files are untracked, so a session in a git worktree won't
have them in its own checkout.

| Plan | What | Depends on |
|---|---|---|
| `01-server-attachments.md` | Go API: attachment tables, upload, fetch, attach to a message, delete, purge, limits | nothing |
| `02-image-preparation.md` | Rust: turn a picked, pasted or dropped image into what gets uploaded | nothing |
| `03-desktop-images.md` | Desktop chat: tray, sending, showing, viewer, previews | 01 and 02 |

01 and 02 touch different code and can run at the same time.

## The model

A message keeps its `kind` (`text`) and its `body`, which becomes the caption. It gains an
ordered list of **attachments**. An attachment has two independent axes:

- **`kind`**: how it is shown. `image` now; `gif`, `sticker`, `video`, `file` later.
- **`source`**: where its bytes come from. `stored` now (on the server, in S3); `peer`
  later (sent person to person, never on the server); perhaps `pack` for stickers.

Both are open strings. Neither column has a `CHECK`, the same choice `chat_messages.kind`
already made, so a new kind or source is not a table rebuild.

A stored attachment has one or more **variants**, each its own object: an image has
`full` and `preview`; a video will have `full` and `poster`; a file only `full`. A peer
attachment has no variants on the server, only its description.

What a client receives:

```ts
interface ChatAttachment {
  id: string;
  kind: string;          // "image"
  source: string;        // "stored"
  contentType: string;   // of the full variant
  size: number;          // bytes of the full variant
  name?: string;         // a file name, when it matters (files, "original" images)
  width?: number;        // images, gifs, stickers, videos
  height?: number;
  durationMs?: number;   // videos, later
  placeholder?: string;  // ThumbHash, base64: a blurred stand-in before it loads
  variants: string[];    // what can be fetched: ["full", "preview"]
  meta?: object;         // kind- or source-specific extras (a sticker's pack, a peer offer)
}
```

### Sending is two steps

1. **Create** the attachment: its description, with no bytes
   (`POST /v1/chat/conversations/:id/attachments`). It is the uploader's alone until a
   message claims it. Every create carries a `clientUploadId`, so a retry finds the first
   one, exactly like `clientMessageId` for messages.
2. **Upload** each variant (`PUT .../attachments/:attachmentId/variants/:variant`, raw
   bytes). Then **send** the message with `attachmentIds`.

This is what keeps later features apart from this one: a peer attachment is step 1 with
no step 2; a video is the same PUT made resumable; a sticker is step 1 pointing at a pack.
The send step never cares where the bytes are.

Bytes are fetched from `GET .../attachments/:attachmentId/variants/:variant`, with the
same access rule as the message it belongs to. Requests carry `X-Session-ID`, which an
`<img src>` cannot send, so the desktop fetches bytes and shows them from object URLs.

### Deleting

Objects live in S3 and rows in the database, and the two can't share a transaction. So
every path that removes attachment rows first queues their object keys in
`chat_object_purges` inside its own transaction, and the maintenance loop
(`internal/http/maintenance.go`) deletes the objects later. Uploads that no message
claimed within 24 hours are purged the same way.

- Delete for everyone: the attachments go with the text.
- Remove for me, Clear for me: nothing is deleted, as with text.
- Deleting a text nest keeps its messages (decided for 0.1.5), so its attachments stay
  too. Deleting a group, or the tree, purges them.

## Decisions (2026-10-30)

From the conversation with Soroush, plus defaults chosen in these plans. Defaults marked
**(default)** were not discussed; change them here before a session starts if you want.

- **Compress on the sender's computer, in Rust**, not in the WebView and not on the
  server. Compressing first saves the sender's upload, and Rust gives the same result in
  WebView2 (Windows) and WebKitGTK (Linux). The server still checks everything it gets.
- **No JPEG XL** for now: WebView2 and WebKitGTK can't be relied on to show it, and libjxl
  is another C++ build on MSVC. **No libcaesium**: it is glue around encoders we can call
  directly, and mozjpeg is already in the tree.
- **When to compress** (plan 02 has the exact rules):
  - Always strip metadata (GPS location) and apply EXIF rotation, even for "full quality".
  - Resize only above 2560 px on the longer side.
  - Photos → mozjpeg. Screenshots and graphics → lossless WebP, falling back to
    high-quality JPEG when that is still big.
  - Don't re-encode an image that is already small and within size. Keep whichever is
    smaller, the original or the re-encode.
  - Animated GIF/WebP is sent untouched, within the size limit.
- **Full quality** is one switch in the tray: no resize, no re-encode, metadata still
  stripped. **(default)**
- Width, height and a ThumbHash placeholder travel with every image, so the message list
  reserves the right space and shows a blur before the image loads.
- An attachment belongs to one conversation. Forwarding to another conversation is a later
  feature that copies it.
- An attachment can't be added to or removed from a message after sending. Editing changes
  the caption only.

Limits **(default)**: up to 10 attachments per message; an image's `full` variant up to
10 MB and its `preview` up to 512 KB; images up to 100 megapixels and 16 384 px per side.
The server announces them in `/v1/server/properties` under `chat.attachments`, and a
client shows the attach button only when the server has them.

## Not in these plans

- **Permissions.** Sending an image needs the same right as sending text (`canSend`).
  Whether a tree wants a separate "attach images" permission (see `docs/permissions.md`)
  is open; it fits the model later without changes to it.
- **Older clients.** Raven 0.1.5 and older don't know `attachments` and will show an image
  with no caption as an empty message. When this ships, raise the minimum client version
  (see the `raven-releases` skill) or accept that. That's Soroush's call at release time.
- **Deploying.** nginx on Saye caps API request bodies at 1 MB
  (`infra/homelab/nginx/raven.conf`, `client_max_body_size 1m`), and the ArvanCloud CDN in
  front may have its own cap. Plan 01 raises the nginx limit in the repo; changing Saye or
  the CDN is a deploy step, only when Soroush asks.

## Rules for every plan

- Follow the code style around you: comment density, naming, how errors read.
- Wire changes go in `docs/chat.md` (its Data and Limits sections) in the same change.
- Anything the user sees follows the `raven-ui` skill: load it before writing UI or words.
- Don't commit, push, deploy or release unless asked.
- In a git worktree, copy `.claude/skills` and `.env` from the main checkout and run
  `bun install` in `apps/desktop`.
