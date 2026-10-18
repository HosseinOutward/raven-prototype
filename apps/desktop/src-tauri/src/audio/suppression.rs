//! The noise suppressor that sits between the two halves of the microphone's sonora
//! processing.
//!
//! sonora's front half (high-pass, echo cancellation, and its own suppressor for
//! Standard) runs first. A [`VoiceSuppressor`] then cleans a mono 48 kHz copy of the
//! signal, and gain control runs last, so it sees the cleaned voice and does not lift the
//! noise that was just removed.

use std::collections::VecDeque;

use nnnoiseless::DenoiseState;
use thiserror::Error;

use crate::audio::domain::NoiseSuppressionMode;
use crate::audio::resample::MonoResampler;

/// Samples in the hop every suppressor works on: 10 ms at 48 kHz.
const HOP_SAMPLES: usize = 480;
const HOP_RATE: u32 = 48_000;
/// Deepest suppression, in dB. A little of the room stays so silence does not sound dead.
const MAX_SUPPRESSION_DB: f32 = 24.0;
/// A mode change crossfades over this long, so switching never clicks.
const SWITCH_FADE_MS: usize = 10;
/// RNNoise expects 16-bit sample values, not -1.0..1.0. At the wrong scale it hears
/// everything as silence and suppresses almost nothing.
const RNNOISE_SCALE: f32 = 32768.0;

#[derive(Debug, Error)]
#[error("{0}")]
pub(crate) struct SuppressorError(pub(crate) String);

pub(crate) trait VoiceSuppressor: Send {
    /// One hop of 48 kHz mono, samples in -1.0..1.0. Writes the same length.
    fn process_hop(
        &mut self,
        input: &[f32; HOP_SAMPLES],
        output: &mut [f32; HOP_SAMPLES],
    ) -> Result<(), SuppressorError>;

    /// Samples of delay this suppressor adds at 48 kHz.
    fn latency_samples(&self) -> usize;
}

/// The suppressor a mode needs on top of sonora, or `None` when sonora alone does the work.
pub(crate) fn new_suppressor(mode: NoiseSuppressionMode) -> Option<Box<dyn VoiceSuppressor>> {
    match mode {
        NoiseSuppressionMode::Off | NoiseSuppressionMode::Standard => None,
        // Studio runs as Strong until it has a suppressor of its own.
        NoiseSuppressionMode::Strong | NoiseSuppressionMode::Studio => {
            Some(Box::new(RnNoise::new()))
        }
    }
}

/// RNNoise, with the original signal mixed back in at [`MAX_SUPPRESSION_DB`] below.
struct RnNoise {
    state: Box<DenoiseState<'static>>,
    /// The previous hop of input. RNNoise's output trails its input by exactly one hop,
    /// so this is the dry signal lined up sample for sample with what it returns; any
    /// other offset would comb-filter the voice.
    previous: [f32; HOP_SAMPLES],
    dry_gain: f32,
}

impl RnNoise {
    fn new() -> Self {
        Self {
            state: DenoiseState::new(),
            previous: [0.0; HOP_SAMPLES],
            dry_gain: 10.0_f32.powf(-MAX_SUPPRESSION_DB / 20.0),
        }
    }
}

impl VoiceSuppressor for RnNoise {
    fn process_hop(
        &mut self,
        input: &[f32; HOP_SAMPLES],
        output: &mut [f32; HOP_SAMPLES],
    ) -> Result<(), SuppressorError> {
        let mut scaled = [0.0; HOP_SAMPLES];
        for (scaled, sample) in scaled.iter_mut().zip(input) {
            *scaled = sample * RNNOISE_SCALE;
        }
        // The voice probability is not used: speech detection comes from sonora's own
        // detector, which works in every mode.
        self.state.process_frame(output, &scaled);
        for (sample, dry) in output.iter_mut().zip(&self.previous) {
            *sample = *sample / RNNOISE_SCALE + self.dry_gain * dry;
        }
        self.previous = *input;
        // Bad input poisons RNNoise's state for good; better to stop using it than to
        // send the block on and have the whole capture rebuilt.
        if output.iter().any(|sample| !sample.is_finite()) {
            return Err(SuppressorError(
                "RNNoise produced invalid samples".to_string(),
            ));
        }
        Ok(())
    }

