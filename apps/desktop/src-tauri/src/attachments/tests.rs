use super::*;
use ::image::{DynamicImage, ImageEncoder, ImageFormat, Rgba, RgbaImage};
use base64::{engine::general_purpose::STANDARD, Engine};
use img_parts::{DynImage as Parts, ImageEXIF, ImageICC};
use std::io::Cursor;

fn png(image: &RgbaImage) -> Vec<u8> {
    let mut bytes = Vec::new();
    // An intentionally uncompressed source exercises re-encoding rather than the
    // small-original shortcut, without a multi-megabyte fixture in the repo.
    ::image::codecs::png::PngEncoder::new_with_quality(
        &mut bytes,
        ::image::codecs::png::CompressionType::Uncompressed,
        ::image::codecs::png::FilterType::NoFilter,
    )
    .write_image(
        image.as_raw(),
        image.width(),
        image.height(),
        ::image::ExtendedColorType::Rgba8,
    )
    .unwrap();
    bytes
}
fn jpeg(image: RgbaImage) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .into_rgb8()
        .write_to(&mut bytes, ImageFormat::Jpeg)
        .unwrap();
    bytes.into_inner()
}
fn photo(w: u32, h: u32) -> RgbaImage {
    // Detailed gradients with deterministic sensor-like noise, not white noise.
    RgbaImage::from_fn(w, h, |x, y| {
        let n = ((x.wrapping_mul(1664525) ^ y.wrapping_mul(1013904223)) >> 24) as u8 % 12;
        Rgba([
            ((x * 230 / w) as u8).saturating_add(n),
            ((y * 230 / h) as u8).saturating_add(n),
            (((x + y) * 230 / (w + h)) as u8).saturating_add(n),
            255,
        ])
    })
}
fn decoded(bytes: &[u8]) -> RgbaImage {
    ::image::load_from_memory(bytes).unwrap().into_rgba8()
}
fn no_exif(bytes: &[u8]) {
    let parts = Parts::from_bytes(bytes.to_vec().into()).unwrap().unwrap();
    assert!(parts.exif().is_none());
    if let Parts::Jpeg(jpeg) = parts {
        assert!(!jpeg
            .segments()
            .iter()
            .any(|s| s.marker() == img_parts::jpeg::markers::APP1));
    }
}

