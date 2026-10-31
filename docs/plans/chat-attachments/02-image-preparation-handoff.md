# Plan 02 image preparation - reviewer handoff

Date: 2026-10-30. Implemented locally; no commit, push, deployment or release.

## Scope and checkout state

Review against `02-image-preparation.md`, the attachment README, and server plan 01's
image checks. This implements the native preparation step; no chat UI or upload
integration was added. Plan 03 consumes these commands.

The checkout was already dirty with audio, overlay, call-state and server-attachment
work. Those changes were preserved. `src/lib.rs`, `Cargo.toml`, and `docs/chat.md`
contain both earlier changes and this task's additions; do not attribute their entire
diff to this plan. The plan directory and new attachments directory are untracked and
must be included explicitly when preparing a future commit. `docs/chat.md` had a
non-UTF-8 byte in existing content; the new ASCII section was inserted without
re-encoding or changing those existing bytes.

## Implementation map

Rust paths below are relative to `apps/desktop/src-tauri/`.

| File | Responsibility |
|---|---|
| `src/attachments/mod.rs` | CamelCase result types, stable error codes, raw-header/JSON-path input parsing, blocking command wrappers, generic outbox persistence/read/discard/sweep, startup expiry. |
| `src/attachments/image.rs` | Sniffing and bounded decoding, orientation, GIF block walking and WebP animation detection, classification, SIMD Lanczos3 resize, encoding, metadata removal, bounded still previews. |
| `src/attachments/placeholder.rs` | At-most-100-pixel RGBA downscale and base64 ThumbHash. |
| `src/attachments/tests.rs` | Generated-image unit/integration tests and an explicitly ignored release benchmark. |
| `src/attachments/testdata/` | Two synthetic fixtures (883-byte oriented/GPS JPEG, 149-byte two-frame GIF) plus provenance. No user images were copied into the repository. |
| `src/lib.rs` | Module declaration, all four command registrations and startup cleanup. Other audio/overlay changes predate this task. |
| `Cargo.toml`, `Cargo.lock` | Four direct image-processing dependencies and their lock resolution. |
| `docs/chat.md` | Native IPC contract, cache lifetime, ordering and limits under Desktop attachment preparation. |

## Command contract and plan 03 integration

- `attachment_prepare`: raw bytes with JSON `{name, mode}` in the
  `X-Raven-Attachment` header, or JSON `{path, mode}`. Mode must be `standard` or `full`.
  Returns `{handle, kind, contentType, size, name, width, height, placeholder,
  animated, variants: [{variant, contentType, size}]}`. No filesystem path is returned.
  For raw IPC over an HTTP-backed WebView transport, JSON-escape non-ASCII filename
  characters as `\uXXXX` in the header (including surrogate pairs where needed).
  That preserves Persian/Unicode names without violating browser header restrictions.
- `attachment_read({handle, variant})`: raw IPC response bytes. Only declared variants
  may be read; handle UUIDs and variant components are validated, and symlink paths
  are refused. Metadata is not a readable variant.
- `attachment_discard({handle})`: idempotent when an entry is already absent.
- `attachment_sweep({keep: string[]})`: removes completed handle directories not kept.
  **Restore the client outbox and await this initial sweep before preparing new
  attachments.** Keep every live handle. Concurrent preparations themselves share no
  mutable state and produce independent UUID folders.

Errors serialize as `{code: "unsupported" | "tooLarge" | "damaged" | "io"}` with no
filename/path embedded. Native preparation performs no logging of filenames or paths.
The upload layer should map `animated` to its desired client/server metadata; there is
no server wire change in this plan. Both `full` and `preview` are always declared and
written, even when the preview is a byte-for-byte copy. UI/upload code is not present.

## Invariants and decisions to review

- Input bytes are sniffed, never trusted by extension. Limits are 50 MiB input,
  16,384 px per side, 100,000,000 pixels, 512 MiB decoder allocation, 10 MiB full and
  512 KiB preview. Decoder limits are per preparation, not a global process RAM cap;
  oriented/resized/encoded buffers also consume memory.
