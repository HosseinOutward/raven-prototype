//! Native audio media engine.
//!
//! This owns the LiveKit room connection for a user's **audio sidecar** participant
//! (`<userId>#audio`). It is the single place audio crosses the network:
//!
//! - **Send:** the capture pipeline pushes already-DSP-processed PCM into a per-source
//!   [`PublishSink`]; a drain task forwards it to a LiveKit [`NativeAudioSource`] whose
//!   track is published as `raven-audio-<trackId>`. Because the *processed* samples are
//!   what we publish, faders / mute / the processor chain affect transmitted audio in
//!   real time.
//! - **Receive:** every remote `raven-audio-*` track is subscribed, read via
//!   [`NativeAudioStream`], run through the receiver's *local* gain/mute, mixed, and
//!   played to the default output device. Each peer manages incoming tracks without
//!   affecting anyone else.
//!
//! The JS `livekit-client` keeps the camera/screenshare video participant; this engine
//! never touches video. See the project plan for the full topology.

use std::collections::{HashMap, VecDeque};
use std::f32::consts::TAU;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle as ThreadJoinHandle};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::Device;
use futures_util::StreamExt;
use livekit::options::TrackPublishOptions;
use livekit::prelude::{
    LocalAudioTrack, LocalTrack, RemoteTrack, Room, RoomEvent, RoomOptions, TrackKind, TrackSource,
};
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::stats::RtcStats;
use tauri::{AppHandle, Emitter};
use tokio::runtime::Runtime;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::audio::capture::list_output_devices;
use crate::audio::capture::ProcessedSampleSink;
use crate::audio::domain::{
    AudioMeterUpdate, AudioOutputDevice, AudioSourceId, AudioSourceState, AudioSourceType, GainDb,
    MeterState, ParticipantId, ProcessorChainState, PublishedTrackId, PublishedTrackMetadata,
};
use crate::audio::processor::{
    meter_samples, AudioBuffer, AudioProcessorPrepareConfig, ProcessorChainRuntime,
};
use crate::audio::publisher::stable_webrtc_track_id;
use crate::audio::state::{
    SharedAudioEngineState, AUDIO_METER_CHANGED_EVENT, AUDIO_STATE_CHANGED_EVENT,
};
use serde::{Deserialize, Serialize};

/// Per-track metadata the publisher shares with subscribers via LiveKit participant
/// metadata (a JSON map of `trackId` → this). It lets each incoming track show what the
/// owner is actually sharing — the precise source type and a human name (the mic, the app).
#[derive(Serialize, Deserialize)]
struct SharedTrackMeta {
    #[serde(rename = "sourceType")]
    source_type: AudioSourceType,
    #[serde(rename = "displayName", default)]
    display_name: String,
    #[serde(rename = "deviceName", default)]
    device_name: Option<String>,
    #[serde(rename = "appName", default)]
    app_name: Option<String>,
    #[serde(rename = "appExeName", default)]
    app_exe_name: Option<String>,
    #[serde(rename = "appIconDataUrl", default)]
    app_icon_data_url: Option<String>,
}

fn parse_shared_meta(metadata: &str) -> HashMap<String, SharedTrackMeta> {
    if metadata.is_empty() {
        return HashMap::new();
    }
    serde_json::from_str(metadata).unwrap_or_default()
}

/// Channel layout we publish and play at. libwebrtc resamples to/from its internal
/// 48 kHz pipeline, so a fixed stereo contract keeps the mixer trivial.
const PUBLISH_CHANNELS: usize = 2;
/// Drop the oldest queued samples once a receive queue grows past this (~400 ms) to
/// bound playback latency when a reader briefly outpaces the output device.
const MIX_MAX_SAMPLES: usize = 48_000 * PUBLISH_CHANNELS * 2 / 5;
/// How often each remote reader publishes a meter update for its Incoming Tracks strip.
const METER_INTERVAL: Duration = Duration::from_millis(120);
/// How often a remote reader refreshes receiver-local controls from mixer state.
/// Reading them for every audio frame lets active remote playback starve local publish
/// mutations on some machines.
const RECEIVER_CONTROL_REFRESH_INTERVAL: Duration = Duration::from_millis(40);
/// Upper bound on the per-block frame count fed to a receiver processor chain. LiveKit
/// audio frames are ~10 ms, well under this.
const RECEIVER_MAX_BLOCK: usize = 4096;

/// Run a synchronous LiveKit operation with the audio engine's Tokio reactor installed.
///
/// Some LiveKit methods, including `RemoteTrackPublication::set_subscribed`, spawn async
/// work internally even though their public API is synchronous. Tauri invokes synchronous
/// commands from WebView threads that do not have a Tokio reactor, so those methods must be
/// called from this context or they will panic instead of returning an error.
fn within_runtime_context<T>(runtime: &Runtime, operation: impl FnOnce() -> T) -> T {
    let _guard = runtime.enter();
    operation()
}

#[cfg(test)]
mod runtime_context_tests {
    use super::*;

    #[test]
    fn synchronous_media_operations_can_spawn_on_the_audio_runtime() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build test runtime");

        let task = within_runtime_context(&runtime, || tokio::spawn(async { 42 }));

        assert_eq!(runtime.block_on(task).expect("spawned task"), 42);
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioNetworkTotals {
    pub sent_bytes: u64,
    pub received_bytes: u64,
}

pub async fn measure_audio_network_totals(room: Arc<Room>) -> Result<AudioNetworkTotals, String> {
    let stats = room.get_stats().await.map_err(|error| error.to_string())?;
    let sent_bytes = stats
        .publisher_stats
        .iter()
        .filter_map(|stat| match stat {
            RtcStats::OutboundRtp(outbound) => Some(outbound.sent.bytes_sent),
            _ => None,
        })
        .sum();
    let received_bytes = stats
        .subscriber_stats
        .iter()
        .filter_map(|stat| match stat {
            RtcStats::InboundRtp(inbound) => Some(inbound.inbound.bytes_received),
            _ => None,
        })
        .sum();

    Ok(AudioNetworkTotals {
        sent_bytes,
        received_bytes,
    })
}

fn db_to_linear(db: GainDb) -> f32 {
    10.0_f32.powf(db.0 / 20.0)
}

fn f32_to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * 32767.0) as i16
}

