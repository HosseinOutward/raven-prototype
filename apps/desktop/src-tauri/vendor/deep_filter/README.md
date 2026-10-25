# deep_filter (vendored)

DeepFilterNet's Rust inference library, `libDF`, from
<https://github.com/Rikorose/DeepFilterNet>, used by Raven's "Studio" noise suppression
(`src/audio/suppression.rs`, behind the `studio-noise-suppression` cargo feature).

- **Upstream revision:** `d375b2d8309e0935d165700c91da9de862a99c31` (2024-10-17), crate
  version `0.5.7-pre`. Upstream is effectively unmaintained; Raven owns this copy.
- **Licence:** MIT or Apache-2.0, at your option (`LICENSE-MIT`, `LICENSE-APACHE`).
- **Model:** `models/DeepFilterNet3_onnx.tar.gz`, copied unchanged from the same
  revision. SHA-256 `c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616`.

## Why vendored rather than a git dependency

crates.io's `deep_filter` is 0.2.5 from 2022. A git dependency fetches the whole
repository (about 280 MB: Python training code, datasets tooling, seven models) and,
with the `tract` feature, also builds the resampling and logging modules Raven never
calls. This copy is only the inference path.

## What was kept and changed

- `src/lib.rs`: upstream's, minus the dataset, transforms, logging, C API, WASM and
  WAV modules and its one test (which needed `rand`), and with upstream's lifetime
  warnings allowed.
- `src/tract.rs`: upstream's, with two changes marked `Raven:`:
  - `DfParams::default()` always loads the vendored DeepFilterNet 3 model (no
    `default-model` / `default-model-ll` features);
  - the "possible clipping" warning in `DfTract::process` is gone, because it ran on the
    audio thread every 10 ms.

`rustfmt.toml` is upstream's layout, so `cargo fmt --all` in the app keeps this copy
diffable against DeepFilterNet.

tract checks its graphs under debug assertions, and one of those checks rejects the
DeepFilterNet 3 model ("duplicate name /convt3/Conv.bias") although the optimised graph
runs correctly. Release builds never run the check; the app's `Cargo.toml` turns debug
assertions off for the tract crates in dev and test builds too.

Known upstream behaviour left as it is: `process` allocates every hop (tensor clones),
and returns zeros after five hops whose mean square is below 1e-7 (about −70 dBFS).

## Updating

There is nothing upstream to update from. To change the model or the code, edit here
and keep the `Raven:` comments and this file accurate.
