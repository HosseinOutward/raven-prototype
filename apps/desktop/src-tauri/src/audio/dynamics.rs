//! Dynamics building blocks shared by the processor chain and the per-channel safety
//! stage.

use std::collections::VecDeque;

/// How far ahead the limiter looks. Long enough to bring the gain down smoothly before a
/// peak arrives, short enough to be irrelevant as latency in a conversation.
pub(crate) const LIMITER_LOOKAHEAD_MS: f32 = 1.5;

/// Look-ahead peak limiter for interleaved audio.
///
/// A hard clip flattens every sample over the ceiling, which is audible as distortion on
/// exactly the loud moments it exists for. This limiter instead delays the signal by the
/// look-ahead and turns the gain down *before* a peak reaches the output:
///
/// 1. the loudest sample across all channels is tracked over a sliding window,
/// 2. the gain that would bring that window under the ceiling is released exponentially,
/// 3. and averaged over the same window, so gain changes are ramps rather than steps.
///
/// With a window of `L` frames and a delay of `L - 1`, every gain value that contributes
/// to an output sample was computed with that sample inside its window, so the output
/// never exceeds the ceiling. Channels share one gain, which keeps the stereo image still.
#[derive(Clone, Debug)]
pub(crate) struct PeakLimiter {
    channels: usize,
    window: usize,
    sample_rate: u32,
    release_coeff: f32,
    /// Interleaved samples waiting out the look-ahead (`window - 1` frames).
    delay: VecDeque<f32>,
    /// Monotonic queue of `(frame index, peak)` for the sliding maximum.
    peaks: VecDeque<(u64, f32)>,
    /// The released gains inside the averaging window.
    gains: VecDeque<f32>,
    gain_sum: f32,
    released: f32,
    frame: u64,
}

impl PeakLimiter {
    pub(crate) fn new(sample_rate: u32, channels: usize, release_ms: f32) -> Self {
        let channels = channels.max(1);
        let window = ((sample_rate as f32 * LIMITER_LOOKAHEAD_MS / 1000.0).round() as usize).max(1);
        let mut limiter = Self {
            channels,
            window,
            sample_rate,
            release_coeff: 0.0,
            delay: VecDeque::from(vec![0.0; (window - 1) * channels]),
            peaks: VecDeque::new(),
            gains: VecDeque::from(vec![1.0; window]),
            gain_sum: window as f32,
            released: 1.0,
            frame: 0,
        };
        limiter.set_release_ms(release_ms);
        limiter
    }

    pub(crate) fn channels(&self) -> usize {
        self.channels
    }

    pub(crate) fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Delay introduced by the look-ahead, in frames.
    pub(crate) fn latency_frames(&self) -> usize {
        self.window - 1
    }

    pub(crate) fn set_release_ms(&mut self, release_ms: f32) {
        let release_ms = if release_ms.is_finite() {
            release_ms.clamp(1.0, 5_000.0)
        } else {
            50.0
        };
        self.release_coeff = 1.0 - (-1.0 / (self.sample_rate as f32 * release_ms / 1000.0)).exp();
    }

