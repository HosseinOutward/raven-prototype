use super::{AttachmentError as Error, Mode, Result, FULL_LIMIT, INPUT_LIMIT, PREVIEW_LIMIT};
use fast_image_resize::{
    images::{Image, ImageRef},
    FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer,
};
use image::{
    metadata::Orientation, DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader,
    RgbaImage,
};
use img_parts::{DynImage, ImageEXIF, ImageICC};
use std::{collections::HashSet, io::Cursor};

pub(super) struct Output {
    pub full: Vec<u8>,
    pub content_type: &'static str,
    pub preview: Vec<u8>,
    pub preview_type: &'static str,
    pub width: u32,
    pub height: u32,
    pub placeholder: String,
    pub animated: bool,
}
fn decode_error(error: image::ImageError) -> Error {
    match error {
        image::ImageError::Limits(_) => Error::TooLarge,
        image::ImageError::Unsupported(_) => Error::Unsupported,
        _ => Error::Damaged,
    }
}
fn mime(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Png => "image/png",
        ImageFormat::WebP => "image/webp",
        ImageFormat::Gif => "image/gif",
        _ => unreachable!(),
    }
}
fn dimensions(width: u32, height: u32) -> Result<()> {
    if width > 16384 || height > 16384 || u64::from(width) * u64::from(height) > 100_000_000 {
        return Err(Error::TooLarge);
    }
    if width == 0 || height == 0 {
        return Err(Error::Damaged);
    }
    Ok(())
}
pub(super) fn resize(source: &RgbaImage, side: u32) -> Result<RgbaImage> {
    let (width, height) = source.dimensions();
    if width.max(height) <= side {
        return Ok(source.clone());
    }
    let ratio = f64::from(side) / f64::from(width.max(height));
    let (w, h) = (
        (f64::from(width) * ratio).round().max(1.0) as u32,
        (f64::from(height) * ratio).round().max(1.0) as u32,
    );
    let input = ImageRef::new(width, height, source.as_raw(), PixelType::U8x4)
        .map_err(|_| Error::Damaged)?;
    let mut target = Image::new(w, h, PixelType::U8x4);
    Resizer::new()
        .resize(
            &input,
            &mut target,
            &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3)),
        )
        .map_err(|_| Error::Damaged)?;
    RgbaImage::from_raw(w, h, target.into_vec()).ok_or(Error::Damaged)
}
fn transparent(image: &RgbaImage) -> bool {
    image.pixels().any(|p| p[3] < 255)
}

/// JPEG is a photo; transparency, a small palette, or many flat neighbours mean graphic.
/// Count on a nearest-neighbour sample so screenshot text does not gain filter colours.
pub(super) fn is_graphic(image: &RgbaImage, format: ImageFormat) -> bool {
    if format == ImageFormat::Jpeg {
        return false;
    }
    if transparent(image) {
        return true;
    }
    let sample = image::imageops::resize(
        image,
        image.width().min(256),
        image.height().min(256),
        image::imageops::FilterType::Nearest,
    );
    let mut colours = HashSet::with_capacity(4097);
    let mut flat = 0;
    let mut comparisons = 0;
    for (x, y, pixel) in sample.enumerate_pixels() {
        if colours.len() <= 4096 {
            colours.insert(pixel.0);
        }
        if x > 0 {
            comparisons += 1;
            flat += usize::from(pixel == sample.get_pixel(x - 1, y));
        }
        if y > 0 {
            comparisons += 1;
            flat += usize::from(pixel == sample.get_pixel(x, y - 1));
        }
    }
    colours.len() <= 4096 || (comparisons > 0 && flat * 100 >= comparisons * 35)
}
fn jpeg(image: &RgbaImage, quality: f32, graphic: bool, icc: Option<&[u8]>) -> Result<Vec<u8>> {
    std::panic::catch_unwind(|| {
        let rgb = DynamicImage::ImageRgba8(image.clone()).into_rgb8();
        let mut encoder = mozjpeg::Compress::new(mozjpeg::ColorSpace::JCS_RGB);
        encoder.set_size(image.width() as usize, image.height() as usize);
        encoder.set_quality(quality);
        encoder.set_progressive_mode();
        let sampling = if graphic { (1, 1) } else { (2, 2) };
        encoder.set_chroma_sampling_pixel_sizes(sampling, sampling);
        let mut encoder = encoder
            .start_compress(Vec::new())
            .map_err(|_| Error::Damaged)?;
        if let Some(profile) = icc {
            encoder.write_icc_profile(profile);
        }
        encoder
            .write_scanlines(rgb.as_raw())
            .map_err(|_| Error::Damaged)?;
        encoder.finish().map_err(|_| Error::Damaged)
    })
    .map_err(|_| Error::Damaged)?
}
fn webp(image: &RgbaImage) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut bytes)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(decode_error)?;
    Ok(bytes)
}
fn encode_full(
    image: &RgbaImage,
    graphic: bool,
    full_quality: bool,
    icc: Option<&[u8]>,
) -> Result<(Vec<u8>, &'static str)> {
    if graphic {
        let bytes = webp(image)?;
        if full_quality || bytes.len() <= 1536 * 1024 || transparent(image) {
            return Ok((bytes, "image/webp"));
        }
    }
    Ok((
        jpeg(
            image,
            if full_quality {
                95.0
            } else if graphic {
                90.0
            } else {
                82.0
            },
            graphic,
            icc,
        )?,
        "image/jpeg",
    ))
}

