use super::{image::resize, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::RgbaImage;

pub(super) fn encode(image: &RgbaImage) -> Result<String> {
    let small = resize(image, 100)?;
    Ok(STANDARD.encode(thumbhash::rgba_to_thumb_hash(
        small.width() as usize,
        small.height() as usize,
        small.as_raw(),
    )))
}