#[test]
fn rotated_jpeg_strips_location_and_is_upright() {
    let input = include_bytes!("testdata/orientation-6-gps.jpg");
    assert!(Parts::from_bytes(input.to_vec().into())
        .unwrap()
        .unwrap()
        .exif()
        .is_some());
    for mode in [Mode::Standard, Mode::Full] {
        let output = image::prepare(input.to_vec(), mode).unwrap();
        assert_eq!((output.width, output.height), (32, 48));
        for bytes in [&output.full, &output.preview] {
            no_exif(bytes);
            let image = decoded(bytes);
            assert!(image.get_pixel(16, 6)[0] > 200);
            assert!(image.get_pixel(16, 42)[2] > 200);
        }
    }
}
#[test]
fn large_photo_is_bounded_and_full_quality_keeps_dimensions() {
    let bytes = jpeg(photo(4000, 3000));
    let output = image::prepare(bytes.clone(), Mode::Standard).unwrap();
    assert_eq!((output.width, output.height), (2560, 1920));
    assert_eq!(output.content_type, "image/jpeg");
    assert!(output.full.len() < 1536 * 1024);
    let preview = decoded(&output.preview);
    assert_eq!(preview.dimensions(), (960, 720));
    assert!(output.preview.len() <= PREVIEW_LIMIT);
    let full = image::prepare(bytes.clone(), Mode::Full).unwrap();
    assert_eq!((full.width, full.height), (4000, 3000));
    assert_eq!(full.full, bytes);
}
#[test]
fn flat_screenshot_is_lossless_webp() {
    let image = RgbaImage::from_fn(1920, 1080, |x, y| {
        Rgba([
            if x < 500 { 40 } else { 230 },
            if y < 50 { 60 } else { 200 },
            70,
            255,
        ])
    });
    assert!(image::is_graphic(&image, ImageFormat::Png));
    let output = image::prepare(png(&image), Mode::Standard).unwrap();
    assert_eq!(output.content_type, "image/webp");
    assert_eq!(decoded(&output.full), image);
}
#[test]
fn classification_distinguishes_palette_transparency_and_photos() {
    let detailed = photo(1000, 700);
    assert!(!image::is_graphic(&detailed, ImageFormat::Png));
    assert!(!image::is_graphic(
        &RgbaImage::from_pixel(10, 10, Rgba([0, 0, 0, 255])),
        ImageFormat::Jpeg
    ));
    let mut alpha = detailed;
    alpha.get_pixel_mut(0, 0)[3] = 254;
    assert!(image::is_graphic(&alpha, ImageFormat::WebP));
}
#[test]
fn transparent_images_and_noisy_previews_keep_alpha() {
    let image = RgbaImage::from_fn(1100, 1000, |x, y| {
        let n = x
            .wrapping_mul(747796405)
            .wrapping_add(y.wrapping_mul(2891336453));
        Rgba([
            n as u8,
            (n >> 8) as u8,
            (n >> 16) as u8,
            if x < 100 { 0 } else { (n >> 24) as u8 },
        ])
    });
    let output = image::prepare(png(&image), Mode::Standard).unwrap();
    assert_eq!(output.content_type, "image/webp");
    assert_eq!(decoded(&output.full), image);
    let preview = decoded(&output.preview);
    assert_eq!(output.preview_type, "image/webp");
    assert!(output.preview.len() <= PREVIEW_LIMIT);
    assert!(preview.pixels().any(|p| p[3] == 0));
    assert!(preview.pixels().any(|p| p[3] > 128));
}
#[test]
fn small_original_is_kept_with_icc_but_no_metadata() {
    let bytes = jpeg(photo(1200, 800));
    assert!(bytes.len() <= 500 * 1024);
    let mut parts = Parts::from_bytes(bytes.clone().into()).unwrap().unwrap();
    parts.set_exif(Some(img_parts::Bytes::from_static(b"II*\0GPS test")));
    parts.set_icc_profile(Some(img_parts::Bytes::from_static(b"test ICC profile")));
    let input = parts.encoder().bytes().to_vec();
    let output = image::prepare(input, Mode::Standard).unwrap();
    no_exif(&output.full);
    let mut actual = Parts::from_bytes(output.full.into()).unwrap().unwrap();
    assert_eq!(actual.icc_profile().unwrap().as_ref(), b"test ICC profile");
    actual.set_icc_profile(None);
    assert_eq!(actual.encoder().bytes().as_ref(), bytes);
}
#[test]
fn animated_gif_is_original_and_preview_is_still() {
    let bytes = include_bytes!("testdata/two-frames.gif");
    for mode in [Mode::Standard, Mode::Full] {
        let output = image::prepare(bytes.to_vec(), mode).unwrap();
        assert!(output.animated);
        assert_eq!(output.full, bytes);
        assert_eq!(output.content_type, "image/gif");
        assert_eq!(output.preview_type, "image/jpeg");
        assert_eq!(decoded(&output.preview).dimensions(), (16, 12));
    }
}

#[test]
fn animated_webp_is_detected_and_passed_through() {
    use img_parts::riff::{RiffChunk, RiffContent};
    let frame = image::prepare(
        png(&RgbaImage::from_pixel(20, 10, Rgba([200, 50, 30, 255]))),
        Mode::Standard,
    )
    .unwrap();
    // The uncompressed source is small, so explicitly encode a WebP frame here.
    let rgba = decoded(&frame.full);
    let mut still = Vec::new();
    ::image::codecs::webp::WebPEncoder::new_lossless(&mut still)
        .write_image(rgba.as_raw(), 20, 10, ::image::ExtendedColorType::Rgba8)
        .unwrap();
    let mut frame_data = vec![0; 16];
    frame_data[6] = 19;
    frame_data[9] = 9;
    frame_data[12] = 100;
    frame_data.extend_from_slice(&still[12..]);
    let chunks = vec![
        RiffChunk::new(
            *b"VP8X",
            RiffContent::Data(vec![2, 0, 0, 0, 19, 0, 0, 9, 0, 0].into()),
        ),
        RiffChunk::new(*b"ANIM", RiffContent::Data(vec![0; 6].into())),
        RiffChunk::new(*b"ANMF", RiffContent::Data(frame_data.clone().into())),
        RiffChunk::new(*b"ANMF", RiffContent::Data(frame_data.into())),
    ];
    let bytes = RiffChunk::new(
        *b"RIFF",
        RiffContent::List {
            kind: Some(*b"WEBP"),
            subchunks: chunks,
        },
    )
    .encoder()
    .bytes()
    .to_vec();
    let output = image::prepare(bytes.clone(), Mode::Standard).unwrap();
    assert!(output.animated);
    assert_eq!(output.full, bytes);
    assert_eq!(output.preview_type, "image/jpeg");
    assert_eq!(decoded(&output.preview).dimensions(), (20, 10));
}

