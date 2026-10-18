//! Sample-rate conversion for the publish path and the noise suppressor.
//!
//! Capture devices run at whatever rate they like (44.1 kHz is common, 16 kHz for a
//! hands-free headset, 96 kHz for an audio interface) while every source is published at
//! 48 kHz. Straight-line interpolation between samples is cheap but leaves images and
//! dulls the top end; this resampler interpolates with a windowed-sinc kernel instead, so
//! a non-48 kHz device sounds the same as a 48 kHz one.

use std::collections::VecDeque;

/// Kernel half-width, in input frames, when converting up (or not at all).
const BASE_HALF_TAPS: usize = 16;
/// Upper bound on the half-width when converting down from very high rates.
const MAX_HALF_TAPS: usize = 64;
/// Sub-sample positions the kernel is tabulated for; in-between positions are blended.
const PHASES: usize = 256;
/// Pass band as a fraction of the lower Nyquist frequency, leaving room for the roll-off.
const CUTOFF: f64 = 0.94;

fn f32_to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * 32767.0) as i16
}

/// Streaming resampler for one channel of f32 at any rate pair. State carries across
/// blocks, so the output is continuous whatever sizes the input arrives in.
pub(crate) struct MonoResampler {
    src_rate: u32,
    dst_rate: u32,
    half: usize,
    /// `PHASES + 1` rows of `2 * half` taps. Empty when the rates match: nothing to do.
    kernel: Vec<f32>,
    /// Input frames not yet fully consumed, oldest first.
    input: VecDeque<f32>,
    /// Position of the next output frame, in input frames, as an index into `input`.
    position: f64,
}

impl MonoResampler {
    pub(crate) fn new(src_rate: u32, dst_rate: u32) -> Self {
        let mut resampler = Self {
            src_rate,
            dst_rate,
            half: BASE_HALF_TAPS,
            kernel: Vec::new(),
            input: VecDeque::new(),
            position: 0.0,
        };
        if src_rate != dst_rate && src_rate != 0 {
            resampler.build_kernel();
        }
        resampler
    }

    /// Tabulate the kernel for this rate pair and start from silence.
    fn build_kernel(&mut self) {
        let ratio = f64::from(self.src_rate) / f64::from(self.dst_rate);
        // Converting down needs a lower cutoff and a proportionally longer kernel to keep
        // the same transition width.
        self.half = ((BASE_HALF_TAPS as f64 * ratio.max(1.0)).ceil() as usize)
            .clamp(BASE_HALF_TAPS, MAX_HALF_TAPS);
        let cutoff = CUTOFF * (1.0 / ratio).min(1.0);
        let taps = self.half * 2;
        self.kernel = vec![0.0; (PHASES + 1) * taps];
        for phase in 0..=PHASES {
            let fraction = phase as f64 / PHASES as f64;
            let row = &mut self.kernel[phase * taps..(phase + 1) * taps];
            let mut sum = 0.0_f64;
            for (tap, value) in row.iter_mut().enumerate() {
                // Distance from the output position to this input frame.
                let x = tap as f64 - (self.half as f64 - 1.0) - fraction;
                let weight = cutoff * sinc(cutoff * x) * blackman(x / self.half as f64);
                *value = weight as f32;
                sum += weight;
            }
            // Unity gain at DC for every phase, so the level does not ripple.
            if sum.abs() > 1e-9 {
                for value in row.iter_mut() {
                    *value = (f64::from(*value) / sum) as f32;
                }
            }
        }
        // Prime with silence so the first output aligns with the first input frame.
        self.input
            .extend(std::iter::repeat(0.0).take(self.half - 1));
        self.position = (self.half - 1) as f64;
    }

    /// Input frames the kernel must see beyond an output's own position before it can
    /// produce it: how far the output trails the input.
    pub(crate) fn lookahead_frames(&self) -> usize {
        if self.kernel.is_empty() {
            0
        } else {
            self.half
        }
    }