    /// Limit `samples` (interleaved, a whole number of frames) to `ceiling` in place. The
    /// output is the input delayed by [`Self::latency_frames`].
    pub(crate) fn process(&mut self, samples: &mut [f32], ceiling: f32) {
        let ceiling = if ceiling.is_finite() && ceiling > 0.0 {
            ceiling
        } else {
            1.0
        };
        let window = self.window as u64;
        for frame in samples.chunks_exact_mut(self.channels) {
            let peak = frame
                .iter()
                .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
            let peak = if peak.is_finite() { peak } else { f32::MAX };

            while self.peaks.back().is_some_and(|(_, queued)| *queued <= peak) {
                self.peaks.pop_back();
            }
            self.peaks.push_back((self.frame, peak));
            while self
                .peaks
                .front()
                .is_some_and(|(index, _)| index + window <= self.frame)
            {
                self.peaks.pop_front();
            }
            let window_peak = self.peaks.front().map_or(0.0, |(_, peak)| *peak);

            let target = if window_peak > ceiling {
                ceiling / window_peak
            } else {
                1.0
            };
            self.released = target.min(self.released + (1.0 - self.released) * self.release_coeff);

            self.gains.push_back(self.released);
            self.gain_sum += self.released;
            if let Some(expired) = self.gains.pop_front() {
                self.gain_sum -= expired;
            }
            // The running sum drifts by rounding; refresh it now and then.
            if self.frame % 4096 == 0 {
                self.gain_sum = self.gains.iter().sum();
            }
            let gain = (self.gain_sum / self.window as f32).clamp(0.0, 1.0);

            for sample in frame.iter_mut() {
                let incoming = if sample.is_finite() { *sample } else { 0.0 };
                self.delay.push_back(incoming);
                let delayed = self.delay.pop_front().unwrap_or(0.0);
                *sample = (delayed * gain).clamp(-ceiling, ceiling);
            }
            self.frame += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(frequency_hz: f32, amplitude: f32, sample_rate: u32, frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|n| {
                (std::f32::consts::TAU * frequency_hz * n as f32 / sample_rate as f32).sin()
                    * amplitude
            })
            .collect()
    }

    #[test]
    fn output_never_exceeds_the_ceiling() {
        let mut limiter = PeakLimiter::new(48_000, 1, 50.0);
        let ceiling = 0.5;
        // Quiet, then a sudden burst four times over the ceiling, then quiet again.
        let mut audio = sine(440.0, 0.2, 48_000, 4_800);
        audio.extend(sine(440.0, 2.0, 48_000, 4_800));
        audio.extend(sine(440.0, 0.2, 48_000, 4_800));
        // Feed it in uneven blocks, as a capture callback would.
        for block in audio.chunks_mut(337) {
            limiter.process(block, ceiling);
        }
        let peak = audio
            .iter()
            .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
        assert!(
            peak <= ceiling + 1e-6,
            "peak {peak} exceeded ceiling {ceiling}"
        );
    }

    #[test]
    fn a_signal_under_the_ceiling_passes_unchanged_apart_from_the_delay() {
        let mut limiter = PeakLimiter::new(48_000, 1, 50.0);
        let input = sine(1_000.0, 0.4, 48_000, 2_400);
        let mut output = input.clone();
        limiter.process(&mut output, 0.9);

        let delay = limiter.latency_frames();
        assert_eq!(delay, 71);
        assert!(output[..delay].iter().all(|sample| *sample == 0.0));
        for (delayed, original) in output[delay..].iter().zip(&input) {
            assert!((delayed - original).abs() < 1e-5);
        }
    }

    #[test]
    fn limiting_ramps_the_gain_instead_of_clipping_the_waveform() {
        let mut limiter = PeakLimiter::new(48_000, 1, 50.0);
        let mut audio = sine(200.0, 1.6, 48_000, 9_600);
        limiter.process(&mut audio, 0.8);

        // A clipper leaves long runs of samples pinned at the ceiling. Once the limiter
        // has settled, the peaks of a sine should touch it only briefly.
        let settled = &audio[4_800..];
        let pinned = settled
            .iter()
            .filter(|sample| sample.abs() >= 0.8 - 1e-4)
            .count();
        assert!(
            pinned < settled.len() / 20,
            "{pinned} of {} samples sat on the ceiling",
            settled.len()
        );
        let peak = settled
            .iter()
            .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
        assert!(
            peak > 0.7,
            "the limiter should use the available headroom, peak {peak}"
        );
    }

    #[test]
    fn gain_recovers_after_a_loud_passage() {
        let mut limiter = PeakLimiter::new(48_000, 1, 30.0);
        let mut loud = sine(300.0, 3.0, 48_000, 4_800);
        limiter.process(&mut loud, 0.5);

        let mut quiet = sine(300.0, 0.25, 48_000, 48_000);
        limiter.process(&mut quiet, 0.5);
        let tail_peak = quiet[40_000..]
            .iter()
            .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
        assert!(
            (tail_peak - 0.25).abs() < 0.01,
            "gain did not recover: {tail_peak}"
        );
    }

    #[test]
    fn channels_share_one_gain_and_non_finite_input_is_contained() {
        let mut limiter = PeakLimiter::new(48_000, 2, 50.0);
        // Left is hot, right is quiet: both must be turned down together.
        let mut audio: Vec<f32> = (0..4_800).flat_map(|_| [2.0_f32, 0.1]).collect();
        limiter.process(&mut audio, 1.0);
        let settled = &audio[2_000..];
        assert!(settled.chunks(2).all(|frame| frame[0] <= 1.0 + 1e-6));
        assert!(settled
            .chunks(2)
            .all(|frame| (frame[1] - 0.05).abs() < 0.01));

        let mut broken = vec![f32::NAN, f32::INFINITY, 0.3, -0.3];
        limiter.process(&mut broken, 1.0);
        assert!(broken.iter().all(|sample| sample.is_finite()));
    }
}