fn lk_track_source(source_type: &AudioSourceType) -> TrackSource {
    match source_type {
        AudioSourceType::Microphone => TrackSource::Microphone,
        AudioSourceType::ScreenAudio | AudioSourceType::SystemAudio | AudioSourceType::AppAudio => {
            TrackSource::ScreenshareAudio
        }
        _ => TrackSource::Unknown,
    }
}

fn audio_source_from_lk(source: TrackSource) -> AudioSourceType {
    match source {
        TrackSource::Microphone => AudioSourceType::Microphone,
        TrackSource::ScreenshareAudio => AudioSourceType::ScreenAudio,
        _ => AudioSourceType::Unknown,
    }
}

fn base_participant_identity(identity: &str) -> &str {
    identity
        .strip_suffix("#audio")
        .or_else(|| identity.strip_suffix("#video"))
        .unwrap_or(identity)
}

// ---------------------------------------------------------------------------
// Send path: streaming resampler + per-source publish sink
// ---------------------------------------------------------------------------

/// Streaming linear resampler that normalizes any capture format to stereo at the
/// publish rate. Keeps the previous frame so interpolation is continuous across blocks.
struct StereoResampler {
    src_rate: u32,
    dst_rate: u32,
    pos: f64,
    prev: [f32; 2],
    primed: bool,
}

impl StereoResampler {
    fn new(dst_rate: u32) -> Self {
        Self {
            src_rate: 0,
            dst_rate,
            pos: 0.0,
            prev: [0.0; 2],
            primed: false,
        }
    }

    fn process(&mut self, samples: &[f32], channels: usize, sample_rate: u32, out: &mut Vec<i16>) {
        if channels == 0 || samples.is_empty() {
            return;
        }
        let frames = samples.len() / channels;
        if frames == 0 {
            return;
        }
        let frame_at_block = |i: usize| -> [f32; 2] {
            let base = i * channels;
            if channels == 1 {
                let s = samples[base];
                [s, s]
            } else {
                [samples[base], samples[base + 1]]
            }
        };

        if sample_rate != self.src_rate {
            // Format changed (device switch); reset interpolation state.
            self.src_rate = sample_rate;
            self.pos = 0.0;
            self.primed = false;
        }

        if sample_rate == self.dst_rate {
            for i in 0..frames {
                let f = frame_at_block(i);
                out.push(f32_to_i16(f[0]));
                out.push(f32_to_i16(f[1]));
            }
            return;
        }

        if !self.primed {
            self.prev = frame_at_block(0);
            self.primed = true;
            self.pos = 0.0;
        }

        // Virtual input sequence is [prev, block[0], block[1], ...]; index 0 == prev.
        let total = frames + 1;
        let step = sample_rate as f64 / self.dst_rate as f64;
        let frame_at = |idx: usize| -> [f32; 2] {
            if idx == 0 {
                self.prev
            } else {
                frame_at_block(idx - 1)
            }
        };
        while self.pos < (total - 1) as f64 {
            let idx = self.pos.floor() as usize;
            let frac = (self.pos - idx as f64) as f32;
            let a = frame_at(idx);
            let b = frame_at(idx + 1);
            out.push(f32_to_i16(a[0] + (b[0] - a[0]) * frac));
            out.push(f32_to_i16(a[1] + (b[1] - a[1]) * frac));
            self.pos += step;
        }
        self.pos -= frames as f64;
        self.prev = frame_at_block(frames - 1);
    }
}

/// Capture-side sink for one published source. Receives processed f32 PCM on the audio
/// thread, normalizes it to stereo i16 at the publish rate, and hands it to the drain task.
pub struct PublishSink {
    sender: mpsc::Sender<Vec<i16>>,
    resampler: Mutex<StereoResampler>,
}

impl PublishSink {
    fn new(sender: mpsc::Sender<Vec<i16>>, dst_rate: u32) -> Self {
        Self {
            sender,
            resampler: Mutex::new(StereoResampler::new(dst_rate)),
        }
    }
}

impl std::fmt::Debug for PublishSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PublishSink").finish_non_exhaustive()
    }
}

impl ProcessedSampleSink for PublishSink {
    fn push_samples(&self, samples: &[f32], channels: usize, sample_rate: u32) {
        let mut out = Vec::new();
        if let Ok(mut resampler) = self.resampler.lock() {
            resampler.process(samples, channels, sample_rate, &mut out);
        }
        if !out.is_empty() {
            // Drop on backpressure rather than block the audio thread; bounds latency.
            let _ = self.sender.try_send(out);
        }
    }
}

struct PublishEntry {
    track_sid: livekit::prelude::TrackSid,
    sink: Arc<PublishSink>,
    drain: JoinHandle<()>,
}

// ---------------------------------------------------------------------------
// Receive path: output mixer playing all subscribed tracks
// ---------------------------------------------------------------------------

/// Short history of the mixed speaker signal. Microphone AEC reads this as the
/// render reference that the WebRTC APM needs before processing capture frames.
#[derive(Debug)]
pub struct RenderReference {
    samples: Mutex<VecDeque<f32>>,
    sample_rate: AtomicU32,
}

impl Default for RenderReference {
    fn default() -> Self {
        Self {
            samples: Mutex::new(VecDeque::new()),
            sample_rate: AtomicU32::new(48_000),
        }
    }
}

impl RenderReference {
    fn push_stereo(&self, interleaved_stereo: &[f32], sample_rate: u32) {
        if interleaved_stereo.is_empty() {
            return;
        }
        self.sample_rate.store(sample_rate, Ordering::Relaxed);
        let max_samples = (sample_rate as usize * PUBLISH_CHANNELS * 250) / 1000;
        if let Ok(mut guard) = self.samples.lock() {
            guard.extend(interleaved_stereo.iter().copied());
            if guard.len() > max_samples {
                let overflow = guard.len() - max_samples;
                guard.drain(0..overflow);
            }
        }
    }