    fn latency_samples(&self) -> usize {
        HOP_SAMPLES
    }
}

/// One suppressor and the buffering that adapts a device stream to its hops. Without a
/// suppressor it does nothing and adds no delay.
struct SuppressorPath {
    suppressor: Option<Box<dyn VoiceSuppressor>>,
    sample_rate: u32,
    /// Device rate to 48 kHz and back. Absent for a 48 kHz device, where one 10 ms frame
    /// is exactly one hop.
    to_hop_rate: Option<MonoResampler>,
    from_hop_rate: Option<MonoResampler>,
    /// 48 kHz samples waiting for a whole hop.
    pending: VecDeque<f32>,
    /// Cleaned samples at the device rate waiting to be picked up.
    ready: VecDeque<f32>,
    /// Silence `ready` started with.
    priming: usize,
    resampled: Vec<f32>,
    cleaned: Vec<f32>,
}

impl SuppressorPath {
    fn new(suppressor: Option<Box<dyn VoiceSuppressor>>, sample_rate: u32) -> Self {
        let resampling = suppressor.is_some() && sample_rate != HOP_RATE;
        let to_hop_rate = resampling.then(|| MonoResampler::new(sample_rate, HOP_RATE));
        let from_hop_rate = resampling.then(|| MonoResampler::new(HOP_RATE, sample_rate));
        // At other rates a hop completes up to one frame late, and the second resampler
        // holds back its lookahead. This much silence keeps `ready` from ever running dry.
        let priming = from_hop_rate.as_ref().map_or(0, |resampler| {
            let lookahead =
                (resampler.lookahead_frames() * sample_rate as usize).div_ceil(HOP_RATE as usize);
            sample_rate as usize / 100 + lookahead + 2
        });
        Self {
            suppressor,
            sample_rate,
            to_hop_rate,
            from_hop_rate,
            pending: VecDeque::new(),
            ready: std::iter::repeat(0.0).take(priming).collect(),
            priming,
            resampled: Vec::new(),
            cleaned: Vec::new(),
        }
    }

    /// Samples at the device rate between a sample going in and coming out.
    fn latency_samples(&self) -> usize {
        self.suppressor.as_ref().map_or(0, |suppressor| {
            suppressor.latency_samples() * self.sample_rate as usize / HOP_RATE as usize
                + self.priming
        })
    }

    /// Clean `mono` in place. On an error the path is no longer usable.
    fn process(&mut self, mono: &mut [f32]) -> Result<(), SuppressorError> {
        let Some(suppressor) = self.suppressor.as_mut() else {
            return Ok(());
        };
        self.resampled.clear();
        match self.to_hop_rate.as_mut() {
            Some(resampler) => resampler.process(mono.iter().copied(), &mut self.resampled),
            None => self.resampled.extend_from_slice(mono),
        }
        self.pending.extend(self.resampled.drain(..));

        self.cleaned.clear();
        let mut input = [0.0; HOP_SAMPLES];
        let mut output = [0.0; HOP_SAMPLES];
        while self.pending.len() >= HOP_SAMPLES {
            for (slot, sample) in input.iter_mut().zip(self.pending.drain(..HOP_SAMPLES)) {
                *slot = sample;
            }
            suppressor.process_hop(&input, &mut output)?;
            self.cleaned.extend_from_slice(&output);
        }

        match self.from_hop_rate.as_mut() {
            Some(resampler) => {
                self.resampled.clear();
                resampler.process(self.cleaned.iter().copied(), &mut self.resampled);
                self.ready.extend(self.resampled.drain(..));
            }
            None => self.ready.extend(self.cleaned.drain(..)),
        }
        for sample in mono.iter_mut() {
            *sample = self.ready.pop_front().unwrap_or(0.0);
        }
        Ok(())
    }
}

/// A path being faded in over the one that is running.
struct Incoming {
    path: SuppressorPath,
    /// Samples until the path's output is real audio rather than its priming.
    wait: usize,
    faded: usize,
}

impl Incoming {
    fn next_weight(&mut self, fade_len: usize) -> f32 {
        if self.wait > 0 {
            self.wait -= 1;
            return 0.0;
        }
        self.faded += 1;
        (self.faded as f32 / fade_len as f32).min(1.0)
    }
}

