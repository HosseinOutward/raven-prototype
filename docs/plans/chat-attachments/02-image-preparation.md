# Plan 02 — Desktop: preparing an image to send

You are working on Raven, a Tauri v2 desktop app for voice-first rooms with text chat
(repo `C:\Users\Soroush Taheri\code\raven`, desktop app in `apps/desktop`). Read
`docs/plans/chat-attachments/README.md` first: it has the attachment model, the decisions
and the limits.

This plan is Rust only, in `apps/desktop/src-tauri`. When you're done, the app has
commands that take an image the person picked, pasted or dropped. They turn it into what
gets uploaded: a `full` and a `preview` variant on disk, plus width, height and a
placeholder. Nothing in the UI uses them yet; plan 03 does that.

Design it as a step that prepares **an attachment**, of which images are the first kind.
Later a video will produce `full` + `poster`, a file only `full`, a peer transfer no
upload at all. The command's shape and the folder layout must work for those without
changes. Only the image step itself is image-specific.

## Before you start

- Build and test through `.claude/skills/raven-media-engine/scripts/cargo.ps1` (it sets up
  MSVC, libclang and the shared target dir `%USERPROFILE%\rv`). Expect waits if another
  session is building.
- Read `docs/plans/chat-attachments/01-server-attachments.md`, steps 1 to 4, for what the
  server checks. What you produce must pass those checks.
- No new C or C++ dependencies. mozjpeg is already built (`Cargo.toml`, used in
  `src/video/stream.rs`). Everything you add must be pure Rust.
- Don't commit, push or release unless asked.

## What is true now

- Commands are registered in `src/lib.rs` (`generate_handler!` ~79). App paths come from
  `app.path()` (see `src/audio/state.rs` ~3571 for `app_data_dir`).
- Dependencies already there: `mozjpeg 0.10`, `png 0.17`, `base64 0.22`.
- `src/video/stream.rs` (~442) shows how mozjpeg is called and that it reports errors by
  unwinding (wrap it in `catch_unwind`, as that code does).
- Tauri is 2.5. Commands can take raw bytes (`tauri::ipc::Request`, body
  `InvokeBody::Raw`) and return raw bytes (`tauri::ipc::Response`).

## Design

### 1. Module and commands

New module `src/attachments/`:
- `mod.rs`: commands, the outbox folder, the result types;
- `image.rs`: the image step;
- `placeholder.rs`: ThumbHash.

Commands:

| Command | Takes | Does |
|---|---|---|
| `attachment_prepare` | raw bytes, with `{ name, mode }` in an `X-Raven-Attachment` header as JSON; **or** JSON `{ path, mode }` | Prepares, writes variants, returns the description |
| `attachment_read` | `{ handle, variant }` | The variant's bytes, raw |
| `attachment_discard` | `{ handle }` | Deletes the handle's folder |
| `attachment_sweep` | `{ keep: string[] }` | Deletes every handle folder not in `keep` |

Bytes come from paste and the file picker. A path comes from a drop: Tauri's drag-drop
event gives paths, and reading the file in Rust saves sending it across IPC. `mode` is
`"standard"` or `"full"` (the "Full quality" switch).

The result:

```rust
struct PreparedAttachment {
    handle: String,          // a random id; also the folder name
    kind: String,            // "image"
    content_type: String,    // of full
    size: u64,               // of full
    name: String,            // original file name, without the path
    width: u32, height: u32, // of full, after rotation
    placeholder: String,     // ThumbHash, base64
    animated: bool,
    variants: Vec<PreparedVariant>, // { variant, content_type, size }
}
```

Serialize as camelCase to match the wire shape in the README. Variants are written to
`<app_cache_dir>/chat-outbox/<handle>/<variant>`, with the description beside them as
`attachment.json`. They're files, not memory, so an unsent message survives a restart
(plan 03 keeps the handle in its outbox) and big inputs don't sit in memory twice.

All work runs in `tauri::async_runtime::spawn_blocking`. Prepare several attachments at
once with no shared state between them.

Errors are an enum with a stable `code` the UI can word:
- `unsupported`: not an image we can read, for example HEIC or a PDF;
- `tooLarge`: over 50 MB in, or over the pixel limit;
- `damaged`: an image we can't decode;
- `io`.

Never put the file name or path in a log line.

### 2. Reading

- `image = { version = "0.25", default-features = false, features = ["jpeg", "png", "gif", "webp"] }`.
- Sniff the format from the bytes (`image::guess_format`), never from the name.
- Set `image::Limits`: at most 16 384 px per side and 100 megapixels, and a memory cap.
  Refuse inputs over 50 MB before decoding.
- Apply EXIF orientation: `ImageDecoder::orientation()` and
  `DynamicImage::apply_orientation` (image 0.25.4+). Width and height in the result are
  after rotation.
- Animated: a GIF with more than one frame, or an animated WebP. Detect it without
  decoding every frame.