    pub fn recent_frame(&self, channels: usize, sample_rate: u32, frames: usize) -> Vec<Vec<f32>> {
        let channels = channels.max(1);
        let mut out = vec![vec![0.0; frames]; channels];
        if frames == 0 {
            return out;
        }

        let stored_rate = self.sample_rate.load(Ordering::Relaxed).max(1);
        let needed_stored_frames = ((frames as u64 * stored_rate as u64)
            .div_ceil(sample_rate.max(1) as u64) as usize)
            .saturating_add(1);
        let recent: Vec<f32> = match self.samples.lock() {
            Ok(guard) => {
                let needed_samples = needed_stored_frames.saturating_mul(PUBLISH_CHANNELS);
                guard
                    .iter()
                    .rev()
                    .take(needed_samples)
                    .copied()
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect()
            }
            Err(_) => return out,
        };
        let available_frames = recent.len() / PUBLISH_CHANNELS;
        if available_frames == 0 {
            return out;
        }

        let rate_ratio = stored_rate as f64 / sample_rate.max(1) as f64;
        for frame in 0..frames {
            let src_pos = frame as f64 * rate_ratio;
            let src_idx = src_pos.floor() as usize;
            let frac = (src_pos - src_idx as f64) as f32;
            let a = src_idx.min(available_frames - 1) * PUBLISH_CHANNELS;
            let b = (src_idx + 1).min(available_frames - 1) * PUBLISH_CHANNELS;
            let left = recent[a] + (recent[b] - recent[a]) * frac;
            let right = recent[a + 1] + (recent[b + 1] - recent[a + 1]) * frac;
            for (channel, channel_out) in out.iter_mut().enumerate() {
                channel_out[frame] = if channels == 1 {
                    (left + right) * 0.5
                } else if channel == 0 {
                    left
                } else if channel == 1 {
                    right
                } else {
                    0.0
                };
            }
        }
        out
    }
}

/// Sums every subscribed remote track into the default output device. Each track owns a
/// queue of interleaved stereo f32 at [`OutputMixer::sample_rate`]; the output callback
/// pops one frame per track and sums.
pub struct OutputMixer {
    tracks: Arc<Mutex<HashMap<String, VecDeque<f32>>>>,
    render_reference: Arc<RenderReference>,
    running: Arc<AtomicBool>,
    sample_rate: Arc<AtomicU32>,
    selected_device_id: Arc<Mutex<Option<String>>>,
    worker: Mutex<Option<ThreadJoinHandle<()>>>,
}

impl std::fmt::Debug for OutputMixer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutputMixer")
            .field("sample_rate", &self.sample_rate.load(Ordering::Relaxed))
            .finish_non_exhaustive()
    }
}

impl OutputMixer {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            tracks: Arc::new(Mutex::new(HashMap::new())),
            render_reference: Arc::new(RenderReference::default()),
            running: Arc::new(AtomicBool::new(false)),
            sample_rate: Arc::new(AtomicU32::new(48_000)),
            selected_device_id: Arc::new(Mutex::new(None)),
            worker: Mutex::new(None),
        })
    }

    fn sample_rate(&self) -> u32 {
        self.sample_rate.load(Ordering::Relaxed)
    }

    pub fn render_reference(&self) -> Arc<RenderReference> {
        Arc::clone(&self.render_reference)
    }

    fn start(self: &Arc<Self>) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let selected_device_id = self
            .selected_device_id
            .lock()
            .ok()
            .and_then(|id| id.clone());
        let resolved = resolve_output_device(selected_device_id.as_deref());
        let rate = resolved
            .as_ref()
            .ok()
            .and_then(|(device, _)| device.default_output_config().ok())
            .map(|config| config.sample_rate().0)
            .unwrap_or(48_000);
        self.sample_rate.store(rate, Ordering::SeqCst);

        let tracks = Arc::clone(&self.tracks);
        let render_reference = Arc::clone(&self.render_reference);
        let running = Arc::clone(&self.running);
        let selected_device_id = Arc::clone(&self.selected_device_id);
        let worker = thread::spawn(move || {
            let device = resolved
                .ok()
                .map(|(device, selected)| {
                    if let Ok(mut guard) = selected_device_id.lock() {
                        *guard = selected;
                    }
                    device
                })
                .or_else(|| cpal::default_host().default_output_device());
            let Some(device) = device else {
                running.store(false, Ordering::SeqCst);
                return;
            };
            let config = cpal::StreamConfig {
                channels: PUBLISH_CHANNELS as u16,
                sample_rate: cpal::SampleRate(rate),
                buffer_size: cpal::BufferSize::Default,
            };
            let cb_tracks = Arc::clone(&tracks);
            let cb_render_reference = Arc::clone(&render_reference);
            let stream = device.build_output_stream(
                &config,
                move |data: &mut [f32], _| {
                    {
                        let mut guard = match cb_tracks.lock() {
                            Ok(guard) => guard,
                            Err(_) => {
                                data.fill(0.0);
                                return;
                            }
                        };
                        for frame in data.chunks_mut(PUBLISH_CHANNELS) {
                            let mut left = 0.0_f32;
                            let mut right = 0.0_f32;
                            for queue in guard.values_mut() {
                                if let Some(sample) = queue.pop_front() {
                                    left += sample;
                                }
                                if let Some(sample) = queue.pop_front() {
                                    right += sample;
                                }
                            }
                            if let [l, r, ..] = frame {
                                *l = left.clamp(-1.0, 1.0);
                                *r = right.clamp(-1.0, 1.0);
                            }
                        }
                    };
                    cb_render_reference.push_stereo(data, rate);
                },
                |error| {
                    eprintln!("[audio-engine] output stream error: {error}");
                },
                None,
            );
            let stream = match stream {
                Ok(stream) => stream,
                Err(error) => {
                    eprintln!("[audio-engine] failed to open output stream: {error}");
                    running.store(false, Ordering::SeqCst);
                    return;
                }
            };
            let _ = stream.play();
            while running.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(100));
            }
            // `stream` is dropped here, stopping playback.
        });
        *self.worker.lock().unwrap() = Some(worker);
    }

    fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.worker.lock().unwrap().take() {
            let _ = handle.join();
        }
        self.tracks.lock().unwrap().clear();
    }

    fn restart_if_running(self: &Arc<Self>) {
        if !self.running.load(Ordering::SeqCst) {
            return;
        }
        self.stop();
        self.start();
    }

    fn set_device(
        self: &Arc<Self>,
        device_id: Option<String>,
    ) -> Result<Option<AudioOutputDevice>, String> {
        let normalized = device_id.and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        });
        if let Some(id) = normalized.as_deref() {
            let devices = list_output_devices();
            let selected = devices
                .into_iter()
                .find(|device| device.device_id == id)
                .ok_or_else(|| "Speaker is no longer available.".to_string())?;
            resolve_output_device(Some(&selected.device_id))?;
            *self
                .selected_device_id
                .lock()
                .map_err(|_| "Audio output state is unavailable.".to_string())? =
                Some(selected.device_id.clone());
            self.restart_if_running();
            Ok(Some(selected))
        } else {
            resolve_output_device(None)?;
            *self
                .selected_device_id
                .lock()
                .map_err(|_| "Audio output state is unavailable.".to_string())? = None;
            self.restart_if_running();
            Ok(default_output_device())
        }
    }

    fn selected_device(&self) -> Option<AudioOutputDevice> {
        let selected = self
            .selected_device_id
            .lock()
            .ok()
            .and_then(|id| id.clone());
        selected
            .as_deref()
            .and_then(output_device_by_id)
            .or_else(default_output_device)
    }

    fn play_test_tone(&self, device_id: Option<String>) -> Result<(), String> {
        let target = device_id
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                self.selected_device_id
                    .lock()
                    .ok()
                    .and_then(|id| id.clone())
            });
        play_test_tone_on_device(target.as_deref())
    }

    fn ensure_track(&self, key: &str) {
        self.tracks
            .lock()
            .unwrap()
            .entry(key.to_string())
            .or_default();
    }

    fn push(&self, key: &str, stereo: &[f32]) {
        let mut guard = self.tracks.lock().unwrap();
        let queue = guard.entry(key.to_string()).or_default();
        if queue.len() > MIX_MAX_SAMPLES {
            let overflow = queue.len() - MIX_MAX_SAMPLES;
            queue.drain(0..overflow);
        }
        queue.extend(stereo.iter().copied());
    }

    fn remove_track(&self, key: &str) {
        self.tracks.lock().unwrap().remove(key);
    }
}