/// Remove EXIF and all text metadata (including PNG XMP carried in iTXt).
/// Retain ICC, which changes how the pixel values should be interpreted.
fn strip(bytes: Vec<u8>) -> Result<(Vec<u8>, Option<img_parts::Bytes>)> {
    let mut container = DynImage::from_bytes(bytes.into())
        .map_err(|_| Error::Damaged)?
        .ok_or(Error::Unsupported)?;
    let icc = container.icc_profile();
    container.set_exif(None);
    match &mut container {
        DynImage::Jpeg(jpeg) => jpeg.segments_mut().retain(|s| {
            s.marker() != img_parts::jpeg::markers::APP1
                && s.marker() != img_parts::jpeg::markers::COM
        }),
        DynImage::Png(png) => png
            .chunks_mut()
            .retain(|c| ![*b"eXIf", *b"tEXt", *b"zTXt", *b"iTXt"].contains(&c.kind())),
        DynImage::WebP(webp) => {
            webp.remove_chunks_by_id(*b"XMP ");
            // Refresh VP8X feature flags after removing XMP too.
            webp.set_exif(None);
        }
    }
    Ok((container.encoder().bytes().to_vec(), icc))
}

// Walk GIF blocks and count image descriptors without decompressing their LZW data.
fn gif_animated(bytes: &[u8]) -> Result<bool> {
    fn skip_blocks(bytes: &[u8], pos: &mut usize) -> Result<()> {
        loop {
            let length = usize::from(*bytes.get(*pos).ok_or(Error::Damaged)?);
            *pos += 1;
            if length == 0 {
                return Ok(());
            }
            *pos = pos
                .checked_add(length)
                .filter(|end| *end <= bytes.len())
                .ok_or(Error::Damaged)?;
        }
    }
    let packed = *bytes.get(10).ok_or(Error::Damaged)?;
    let mut pos = 13
        + if packed & 0x80 != 0 {
            3 * (1 << ((packed & 7) + 1))
        } else {
            0
        };
    let mut frames = 0;
    loop {
        let tag = *bytes.get(pos).ok_or(Error::Damaged)?;
        pos += 1;
        match tag {
            0x3b => return Ok(frames > 1),
            0x21 => {
                pos += 1;
                skip_blocks(bytes, &mut pos)?;
            }
            0x2c => {
                let packed = *bytes.get(pos + 8).ok_or(Error::Damaged)?;
                pos += 9;
                if packed & 0x80 != 0 {
                    pos += 3 * (1 << ((packed & 7) + 1));
                }
                pos += 1; // LZW minimum code size
                skip_blocks(bytes, &mut pos)?;
                frames += 1;
            }
            _ => return Err(Error::Damaged),
        }
    }
}
pub(super) fn prepare(bytes: Vec<u8>, mode: Mode) -> Result<Output> {
    if bytes.len() > INPUT_LIMIT {
        return Err(Error::TooLarge);
    }
    let format = image::guess_format(&bytes).map_err(|_| Error::Unsupported)?;
    if !matches!(
        format,
        ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::Gif | ImageFormat::WebP
    ) {
        return Err(Error::Unsupported);
    }
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(decode_error)?;
    let (width, height) = decoder.dimensions();
    dimensions(width, height)?;
    let orientation = decoder.orientation().map_err(decode_error)?;
    let source_icc = decoder.icc_profile().map_err(decode_error)?;
    let rotated = orientation != Orientation::NoTransforms;
    let animated = match format {
        ImageFormat::Gif => gif_animated(&bytes)?,
        ImageFormat::WebP => image::codecs::webp::WebPDecoder::new(Cursor::new(&bytes))
            .map_err(decode_error)?
            .has_animation(),
        _ => false,
    };
    if animated && bytes.len() > FULL_LIMIT {
        return Err(Error::TooLarge);
    }
    let mut decoded = DynamicImage::from_decoder(decoder).map_err(decode_error)?;
    decoded.apply_orientation(orientation);
    let rgba = decoded.into_rgba8();
    let graphic = is_graphic(&rgba, format);
    let placeholder = super::placeholder::encode(&rgba)?;
    let full_image = if mode == Mode::Standard && !animated {
        resize(&rgba, 2560)?
    } else {
        rgba.clone()
    };
    let (width, height) = full_image.dimensions();
    let (full, content_type) =
        if animated || (mode == Mode::Full && !rotated && format == ImageFormat::Gif) {
            (bytes, mime(format))
        } else {
            let original = if format != ImageFormat::Gif {
                Some(strip(bytes)?)
            } else {
                None
            };
            if mode == Mode::Full && !rotated {
                if let Some((bytes, _)) = original {
                    (bytes, mime(format))
                } else {
                    encode_full(&full_image, graphic, true, None)?
                }
            } else {
                let icc = original.as_ref().and_then(|(_, icc)| icc.as_deref());
                let encoded = encode_full(&full_image, graphic, mode == Mode::Full, icc)?;
                match original {
                    Some((bytes, _))
                        if !rotated
                            && rgba.dimensions() == full_image.dimensions()
                            && (bytes.len() <= 500 * 1024 || bytes.len() < encoded.0.len()) =>
                    {
                        (bytes, mime(format))
                    }
                    _ => encoded,
                }
            }
        };
    if full.len() > FULL_LIMIT {
        return Err(Error::TooLarge);
    }
    let (preview, preview_type) =
        if !animated && width.max(height) <= 960 && full.len() <= PREVIEW_LIMIT {
            (full.clone(), content_type)
        } else {
            preview(&rgba, source_icc.as_deref())?
        };
    Ok(Output {
        full,
        content_type,
        preview,
        preview_type,
        width,
        height,
        placeholder,
        animated,
    })
}
fn preview(image: &RgbaImage, icc: Option<&[u8]>) -> Result<(Vec<u8>, &'static str)> {
    let mut image = resize(image, 960)?;
    let alpha = transparent(&image);
    let mut bytes = if alpha {
        webp(&image)?
    } else {
        jpeg(&image, 78.0, false, icc)?
    };
    // Quantize RGBA, retaining alpha. If an adversarial/noisy image still exceeds
    // the bound, reduce dimensions as well; the loop has a strict terminal size.
    for bits in [6, 5, 4, 3, 2] {
        if bytes.len() <= PREVIEW_LIMIT {
            break;
        }
        if alpha {
            let mask = 0xff << (8 - bits);
            for pixel in image.pixels_mut() {
                for channel in &mut pixel.0 {
                    *channel &= mask;
                }
            }
            bytes = webp(&image)?;
        }
    }
    while bytes.len() > PREVIEW_LIMIT {
        if image.width().max(image.height()) == 1 {
            // A very large ICC profile alone may exceed the preview budget.
            return Err(Error::TooLarge);
        }
        image = resize(&image, (image.width().max(image.height()) * 3 / 4).max(1))?;
        bytes = if alpha {
            webp(&image)?
        } else {
            jpeg(&image, 78.0, false, icc)?
        };
    }
    Ok((bytes, if alpha { "image/webp" } else { "image/jpeg" }))
}