#[test]
fn still_png_and_webp_remove_exif_xmp_and_retain_icc() {
    use img_parts::riff::{RiffChunk, RiffContent};
    for webp in [false, true] {
        let source = RgbaImage::from_pixel(30, 20, Rgba([1, 2, 3, 255]));
        let mut bytes = png(&source);
        if webp {
            bytes.clear();
            ::image::codecs::webp::WebPEncoder::new_lossless(&mut bytes)
                .write_image(source.as_raw(), 30, 20, ::image::ExtendedColorType::Rgba8)
                .unwrap();
        }
        let mut parts = Parts::from_bytes(bytes.into()).unwrap().unwrap();
        parts.set_icc_profile(Some(img_parts::Bytes::from_static(b"test ICC")));
        parts.set_exif(Some(img_parts::Bytes::from_static(b"II*\0GPS")));
        match &mut parts {
            Parts::Png(png) => png.chunks_mut().insert(
                1,
                img_parts::png::PngChunk::new(
                    *b"iTXt",
                    img_parts::Bytes::from_static(b"XML:com.adobe.xmp\0\0\0\0\0private XMP"),
                ),
            ),
            Parts::WebP(webp) => webp.chunks_mut().push(RiffChunk::new(
                *b"XMP ",
                RiffContent::Data(img_parts::Bytes::from_static(b"private XMP")),
            )),
            _ => unreachable!(),
        }
        let output = image::prepare(parts.encoder().bytes().to_vec(), Mode::Full).unwrap();
        assert_eq!(decoded(&output.full), source);
        let parts = Parts::from_bytes(output.full.into()).unwrap().unwrap();
        assert!(parts.exif().is_none());
        assert_eq!(parts.icc_profile().unwrap().as_ref(), b"test ICC");
        match parts {
            Parts::Png(png) => assert!(png.chunk_by_type(*b"iTXt").is_none()),
            Parts::WebP(webp) => assert!(!webp.has_chunk(*b"XMP ")),
            _ => unreachable!(),
        }
    }
}
#[test]
fn invalid_inputs_have_stable_codes() {
    assert_eq!(
        image::prepare(vec![0; INPUT_LIMIT + 1], Mode::Standard).err(),
        Some(AttachmentError::TooLarge)
    );
    assert_eq!(
        image::prepare(b"%PDF-1.7".to_vec(), Mode::Standard).err(),
        Some(AttachmentError::Unsupported)
    );
    assert_eq!(
        image::prepare(b"\xff\xd8\xff\xe0".to_vec(), Mode::Standard).err(),
        Some(AttachmentError::Damaged)
    );
    let mut header = png(&RgbaImage::new(1, 1));
    // Build a valid oversized IHDR (including CRC) through the existing png crate.
    let mut oversized = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut oversized, 16385, 1);
        encoder.set_color(png::ColorType::Rgba);
        let _ = encoder.write_header().unwrap();
    }
    assert_eq!(
        image::prepare(oversized, Mode::Standard).err(),
        Some(AttachmentError::TooLarge)
    );
    // Keep IDAT present so the PNG decoder can construct its header reader; the
    // pixel guard must fire before the deliberately mismatched data is decoded.
    let mut over_pixels = png(&RgbaImage::new(1, 1));
    over_pixels[16..20].copy_from_slice(&12000u32.to_be_bytes());
    over_pixels[20..24].copy_from_slice(&9000u32.to_be_bytes());
    let mut crc = !0u32;
    for byte in &over_pixels[12..29] {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb88320u32.wrapping_mul(crc & 1));
        }
    }
    over_pixels[29..33].copy_from_slice(&(!crc).to_be_bytes());
    assert_eq!(
        image::prepare(over_pixels, Mode::Standard).err(),
        Some(AttachmentError::TooLarge)
    );
    header.truncate(24);
    assert_eq!(
        image::prepare(header, Mode::Standard).err(),
        Some(AttachmentError::Damaged)
    );
    assert_eq!(
        serde_json::to_string(&AttachmentError::TooLarge).unwrap(),
        "{\"code\":\"tooLarge\"}"
    );
}