    pub(crate) fn process(&mut self, samples: impl IntoIterator<Item = f32>, out: &mut Vec<f32>) {
        if self.kernel.is_empty() {
            out.extend(samples);
            return;
        }
        self.input.extend(samples);

        let taps = self.half * 2;
        let step = f64::from(self.src_rate) / f64::from(self.dst_rate);
        // An output at `position` needs input frames up to `floor(position) + half`.
        while (self.position.floor() as usize) + self.half < self.input.len() {
            let base = self.position.floor() as usize;
            let fraction = self.position - base as f64;
            let phase = fraction * PHASES as f64;
            let row = phase.floor() as usize;
            let blend = (phase - row as f64) as f32;
            let lower = &self.kernel[row * taps..(row + 1) * taps];
            let upper = &self.kernel[(row + 1) * taps..(row + 2) * taps];
            let first = base + 1 - self.half;

            let mut value = 0.0_f32;
            for tap in 0..taps {
                let weight = lower[tap] + (upper[tap] - lower[tap]) * blend;
                value += self.input[first + tap] * weight;
            }
            out.push(value);
            self.position += step;
        }

        // Drop input no future output can reach.
        let keep_from = (self.position.floor() as usize + 1).saturating_sub(self.half);
        if keep_from > 0 {
            self.input.drain(..keep_from.min(self.input.len()));
            self.position -= keep_from as f64;
        }
    }
}

/// Streaming resampler that turns interleaved f32 at any rate / channel count into
/// interleaved stereo i16 at a fixed rate, one [`MonoResampler`] per channel.
pub(crate) struct StereoResampler {
    src_rate: u32,
    dst_rate: u32,
    left: MonoResampler,
    right: MonoResampler,
    left_out: Vec<f32>,
    right_out: Vec<f32>,
}

impl StereoResampler {
    pub(crate) fn new(dst_rate: u32) -> Self {
        Self {
            src_rate: 0,
            dst_rate,
            left: MonoResampler::new(0, dst_rate),
            right: MonoResampler::new(0, dst_rate),
            left_out: Vec::new(),
            right_out: Vec::new(),
        }
    }

    pub(crate) fn process(
        &mut self,
        samples: &[f32],
        channels: usize,
        sample_rate: u32,
        out: &mut Vec<i16>,
    ) {
        if channels == 0 || samples.is_empty() || sample_rate == 0 {
            return;
        }
        let frames = samples.len() / channels;
        if frames == 0 {
            return;
        }
        let frame_at = |index: usize| -> [f32; 2] {
            let base = index * channels;
            if channels == 1 {
                [samples[base], samples[base]]
            } else {
                [samples[base], samples[base + 1]]
            }
        };

        if sample_rate != self.src_rate {
            // Format changed (device switch): start over at the new rate.
            self.src_rate = sample_rate;
            self.left = MonoResampler::new(sample_rate, self.dst_rate);
            self.right = MonoResampler::new(sample_rate, self.dst_rate);
        }

        if sample_rate == self.dst_rate {
            out.reserve(frames * 2);
            for index in 0..frames {
                let frame = frame_at(index);
                out.push(f32_to_i16(frame[0]));
                out.push(f32_to_i16(frame[1]));
            }
            return;
        }

        self.left_out.clear();
        self.right_out.clear();
        self.left.process(
            (0..frames).map(|index| frame_at(index)[0]),
            &mut self.left_out,
        );
        self.right.process(
            (0..frames).map(|index| frame_at(index)[1]),
            &mut self.right_out,
        );
        out.reserve(self.left_out.len() * 2);
        for (left, right) in self.left_out.iter().zip(&self.right_out) {
            out.push(f32_to_i16(*left));
            out.push(f32_to_i16(*right));
        }
    }
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-9 {
        1.0
    } else {
        let scaled = std::f64::consts::PI * x;
        scaled.sin() / scaled
    }
}

