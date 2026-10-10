//! Color-space conversion for the video publish path.
//!
//! Capture backends produce packed RGB/BGRA frames; LiveKit's `NativeVideoSource` wants
//! planar I420 (YUV 4:2:0). These helpers do a straightforward BT.601 conversion in pure
//! Rust so we don't pull in a native color-conversion dependency. Capture resolutions are
//! downscaled by the backends where appropriate, keeping this cheap enough per frame.

/// A planar I420 frame with tightly-packed planes (stride == width / chroma width).
#[derive(Clone)]
pub struct I420Frame {
    pub width: u32,
    pub height: u32,
    pub y: Vec<u8>,
    pub u: Vec<u8>,
    pub v: Vec<u8>,
}

impl I420Frame {
    fn allocate(width: u32, height: u32) -> Self {
        let w = width as usize;
        let h = height as usize;
        let cw = (w + 1) / 2;
        let ch = (h + 1) / 2;
        Self {
            width,
            height,
            y: vec![0; w * h],
            u: vec![0; cw * ch],
            v: vec![0; cw * ch],
        }
    }

    pub fn chroma_width(&self) -> u32 {
        (self.width + 1) / 2
    }

    pub fn chroma_height(&self) -> u32 {
        (self.height + 1) / 2
    }
}

/// Resize a planar I420 frame to an exact output size. Downscales use an area average so
/// desktop text keeps its edges instead of aliasing into blocky pixels; upscales use
/// bilinear interpolation. Capture backends may choose their own native dimensions, but
/// LiveKit's `NativeVideoSource` is created with the profile dimensions, so the publish path
/// must hand it matching frames.
pub fn resize_i420_filtered(src: &I420Frame, width: u32, height: u32) -> I420Frame {
    let width = width.max(2);
    let height = height.max(2);
    if src.width == width && src.height == height {
        return src.clone();
    }

    let mut y = vec![0; (width * height) as usize];
    resize_plane_filtered(&src.y, src.width, src.height, &mut y, width, height);

    let src_cw = src.chroma_width();
    let src_ch = src.chroma_height();
    let cw = (width + 1) / 2;
    let ch = (height + 1) / 2;
    let mut u = vec![0; (cw * ch) as usize];
    let mut v = vec![0; (cw * ch) as usize];
    resize_plane_filtered(&src.u, src_cw, src_ch, &mut u, cw, ch);
    resize_plane_filtered(&src.v, src_cw, src_ch, &mut v, cw, ch);

    I420Frame {
        width,
        height,
        y,
        u,
        v,
    }
}

/// Reusing variant for the local presentation bridge, which must avoid a new allocation on
/// every remote frame.
pub fn resize_i420_filtered_reusing(
    src: &I420Frame,
    width: u32,
    height: u32,
    target: &mut I420Frame,
) {
    let width = width.max(2);
    let height = height.max(2);
    target.width = width;
    target.height = height;
    target.y.resize((width * height) as usize, 0);
    resize_plane_filtered(&src.y, src.width, src.height, &mut target.y, width, height);

    let source_chroma_width = src.chroma_width();
    let source_chroma_height = src.chroma_height();
    let chroma_width = width.div_ceil(2);
    let chroma_height = height.div_ceil(2);
    target.u.resize((chroma_width * chroma_height) as usize, 0);
    target.v.resize((chroma_width * chroma_height) as usize, 0);
    resize_plane_filtered(
        &src.u,
        source_chroma_width,
        source_chroma_height,
        &mut target.u,
        chroma_width,
        chroma_height,
    );
    resize_plane_filtered(
        &src.v,
        source_chroma_width,
        source_chroma_height,
        &mut target.v,
        chroma_width,
        chroma_height,
    );
}

fn resize_plane_filtered(
    source: &[u8],
    source_width: u32,
    source_height: u32,
    target: &mut [u8],
    target_width: u32,
    target_height: u32,
) {
    if target_width <= source_width && target_height <= source_height {
        resize_plane_area(
            source,
            source_width,
            source_height,
            target,
            target_width,
            target_height,
        );
    } else {
        resize_plane_bilinear(
            source,
            source_width,
            source_height,
            target,
            target_width,
            target_height,
        );
    }
}

