# Synthetic fixtures

These contain no user images or real location data. Generated locally with Pillow 12.2.

- `orientation-6-gps.jpg`: 48 x 32, left half red, right half blue; JPEG quality 95,
  EXIF orientation 6, synthetic GPS N 35 degrees 41 minutes, E 51 degrees 25 minutes.
  Correct rotation produces a 32 x 48 image with red above blue.
- `two-frames.gif`: 16 x 12, solid red followed by solid blue, 100 ms frames, looping.

Other test inputs are generated in Rust. The ThumbHash interoperability vector in
`tests.rs` was generated using the official reference JavaScript implementation:
https://github.com/evanw/thumbhash/blob/master/js/thumbhash.js