/// Blackman window over `[-1, 1]`, zero outside.
fn blackman(t: f64) -> f64 {
    if t.abs() >= 1.0 {
        return 0.0;
    }
    let phase = std::f64::consts::PI * t;
    0.42 + 0.5 * phase.cos() + 0.08 * (2.0 * phase).cos()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(frequency_hz: f64, amplitude: f64, rate: u32, frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|n| {
                ((std::f64::consts::TAU * frequency_hz * n as f64 / f64::from(rate)).sin()
                    * amplitude) as f32
            })
            .collect()
    }

    /// Left channel of interleaved stereo i16, as f32.
    fn left(stereo: &[i16]) -> Vec<f32> {
        stereo
            .chunks(2)
            .map(|pair| f32::from(pair[0]) / 32767.0)
            .collect()
    }

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
    }

    /// Level of `frequency_hz` in `samples`, by correlating with a quadrature pair.
    fn level_at(samples: &[f32], frequency_hz: f64, rate: u32) -> f32 {
        let (mut sine, mut cosine) = (0.0_f64, 0.0_f64);
        for (n, sample) in samples.iter().enumerate() {
            let phase = std::f64::consts::TAU * frequency_hz * n as f64 / f64::from(rate);
            sine += f64::from(*sample) * phase.sin();
            cosine += f64::from(*sample) * phase.cos();
        }
        (2.0 * (sine * sine + cosine * cosine).sqrt() / samples.len() as f64) as f32
    }

    #[test]
    fn native_rate_audio_passes_through_untouched() {
        let mut resampler = StereoResampler::new(48_000);
        let mut out = Vec::new();
        resampler.process(&[0.5, -0.25, 0.25, 0.75], 2, 48_000, &mut out);
        assert_eq!(out, vec![16383, -8191, 8191, 24575]);
    }

    #[test]
    fn mono_is_duplicated_to_both_channels() {
        let mut resampler = StereoResampler::new(48_000);
        let mut out = Vec::new();
        resampler.process(&tone(440.0, 0.5, 44_100, 4_410), 1, 44_100, &mut out);
        assert!(out.chunks(2).all(|pair| pair[0] == pair[1]));
    }

    #[test]
    fn a_44_1_khz_tone_keeps_its_level_and_pitch_at_48_khz() {
        let mut resampler = StereoResampler::new(48_000);
        let mut out = Vec::new();
        resampler.process(&tone(1_000.0, 0.5, 44_100, 44_100), 1, 44_100, &mut out);
        let output = left(&out);

        // One second in gives one second out (less the kernel's short look-ahead).
        assert!(
            (output.len() as i64 - 48_000).abs() < 64,
            "got {} frames",
            output.len()
        );
        let settled = &output[2_400..];
        assert!((level_at(settled, 1_000.0, 48_000) - 0.5).abs() < 0.005);
        // Nothing but the tone: no images or other artefacts of note.
        let residue = (rms(settled).powi(2) - 0.5_f32.powi(2) / 2.0).abs().sqrt();
        assert!(residue < 0.01, "residue {residue}");
    }

    #[test]
    fn high_frequencies_survive_conversion() {
        // Linear interpolation loses several dB up here; the kernel must not.
        let mut resampler = StereoResampler::new(48_000);
        let mut out = Vec::new();
        resampler.process(&tone(12_000.0, 0.5, 44_100, 44_100), 1, 44_100, &mut out);
        let settled = left(&out)[2_400..].to_vec();
        let level_db = 20.0 * (level_at(&settled, 12_000.0, 48_000) / 0.5).log10();
        assert!(level_db.abs() < 0.2, "12 kHz changed by {level_db} dB");
    }

    #[test]
    fn output_is_identical_however_the_input_is_chunked() {
        let input = tone(700.0, 0.4, 44_100, 8_820);
        let mut whole = Vec::new();
        StereoResampler::new(48_000).process(&input, 1, 44_100, &mut whole);

        let mut chunked = Vec::new();
        let mut resampler = StereoResampler::new(48_000);
        for block in input.chunks(441 + 37) {
            resampler.process(block, 1, 44_100, &mut chunked);
        }
        assert_eq!(whole.len(), chunked.len());
        assert!(whole
            .iter()
            .zip(&chunked)
            .all(|(a, b)| (i32::from(*a) - i32::from(*b)).abs() <= 1));
    }

    #[test]
    fn downsampling_removes_what_the_target_rate_cannot_hold() {
        // 36 kHz at 96 kHz would fold down to 12 kHz in a 48 kHz stream if it got through.
        let mut resampler = StereoResampler::new(48_000);
        let mut out = Vec::new();
        resampler.process(&tone(36_000.0, 0.5, 96_000, 96_000), 1, 96_000, &mut out);
        let settled = left(&out)[4_800..].to_vec();
        let alias_db = 20.0 * (level_at(&settled, 12_000.0, 48_000).max(1e-9) / 0.5).log10();
        assert!(alias_db < -40.0, "alias only {alias_db} dB down");

        // ...while audio inside the band is kept.
        let mut in_band = Vec::new();
        StereoResampler::new(48_000).process(
            &tone(5_000.0, 0.5, 96_000, 96_000),
            1,
            96_000,
            &mut in_band,
        );
        let kept = left(&in_band)[4_800..].to_vec();
        assert!((level_at(&kept, 5_000.0, 48_000) - 0.5).abs() < 0.005);
    }

    #[test]
    fn a_rate_change_starts_cleanly_at_the_new_rate() {
        let mut resampler = StereoResampler::new(48_000);
        let mut out = Vec::new();
        resampler.process(&tone(440.0, 0.5, 44_100, 4_410), 1, 44_100, &mut out);
        out.clear();
        resampler.process(&tone(440.0, 0.5, 16_000, 16_000), 1, 16_000, &mut out);
        let output = left(&out);
        assert!((output.len() as i64 - 48_000).abs() < 128);
        assert!((level_at(&output[2_400..], 440.0, 48_000) - 0.5).abs() < 0.01);
    }
}