- Orientation is applied before dimensions, resizing, preview and placeholder.
  Still JPEG/PNG/WebP originals lose EXIF and XMP; PNG text chunks and JPEG comments
  are also removed. ICC is retained on kept originals and re-encoded JPEGs, including
  JPEG previews. No general ICC-to-sRGB conversion is introduced.
- Classification is centralized: JPEG means photo; alpha means graphic; otherwise
  sample at most 256 x 256 with nearest-neighbour, retain at most 4,097 distinct
  colours, and classify as graphic for <=4,096 colours or >=35% identical horizontal
  and vertical neighbours. The last threshold is deliberately tunable.
- Standard full output fits 2560 px, photo JPEG 82 progressive 4:2:0; graphics use
  lossless WebP, with JPEG 90 4:4:4 above 1.5 MiB unless transparent. The small/original
  exception is evaluated after encoding, with no resize or orientation transform.
- Full mode preserves unrotated originals, including single-frame GIFs, within the
  full limit. Transformed graphics use lossless WebP, transformed photos JPEG 95.
  The plan calls rotation lossless but explicitly specifies JPEG 95 for photos;
  JPEG 95 is still a lossy encode. That explicit encoder choice was followed.
- Animation takes precedence over original metadata stripping, as rule 1 specifies:
  animated GIF/WebP full bytes pass through untouched. This also retains any metadata
  in those animated originals. GIF detection scans block sizes without decompressing
  frames; WebP uses its animation flag. Only the first frame becomes a still preview.
- Transparent previews quantize RGBA progressively if needed and then reduce
  dimensions to meet the byte budget, retaining alpha. Opaque previews reduce
  dimensions if JPEG 78 exceeds the budget. An oversized ICC profile can make the
  budget impossible; the terminal-size guard returns `tooLarge` rather than looping.
- Completed folders contain only variants and `attachment.json`. Individual files
  use temporary names; a final directory rename publishes the entire entry. Failed
  writes attempt to remove the temporary directory. Startup asynchronously expires
  completed and abandoned temporary folders older than 14 days. An ordinary sweep
  leaves in-progress temporary folders alone. This is rename-based crash visibility,
  not an fsync/power-loss durability guarantee.
- The ThumbHash interoperability test decodes a fixed vector generated with the
  official JavaScript `rgbaToThumbHash` API and checks average colour; another checks
  a locally encoded solid-colour placeholder. Rust and JavaScript float precision
  need not yield byte-identical encodings. Reference:
  https://github.com/evanw/thumbhash/blob/master/js/thumbhash.js

## Verification

All Cargo operations used `.claude/skills/raven-media-engine/scripts/cargo.ps1`,
MSVC/libclang setup and the shared `%USERPROFILE%/rv` target directory. Rust 1.96.0.
When passing harness flags from PowerShell, use an explicit argument array:

```powershell
.\.claude\skills\raven-media-engine\scripts\cargo.ps1 -CargoArgs @('test')
.\.claude\skills\raven-media-engine\scripts\cargo.ps1 -CargoArgs @('clippy','--all-targets','--message-format','short')
.\.claude\skills\raven-media-engine\scripts\cargo.ps1 -CargoArgs @('test','--release','--lib','attachments::tests::benchmark','--','--ignored','--nocapture')
```

| Check | Result |
|---|---|
| `cargo test` | Pass: 300 tests, 0 failures, 2 ignored benchmarks; 23.23 s test runtime. Binary and doc tests also pass (0 tests each). |
| Focused attachment tests | 13 pass; release benchmark ignored during ordinary test runs. |
| Final raw-input/Unicode/profile-budget test | Pass after the final UTF-8 header receiver adjustment; 0.07 s. |
| `cargo clippy --all-targets --message-format short` | Pass on final sources, no diagnostics under `src/attachments`; 28 library warnings and 34 test-target warnings (28 duplicates) remain in unrelated audio/video/overlay/hotkey/toolbar code. |
| New module rustfmt check | Clean. |
| `git diff --check` on task paths | Clean. |