fn default_output_device() -> Option<AudioOutputDevice> {
    list_output_devices()
        .into_iter()
        .find(|device| device.is_default)
        .or_else(|| list_output_devices().into_iter().next())
}

fn output_device_by_id(device_id: &str) -> Option<AudioOutputDevice> {
    list_output_devices()
        .into_iter()
        .find(|device| device.device_id == device_id)
}

fn resolve_output_device(device_id: Option<&str>) -> Result<(Device, Option<String>), String> {
    let host = cpal::default_host();
    if let Some(device_id) = device_id {
        let target = output_device_by_id(device_id)
            .ok_or_else(|| "Selected speaker is no longer available.".to_string())?;
        let devices = host
            .output_devices()
            .map_err(|error| format!("Speakers could not be enumerated: {error}"))?;
        for device in devices {
            let name = device.name().ok();
            if name.as_deref() == Some(target.name.as_str())
                || name.as_deref() == Some(target.device_id.as_str())
            {
                return Ok((device, Some(target.device_id)));
            }
        }
        return Err(format!(
            "Selected speaker `{}` could not be opened by the playback backend.",
            target.name
        ));
    }
    host.default_output_device()
        .map(|device| (device, None))
        .ok_or_else(|| "No default speaker is available.".to_string())
}

#[cfg(test)]
mod output_device_tests {
    use super::resolve_output_device;

    #[test]
    fn an_unknown_selected_speaker_is_rejected_instead_of_using_the_default() {
        let result = resolve_output_device(Some("raven-test-device-that-does-not-exist"));
        assert!(result.is_err());
    }
}

fn play_test_tone_on_device(device_id: Option<&str>) -> Result<(), String> {
    let (device, _) = resolve_output_device(device_id)?;
    let config = device
        .default_output_config()
        .map_err(|error| format!("Speaker could not be opened: {error}"))?;
    let sample_rate = config.sample_rate().0 as f32;
    let channels = config.channels().max(1) as usize;
    let duration = Duration::from_millis(420);
    let total_frames = (sample_rate * duration.as_secs_f32()).round() as usize;
    let frame_index = Arc::new(AtomicU32::new(0));
    let frame_counter = Arc::clone(&frame_index);
    let err_fn = |error| eprintln!("[audio-engine] test sound stream error: {error}");
    let stream = device
        .build_output_stream(
            &cpal::StreamConfig {
                channels: channels as u16,
                sample_rate: config.sample_rate(),
                buffer_size: cpal::BufferSize::Default,
            },
            move |data: &mut [f32], _| {
                for frame in data.chunks_mut(channels) {
                    let n = frame_counter.fetch_add(1, Ordering::Relaxed) as usize;
                    let progress = (n as f32 / total_frames.max(1) as f32).clamp(0.0, 1.0);
                    let envelope = if progress < 0.08 {
                        progress / 0.08
                    } else if progress > 0.86 {
                        ((1.0 - progress) / 0.14).clamp(0.0, 1.0)
                    } else {
                        1.0
                    };
                    let sample = if n < total_frames {
                        (TAU * 660.0 * n as f32 / sample_rate).sin() * 0.18 * envelope
                    } else {
                        0.0
                    };
                    for channel in frame {
                        *channel = sample;
                    }
                }
            },
            err_fn,
            None,
        )
        .map_err(|error| format!("Test sound could not start: {error}"))?;
    stream
        .play()
        .map_err(|error| format!("Test sound could not play: {error}"))?;
    thread::sleep(duration + Duration::from_millis(80));
    drop(stream);
    Ok(())
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

struct RoomConnection {
    room: Arc<Room>,
    event_loop: JoinHandle<()>,
    readers: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
}

/// The audio media engine. Stored inside `AudioEngineState` next to the capture manager.
pub struct AudioEngine {
    runtime: Option<Runtime>,
    connection: Option<RoomConnection>,
    publications: HashMap<AudioSourceId, PublishEntry>,
    output: Arc<OutputMixer>,
    receive_remote_audio: Arc<AtomicBool>,
    /// Last participant-metadata JSON we pushed, so we only re-send on change.
    published_meta: String,
}

impl std::fmt::Debug for AudioEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioEngine")
            .field("connected", &self.connection.is_some())
            .field("publications", &self.publications.len())
            .finish_non_exhaustive()
    }
}