#[test]
fn commands_accept_raw_headers_and_json_paths_and_bound_profile_previews() {
    let raw = InvokeBody::Raw(vec![1, 2, 3]);
    assert!(matches!(
        parse_input(&raw, Some(r#"{"name":"paste.png","mode":"standard"}"#)).unwrap(),
        Input::Bytes(
            _,
            RawOptions {
                mode: Mode::Standard,
                ..
            }
        )
    ));
    assert!(parse_input(&raw, None).is_err());
    if let Input::Bytes(_, options) = parse_input(
        &raw,
        Some(r#"{"name":"\u0639\u06a9\u0633.png","mode":"standard"}"#),
    )
    .unwrap()
    {
        assert_eq!(options.name, "عکس.png");
    } else {
        panic!("expected raw input");
    }
    assert!(parse_input(&raw, Some(r#"{"name":"paste.png","mode":"invalid"}"#)).is_err());
    let json = InvokeBody::Json(serde_json::json!({"path":"drop.png", "mode":"full"}));
    assert!(matches!(
        parse_input(&json, None).unwrap(),
        Input::Path(PathOptions {
            mode: Mode::Full,
            ..
        })
    ));
    let mut parts = Parts::from_bytes(jpeg(photo(1000, 2)).into())
        .unwrap()
        .unwrap();
    parts.set_icc_profile(Some(vec![0; PREVIEW_LIMIT + 1].into()));
    // A profile that exceeds the preview budget cannot be made to fit by resizing.
    assert_eq!(
        image::prepare(parts.encoder().bytes().to_vec(), Mode::Standard).err(),
        Some(AttachmentError::TooLarge)
    );
}
#[test]
fn placeholder_agrees_with_reference_javascript_and_average_colour() {
    // Generated using evanw/thumbhash js/thumbhash.js rgbaToThumbHash(2, 2, ...)
    // on 2026-10-30. Pixels: red, green, blue, white. Reference is the npm API.
    let reference = STANDARD.decode("IAhCtyx2CYmWaGmHiJiGCYlpSPeKj9gI").unwrap();
    let (w, h, rgba) = thumbhash::thumb_hash_to_rgba(&reference).unwrap();
    assert_eq!((w, h), (32, 32));
    for channel in 0..3 {
        let average = rgba
            .chunks_exact(4)
            .map(|p| u64::from(p[channel]))
            .sum::<u64>() as f64
            / (w * h) as f64;
        assert!((average - 128.0).abs() < 15.0);
    }
    let solid = RgbaImage::from_pixel(150, 100, Rgba([40, 120, 200, 255]));
    let hash = STANDARD
        .decode(placeholder::encode(&solid).unwrap())
        .unwrap();
    let (r, g, b, a) = thumbhash::thumb_hash_to_average_rgba(&hash).unwrap();
    for (actual, expected) in [
        (r, 40.0 / 255.0),
        (g, 120.0 / 255.0),
        (b, 200.0 / 255.0),
        (a, 1.0),
    ] {
        assert!((actual - expected).abs() < 0.04);
    }
}
#[test]
fn outbox_prepares_reads_discards_and_sweeps() {
    let root = std::env::temp_dir().join(format!("raven-attachment-test-{}", uuid::Uuid::new_v4()));
    let bytes = png(&RgbaImage::from_pixel(40, 20, Rgba([1, 2, 3, 255])));
    let first = prepare(
        &root,
        bytes.clone(),
        "C:\\private\\picture.png",
        Mode::Standard,
    )
    .unwrap();
    let second = prepare_input(
        &root,
        Input::Bytes(
            bytes.clone(),
            RawOptions {
                name: "other.png".into(),
                mode: Mode::Full,
            },
        ),
    )
    .unwrap();
    let dropped = root.join("dropped.png");
    fs::write(&dropped, &bytes).unwrap();
    let third = prepare_input(
        &root,
        Input::Path(PathOptions {
            path: dropped.clone(),
            mode: Mode::Standard,
        }),
    )
    .unwrap();
    assert_eq!(third.name, "dropped.png");
    assert_eq!(first.name, "picture.png");
    assert_eq!(read_variant(&root, &first.handle, "full").unwrap(), bytes);
    assert!(!read_variant(&root, &first.handle, "preview")
        .unwrap()
        .is_empty());
    let value: serde_json::Value = serde_json::from_slice(
        &fs::read(root.join(&first.handle).join("attachment.json")).unwrap(),
    )
    .unwrap();
    assert!(value.get("contentType").is_some());
    assert!(read_variant(&root, "../escape", "full").is_err());
    assert!(read_variant(&root, &first.handle, "../attachment.json").is_err());
    assert!(read_variant(&root, &first.handle, "attachment.json").is_err());
    sweep(&root, std::slice::from_ref(&first.handle), None).unwrap();
    assert!(root.join(&first.handle).exists());
    assert!(!root.join(second.handle).exists());
    assert!(!root.join(third.handle).exists());
    sweep(
        &root,
        &[],
        Some(SystemTime::now() - Duration::from_secs(14 * 86400)),
    )
    .unwrap();
    assert!(root.join(&first.handle).exists());
    sweep(&root, &[], Some(SystemTime::now() + Duration::from_secs(1))).unwrap();
    assert!(!root.join(&first.handle).exists());
    discard(&root, &first.handle).unwrap();
    let abandoned = root.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::create_dir(&abandoned).unwrap();
    sweep(&root, &[], None).unwrap();
    assert!(abandoned.exists());
    sweep(&root, &[], Some(SystemTime::now() + Duration::from_secs(1))).unwrap();
    assert!(!abandoned.exists());
    assert!(dropped.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "release benchmark: cargo.ps1 test --release --lib attachments::tests::benchmark -- --ignored --nocapture"]
fn benchmark() {
    let photo = match std::env::var("RAVEN_ATTACHMENT_BENCH_PHOTO") {
        Ok(path) => fs::read(path).unwrap(),
        Err(_) => jpeg(photo(4000, 3000)),
    };
    let screenshot = png(&RgbaImage::from_fn(3840, 2160, |x, y| {
        Rgba([
            if x % 300 < 240 { 35 } else { 220 },
            if y % 100 < 80 { 40 } else { 200 },
            55,
            255,
        ])
    }));
    for (label, bytes) in [
        ("12MP photo", photo),
        ("4K generated screenshot", screenshot),
    ] {
        let mut times = Vec::new();
        for _ in 0..3 {
            let input = bytes.clone();
            let start = std::time::Instant::now();
            let output = image::prepare(input, Mode::Standard).unwrap();
            times.push(start.elapsed().as_millis());
            std::hint::black_box(output);
        }
        eprintln!("{label}: milliseconds {times:?}");
    }
    // An explicit allowlist supplied by the developer, never a recursive file scan.
    if let Ok(paths) = std::env::var("RAVEN_ATTACHMENT_SAMPLES") {
        for (index, path) in paths.split('|').enumerate() {
            let bytes = fs::read(path).unwrap();
            let source = ::image::load_from_memory(&bytes).unwrap().into_rgba8();
            let graphic = image::is_graphic(&source, ::image::guess_format(&bytes).unwrap());
            let start = std::time::Instant::now();
            let output = image::prepare(bytes, Mode::Standard).unwrap();
            eprintln!(
                "authorized sample {}: {}x{}, graphic={}, full={}, {} bytes, {}ms",
                index + 1,
                source.width(),
                source.height(),
                graphic,
                output.content_type,
                output.full.len(),
                start.elapsed().as_millis()
            );
        }
    }
}