/// Runs the active suppressor over a block of interleaved microphone samples, in place.
///
/// Channels are averaged into one going in and the result is copied to every channel
/// coming out: a microphone is a voice, and cleaning each channel would double the cost
/// for nothing. With no suppressor the block is left untouched.
pub(crate) struct SuppressorStage {
    channels: usize,
    sample_rate: u32,
    current: SuppressorPath,
    incoming: Option<Incoming>,
    mono: Vec<f32>,
    incoming_mono: Vec<f32>,
}

impl std::fmt::Debug for SuppressorStage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SuppressorStage")
            .field("sample_rate", &self.sample_rate)
            .field("channels", &self.channels)
            .field("latency_samples", &self.latency_samples())
            .field("switching", &self.is_switching())
            .finish_non_exhaustive()
    }
}

impl SuppressorStage {
    pub(crate) fn new(
        suppressor: Option<Box<dyn VoiceSuppressor>>,
        sample_rate: u32,
        channels: usize,
    ) -> Self {
        Self {
            channels: channels.max(1),
            sample_rate,
            current: SuppressorPath::new(suppressor, sample_rate),
            incoming: None,
            mono: Vec::new(),
            incoming_mono: Vec::new(),
        }
    }

    /// Delay the stage adds at the device rate.
    pub(crate) fn latency_samples(&self) -> usize {
        self.current.latency_samples()
    }

    pub(crate) fn is_switching(&self) -> bool {
        self.incoming.is_some()
    }

    /// Start moving to another suppressor (`None` for sonora alone). The new one runs
    /// beside the old for a moment and the output fades from one to the other; their
    /// delays differ, so a few milliseconds are skipped or repeated under the fade.
    pub(crate) fn switch(&mut self, suppressor: Option<Box<dyn VoiceSuppressor>>) {
        if suppressor.is_none() && self.current.suppressor.is_none() {
            return;
        }
        let path = SuppressorPath::new(suppressor, self.sample_rate);
        // Until it has delivered its latency, a path's output is silence; fade once real
        // audio arrives.
        let wait = path.latency_samples();
        self.incoming = Some(Incoming {
            path,
            wait,
            faded: 0,
        });
    }

    /// Stop suppressing at once, for a suppressor that can no longer be trusted.
    pub(crate) fn bypass(&mut self) {
        self.current = SuppressorPath::new(None, self.sample_rate);
        self.incoming = None;
    }

