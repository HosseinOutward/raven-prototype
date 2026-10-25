use std::time::Instant;

use crate::audio::domain::{ChannelHealthState, GainDb, MeterState, ProcessorChainState};
use crate::audio::dynamics::PeakLimiter;
use crate::audio::processor::meter_samples;

/// Release time of the always-on safety limiter.
const SAFETY_LIMITER_RELEASE_MS: f32 = 80.0;

pub const CHANNEL_GAIN_MIN_DB: f32 = -60.0;
pub const CHANNEL_GAIN_MAX_DB: f32 = 12.0;
pub const SAFETY_LIMITER_MIN_CEILING_DB: f32 = -6.0;
pub const SAFETY_LIMITER_MAX_CEILING_DB: f32 = -0.5;
pub const SILENCE_RMS_DB: f32 = -75.0;
pub const TOO_QUIET_RMS_DB: f32 = -45.0;
pub const TOO_LOUD_RMS_DB: f32 = -8.0;
pub const NEAR_CLIPPING_PEAK_DB: f32 = -1.0;
pub const HIGH_LATENCY_SAMPLES: u32 = 2_400;

#[derive(Clone, Debug)]
pub struct ChannelSafetyRuntime {
    clipping_count: u64,
    silent_frames: u32,
    last_update: Option<Instant>,
    limiter: Option<PeakLimiter>,
}

impl ChannelSafetyRuntime {
    pub fn new() -> Self {
        Self {
            clipping_count: 0,
            silent_frames: 0,
            last_update: None,
            limiter: None,
        }
    }

    /// Give the safety stage the stream format so it can limit with look-ahead instead of
    /// clipping. Until this is called it falls back to a hard clamp.
    pub fn configure(&mut self, sample_rate: u32, channels: usize) {
        if sample_rate == 0 || channels == 0 {
            self.limiter = None;
            return;
        }
        let current = self
            .limiter
            .as_ref()
            .map(|limiter| (limiter.sample_rate(), limiter.channels()));
        if current != Some((sample_rate, channels)) {
            self.limiter = Some(PeakLimiter::new(
                sample_rate,
                channels,
                SAFETY_LIMITER_RELEASE_MS,
            ));
        }
    }

    /// Delay added by the look-ahead, in frames.
    pub fn latency_frames(&self) -> usize {
        self.limiter.as_ref().map_or(0, PeakLimiter::latency_frames)
    }

    pub fn analyze_and_limit(
        &mut self,
        samples: &mut [f32],
        ceiling_db: GainDb,
        latency_samples: u32,
        processor_cpu_estimate: Option<f32>,
    ) -> ChannelSafetyAnalysis {
        let unsafe_peak_count = samples.iter().filter(|sample| sample.abs() > 1.0).count() as u64;
        let ceiling = db_to_linear(clamp_safety_limiter_ceiling(ceiling_db));
        match self.limiter.as_mut() {
            Some(limiter) if samples.len() % limiter.channels() == 0 => {
                limiter.process(samples, ceiling);
            }
            _ => {
                for sample in &mut *samples {
                    *sample = sample.clamp(-ceiling, ceiling);
                }
            }
        }

        let meter = meter_samples(samples);
        if unsafe_peak_count > 0 {
            self.clipping_count = self.clipping_count.saturating_add(unsafe_peak_count);
        }
        if meter.rms_db.0 <= SILENCE_RMS_DB {
            self.silent_frames = self.silent_frames.saturating_add(1);
        } else {
            self.silent_frames = 0;
        }

        let clipping = unsafe_peak_count > 0;
        let recent_clipping = clipping;
        let health = ChannelHealthState {
            clipping,
            clipping_count: self.clipping_count,
            recent_clipping,
            too_quiet: meter.rms_db.0 <= TOO_QUIET_RMS_DB && meter.rms_db.0 > SILENCE_RMS_DB,
            too_loud: meter.rms_db.0 >= TOO_LOUD_RMS_DB,
            near_clipping: meter.peak_db.0 >= NEAR_CLIPPING_PEAK_DB,
            silence_detected: self.silent_frames >= 3,
            peak_db: meter.peak_db,
            rms_db: meter.rms_db,
            short_term_loudness_db: Some(meter.rms_db),
            latency_samples,
            processor_cpu_estimate,
            suppressor_cost_ms: None,
            suppressor_worst_ms: None,
            safety_limiter_active: true,
            safety_limiter_ceiling_db: clamp_safety_limiter_ceiling(ceiling_db),
        };
        self.last_update = Some(Instant::now());
        ChannelSafetyAnalysis { meter, health }
    }
}

impl Default for ChannelSafetyRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug)]
pub struct ChannelSafetyAnalysis {
    pub meter: MeterState,
    pub health: ChannelHealthState,
}

pub fn clamp_channel_gain(gain_db: GainDb) -> GainDb {
    GainDb::new(clamp_finite(
        gain_db.0,
        CHANNEL_GAIN_MIN_DB,
        CHANNEL_GAIN_MAX_DB,
        0.0,
    ))
}

pub fn clamp_safety_limiter_ceiling(ceiling_db: GainDb) -> GainDb {
    GainDb::new(clamp_finite(
        ceiling_db.0,
        SAFETY_LIMITER_MIN_CEILING_DB,
        SAFETY_LIMITER_MAX_CEILING_DB,
        -1.0,
    ))
}