impl Default for AudioEngine {
    fn default() -> Self {
        Self {
            runtime: None,
            connection: None,
            publications: HashMap::new(),
            output: OutputMixer::new(),
            receive_remote_audio: Arc::new(AtomicBool::new(true)),
            published_meta: String::new(),
        }
    }
}

impl AudioEngine {
    fn runtime(&mut self) -> &Runtime {
        if self.runtime.is_none() {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("failed to build audio engine tokio runtime");
            self.runtime = Some(runtime);
        }
        self.runtime.as_ref().unwrap()
    }

    pub fn is_connected(&self) -> bool {
        self.connection.is_some()
    }

    pub fn connected_room(&self) -> Option<Arc<Room>> {
        self.connection
            .as_ref()
            .map(|connection| Arc::clone(&connection.room))
    }

    /// Connect the audio sidecar to a LiveKit room. Blocks briefly on the network
    /// handshake (called from a synchronous Tauri command thread).
    pub fn connect(
        &mut self,
        app: &AppHandle,
        shared: &SharedAudioEngineState,
        url: &str,
        token: &str,
    ) -> Result<(), String> {
        if self.connection.is_some() {
            self.disconnect();
        }
        self.published_meta.clear();
        self.output.start();

        let mut options = RoomOptions::default();
        // Subscribe selectively in the event loop. The audio sidecar must never receive
        // video tracks or another sidecar belonging to the same user.
        options.auto_subscribe = false;
        let (room, events) = {
            let runtime = self.runtime();
            runtime
                .block_on(Room::connect(url, token, options))
                .map_err(|error| error.to_string())?
        };
        let room = Arc::new(room);
        let local_identity =
            base_participant_identity(&room.local_participant().identity().0).to_string();

        let readers: Arc<Mutex<HashMap<String, JoinHandle<()>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let event_loop = self.spawn_event_loop(app, shared, events, &readers, local_identity);

        self.connection = Some(RoomConnection {
            room,
            event_loop,
            readers,
        });
        Ok(())
    }

    pub fn disconnect(&mut self) {
        // Stop publishing.
        for (_, entry) in self.publications.drain() {
            entry.drain.abort();
        }
        if let Some(connection) = self.connection.take() {
            connection.event_loop.abort();
            for (_, reader) in connection.readers.lock().unwrap().drain() {
                reader.abort();
            }
            let room = connection.room.clone();
            if let Some(runtime) = self.runtime.as_ref() {
                let _ = runtime.block_on(room.close());
            }
        }
        self.output.stop();
    }

    pub fn render_reference(&self) -> Arc<RenderReference> {
        self.output.render_reference()
    }

    pub fn set_output_device(
        &mut self,
        device_id: Option<String>,
    ) -> Result<Option<AudioOutputDevice>, String> {
        self.output.set_device(device_id)
    }

    pub fn selected_output_device(&self) -> Option<AudioOutputDevice> {
        self.output.selected_device()
    }

    pub fn play_test_tone(&self, device_id: Option<String>) -> Result<(), String> {
        self.output.play_test_tone(device_id)
    }

    pub fn set_remote_audio_receiving(&mut self, enabled: bool) {
        self.receive_remote_audio.store(enabled, Ordering::SeqCst);
        let subscription_updates = if let Some(connection) = self.connection.as_ref() {
            let local_identity =
                base_participant_identity(&connection.room.local_participant().identity().0)
                    .to_string();
            let mut updates = Vec::new();
            for participant in connection.room.remote_participants().values() {
                let is_self_sidecar =
                    base_participant_identity(&participant.identity().0) == local_identity.as_str();
                for publication in participant.track_publications().values() {
                    let should_subscribe =
                        enabled && !is_self_sidecar && publication.kind() == TrackKind::Audio;
                    if publication.is_desired() != should_subscribe {
                        updates.push((publication.clone(), should_subscribe));
                    }
                }
            }
            updates
        } else {
            Vec::new()
        };

        if subscription_updates.is_empty() {
            return;
        }

        within_runtime_context(self.runtime(), || {
            for (publication, should_subscribe) in subscription_updates {
                publication.set_subscribed(should_subscribe);
            }
        });
    }

    /// Sink map handed to the capture manager so it knows where to push processed PCM.
    pub fn sink_map(&self) -> HashMap<AudioSourceId, Arc<dyn ProcessedSampleSink>> {
        self.publications
            .iter()
            .map(|(id, entry)| (*id, Arc::clone(&entry.sink) as Arc<dyn ProcessedSampleSink>))
            .collect()
    }