    /// Clean a block. On an error the block is left as it came in.
    pub(crate) fn process(&mut self, samples: &mut [f32]) -> Result<(), SuppressorError> {
        if self.current.suppressor.is_none() && self.incoming.is_none() {
            return Ok(());
        }
        let channels = self.channels;
        self.mono.clear();
        self.mono.extend(
            samples
                .chunks_exact(channels)
                .map(|frame| frame.iter().sum::<f32>() / channels as f32),
        );
        if let Some(incoming) = self.incoming.as_mut() {
            self.incoming_mono.clear();
            self.incoming_mono.extend_from_slice(&self.mono);
            incoming.path.process(&mut self.incoming_mono)?;
        }
        self.current.process(&mut self.mono)?;

        let fade_len = self.sample_rate as usize * SWITCH_FADE_MS / 1000;
        for (index, frame) in samples.chunks_exact_mut(channels).enumerate() {
            let mut value = self.mono[index];
            if let Some(incoming) = self.incoming.as_mut() {
                value += (self.incoming_mono[index] - value) * incoming.next_weight(fade_len);
            }
            frame.fill(value);
        }
        match self.incoming.take() {
            Some(incoming) if incoming.faded >= fade_len => self.current = incoming.path,
            unfinished => self.incoming = unfinished,
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hands audio back one hop late, untouched, as RNNoise delays it.
    struct DelayedCopy {
        held: [f32; HOP_SAMPLES],
    }

    impl DelayedCopy {
        fn boxed() -> Option<Box<dyn VoiceSuppressor>> {
            Some(Box::new(Self {
                held: [0.0; HOP_SAMPLES],
            }))
        }
    }

    impl VoiceSuppressor for DelayedCopy {
        fn process_hop(
            &mut self,
            input: &[f32; HOP_SAMPLES],
            output: &mut [f32; HOP_SAMPLES],
        ) -> Result<(), SuppressorError> {
            *output = self.held;
            self.held = *input;
            Ok(())
        }

        fn latency_samples(&self) -> usize {
            HOP_SAMPLES
        }
    }

    struct Failing;

    impl VoiceSuppressor for Failing {
        fn process_hop(
            &mut self,
            _input: &[f32; HOP_SAMPLES],
            _output: &mut [f32; HOP_SAMPLES],
        ) -> Result<(), SuppressorError> {
            Err(SuppressorError("the model is gone".to_string()))
        }

        fn latency_samples(&self) -> usize {
            0
        }
    }

    fn tone(frequency_hz: f32, amplitude: f32, rate: u32, frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|n| {
                amplitude * (std::f32::consts::TAU * frequency_hz * n as f32 / rate as f32).sin()
            })
            .collect()
    }

    /// Uniform white noise in -amplitude..amplitude, the same every run.
    fn white_noise(amplitude: f32, frames: usize) -> Vec<f32> {
        let mut seed = 99_u32;
        (0..frames)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                amplitude * ((seed >> 8) as f32 / 8_388_608.0 - 1.0)
            })
            .collect()
    }

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
    }

    /// Run mono `input` through the stage in 10 ms blocks, as the microphone delivers it.
    fn run(stage: &mut SuppressorStage, input: &[f32], rate: u32) -> Vec<f32> {
        let mut output = input.to_vec();
        for block in output.chunks_mut(rate as usize / 100) {
            stage.process(block).expect("process block");
        }
        output
    }

    #[test]
    fn the_reported_latency_is_the_measured_impulse_delay_at_every_rate() {
        for rate in [48_000_u32, 44_100, 16_000] {
            let frame = rate as usize / 100;
            let mut stage = SuppressorStage::new(DelayedCopy::boxed(), rate, 1);
            let mut input = vec![0.0; rate as usize];
            let impulse_at = 10 * frame;
            input[impulse_at] = 0.5;

            let output = run(&mut stage, &input, rate);

            let peak_at = output
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
                .map(|(index, _)| index)
                .expect("output");
            let measured = peak_at - impulse_at;
            assert!(
                measured.abs_diff(stage.latency_samples()) <= 1,
                "{rate} Hz: reported {}, measured {measured}",
                stage.latency_samples()
            );
        }
        // At 48 kHz there is nothing to buffer beyond the suppressor's own hop.
        assert_eq!(
            SuppressorStage::new(DelayedCopy::boxed(), 48_000, 1).latency_samples(),
            HOP_SAMPLES
        );
    }

    #[test]
    fn a_tone_comes_out_whole_and_delayed_by_the_latency_at_every_rate() {
        for rate in [48_000_u32, 44_100, 16_000] {
            let mut stage = SuppressorStage::new(DelayedCopy::boxed(), rate, 1);
            let input = tone(440.0, 0.5, rate, rate as usize);

            let output = run(&mut stage, &input, rate);

            // A block that came up short would show as a gap, not as a delayed tone.
            let delay = stage.latency_samples();
            let settled = rate as usize / 5;
            let error: Vec<f32> = (settled..input.len())
                .map(|n| output[n] - input[n - delay])
                .collect();
            assert!(rms(&error) < 0.005, "{rate} Hz: error {}", rms(&error));
        }
    }

    #[test]
    fn a_stereo_block_gets_the_cleaned_average_on_both_channels() {
        let mut stage = SuppressorStage::new(DelayedCopy::boxed(), 48_000, 2);
        let left = tone(440.0, 0.4, 48_000, 4_800);
        let mut stereo: Vec<f32> = left.iter().flat_map(|sample| [*sample, 0.0]).collect();

        for block in stereo.chunks_mut(960) {
            stage.process(block).expect("process block");
        }

        // Only the left channel carried sound; both now carry half of it, one hop late.
        for (n, frame) in stereo.chunks(2).enumerate().skip(HOP_SAMPLES) {
            let expected = left[n - HOP_SAMPLES] / 2.0;
            assert!((frame[0] - expected).abs() < 1e-6 && (frame[1] - expected).abs() < 1e-6);
        }
    }

    #[test]
    fn switching_fades_instead_of_cutting() {
        let mut stage = SuppressorStage::new(None, 48_000, 1);
        let input = tone(440.0, 0.5, 48_000, 9_600);
        let mut output = input.clone();
        for (index, block) in output.chunks_mut(480).enumerate() {
            if index == 5 {
                stage.switch(DelayedCopy::boxed());
            }
            stage.process(block).expect("process block");
        }

        // The new path lags by 480 samples (about 144 degrees of this tone), so a cut
        // would jump by up to the full swing. The fade stays within the tone's own slope.
        let natural_step = 0.5 * std::f32::consts::TAU * 440.0 / 48_000.0;
        let biggest_step = output
            .windows(2)
            .map(|pair| (pair[1] - pair[0]).abs())
            .fold(0.0, f32::max);
        assert!(
            biggest_step < natural_step * 1.2,
            "step {biggest_step} against a natural {natural_step}"
        );
        assert!(!stage.is_switching());
        assert_eq!(stage.latency_samples(), HOP_SAMPLES);
    }

    #[test]
    fn an_error_leaves_the_block_as_it_came_in() {
        let mut stage = SuppressorStage::new(Some(Box::new(Failing)), 48_000, 1);
        let input = tone(440.0, 0.5, 48_000, 480);
        let mut block = input.clone();

        assert!(stage.process(&mut block).is_err());
        assert_eq!(block, input);

        stage.bypass();
        assert!(stage.process(&mut block).is_ok());
        assert_eq!(block, input);
        assert_eq!(stage.latency_samples(), 0);
    }

    #[test]
    fn rnnoise_takes_most_of_the_noise_out_from_under_a_tone() {
        let rate = 48_000;
        let noise = white_noise(0.03, 3 * rate);
        let voiced: Vec<f32> = noise
            .iter()
            .zip(tone(300.0, 0.2, rate as u32, 3 * rate))
            .map(|(noise, tone)| noise + tone)
            .collect();

        let mut noise_only =
            SuppressorStage::new(new_suppressor(NoiseSuppressionMode::Strong), 48_000, 1);
        let cleaned_noise = run(&mut noise_only, &noise, 48_000);
        let reduction_db =
            20.0 * (rms(&noise[2 * rate..]) / rms(&cleaned_noise[2 * rate..])).log10();
        // The dry mix at -24 dB caps what is possible; at the wrong sample scale RNNoise
        // would take out almost none of this.
        assert!(
            reduction_db > 20.0,
            "noise only came down {reduction_db} dB"
        );

        let mut with_tone =
            SuppressorStage::new(new_suppressor(NoiseSuppressionMode::Strong), 48_000, 1);
        let cleaned = run(&mut with_tone, &voiced, 48_000);
        let kept = rms(&cleaned[2 * rate..]) / rms(&voiced[2 * rate..]);
        assert!(
            (0.9..1.2).contains(&kept),
            "the tone came out at {kept} of its level"
        );
    }

    #[test]
    fn the_dry_signal_lines_up_with_rnnoise_output_sample_for_sample() {
        let mut mixed = RnNoise::new();
        let mut plain = DenoiseState::new();
        let mut impulse = [0.0; HOP_SAMPLES];
        impulse[100] = 0.5;
        let silence = [0.0; HOP_SAMPLES];

        for (hop, input) in [impulse, silence, silence].iter().enumerate() {
            let mut with_dry = [0.0; HOP_SAMPLES];
            mixed
                .process_hop(input, &mut with_dry)
                .expect("process hop");
            let mut without = [0.0; HOP_SAMPLES];
            let scaled: Vec<f32> = input.iter().map(|sample| sample * RNNOISE_SCALE).collect();
            plain.process_frame(&mut without, &scaled);

            for (index, (with_dry, without)) in with_dry.iter().zip(&without).enumerate() {
                let added = with_dry - without / RNNOISE_SCALE;
                // The impulse went in at sample 100 of hop 0 and its dry copy comes out
                // exactly one hop later, 24 dB down: nowhere else.
                let expected = if hop == 1 && index == 100 {
                    0.5 * 10.0_f32.powf(-MAX_SUPPRESSION_DB / 20.0)
                } else {
                    0.0
                };
                assert!(
                    (added - expected).abs() < 1e-7,
                    "hop {hop} sample {index}: dry {added}, expected {expected}"
                );
            }
        }
    }
}