Coverage includes orientation 6/GPS removal and upright pixels in both modes,
12 MP standard resize/full preservation, lossless screenshot output, classification,
transparent noisy previews, small-original/ICC retention, animated GIF and WebP,
PNG/WebP EXIF/XMP stripping, input byte/side/pixel/truncation errors, raw-header and
JSON-path parsing, oversized ICC handling, ThumbHash compatibility, persistent
prepare/read/drop-path/discard/sweep, invalid path components and startup-age cleanup.
Commands compile through Tauri's real registration macro; tests call the functions
behind them. No live WebView console invoke or plan 03 end-to-end upload was performed.
Linux was not built. The existing manifest's declared Rust 1.77.2 minimum was not
verified; resolved `image` 0.25.10 requires 1.88 and `fast_image_resize` 5.5 requires
1.87. `image` 0.25.10 was already present transitively in the original lockfile.

## Release benchmarks and authorized local sample

Initial generated-input pipeline results (three runs; excludes fixture creation,
IPC transfer and outbox filesystem writes):

| Input | Milliseconds | Median |
|---|---|---|
| Generated 4000 x 3000 photo-like JPEG | 302, 302, 301 | 302 ms |
| Generated 3840 x 2160 flat screenshot PNG | 97, 98, 98 | 98 ms |

Soroush explicitly authorized reading a few local screenshots/photos. Visual inspection
confirmed two UI screenshots, one game capture and two 6000 x 4000 photos. All three
screenshots classified as graphic and both JPEG photos as photo. The small UI images
kept their original PNG (36,062 and 48,860 bytes); the game capture became WebP
(517,788 bytes). Photos became JPEG (257,543 and 254,436 bytes), with first-run pipeline
times of 594 and 617 ms for those 24 MP originals. Five examples are a smoke test of
the heuristic, not a general accuracy benchmark. No personal sample paths or image
contents are checked in.

Final release run used a 4000 x 3000, quality-95 JPEG crop derived locally from the
authorized real photo (preparation of this input is outside the timed region):

| Input | Milliseconds | Median |
|---|---|---|
| Real-photo 12 MP JPEG | 394, 381, 389 | 389 ms |
| Generated 4K screenshot PNG | 103, 105, 105 | 105 ms |

The real photo meets the 400 ms target on this machine. The optional benchmark environment
`RAVEN_ATTACHMENT_BENCH_PHOTO` supplies that input; otherwise it uses generated pixels.
`RAVEN_ATTACHMENT_SAMPLES` accepts an explicit `|`-separated allowlist for additional
samples and logs only index, dimensions, classification, output type/size and timing.
Neither variable is used by production code.

## Dependencies and licences

No new C/C++ dependencies were added. Existing mozjpeg remains the JPEG encoder.
Licences below were read from the downloaded crates' package manifests.

| Direct dependency | Resolved version | Licence |
|---|---|---|
| `image` (JPEG/PNG/GIF/WebP only) | 0.25.10 | MIT OR Apache-2.0 |
| `img-parts` | 0.4.1 | MIT OR Apache-2.0 |
| `fast_image_resize` | 5.5.0 | MIT OR Apache-2.0 |
| `thumbhash` | 0.1.0 | MIT |

New transitive packages: `color_quant` 1.1.0 (MIT); `document-features` 0.2.12,
`gif` 0.14.2, `image-webp` 0.2.4, `litrs` 1.0.1, `weezl` 0.1.12
(MIT OR Apache-2.0); `quick-error` 2.0.1 (manifest: MIT/Apache-2.0);
`miniz_oxide` 0.9.1 (MIT OR Zlib OR Apache-2.0); `zune-core` 0.5.3 and
`zune-jpeg` 0.5.15 (MIT OR Apache-2.0 OR Zlib). Existing `image`/`png` dependencies
gain codec features. Cargo also re-resolved the already-locked `iana-time-zone`
Windows dependency from already-locked windows-core 0.58 to 0.62; no new version of
either was added by that line change.
