//! Tells speech from keyboards, clicks and coughs, for the speaking ring and the
//! "talking while muted" warning.
//!
//! This is the detector inside sonora's gain control (WebRTC's RNN VAD), run on its own.
//! It costs a small fraction of a noise suppressor, so it can listen to every incoming
//! microphone. The answer is computed here, from audio this machine already holds, and
//! is only ever shown to the person it was computed for.

use sonora_agc2::vad_wrapper::VoiceActivityDetectorWrapper;

/// The detector, like the rest of WebRTC's audio code, reads samples as 16-bit values.
/// At the -1.0..1.0 scale it hears everything as silence.
const S16_SCALE: f32 = 32768.0;

#[derive(Debug)]
pub(crate) struct VoiceDetector {
    vad: VoiceActivityDetectorWrapper,
    channels: usize,
    /// Samples in 10 ms of one channel.
    frame_samples: usize,
    /// Channel 0 of the 10 ms frame being filled, the only channel the detector reads.
    frame: Vec<f32>,
    /// The highest probability since it was last taken.
    highest: f32,
}

impl VoiceDetector {
    pub(crate) fn new(sample_rate: u32, channels: usize) -> Self {
        let frame_samples = (sample_rate / 100) as usize;
        Self {
            vad: VoiceActivityDetectorWrapper::new(
                sonora_simd::detect_backend(),
                sample_rate as i32,
            ),
            channels: channels.max(1),
            frame_samples,
            frame: Vec::with_capacity(frame_samples),
            highest: 0.0,
        }
    }

    /// Listen to a block of interleaved samples (-1.0..1.0) of any length. The detector
    /// works on 10 ms frames, so a partial one waits for the next block.
    pub(crate) fn process(&mut self, interleaved: &[f32]) {
        for frame in interleaved.chunks_exact(self.channels) {
            self.frame.push(frame[0] * S16_SCALE);
            if self.frame.len() == self.frame_samples {
                self.highest = self.highest.max(self.vad.analyze(&self.frame));
                self.frame.clear();
            }
        }
    }

    /// The highest chance of speech since the last call, 0 to 1. The meter window is
    /// 120 ms, so keeping the highest is what lets a syllable shorter than that count.
    pub(crate) fn take_probability(&mut self) -> f32 {
        std::mem::take(&mut self.highest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::TAU;

    /// A vowel-like voice: a harmonic stack whose pitch glides between 110 and 140 Hz,
    /// shaped like a voiced sound (strong low harmonics, rolling off), with a syllable
    /// rhythm of a few hundred milliseconds. The detector wants something close to
    /// speech; a steady tone or noise does not qualify.
    fn voice_like(rate: u32, seconds: f32) -> Vec<f32> {
        let mut phase = 0.0_f32;
        (0..(rate as f32 * seconds) as usize)
            .map(|n| {
                let t = n as f32 / rate as f32;
                let pitch = 125.0 + 15.0 * (TAU * 2.0 * t).sin();
                phase += TAU * pitch / rate as f32;
                let syllable = 0.5 + 0.5 * (TAU * 3.0 * t).sin();
                let voiced: f32 = (1..=20)
                    .map(|harmonic| (phase * harmonic as f32).sin() / harmonic as f32)
                    .sum();
                0.3 * syllable * voiced
            })
            .collect()
    }

    /// Uniform white noise bursts, 80 ms on and 120 ms off, the same every run.
    fn noise_bursts(rate: u32, seconds: f32) -> Vec<f32> {
        let mut seed = 7_u32;
        (0..(rate as f32 * seconds) as usize)
            .map(|n| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let on = (n * 1000 / rate as usize) % 200 < 80;
                if on {
                    0.3 * ((seed >> 8) as f32 / 8_388_608.0 - 1.0)
                } else {
                    0.0
                }
            })
            .collect()
    }

    /// The highest probability over a signal, fed in blocks of `block` samples.
    fn highest_probability(signal: &[f32], rate: u32, block: usize) -> f32 {
        let mut detector = VoiceDetector::new(rate, 1);
        for chunk in signal.chunks(block) {
            detector.process(chunk);
        }
        detector.take_probability()
    }

    /// What the speaking ring sees: the highest probability in each 120 ms meter window,
    /// averaged over the signal.
    fn average_window_probability(signal: &[f32], rate: u32) -> f32 {
        let mut detector = VoiceDetector::new(rate, 1);
        let windows: Vec<f32> = signal
            .chunks(rate as usize * 120 / 1000)
            .map(|window| {
                detector.process(window);
                detector.take_probability()
            })
            .collect();
        windows.iter().sum::<f32>() / windows.len() as f32
    }

    #[test]
    fn voice_scores_well_above_noise_bursts_at_every_rate() {
        for rate in [48_000_u32, 44_100, 16_000] {
            let voice = average_window_probability(&voice_like(rate, 2.0), rate);
            let noise = average_window_probability(&noise_bursts(rate, 2.0), rate);
            assert!(
                voice > 0.8 && voice > noise + 0.2,
                "{rate} Hz: voice {voice}, noise {noise}"
            );
        }
    }

    #[test]
    fn block_sizes_do_not_change_the_answer() {
        for rate in [48_000_u32, 44_100, 16_000] {
            let signal = voice_like(rate, 1.0);
            let whole = highest_probability(&signal, rate, rate as usize / 100);
            // Odd sizes: smaller than a frame, straddling frames, and one sample at a time.
            for block in [1, 7, 333, 1021] {
                assert_eq!(
                    highest_probability(&signal, rate, block),
                    whole,
                    "{rate} Hz in blocks of {block}"
                );
            }
        }
    }

    #[test]
    fn only_the_first_channel_is_heard_and_a_read_starts_over() {
        let voice = voice_like(48_000, 1.0);
        let silence = vec![0.0; voice.len()];
        let interleaved = |first: &[f32], second: &[f32]| -> Vec<f32> {
            first
                .iter()
                .zip(second)
                .flat_map(|(a, b)| [*a, *b])
                .collect()
        };

        let mut detector = VoiceDetector::new(48_000, 2);
        detector.process(&interleaved(&silence, &voice));
        assert!(detector.take_probability() < 0.3);

        detector.process(&interleaved(&voice, &silence));
        assert!(detector.take_probability() > 0.6);
        assert_eq!(detector.take_probability(), 0.0);
    }
}
