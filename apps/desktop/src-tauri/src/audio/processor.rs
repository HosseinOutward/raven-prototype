use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::audio::domain::{
    AudioProcessorId, AudioProcessorKind, AudioProcessorParameters, AudioProcessorState, GainDb,
    MeterState, ProcessorChainState,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AudioProcessorPrepareConfig {
    pub sample_rate: u32,
    pub channels: usize,
    pub max_block_size: usize,
}

impl AudioProcessorPrepareConfig {
    pub fn new(sample_rate: u32, channels: usize, max_block_size: usize) -> Self {
        Self {
            sample_rate,
            channels,
            max_block_size,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AudioBuffer {
    channels: usize,
    samples: Vec<f32>,
}

impl AudioBuffer {
    pub fn from_interleaved(channels: usize, samples: Vec<f32>) -> Result<Self, ProcessorError> {
        if channels == 0 {
            return Err(ProcessorError::InvalidBuffer {
                message: "channel count must be greater than zero".to_string(),
            });
        }
        if samples.len() % channels != 0 {
            return Err(ProcessorError::InvalidBuffer {
                message: "interleaved sample count must be divisible by channel count".to_string(),
            });
        }
        Ok(Self { channels, samples })
    }

    pub fn silence(channels: usize, frames: usize) -> Result<Self, ProcessorError> {
        Self::from_interleaved(channels, vec![0.0; channels * frames])
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    pub fn frames(&self) -> usize {
        self.samples.len() / self.channels
    }

    pub fn samples(&self) -> &[f32] {
        &self.samples
    }

    pub fn samples_mut(&mut self) -> &mut [f32] {
        &mut self.samples
    }

    pub fn into_samples(self) -> Vec<f32> {
        self.samples
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AudioParameterValue {
    Bool(bool),
    Number(f32),
}

pub trait AudioProcessorRuntime: Send {
    fn id(&self) -> AudioProcessorId;
    fn kind(&self) -> &AudioProcessorKind;
    fn prepare(&mut self, config: AudioProcessorPrepareConfig) -> Result<(), ProcessorError>;
    fn process(&mut self, buffer: &mut AudioBuffer) -> Result<(), ProcessorError>;
    fn set_parameter(
        &mut self,
        name: &str,
        value: AudioParameterValue,
    ) -> Result<(), ProcessorError>;
    fn set_enabled(&mut self, enabled: bool);
    fn latency_samples(&self) -> u32;
    fn state(&self) -> &AudioProcessorState;
}

/// A single direct-form-I biquad section with persistent per-channel state. Coefficients
/// are recomputed from live parameters each block; the `z` history is preserved so
/// parameter tweaks don't reset the filter.
#[derive(Clone, Copy, Debug)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Default for Biquad {
    fn default() -> Self {
        // Identity (pass-through) until coefficients are set.
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            z1: 0.0,
            z2: 0.0,
        }
    }
}

impl Biquad {
    fn set_coeffs(&mut self, b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) {
        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = a1 / a0;
        self.a2 = a2 / a0;
    }

    fn process(&mut self, x: f32) -> f32 {
        // Transposed direct form II.
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// RBJ cookbook high-pass / low-pass coefficients for a unity-Q-ish second-order filter.
fn highpass_coeffs(cutoff_hz: f32, sample_rate: f32) -> (f32, f32, f32, f32, f32, f32) {
    let q = std::f32::consts::FRAC_1_SQRT_2;
    let w0 = 2.0 * std::f32::consts::PI * (cutoff_hz / sample_rate);
    let (sin_w0, cos_w0) = w0.sin_cos();
    let alpha = sin_w0 / (2.0 * q);
    let b0 = (1.0 + cos_w0) / 2.0;
    let b1 = -(1.0 + cos_w0);
    let b2 = (1.0 + cos_w0) / 2.0;
    let a0 = 1.0 + alpha;
    let a1 = -2.0 * cos_w0;
    let a2 = 1.0 - alpha;
    (b0, b1, b2, a0, a1, a2)
}

fn lowpass_coeffs(cutoff_hz: f32, sample_rate: f32) -> (f32, f32, f32, f32, f32, f32) {
    let q = std::f32::consts::FRAC_1_SQRT_2;
    let w0 = 2.0 * std::f32::consts::PI * (cutoff_hz / sample_rate);
    let (sin_w0, cos_w0) = w0.sin_cos();
    let alpha = sin_w0 / (2.0 * q);
    let b0 = (1.0 - cos_w0) / 2.0;
    let b1 = 1.0 - cos_w0;
    let b2 = (1.0 - cos_w0) / 2.0;
    let a0 = 1.0 + alpha;
    let a1 = -2.0 * cos_w0;
    let a2 = 1.0 - alpha;
    (b0, b1, b2, a0, a1, a2)
}

#[derive(Clone, Debug)]
pub struct ProcessorRuntime {
    state: AudioProcessorState,
    prepare_config: Option<AudioProcessorPrepareConfig>,
    last_meter: MeterState,
    /// Per-channel biquad state for filter processors (high-pass / low-pass).
    biquads: Vec<Biquad>,
    /// Smoothed gate gain (1 = open, 0 = closed) for the noise gate.
    gate_gain: f32,
    /// Smoothed compressor gain reduction envelope (linear).
    comp_gain: f32,
}

impl ProcessorRuntime {
    pub fn from_state(state: AudioProcessorState) -> Result<Self, ProcessorError> {
        validate_parameters(&state.kind, &state.parameters, None)?;
        Ok(Self {
            state,
            prepare_config: None,
            last_meter: MeterState::default(),
            biquads: Vec::new(),
            gate_gain: 1.0,
            comp_gain: 1.0,
        })
    }

    pub fn last_meter(&self) -> &MeterState {
        &self.last_meter
    }
}

impl AudioProcessorRuntime for ProcessorRuntime {
    fn id(&self) -> AudioProcessorId {
        self.state.id
    }

    fn kind(&self) -> &AudioProcessorKind {
        &self.state.kind
    }

    fn prepare(&mut self, config: AudioProcessorPrepareConfig) -> Result<(), ProcessorError> {
        if config.sample_rate == 0 || config.channels == 0 || config.max_block_size == 0 {
            return Err(ProcessorError::InvalidPrepareConfig);
        }
        validate_parameters(
            &self.state.kind,
            &self.state.parameters,
            Some(config.sample_rate),
        )?;
        self.prepare_config = Some(config);
        self.biquads = vec![Biquad::default(); config.channels];
        self.gate_gain = 1.0;
        self.comp_gain = 1.0;
        Ok(())
    }

    fn process(&mut self, buffer: &mut AudioBuffer) -> Result<(), ProcessorError> {
        if let Some(config) = self.prepare_config {
            if buffer.channels() != config.channels {
                return Err(ProcessorError::InvalidBuffer {
                    message: format!(
                        "buffer channel count {} does not match prepared channel count {}",
                        buffer.channels(),
                        config.channels
                    ),
                });
            }
            if buffer.frames() > config.max_block_size {
                return Err(ProcessorError::InvalidBuffer {
                    message: format!(
                        "buffer frame count {} exceeds max block size {}",
                        buffer.frames(),
                        config.max_block_size
                    ),
                });
            }
        }

        if !self.state.enabled {
            return Ok(());
        }

        match self.state.kind {
            AudioProcessorKind::Gain => {
                let gain = db_to_linear(self.state.parameters.gain_db.unwrap_or_default());
                for sample in buffer.samples_mut() {
                    *sample *= gain;
                }
            }
            AudioProcessorKind::Mute => {
                if self.state.parameters.muted.unwrap_or(false) {
                    buffer.samples_mut().fill(0.0);
                }
            }
            AudioProcessorKind::Meter => {
                self.last_meter = meter_buffer(buffer);
            }
            AudioProcessorKind::Limiter => {
                let threshold =
                    db_to_linear(self.state.parameters.threshold_db.unwrap_or(GainDb::UNITY));
                for sample in buffer.samples_mut() {
                    *sample = sample.clamp(-threshold, threshold);
                }
            }
            AudioProcessorKind::HighPassFilter | AudioProcessorKind::LowPassFilter => {
                let sample_rate = self
                    .prepare_config
                    .map(|config| config.sample_rate)
                    .unwrap_or(48_000) as f32;
                let cutoff = self
                    .state
                    .parameters
                    .cutoff_hz
                    .unwrap_or(80.0)
                    .clamp(20.0, sample_rate / 2.0 - 1.0);
                let coeffs = if matches!(self.state.kind, AudioProcessorKind::HighPassFilter) {
                    highpass_coeffs(cutoff, sample_rate)
                } else {
                    lowpass_coeffs(cutoff, sample_rate)
                };
                let channels = buffer.channels();
                if self.biquads.len() < channels {
                    self.biquads.resize(channels, Biquad::default());
                }
                for biquad in self.biquads.iter_mut().take(channels) {
                    biquad.set_coeffs(coeffs.0, coeffs.1, coeffs.2, coeffs.3, coeffs.4, coeffs.5);
                }
                for frame in buffer.samples_mut().chunks_mut(channels) {
                    for (channel, sample) in frame.iter_mut().enumerate() {
                        *sample = self.biquads[channel].process(*sample);
                    }
                }
            }
            AudioProcessorKind::NoiseGate => {
                let sample_rate = self
                    .prepare_config
                    .map(|config| config.sample_rate)
                    .unwrap_or(48_000) as f32;
                let threshold = db_to_linear(
                    self.state
                        .parameters
                        .threshold_db
                        .unwrap_or(GainDb::new(-45.0)),
                );
                let attack_ms = self.state.parameters.attack_ms.unwrap_or(5.0).max(0.1);
                let release_ms = self.state.parameters.release_ms.unwrap_or(120.0).max(0.1);
                let attack_coeff = (-1.0 / (attack_ms * 0.001 * sample_rate)).exp();
                let release_coeff = (-1.0 / (release_ms * 0.001 * sample_rate)).exp();
                let channels = buffer.channels();
                for frame in buffer.samples_mut().chunks_mut(channels) {
                    let level = frame.iter().fold(0.0_f32, |max, s| max.max(s.abs()));
                    // Open toward 1.0 when above threshold, close toward 0.0 below it, with
                    // separate attack/release smoothing so gating is click-free.
                    let target = if level >= threshold { 1.0 } else { 0.0 };
                    let coeff = if target > self.gate_gain {
                        attack_coeff
                    } else {
                        release_coeff
                    };
                    self.gate_gain = target + (self.gate_gain - target) * coeff;
                    for sample in frame.iter_mut() {
                        *sample *= self.gate_gain;
                    }
                }
            }
            AudioProcessorKind::Compressor => {
                let sample_rate = self
                    .prepare_config
                    .map(|config| config.sample_rate)
                    .unwrap_or(48_000) as f32;
                let threshold_db = self
                    .state
                    .parameters
                    .threshold_db
                    .unwrap_or(GainDb::new(-18.0))
                    .0;
                let ratio = self.state.parameters.ratio.unwrap_or(3.0).max(1.0);
                let attack_ms = self.state.parameters.attack_ms.unwrap_or(10.0).max(0.1);
                let release_ms = self.state.parameters.release_ms.unwrap_or(120.0).max(0.1);
                let attack_coeff = (-1.0 / (attack_ms * 0.001 * sample_rate)).exp();
                let release_coeff = (-1.0 / (release_ms * 0.001 * sample_rate)).exp();
                let channels = buffer.channels();
                for frame in buffer.samples_mut().chunks_mut(channels) {
                    let level = frame
                        .iter()
                        .fold(0.0_f32, |max, s| max.max(s.abs()))
                        .max(1e-6);
                    let level_db = 20.0 * level.log10();
                    let target_gain = if level_db > threshold_db {
                        let reduction_db = (level_db - threshold_db) * (1.0 - 1.0 / ratio);
                        db_to_linear(GainDb::new(-reduction_db))
                    } else {
                        1.0
                    };
                    // Attack when clamping down (gain falling), release when recovering.
                    let coeff = if target_gain < self.comp_gain {
                        attack_coeff
                    } else {
                        release_coeff
                    };
                    self.comp_gain = target_gain + (self.comp_gain - target_gain) * coeff;
                    for sample in frame.iter_mut() {
                        *sample *= self.comp_gain;
                    }
                }
            }
            // EQ (multiband peaking) is scaffolded behind the same trait but not yet
            // implemented; custom/unknown processors are intentional no-ops.
            AudioProcessorKind::Eq | AudioProcessorKind::Custom | AudioProcessorKind::Unknown => {}
        }

        Ok(())
    }

    fn set_parameter(
        &mut self,
        name: &str,
        value: AudioParameterValue,
    ) -> Result<(), ProcessorError> {
        let mut next = self.state.parameters.clone();
        set_parameter_value(&self.state.kind, &mut next, name, value)?;
        validate_parameters(
            &self.state.kind,
            &next,
            self.prepare_config.map(|config| config.sample_rate),
        )?;
        self.state.parameters = next;
        Ok(())
    }

    fn set_enabled(&mut self, enabled: bool) {
        self.state.enabled = enabled;
    }

    fn latency_samples(&self) -> u32 {
        self.state.latency_samples.unwrap_or(0)
    }

    fn state(&self) -> &AudioProcessorState {
        &self.state
    }
}

#[derive(Debug)]
pub struct ProcessorChainRuntime {
    processors: Vec<ProcessorRuntime>,
    prepare_config: Option<AudioProcessorPrepareConfig>,
}

impl ProcessorChainRuntime {
    pub fn empty() -> Self {
        Self {
            processors: Vec::new(),
            prepare_config: None,
        }
    }

    pub fn from_state(state: &ProcessorChainState) -> Result<Self, ProcessorError> {
        let processors = state
            .processors
            .iter()
            .cloned()
            .map(ProcessorRuntime::from_state)
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Self {
            processors,
            prepare_config: None,
        })
    }

    pub fn processor_ids(&self) -> Vec<AudioProcessorId> {
        self.processors
            .iter()
            .map(AudioProcessorRuntime::id)
            .collect()
    }

    pub fn prepare(&mut self, config: AudioProcessorPrepareConfig) -> Result<(), ProcessorError> {
        for processor in &mut self.processors {
            processor.prepare(config)?;
        }
        self.prepare_config = Some(config);
        Ok(())
    }

    pub fn process(&mut self, buffer: &mut AudioBuffer) -> Result<(), ProcessorError> {
        for processor in &mut self.processors {
            processor.process(buffer)?;
        }
        Ok(())
    }

    pub fn set_processor_enabled(
        &mut self,
        processor_id: AudioProcessorId,
        enabled: bool,
    ) -> Result<(), ProcessorError> {
        let processor = self.processor_mut(processor_id)?;
        processor.set_enabled(enabled);
        Ok(())
    }

    pub fn set_parameter(
        &mut self,
        processor_id: AudioProcessorId,
        name: &str,
        value: AudioParameterValue,
    ) -> Result<(), ProcessorError> {
        let processor = self.processor_mut(processor_id)?;
        processor.set_parameter(name, value)
    }

    pub fn latency_samples(&self) -> u32 {
        self.processors
            .iter()
            .map(AudioProcessorRuntime::latency_samples)
            .sum()
    }

    fn processor_mut(
        &mut self,
        processor_id: AudioProcessorId,
    ) -> Result<&mut ProcessorRuntime, ProcessorError> {
        self.processors
            .iter_mut()
            .find(|processor| processor.id() == processor_id)
            .ok_or(ProcessorError::ProcessorNotFound { processor_id })
    }
}

#[derive(Debug, Error, PartialEq)]
pub enum ProcessorError {
    #[error("audio processor not found")]
    ProcessorNotFound { processor_id: AudioProcessorId },
    #[error("invalid audio processor prepare config")]
    InvalidPrepareConfig,
    #[error("invalid audio buffer: {message}")]
    InvalidBuffer { message: String },
    #[error("unsupported parameter `{name}` for processor kind {kind:?}")]
    UnsupportedParameter {
        kind: AudioProcessorKind,
        name: String,
    },
    #[error("invalid parameter type for `{name}`")]
    InvalidParameterType { name: String },
    #[error("invalid parameter `{name}`: {message}")]
    InvalidParameter { name: String, message: String },
}

fn set_parameter_value(
    kind: &AudioProcessorKind,
    parameters: &mut AudioProcessorParameters,
    name: &str,
    value: AudioParameterValue,
) -> Result<(), ProcessorError> {
    match (kind, name, value) {
        (AudioProcessorKind::Gain, "gainDb", AudioParameterValue::Number(value)) => {
            parameters.gain_db = Some(GainDb::new(clamp_finite(value, -24.0, 24.0, 0.0)));
            Ok(())
        }
        (AudioProcessorKind::Mute, "muted", AudioParameterValue::Bool(value)) => {
            parameters.muted = Some(value);
            Ok(())
        }
        (
            AudioProcessorKind::HighPassFilter | AudioProcessorKind::LowPassFilter,
            "cutoffHz",
            AudioParameterValue::Number(value),
        ) => {
            parameters.cutoff_hz = Some(clamp_finite(value, 20.0, 20_000.0, 80.0));
            Ok(())
        }
        (
            AudioProcessorKind::Limiter
            | AudioProcessorKind::NoiseGate
            | AudioProcessorKind::Compressor,
            "thresholdDb",
            AudioParameterValue::Number(value),
        ) => {
            let (min, max) = if matches!(kind, AudioProcessorKind::Limiter) {
                (-24.0, 0.0)
            } else {
                (-90.0, 24.0)
            };
            parameters.threshold_db = Some(GainDb::new(clamp_finite(value, min, max, -1.0)));
            Ok(())
        }
        (AudioProcessorKind::Compressor, "ratio", AudioParameterValue::Number(value)) => {
            parameters.ratio = Some(clamp_finite(value, 1.0, 100.0, 3.0));
            Ok(())
        }
        (
            AudioProcessorKind::Limiter
            | AudioProcessorKind::NoiseGate
            | AudioProcessorKind::Compressor,
            "attackMs",
            AudioParameterValue::Number(value),
        ) => {
            parameters.attack_ms = Some(clamp_finite(value, 0.0, 10_000.0, 5.0));
            Ok(())
        }
        (
            AudioProcessorKind::Limiter
            | AudioProcessorKind::NoiseGate
            | AudioProcessorKind::Compressor,
            "releaseMs",
            AudioParameterValue::Number(value),
        ) => {
            parameters.release_ms = Some(clamp_finite(value, 0.0, 10_000.0, 80.0));
            Ok(())
        }
        (_, name, AudioParameterValue::Bool(_) | AudioParameterValue::Number(_)) => {
            let supported = supported_parameter_names(kind);
            if supported.contains(&name) {
                Err(ProcessorError::InvalidParameterType {
                    name: name.to_string(),
                })
            } else {
                Err(ProcessorError::UnsupportedParameter {
                    kind: kind.clone(),
                    name: name.to_string(),
                })
            }
        }
    }
}

fn clamp_finite(value: f32, min: f32, max: f32, fallback: f32) -> f32 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

fn validate_parameters(
    kind: &AudioProcessorKind,
    parameters: &AudioProcessorParameters,
    sample_rate: Option<u32>,
) -> Result<(), ProcessorError> {
    if let Some(gain_db) = parameters.gain_db {
        validate_db_range("gainDb", gain_db, -24.0, 24.0)?;
    }
    if let Some(threshold_db) = parameters.threshold_db {
        let (min, max) = if matches!(kind, AudioProcessorKind::Limiter) {
            (-24.0, 0.0)
        } else {
            (-90.0, 24.0)
        };
        validate_db_range("thresholdDb", threshold_db, min, max)?;
    }
    if let Some(cutoff_hz) = parameters.cutoff_hz {
        validate_positive("cutoffHz", cutoff_hz)?;
        if let Some(sample_rate) = sample_rate {
            let nyquist = sample_rate as f32 / 2.0;
            if cutoff_hz >= nyquist {
                return Err(ProcessorError::InvalidParameter {
                    name: "cutoffHz".to_string(),
                    message: format!("must be below Nyquist frequency {nyquist} Hz"),
                });
            }
        }
    }
    if let Some(ratio) = parameters.ratio {
        validate_positive("ratio", ratio)?;
        if ratio < 1.0 || ratio > 100.0 {
            return Err(ProcessorError::InvalidParameter {
                name: "ratio".to_string(),
                message: "must be between 1 and 100".to_string(),
            });
        }
    }
    if let Some(attack_ms) = parameters.attack_ms {
        validate_non_negative_duration("attackMs", attack_ms)?;
    }
    if let Some(release_ms) = parameters.release_ms {
        validate_non_negative_duration("releaseMs", release_ms)?;
    }
    for band in &parameters.eq_bands {
        validate_positive("eqBand.frequencyHz", band.frequency_hz)?;
        validate_positive("eqBand.q", band.q)?;
        if let Some(sample_rate) = sample_rate {
            let nyquist = sample_rate as f32 / 2.0;
            if band.frequency_hz >= nyquist {
                return Err(ProcessorError::InvalidParameter {
                    name: "eqBand.frequencyHz".to_string(),
                    message: format!("must be below Nyquist frequency {nyquist} Hz"),
                });
            }
        }
    }
    Ok(())
}

fn supported_parameter_names(kind: &AudioProcessorKind) -> &'static [&'static str] {
    match kind {
        AudioProcessorKind::Gain => &["gainDb"],
        AudioProcessorKind::Mute => &["muted"],
        AudioProcessorKind::HighPassFilter | AudioProcessorKind::LowPassFilter => &["cutoffHz"],
        AudioProcessorKind::Limiter => &["thresholdDb", "attackMs", "releaseMs"],
        AudioProcessorKind::NoiseGate => &["thresholdDb", "attackMs", "releaseMs"],
        AudioProcessorKind::Compressor => &["thresholdDb", "ratio", "attackMs", "releaseMs"],
        AudioProcessorKind::Eq
        | AudioProcessorKind::Meter
        | AudioProcessorKind::Custom
        | AudioProcessorKind::Unknown => &[],
    }
}

fn validate_db_range(name: &str, value: GainDb, min: f32, max: f32) -> Result<(), ProcessorError> {
    if !value.0.is_finite() || value.0 < min || value.0 > max {
        return Err(ProcessorError::InvalidParameter {
            name: name.to_string(),
            message: format!("must be between {min} dB and {max} dB"),
        });
    }
    Ok(())
}

fn validate_positive(name: &str, value: f32) -> Result<(), ProcessorError> {
    if !value.is_finite() || value <= 0.0 {
        return Err(ProcessorError::InvalidParameter {
            name: name.to_string(),
            message: "must be greater than zero".to_string(),
        });
    }
    Ok(())
}

fn validate_non_negative_duration(name: &str, value: f32) -> Result<(), ProcessorError> {
    if !value.is_finite() || !(0.0..=10_000.0).contains(&value) {
        return Err(ProcessorError::InvalidParameter {
            name: name.to_string(),
            message: "must be between 0 ms and 10000 ms".to_string(),
        });
    }
    Ok(())
}

fn db_to_linear(value: GainDb) -> f32 {
    10.0_f32.powf(value.0 / 20.0)
}

fn linear_to_db(value: f32) -> GainDb {
    if value <= 0.0 {
        GainDb::MUTED_FLOOR
    } else {
        GainDb::new((20.0 * value.log10()).max(GainDb::MUTED_FLOOR.0))
    }
}

pub fn meter_samples(samples: &[f32]) -> MeterState {
    meter_sample_slice(samples)
}

fn meter_buffer(buffer: &AudioBuffer) -> MeterState {
    meter_sample_slice(buffer.samples())
}

fn meter_sample_slice(samples: &[f32]) -> MeterState {
    if samples.is_empty() {
        return MeterState::default();
    }

    let mut peak = 0.0_f32;
    let mut sum_squares = 0.0_f32;
    for sample in samples {
        let sample_abs = sample.abs();
        peak = peak.max(sample_abs);
        sum_squares += sample * sample;
    }
    let rms = (sum_squares / samples.len() as f32).sqrt();

    MeterState {
        peak_db: linear_to_db(peak),
        rms_db: linear_to_db(rms),
        clipping: peak >= 1.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn processor(kind: AudioProcessorKind, display_name: &str) -> AudioProcessorState {
        AudioProcessorState::new(kind, display_name)
    }

    #[test]
    fn chain_order_is_preserved() {
        let gain = processor(AudioProcessorKind::Gain, "Gain");
        let mute = processor(AudioProcessorKind::Mute, "Mute");
        let meter = processor(AudioProcessorKind::Meter, "Meter");
        let state = ProcessorChainState {
            processors: vec![gain.clone(), mute.clone(), meter.clone()],
        };

        let chain = ProcessorChainRuntime::from_state(&state).expect("build chain");

        assert_eq!(chain.processor_ids(), vec![gain.id, mute.id, meter.id]);
    }

    #[test]
    fn enabling_and_disabling_processors_changes_chain_output() {
        let mut gain = processor(AudioProcessorKind::Gain, "Gain");
        gain.parameters.gain_db = Some(GainDb::new(6.0));
        let mut mute = processor(AudioProcessorKind::Mute, "Mute");
        mute.parameters.muted = Some(true);
        let mute_id = mute.id;
        let state = ProcessorChainState {
            processors: vec![gain, mute],
        };
        let mut chain = ProcessorChainRuntime::from_state(&state).expect("build chain");
        chain
            .prepare(AudioProcessorPrepareConfig::new(48_000, 1, 16))
            .expect("prepare");

        let mut muted_buffer =
            AudioBuffer::from_interleaved(1, vec![0.5, -0.5]).expect("audio buffer");
        chain.process(&mut muted_buffer).expect("process");
        assert_eq!(muted_buffer.samples(), &[0.0, 0.0]);

        chain
            .set_processor_enabled(mute_id, false)
            .expect("disable mute");
        let mut gained_buffer =
            AudioBuffer::from_interleaved(1, vec![0.5, -0.5]).expect("audio buffer");
        chain.process(&mut gained_buffer).expect("process");
        assert_approx_eq(gained_buffer.samples()[0], 0.9976312);
        assert_approx_eq(gained_buffer.samples()[1], -0.9976312);
    }

    #[test]
    fn parameter_updates_validate_correctly() {
        let high_pass = processor(AudioProcessorKind::HighPassFilter, "High pass");
        let high_pass_id = high_pass.id;
        let state = ProcessorChainState {
            processors: vec![high_pass],
        };
        let mut chain = ProcessorChainRuntime::from_state(&state).expect("build chain");
        chain
            .prepare(AudioProcessorPrepareConfig::new(48_000, 2, 128))
            .expect("prepare");

        chain
            .set_parameter(high_pass_id, "cutoffHz", AudioParameterValue::Number(120.0))
            .expect("valid cutoff");

        chain
            .set_parameter(
                high_pass_id,
                "cutoffHz",
                AudioParameterValue::Number(25_000.0),
            )
            .expect("cutoff should clamp to safe range");

        let wrong_type = chain
            .set_parameter(high_pass_id, "cutoffHz", AudioParameterValue::Bool(true))
            .expect_err("wrong type should fail");
        assert_eq!(
            wrong_type,
            ProcessorError::InvalidParameterType {
                name: "cutoffHz".to_string()
            }
        );
    }

    #[test]
    fn gain_processor_scales_samples() {
        let mut gain = processor(AudioProcessorKind::Gain, "Gain");
        gain.parameters.gain_db = Some(GainDb::new(-6.0));
        let mut runtime = ProcessorRuntime::from_state(gain).expect("runtime");
        runtime
            .prepare(AudioProcessorPrepareConfig::new(48_000, 1, 16))
            .expect("prepare");
        let mut buffer = AudioBuffer::from_interleaved(1, vec![1.0, -1.0]).expect("audio buffer");

        runtime.process(&mut buffer).expect("process");

        assert_approx_eq(buffer.samples()[0], 0.5011872);
        assert_approx_eq(buffer.samples()[1], -0.5011872);
    }

    #[test]
    fn mute_processor_outputs_silence() {
        let mut mute = processor(AudioProcessorKind::Mute, "Mute");
        mute.parameters.muted = Some(true);
        let mut runtime = ProcessorRuntime::from_state(mute).expect("runtime");
        runtime
            .prepare(AudioProcessorPrepareConfig::new(48_000, 2, 16))
            .expect("prepare");
        let mut buffer =
            AudioBuffer::from_interleaved(2, vec![0.25, -0.25, 0.5, -0.5]).expect("audio buffer");

        runtime.process(&mut buffer).expect("process");

        assert_eq!(buffer.samples(), &[0.0, 0.0, 0.0, 0.0]);
    }

    fn assert_approx_eq(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() < 0.000_001,
            "expected {expected}, got {actual}"
        );
    }
}