    /// Reconcile published LiveKit tracks against which local sources are marked
    /// `publishing`. Called under the state write lock after every mutation.
    pub fn reconcile_publications(&mut self, sources: &[AudioSourceState]) -> Result<(), String> {
        let Some(connection) = self.connection.as_ref() else {
            // Not connected: nothing can be published.
            for (_, entry) in self.publications.drain() {
                entry.drain.abort();
            }
            return Ok(());
        };
        let room = Arc::clone(&connection.room);

        let desired: HashMap<AudioSourceId, &AudioSourceState> = sources
            .iter()
            .filter(|source| source.publishing)
            .map(|source| (source.id, source))
            .collect();

        // Unpublish sources that are no longer publishing.
        let stale: Vec<AudioSourceId> = self
            .publications
            .keys()
            .copied()
            .filter(|id| !desired.contains_key(id))
            .collect();
        for id in stale {
            if let Some(entry) = self.publications.remove(&id) {
                entry.drain.abort();
                let room = Arc::clone(&room);
                let sid = entry.track_sid.clone();
                if let Some(runtime) = self.runtime.as_ref() {
                    let _ = runtime.block_on(room.local_participant().unpublish_track(&sid));
                }
            }
        }

        // Publish newly-publishing sources.
        let to_publish: Vec<AudioSourceState> = desired
            .values()
            .filter(|source| !self.publications.contains_key(&source.id))
            .map(|source| (*source).clone())
            .collect();
        let mut first_error = None;
        for source in to_publish {
            if let Err(error) = self.publish_source(&room, &source) {
                eprintln!("[audio-engine] publish failed for {}: {error}", source.id);
                first_error.get_or_insert_with(|| {
                    format!("could not publish audio source {}: {error}", source.id)
                });
            }
        }

        // Share each published track's source type + human name with peers via participant
        // metadata, so their Incoming Tracks show what we're actually sending. Only re-send
        // when it changes (this runs on every mixer mutation, incl. fader ticks).
        let meta: HashMap<String, SharedTrackMeta> = sources
            .iter()
            .filter(|source| source.publishing)
            .filter_map(|source| {
                source.published_track.as_ref().map(|track| {
                    (
                        track.track_id.to_string(),
                        SharedTrackMeta {
                            source_type: source.source_type.clone(),
                            display_name: source.display_name.clone(),
                            device_name: source.runtime.device_name.clone(),
                            app_name: (source.source_type == AudioSourceType::AppAudio)
                                .then(|| source.display_name.clone()),
                            app_exe_name: None,
                            app_icon_data_url: None,
                        },
                    )
                })
            })
            .collect();
        if let Ok(json) = serde_json::to_string(&meta) {
            if json != self.published_meta {
                if let Some(runtime) = self.runtime.as_ref() {
                    match runtime.block_on(room.local_participant().set_metadata(json.clone())) {
                        Ok(()) => {
                            self.published_meta = json;
                        }
                        Err(error) => {
                            eprintln!("[audio-engine] failed to publish track metadata: {error}");
                        }
                    }
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn publish_source(
        &mut self,
        room: &Arc<Room>,
        source: &AudioSourceState,
    ) -> Result<(), String> {
        let track_id = source
            .published_track
            .as_ref()
            .map(|track| track.track_id)
            .unwrap_or_else(PublishedTrackId::new);
        let webrtc_track_id = stable_webrtc_track_id(track_id);

        let processing = &source.channel_strip.webrtc_processing;
        let options = AudioSourceOptions {
            echo_cancellation: processing.echo_cancellation,
            noise_suppression: processing.noise_suppression,
            auto_gain_control: processing.auto_gain_control,
        };
        let output_rate = self.output.sample_rate();
        let native = NativeAudioSource::new(options, output_rate, PUBLISH_CHANNELS as u32, 1000);
        let track = LocalAudioTrack::create_audio_track(
            &webrtc_track_id,
            RtcAudioSource::Native(native.clone()),
        );

        let publish_options = TrackPublishOptions {
            source: lk_track_source(&source.source_type),
            stream: format!("raven-source-{}", source.id),
            ..Default::default()
        };

        let (sender, mut receiver) = mpsc::channel::<Vec<i16>>(64);
        let sink = Arc::new(PublishSink::new(sender, output_rate));

        let runtime = self.runtime();
        let publication = runtime
            .block_on(
                room.local_participant()
                    .publish_track(LocalTrack::Audio(track), publish_options),
            )
            .map_err(|error| error.to_string())?;
        let track_sid = publication.sid();

        let drain = runtime.spawn(async move {
            while let Some(chunk) = receiver.recv().await {
                let samples_per_channel = (chunk.len() / PUBLISH_CHANNELS) as u32;
                if samples_per_channel == 0 {
                    continue;
                }
                let frame = AudioFrame {
                    data: chunk.into(),
                    sample_rate: output_rate,
                    num_channels: PUBLISH_CHANNELS as u32,
                    samples_per_channel,
                };
                if native.capture_frame(&frame).await.is_err() {
                    break;
                }
            }
        });

        self.publications.insert(
            source.id,
            PublishEntry {
                track_sid,
                sink,
                drain,
            },
        );
        Ok(())
    }

    fn spawn_event_loop(
        &mut self,
        app: &AppHandle,
        shared: &SharedAudioEngineState,
        mut events: mpsc::UnboundedReceiver<RoomEvent>,
        readers: &Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
        local_identity: String,
    ) -> JoinHandle<()> {
        let app = app.clone();
        let shared = Arc::clone(shared);
        let readers = Arc::clone(readers);
        let output = Arc::clone(&self.output);
        let receive_remote_audio = Arc::clone(&self.receive_remote_audio);
        let runtime_handle = self.runtime().handle().clone();

        self.runtime().spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    RoomEvent::TrackPublished {
                        publication,
                        participant,
                    } => {
                        let is_self_sidecar =
                            base_participant_identity(&participant.identity().0) == local_identity;
                        let should_subscribe = receive_remote_audio.load(Ordering::SeqCst)
                            && !is_self_sidecar
                            && publication.kind() == TrackKind::Audio;
                        publication.set_subscribed(should_subscribe);
                    }
                    RoomEvent::TrackSubscribed {
                        track,
                        publication,
                        participant,
                    } => {
                        let RemoteTrack::Audio(audio_track) = track else {
                            continue;
                        };
                        if !receive_remote_audio.load(Ordering::SeqCst) {
                            publication.set_subscribed(false);
                            continue;
                        }
                        let name = publication.name();
                        let Some(uuid) = name.strip_prefix("raven-audio-") else {
                            continue; // not a Raven-managed audio track
                        };
                        let identity = participant.identity().0;
                        let base = identity
                            .strip_suffix("#audio")
                            .unwrap_or(&identity)
                            .to_string();
                        let (Some(participant_id), Some(track_id), Some(source_id)) = (
                            ParticipantId::parse(&base),
                            PublishedTrackId::parse(uuid),
                            AudioSourceId::parse(uuid),
                        ) else {
                            continue;
                        };
                        // Prefer the owner-shared metadata (precise type + human name);
                        // fall back to the coarse LiveKit source + the participant name.
                        let shared_meta = parse_shared_meta(&participant.metadata());
                        let track_meta = shared_meta.get(uuid);
                        let owner_name = participant.name();
                        let source_type = track_meta
                            .map(|meta| meta.source_type.clone())
                            .unwrap_or_else(|| audio_source_from_lk(publication.source()));
                        let display_name = track_meta
                            .map(|meta| meta.display_name.clone())
                            .filter(|name| !name.is_empty())
                            .unwrap_or_else(|| {
                                if owner_name.is_empty() {
                                    base.clone()
                                } else {
                                    owner_name.clone()
                                }
                            });
                        let device_name = track_meta.and_then(|meta| meta.device_name.clone());
                        let app_name = track_meta.and_then(|meta| meta.app_name.clone());
                        let app_exe_name = track_meta.and_then(|meta| meta.app_exe_name.clone());
                        let app_icon_data_url =
                            track_meta.and_then(|meta| meta.app_icon_data_url.clone());

                        register_remote_track(
                            &app,
                            &shared,
                            source_id,
                            participant_id,
                            track_id,
                            source_type,
                            display_name,
                            device_name,
                            app_name,
                            app_exe_name,
                            app_icon_data_url,
                            name.clone(),
                            publication.is_muted(),
                            owner_name,
                        );

                        let key = reader_key(&base, &track_id.to_string());
                        output.ensure_track(&key);
                        let rtc_track = audio_track.rtc_track();
                        let rate = output.sample_rate();
                        let mut stream =
                            NativeAudioStream::new(rtc_track, rate as i32, PUBLISH_CHANNELS as i32);
                        let reader_output = Arc::clone(&output);
                        let reader_shared = Arc::clone(&shared);
                        let reader_app = app.clone();
                        let reader_key_str = key.clone();
                        let reader = runtime_handle.spawn(async move {
                            let mut meter_accum: Vec<f32> = Vec::new();
                            let mut last_meter = Instant::now();
                            let mut receiver_controls =
                                (1.0_f32, false, ProcessorChainState::default());
                            let mut last_control_refresh =
                                Instant::now() - RECEIVER_CONTROL_REFRESH_INTERVAL;
                            // This peer's own processor chain for the incoming track, rebuilt
                            // when the chain definition changes (a small click on edits, same as
                            // the send path). Applied locally — it never affects other peers.
                            let mut chain: Option<ProcessorChainRuntime> = None;
                            let mut chain_def = ProcessorChainState::default();
                            while let Some(frame) = stream.next().await {
                                if last_control_refresh.elapsed()
                                    >= RECEIVER_CONTROL_REFRESH_INTERVAL
                                {
                                    if let Some(snapshot) = try_receiver_snapshot(
                                        &reader_shared,
                                        participant_id,
                                        track_id,
                                    ) {
                                        receiver_controls = snapshot;
                                    }
                                    last_control_refresh = Instant::now();
                                }
                                let (gain, muted, def) = receiver_controls.clone();
                                let scale = if muted { 0.0 } else { gain };
                                let mut samples: Vec<f32> = frame
                                    .data
                                    .iter()
                                    .map(|sample| (*sample as f32 / 32768.0) * scale)
                                    .collect();

                                if chain.is_none() || def != chain_def {
                                    chain = ProcessorChainRuntime::from_state(&def).ok();
                                    if let Some(runtime) = chain.as_mut() {
                                        let _ = runtime.prepare(AudioProcessorPrepareConfig::new(
                                            rate,
                                            PUBLISH_CHANNELS,
                                            RECEIVER_MAX_BLOCK,
                                        ));
                                    }
                                    chain_def = def;
                                }
                                if let Some(runtime) = chain.as_mut() {
                                    if let Ok(mut audio) = AudioBuffer::from_interleaved(
                                        PUBLISH_CHANNELS,
                                        std::mem::take(&mut samples),
                                    ) {
                                        let _ = runtime.process(&mut audio);
                                        samples = audio.into_samples();
                                    }
                                }

                                reader_output.push(&reader_key_str, &samples);
                                // Meter exactly what we play out so the Incoming Tracks strip
                                // tracks the received signal (post receiver gain / chain / mute).
                                meter_accum.extend_from_slice(&samples);
                                if last_meter.elapsed() >= METER_INTERVAL {
                                    let meter = meter_samples(&meter_accum);
                                    update_remote_meter(
                                        &reader_app,
                                        &reader_shared,
                                        participant_id,
                                        track_id,
                                        meter,
                                    );
                                    meter_accum.clear();
                                    last_meter = Instant::now();
                                }
                            }
                            reader_output.remove_track(&reader_key_str);
                        });
                        readers.lock().unwrap().insert(key, reader);
                    }
                    RoomEvent::TrackUnsubscribed {
                        publication,
                        participant,
                        ..
                    } => {
                        let name = publication.name();
                        let Some(uuid) = name.strip_prefix("raven-audio-") else {
                            continue;
                        };
                        let identity = participant.identity().0;
                        let base = identity
                            .strip_suffix("#audio")
                            .unwrap_or(&identity)
                            .to_string();
                        if let (Some(participant_id), Some(track_id)) =
                            (ParticipantId::parse(&base), PublishedTrackId::parse(uuid))
                        {
                            let key = reader_key(&base, &track_id.to_string());
                            if let Some(reader) = readers.lock().unwrap().remove(&key) {
                                reader.abort();
                            }
                            output.remove_track(&key);
                            unregister_remote_track(&app, &shared, participant_id, track_id);
                        }
                    }
                    RoomEvent::ParticipantDisconnected(participant) => {
                        let identity = participant.identity().0;
                        let base = identity
                            .strip_suffix("#audio")
                            .unwrap_or(&identity)
                            .to_string();
                        if let Some(participant_id) = ParticipantId::parse(&base) {
                            let prefix = format!("{base}|");
                            let removed: Vec<String> = readers
                                .lock()
                                .unwrap()
                                .keys()
                                .filter(|key| key.starts_with(&prefix))
                                .cloned()
                                .collect();
                            for key in removed {
                                if let Some(reader) = readers.lock().unwrap().remove(&key) {
                                    reader.abort();
                                }
                                output.remove_track(&key);
                            }
                            unregister_participant(&app, &shared, participant_id);
                        }
                    }
                    RoomEvent::ParticipantMetadataChanged {
                        participant,
                        metadata,
                        ..
                    } => {
                        // A peer (re)published its shared track metadata; enrich any of their
                        // already-subscribed tracks and refresh the group's display name.
                        let identity = participant.identity().0;
                        let base = identity
                            .strip_suffix("#audio")
                            .unwrap_or(&identity)
                            .to_string();
                        if let Some(participant_id) = ParticipantId::parse(&base) {
                            apply_participant_metadata(
                                &app,
                                &shared,
                                participant_id,
                                participant.name(),
                                &parse_shared_meta(&metadata),
                            );
                        }
                    }
                    _ => {}
                }
            }
        })
    }
}