fn resize_plane_area(
    source: &[u8],
    source_width: u32,
    source_height: u32,
    target: &mut [u8],
    target_width: u32,
    target_height: u32,
) {
    for target_row in 0..target_height {
        let start_row = target_row * source_height / target_height;
        let end_row = ((target_row + 1) * source_height)
            .div_ceil(target_height)
            .min(source_height);
        for target_column in 0..target_width {
            let start_column = target_column * source_width / target_width;
            let end_column = ((target_column + 1) * source_width)
                .div_ceil(target_width)
                .min(source_width);
            let mut sum = 0_u32;
            let mut count = 0_u32;
            for source_row in start_row..end_row {
                for source_column in start_column..end_column {
                    sum += source[(source_row * source_width + source_column) as usize] as u32;
                    count += 1;
                }
            }
            target[(target_row * target_width + target_column) as usize] =
                (sum / count.max(1)) as u8;
        }
    }
}

fn resize_plane_bilinear(
    source: &[u8],
    source_width: u32,
    source_height: u32,
    target: &mut [u8],
    target_width: u32,
    target_height: u32,
) {
    let x_scale =
        source_width.saturating_sub(1) as f64 / target_width.saturating_sub(1).max(1) as f64;
    let y_scale =
        source_height.saturating_sub(1) as f64 / target_height.saturating_sub(1).max(1) as f64;
    for target_row in 0..target_height {
        let source_y = target_row as f64 * y_scale;
        let y0 = source_y.floor() as u32;
        let y1 = (y0 + 1).min(source_height.saturating_sub(1));
        let fy = source_y - y0 as f64;
        for target_column in 0..target_width {
            let source_x = target_column as f64 * x_scale;
            let x0 = source_x.floor() as u32;
            let x1 = (x0 + 1).min(source_width.saturating_sub(1));
            let fx = source_x - x0 as f64;
            let top = source[(y0 * source_width + x0) as usize] as f64 * (1.0 - fx)
                + source[(y0 * source_width + x1) as usize] as f64 * fx;
            let bottom = source[(y1 * source_width + x0) as usize] as f64 * (1.0 - fx)
                + source[(y1 * source_width + x1) as usize] as f64 * fx;
            target[(target_row * target_width + target_column) as usize] =
                (top * (1.0 - fy) + bottom * fy).round() as u8;
        }
    }
}

/// Convert a tightly-packed I420 frame to RGB for local preview rendering.
/// Publishing remains I420 end-to-end; this conversion is used only by the
/// throttled desktop preview bridge.
pub fn i420_to_rgb(frame: &I420Frame) -> Vec<u8> {
    let width = frame.width as usize;
    let height = frame.height as usize;
    let chroma_width = frame.chroma_width() as usize;
    let mut rgb = vec![0; width * height * 3];

    for row in 0..height {
        for col in 0..width {
            let y = frame.y[row * width + col] as i32;
            let chroma_index = (row / 2) * chroma_width + (col / 2);
            let u = frame.u[chroma_index] as i32;
            let v = frame.v[chroma_index] as i32;
            let c = (y - 16).max(0);
            let d = u - 128;
            let e = v - 128;
            let offset = (row * width + col) * 3;
            rgb[offset] = ((298 * c + 409 * e + 128) >> 8).clamp(0, 255) as u8;
            rgb[offset + 1] = ((298 * c - 100 * d - 208 * e + 128) >> 8).clamp(0, 255) as u8;
            rgb[offset + 2] = ((298 * c + 516 * d + 128) >> 8).clamp(0, 255) as u8;
        }
    }

    rgb
}

#[derive(Clone, Copy)]
pub enum PackedFormat {
    /// 4 bytes per pixel, byte order B, G, R, A.
    Bgra,
    /// 3 bytes per pixel, byte order B, G, R (e.g. a Windows RGB24 DIB).
    Bgr,
    /// 3 bytes per pixel, byte order R, G, B.
    Rgb,
    /// 4 bytes per pixel, byte order R, G, B, A.
    Rgba,
}

impl PackedFormat {
    fn bytes_per_pixel(self) -> usize {
        match self {
            PackedFormat::Bgra | PackedFormat::Rgba => 4,
            PackedFormat::Bgr | PackedFormat::Rgb => 3,
        }
    }

    #[inline]
    fn rgb_at(self, chunk: &[u8]) -> (u8, u8, u8) {
        match self {
            PackedFormat::Bgra | PackedFormat::Bgr => (chunk[2], chunk[1], chunk[0]),
            PackedFormat::Rgb | PackedFormat::Rgba => (chunk[0], chunk[1], chunk[2]),
        }
    }
}