pub fn chain_latency_samples(chain: &ProcessorChainState) -> u32 {
    chain
        .processors
        .iter()
        .filter(|processor| processor.enabled)
        .map(|processor| processor.latency_samples.unwrap_or(0))
        .sum()
}

pub fn chain_cpu_estimate(chain: &ProcessorChainState) -> f32 {
    chain
        .processors
        .iter()
        .filter(|processor| processor.enabled)
        .map(|processor| match processor.kind {
            crate::audio::domain::AudioProcessorKind::Eq => 1.6,
            crate::audio::domain::AudioProcessorKind::Compressor => 1.4,
            crate::audio::domain::AudioProcessorKind::Limiter => 1.0,
            crate::audio::domain::AudioProcessorKind::NoiseGate => 1.0,
            crate::audio::domain::AudioProcessorKind::HighPassFilter
            | crate::audio::domain::AudioProcessorKind::LowPassFilter => 0.8,
            crate::audio::domain::AudioProcessorKind::Gain
            | crate::audio::domain::AudioProcessorKind::Mute
            | crate::audio::domain::AudioProcessorKind::Meter => 0.3,
            crate::audio::domain::AudioProcessorKind::Custom
            | crate::audio::domain::AudioProcessorKind::Unknown => 2.0,
        })
        .sum()
}

pub fn health_from_meter(
    meter: MeterState,
    ceiling_db: GainDb,
    latency_samples: u32,
    processor_cpu_estimate: Option<f32>,
) -> ChannelHealthState {
    ChannelHealthState {
        clipping: meter.clipping,
        clipping_count: if meter.clipping { 1 } else { 0 },
        recent_clipping: meter.clipping,
        too_quiet: meter.rms_db.0 <= TOO_QUIET_RMS_DB && meter.rms_db.0 > SILENCE_RMS_DB,
        too_loud: meter.rms_db.0 >= TOO_LOUD_RMS_DB,
        near_clipping: meter.peak_db.0 >= NEAR_CLIPPING_PEAK_DB,
        silence_detected: meter.rms_db.0 <= SILENCE_RMS_DB,
        peak_db: meter.peak_db,
        rms_db: meter.rms_db,
        short_term_loudness_db: Some(meter.rms_db),
        latency_samples,
        processor_cpu_estimate,
        suppressor_cost_ms: None,
        suppressor_worst_ms: None,
        safety_limiter_active: true,
        safety_limiter_ceiling_db: clamp_safety_limiter_ceiling(ceiling_db),
    }
}

pub fn is_high_latency(health: &ChannelHealthState) -> bool {
    health.latency_samples >= HIGH_LATENCY_SAMPLES
}

pub fn db_to_linear(value: GainDb) -> f32 {
    if value.0 <= GainDb::MUTED_FLOOR.0 {
        0.0
    } else {
        10.0_f32.powf(value.0 / 20.0)
    }
}

fn clamp_finite(value: f32, min: f32, max: f32, fallback: f32) -> f32 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safety_limiter_clamps_peaks() {
        let mut runtime = ChannelSafetyRuntime::new();
        let mut samples = vec![2.0, -2.0, 0.25];

        let analysis = runtime.analyze_and_limit(&mut samples, GainDb::new(-1.0), 0, Some(0.0));

        let ceiling = db_to_linear(GainDb::new(-1.0));
        assert!(samples.iter().all(|sample| sample.abs() <= ceiling));
        assert!(analysis.health.clipping);
        assert!(analysis.health.clipping_count >= 2);
    }

    #[test]
    fn a_configured_safety_stage_limits_without_flattening_the_waveform() {
        let mut runtime = ChannelSafetyRuntime::new();
        runtime.configure(48_000, 1);
        let ceiling = db_to_linear(GainDb::new(-1.0));
        let mut samples: Vec<f32> = (0..9_600)
            .map(|n| (std::f32::consts::TAU * 220.0 * n as f32 / 48_000.0).sin() * 1.8)
            .collect();

        let analysis = runtime.analyze_and_limit(&mut samples, GainDb::new(-1.0), 0, None);

        assert!(samples.iter().all(|sample| sample.abs() <= ceiling + 1e-6));
        assert!(analysis.health.clipping, "the input was over full scale");
        let settled = &samples[4_800..];
        let pinned = settled
            .iter()
            .filter(|sample| sample.abs() >= ceiling - 1e-4)
            .count();
        assert!(
            pinned < settled.len() / 20,
            "{pinned} samples were clipped flat"
        );
    }

    #[test]
    fn silence_detection_works_on_zero_buffers() {
        let mut runtime = ChannelSafetyRuntime::new();
        let mut samples = vec![0.0; 32];

        let mut health = ChannelHealthState::default();
        for _ in 0..3 {
            health = runtime
                .analyze_and_limit(&mut samples, GainDb::new(-1.0), 0, None)
                .health;
        }

        assert!(health.silence_detected);
        assert!(!health.clipping);
    }

    #[test]
    fn gain_values_are_clamped() {
        assert_eq!(clamp_channel_gain(GainDb::new(99.0)), GainDb::new(12.0));
        assert_eq!(clamp_channel_gain(GainDb::new(-99.0)), GainDb::new(-60.0));
    }
}