fn apply_participant_metadata(
    app: &AppHandle,
    shared: &SharedAudioEngineState,
    participant_id: ParticipantId,
    owner_name: String,
    meta: &HashMap<String, SharedTrackMeta>,
) {
    let snapshot = {
        let Ok(mut guard) = shared.write() else {
            return;
        };
        guard.set_remote_owner_name(participant_id, owner_name);
        for (uuid, track_meta) in meta {
            if let Some(track_id) = PublishedTrackId::parse(uuid) {
                guard.update_remote_track_meta(
                    participant_id,
                    track_id,
                    track_meta.source_type.clone(),
                    track_meta.display_name.clone(),
                    track_meta.device_name.clone(),
                    track_meta.app_name.clone(),
                    track_meta.app_exe_name.clone(),
                    track_meta.app_icon_data_url.clone(),
                );
            }
        }
        guard.snapshot()
    };
    let _ = app.emit(AUDIO_STATE_CHANGED_EVENT, snapshot);
}

fn reader_key(base_identity: &str, track_id: &str) -> String {
    format!("{base_identity}|{track_id}")
}

/// Snapshot the receiver's local settings for a remote track — each peer's own gain, mute,
/// and processor chain, applied *after* the publisher's chain and local only to this peer.
fn try_receiver_snapshot(
    shared: &SharedAudioEngineState,
    participant_id: ParticipantId,
    track_id: PublishedTrackId,
) -> Option<(f32, bool, ProcessorChainState)> {
    let Ok(guard) = shared.try_read() else {
        return None;
    };
    for track in &guard.mixer.remote_tracks {
        if track.track.participant_id == participant_id && track.track.track_id == track_id {
            let strip = &track.receiver_channel_strip;
            return Some((
                db_to_linear(strip.gain_db),
                strip.mute.muted,
                strip.processor_chain.clone(),
            ));
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn register_remote_track(
    app: &AppHandle,
    shared: &SharedAudioEngineState,
    source_id: AudioSourceId,
    participant_id: ParticipantId,
    track_id: PublishedTrackId,
    source_type: AudioSourceType,
    display_name: String,
    device_name: Option<String>,
    app_name: Option<String>,
    app_exe_name: Option<String>,
    app_icon_data_url: Option<String>,
    webrtc_track_id: String,
    muted: bool,
    owner_name: String,
) {
    let snapshot = {
        let Ok(mut guard) = shared.write() else {
            return;
        };
        guard.set_remote_owner_name(participant_id, owner_name);
        let mut metadata =
            PublishedTrackMetadata::new(source_id, participant_id, source_type, display_name);
        metadata.track_id = track_id;
        metadata.device_name = device_name;
        metadata.app_name = app_name;
        metadata.app_exe_name = app_exe_name;
        metadata.app_icon_data_url = app_icon_data_url;
        metadata.webrtc_track_id = Some(webrtc_track_id);
        metadata.muted = muted;
        guard.add_or_update_remote_track(metadata);
        guard.snapshot()
    };
    let _ = app.emit(AUDIO_STATE_CHANGED_EVENT, snapshot);
}

fn unregister_remote_track(
    app: &AppHandle,
    shared: &SharedAudioEngineState,
    participant_id: ParticipantId,
    track_id: PublishedTrackId,
) {
    let snapshot = {
        let Ok(mut guard) = shared.write() else {
            return;
        };
        let _ = guard.remove_remote_track(participant_id, track_id);
        guard.snapshot()
    };
    let _ = app.emit(AUDIO_STATE_CHANGED_EVENT, snapshot);
}

fn unregister_participant(
    app: &AppHandle,
    shared: &SharedAudioEngineState,
    participant_id: ParticipantId,
) {
    let snapshot = {
        let Ok(mut guard) = shared.write() else {
            return;
        };
        guard.remove_remote_participant(participant_id);
        guard.snapshot()
    };
    let _ = app.emit(AUDIO_STATE_CHANGED_EVENT, snapshot);
}

fn update_remote_meter(
    app: &AppHandle,
    shared: &SharedAudioEngineState,
    participant_id: ParticipantId,
    track_id: PublishedTrackId,
    meter: MeterState,
) {
    {
        let Ok(mut guard) = shared.try_write() else {
            return;
        };
        guard.set_remote_track_meter(participant_id, track_id, meter.clone());
    }
    let _ = app.emit(
        AUDIO_METER_CHANGED_EVENT,
        AudioMeterUpdate::remote(participant_id, track_id, meter),
    );
}