#[inline]
fn rgb_to_y(r: u8, g: u8, b: u8) -> u8 {
    let y = (66 * r as i32 + 129 * g as i32 + 25 * b as i32 + 128) >> 8;
    (y + 16).clamp(0, 255) as u8
}

#[inline]
fn rgb_to_u(r: u8, g: u8, b: u8) -> u8 {
    let u = (-38 * r as i32 - 74 * g as i32 + 112 * b as i32 + 128) >> 8;
    (u + 128).clamp(0, 255) as u8
}

#[inline]
fn rgb_to_v(r: u8, g: u8, b: u8) -> u8 {
    let v = (112 * r as i32 - 94 * g as i32 - 18 * b as i32 + 128) >> 8;
    (v + 128).clamp(0, 255) as u8
}

/// Convert a packed RGB/BGRA buffer into a tightly-packed I420 frame.
///
/// `src_stride` is the number of bytes per source row (may include padding). Rows/cols
/// beyond the requested `width`/`height` are ignored.
pub fn packed_to_i420(
    src: &[u8],
    width: u32,
    height: u32,
    src_stride: usize,
    format: PackedFormat,
) -> Option<I420Frame> {
    if width == 0 || height == 0 {
        return None;
    }
    let bpp = format.bytes_per_pixel();
    let w = width as usize;
    let h = height as usize;
    if src_stride < w * bpp || src.len() < src_stride * h {
        return None;
    }

    let mut frame = I420Frame::allocate(width, height);
    let cw = frame.chroma_width() as usize;

    // Luma: every pixel.
    for row in 0..h {
        let row_start = row * src_stride;
        let y_row = row * w;
        for col in 0..w {
            let px = row_start + col * bpp;
            let (r, g, b) = format.rgb_at(&src[px..px + bpp]);
            frame.y[y_row + col] = rgb_to_y(r, g, b);
        }
    }

    // Chroma: average each 2x2 block, then sample.
    for crow in 0..frame.chroma_height() as usize {
        for ccol in 0..cw {
            let r0 = crow * 2;
            let c0 = ccol * 2;
            let mut rsum = 0u32;
            let mut gsum = 0u32;
            let mut bsum = 0u32;
            let mut count = 0u32;
            for dr in 0..2 {
                let row = r0 + dr;
                if row >= h {
                    continue;
                }
                for dc in 0..2 {
                    let col = c0 + dc;
                    if col >= w {
                        continue;
                    }
                    let px = row * src_stride + col * bpp;
                    let (r, g, b) = format.rgb_at(&src[px..px + bpp]);
                    rsum += r as u32;
                    gsum += g as u32;
                    bsum += b as u32;
                    count += 1;
                }
            }
            if count == 0 {
                continue;
            }
            let r = (rsum / count) as u8;
            let g = (gsum / count) as u8;
            let b = (bsum / count) as u8;
            let idx = crow * cw + ccol;
            frame.u[idx] = rgb_to_u(r, g, b);
            frame.v[idx] = rgb_to_v(r, g, b);
        }
    }

    Some(frame)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn i420_preview_conversion_preserves_neutral_black_and_white() {
        let black = I420Frame {
            width: 2,
            height: 2,
            y: vec![16; 4],
            u: vec![128],
            v: vec![128],
        };
        let white = I420Frame {
            width: 2,
            height: 2,
            y: vec![235; 4],
            u: vec![128],
            v: vec![128],
        };

        assert_eq!(i420_to_rgb(&black), vec![0; 12]);
        assert_eq!(i420_to_rgb(&white), vec![255; 12]);
    }

    #[test]
    fn filtered_downscale_averages_high_contrast_desktop_pixels() {
        let frame = I420Frame {
            width: 4,
            height: 4,
            y: vec![
                0, 255, 0, 255, 255, 0, 255, 0, 0, 255, 0, 255, 255, 0, 255, 0,
            ],
            u: vec![128; 4],
            v: vec![128; 4],
        };
        let resized = resize_i420_filtered(&frame, 2, 2);
        assert_eq!(resized.y, vec![127; 4]);
    }

    #[test]
    fn filtered_upscale_interpolates_between_source_pixels() {
        let frame = I420Frame {
            width: 2,
            height: 2,
            y: vec![0, 100, 200, 255],
            u: vec![128],
            v: vec![128],
        };
        let resized = resize_i420_filtered(&frame, 3, 3);
        assert_eq!(resized.y[4], 139);
    }
}