### 3. Deciding what to send

These rules apply in order, for `mode = "standard"`.

1. **Animated** → send the original bytes untouched as `full` if they fit the `full`
   limit (10 MB), else `tooLarge`. `preview` is the first frame (step 4). Animation is
   for the later GIF feature to improve; don't transcode here.
2. **Strip metadata from originals.** Every time this plan "keeps the original", remove
   EXIF and XMP but keep the ICC profile. Use `img-parts` (pure Rust) for JPEG, PNG and
   WebP. Re-encoded output carries no metadata anyway.
3. **Classify** as photo or graphic:
   - JPEG source → photo.
   - PNG or WebP with real transparency (any alpha < 255) → graphic.
   - Otherwise count distinct colours on a 256×256 downscale: few colours (≤ 4096) or
     large flat areas mean graphic (screenshot, diagram, chat capture). Otherwise photo.
   - Keep the rule in one function with tests. Expect to tune it on real screenshots.
4. **Resize** only if the longer side is over 2560 px, to 2560, with `fast_image_resize`
   (Lanczos3, pure Rust, SIMD).
5. **Encode:**
   - Photo → mozjpeg, quality 82, progressive, 4:2:0, sRGB. If there is an ICC profile,
     keep it in the JPEG.
   - Graphic → lossless WebP (`image::codecs::webp::WebPEncoder::new_lossless`). If that
     is over 1.5 MB, use mozjpeg quality 90 with 4:4:4 instead, unless there is real
     transparency (then keep the WebP).
6. **Keep the original instead** when all of these hold:
   - it is JPEG, PNG or WebP;
   - it needed no resize and no rotation;
   - it is at most 500 KB, or smaller than the re-encode.

   Comparing sizes means encoding first; that is fine at these sizes.

For `mode = "full"`: never resize or re-encode. Strip metadata. If the image needs
rotation, re-encode losslessly: PNG/WebP lossless for graphics, JPEG quality 95 for
photos. An unrotated full-quality original can be large, so refuse over 10 MB with
`tooLarge`.

### 4. The preview

- Longer side at most 960 px, from the oriented image (or the first frame).
- JPEG quality 78 via mozjpeg, or lossless WebP if there is real transparency.
- At most 512 KB. If a lossless WebP preview is over that, quantize it down. Don't drop
  alpha: a sticker-like PNG must stay transparent.
- If the full image is already within 960 px and within 512 KB, the preview is a copy of
  `full`. Write it anyway: the server expects both variants, and the copy is cheap.

### 5. The placeholder

Use ThumbHash (`thumbhash` crate, pure Rust): downscale to at most 100×100 RGBA, encode,
then base64. It is about 25 bytes. Plan 03 decodes it in TypeScript with the `thumbhash`
npm package, so the two must agree. Test one round trip against a known value from that
package's docs or tests.

### 6. The outbox folder

- `attachment_sweep` runs from the client once the outbox has loaded (plan 03). Also
  delete handle folders older than 14 days at app start, in case the client never calls
  it.
- A folder holds at most the variants and `attachment.json`. Write to a temp name and
  rename, so a crash never leaves half a file that looks complete.

## Tests

Unit tests in `src/attachments/` with images made in the test (no large fixtures), plus
two small checked-in fixtures under `src/attachments/testdata/`:
- a JPEG with EXIF orientation 6 and a GPS tag;
- a two-frame GIF.

Cover:

- An EXIF-rotated JPEG comes out upright, with width and height swapped, and no GPS or
  EXIF in either variant.
- A 4000×3000 photo becomes 2560×1920 JPEG, under 1.5 MB, with a ≤ 960 px preview.
- A 1920×1080 flat-colour "screenshot" PNG becomes lossless WebP and is classified graphic.
- A transparent PNG keeps its alpha in both variants.
- A small JPEG (200 KB, 1200 px) is kept as is, metadata stripped.
- An animated GIF is passed through; its preview is a still.
- `mode = "full"` never resizes.
- Inputs that are too big, not images, or truncated return the right error codes.
- The placeholder decodes to roughly the image's average colour.
- Prepare, read, discard and sweep work on the folder.

Benchmark, in a release build, one 12-megapixel photo and one 4K screenshot, and write the
times in your summary. Aim for under 400 ms for the photo on Soroush's machine. If you're
far over, look first at the resize and the colour count, not the encoder.

## Done when

- `cargo test` (through `cargo.ps1`) passes, and `cargo clippy` adds no new warnings
  in `src/attachments`.
- The commands are registered and callable (check with a one-off `invoke` from the dev
  app's console, or a test that calls the functions behind them).
- Your summary to Soroush lists:
  - the crates added and their licences;
  - the benchmark times;
  - how the photo/graphic rule did on a few real screenshots and photos from his machine
    (ask before reading his files; `%USERPROFILE%\Pictures\Screenshots` is a likely
    place).
