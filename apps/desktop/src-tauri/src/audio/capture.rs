use std::{
    collections::{HashMap, HashSet},
    f32::consts::TAU,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};
use serde::Serialize;
use sonora::config::{
    AdaptiveDigital, EchoCanceller, FixedDigital, GainController2, HighPassFilter, NoiseSuppression,
};
use sonora::{AudioProcessing, Config as ApmConfig, StreamConfig};
use tauri::{AppHandle, Emitter};
use thiserror::Error;

use crate::audio::domain::{
    AudioInputDevice, AudioMeterUpdate, AudioOutputDevice, AudioSampleFormat, AudioSourceId,
    AudioSourceRuntimeState, AudioSourceRuntimeStatus, AudioSourceState, AudioSourceType, GainDb,
    MeterState, ProcessorChainState, WebRtcAudioProcessingSettings,
};
use crate::audio::engine::{RenderCursor, RenderReference};
use crate::audio::processor::{AudioBuffer, AudioProcessorPrepareConfig, ProcessorChainRuntime};
use crate::audio::safety::{
    chain_cpu_estimate, chain_latency_samples, db_to_linear, ChannelSafetyAnalysis,
    ChannelSafetyRuntime,
};
use crate::audio::state::{
    SharedAudioEngineState, AUDIO_METER_CHANGED_EVENT, AUDIO_STATE_CHANGED_EVENT,
};

const METER_INTERVAL: Duration = Duration::from_millis(120);
const CAPTURE_EVENT_CAPACITY: usize = 16;
/// Backoff between attempts to reopen a capture device that failed mid-session. The last
/// delay repeats until the device works again or the source is stopped.
const CAPTURE_RETRY_DELAYS: [Duration; 3] = [
    Duration::from_millis(250),
    Duration::from_secs(1),
    Duration::from_secs(3),
];
const CAPTURE_SUPERVISE_TICK: Duration = Duration::from_millis(100);
/// Upper bound the processor chain is prepared for. Capture callbacks vary in size and
/// are never close to this; it only has to be larger than any real block.
const CAPTURE_MAX_BLOCK_FRAMES: usize = 1 << 20;
/// Fastest the fader / mute gain may move, in gain units per millisecond. Reaching
/// silence from unity takes 4 ms: quick enough to feel instant, slow enough not to click.
const FADER_SLEW_PER_MS: f32 = 0.25;
/// Most render frames fed to the echo canceller per capture frame while catching up.
const MAX_RENDER_FRAMES_PER_CAPTURE: usize = 8;
/// How often a running capture checks whether the default device moved or a missing
/// preferred device came back.
const CAPTURE_DEVICE_PROBE_INTERVAL: Duration = Duration::from_secs(2);
const TEST_TONE_SAMPLE_RATE: u32 = 48_000;
const TEST_TONE_CHANNELS: u16 = 1;
const TEST_TONE_BLOCK_FRAMES: usize = 960;

/// Destination for fully-processed capture PCM. Implemented by the media engine's
/// publish sink. Capture pushes from the real-time audio thread, so implementations
/// must be cheap and non-blocking.
pub trait ProcessedSampleSink: Send + Sync {
    fn push_samples(&self, samples: &[f32], channels: usize, sample_rate: u32);
}

/// Live, lock-light per-source controls the capture thread reads every block. Keeping
/// gain/mute here (instead of baking them into the capture config) lets the fader and
/// mute update the transmitted audio in real time without restarting capture, and lets
/// a publish sink be attached/detached as the source is published/unpublished.
#[derive(Default)]
pub struct LiveControls {
    gain_bits: AtomicU32,
    muted: AtomicBool,
    /// Safety-limiter ceiling in dB.
    ceiling_bits: AtomicU32,
    /// The processor chain as last edited, and a counter the capture thread compares to
    /// notice an edit. Applying edits on the capture thread means moving a knob never
    /// reopens the device.
    chain: Mutex<ProcessorChainState>,
    chain_version: AtomicU64,
    sink: Mutex<Option<Arc<dyn ProcessedSampleSink>>>,
}

impl std::fmt::Debug for LiveControls {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveControls")
            .field("gain_linear", &self.gain_linear())
            .field("muted", &self.is_muted())
            .finish_non_exhaustive()
    }
}

impl LiveControls {
    fn new(gain_linear: f32, muted: bool) -> Arc<Self> {
        let controls = Arc::new(Self::default());
        controls.set_gain_linear(gain_linear);
        controls.set_muted(muted);
        controls.set_safety_ceiling_db(GainDb::new(-1.0));
        controls
    }

    fn set_safety_ceiling_db(&self, ceiling: GainDb) {
        self.ceiling_bits
            .store(ceiling.0.to_bits(), Ordering::Relaxed);
    }

    fn safety_ceiling_db(&self) -> GainDb {
        GainDb::new(f32::from_bits(self.ceiling_bits.load(Ordering::Relaxed)))
    }

    /// Publish an edited chain to the capture thread. A no-op when nothing changed, so it
    /// can be called on every reconcile.
    fn set_chain(&self, chain: &ProcessorChainState) {
        if let Ok(mut current) = self.chain.lock() {
            if *current != *chain {
                *current = chain.clone();
                self.chain_version.fetch_add(1, Ordering::Release);
            }
        }
    }

    fn chain_version(&self) -> u64 {
        self.chain_version.load(Ordering::Acquire)
    }

    fn chain(&self) -> Option<ProcessorChainState> {
        self.chain.lock().ok().map(|chain| chain.clone())
    }

    fn set_gain_linear(&self, gain: f32) {
        self.gain_bits.store(gain.to_bits(), Ordering::Relaxed);
    }

    fn gain_linear(&self) -> f32 {
        f32::from_bits(self.gain_bits.load(Ordering::Relaxed))
    }

    fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }

    fn is_muted(&self) -> bool {
        self.muted.load(Ordering::Relaxed)
    }

    fn set_sink(&self, sink: Option<Arc<dyn ProcessedSampleSink>>) {
        if let Ok(mut guard) = self.sink.lock() {
            *guard = sink;
        }
    }

    fn push_to_sink(&self, samples: &[f32], channels: usize, sample_rate: u32) {
        if let Ok(guard) = self.sink.lock() {
            if let Some(sink) = guard.as_ref() {
                sink.push_samples(samples, channels, sample_rate);
            }
        }
    }
}

#[derive(Debug, Default)]
pub struct CaptureRuntimeManager {
    runtimes: HashMap<AudioSourceId, Box<dyn AudioSourceRuntime>>,
    live: HashMap<AudioSourceId, Arc<LiveControls>>,
}

/// What a [`CaptureRuntimeManager::reconcile`] pass changed. The caller merges
/// `runtime_updates` back into the mixer model under a short state lock; reconcile itself
/// runs without that lock because opening a device can take hundreds of milliseconds.
#[derive(Debug, Default)]
pub struct CaptureReconcileOutcome {
    pub runtime_updates: Vec<(AudioSourceId, AudioSourceRuntimeState)>,
    pub first_error: Option<String>,
}

impl CaptureRuntimeManager {
    pub fn reconcile(
        &mut self,
        app: &AppHandle,
        shared_state: SharedAudioEngineState,
        sources: &[AudioSourceState],
        sinks: &HashMap<AudioSourceId, Arc<dyn ProcessedSampleSink>>,
        render_reference: Arc<RenderReference>,
    ) -> CaptureReconcileOutcome {
        let mut outcome = CaptureReconcileOutcome::default();
        let desired_ids: HashSet<_> = sources
            .iter()
            .filter(|source| should_capture_source(source))
            .map(|source| source.id)
            .collect();

        let existing_ids: Vec<_> = self.runtimes.keys().copied().collect();
        for source_id in existing_ids {
            if !desired_ids.contains(&source_id) {
                if let Some(mut runtime) = self.runtimes.remove(&source_id) {
                    runtime.stop();
                }
                self.live.remove(&source_id);
            }
        }

        for source in sources {
            if !desired_ids.contains(&source.id) {
                self.live.remove(&source.id);
                if source.runtime.status != AudioSourceRuntimeStatus::Inactive {
                    outcome
                        .runtime_updates
                        .push((source.id, inactive_runtime_state()));
                }
                continue;
            }

            // Ensure live controls exist and reflect the latest gain / mute / publish
            // sink. These propagate to the running capture thread immediately — no
            // restart — so the fader, mute, and publish toggle take effect smoothly.
            let controls = Arc::clone(self.live.entry(source.id).or_insert_with(|| {
                LiveControls::new(
                    db_to_linear(source.channel_strip.gain_db),
                    source.channel_strip.mute.muted,
                )
            }));
            controls.set_gain_linear(db_to_linear(source.channel_strip.gain_db));
            controls.set_muted(source.channel_strip.mute.muted);
            controls.set_safety_ceiling_db(source.channel_strip.safety_limiter_ceiling_db);
            controls.set_chain(&source.channel_strip.processor_chain);
            controls.set_sink(sinks.get(&source.id).cloned());

            let signature = CaptureConfigSignature::from_source(source);
            let needs_restart = self
                .runtimes
                .get(&source.id)
                .map(|runtime| runtime.config_signature() != &signature)
                .unwrap_or(true);
            if !needs_restart {
                continue;
            }

            if let Some(mut runtime) = self.runtimes.remove(&source.id) {
                runtime.stop();
            }

            let mut starting = source.clone();
            starting.runtime = starting_runtime_state(source);
            match start_adapter_for_source(
                &starting,
                app.clone(),
                Arc::clone(&shared_state),
                Arc::clone(&controls),
                Arc::clone(&render_reference),
            ) {
                Ok(runtime) => {
                    outcome
                        .runtime_updates
                        .push((source.id, runtime.runtime_state()));
                    self.runtimes.insert(source.id, runtime);
                }
                Err(error) => {
                    let message = error.to_string();
                    outcome
                        .runtime_updates
                        .push((source.id, errored_runtime_state(source, message.clone())));
                    outcome.first_error.get_or_insert(message);
                }
            }
        }
        outcome
    }

    #[cfg(test)]
    fn insert_for_test(&mut self, runtime: Box<dyn AudioSourceRuntime>) {
        self.runtimes.insert(runtime.source_id(), runtime);
    }

    #[cfg(test)]
    fn contains(&self, source_id: AudioSourceId) -> bool {
        self.runtimes.contains_key(&source_id)
    }

    #[cfg(test)]
    fn reconcile_without_start_for_test(&mut self, sources: &mut [AudioSourceState]) {
        let desired_ids: HashSet<_> = sources
            .iter()
            .filter(|source| should_capture_source(source))
            .map(|source| source.id)
            .collect();
        let existing_ids: Vec<_> = self.runtimes.keys().copied().collect();
        for source_id in existing_ids {
            if !desired_ids.contains(&source_id) {
                if let Some(mut runtime) = self.runtimes.remove(&source_id) {
                    runtime.stop();
                }
                if let Some(source) = sources.iter_mut().find(|source| source.id == source_id) {
                    source.runtime = inactive_runtime_state();
                }
            }
        }
    }
}

pub trait AudioSourceRuntime: Send + Sync + std::fmt::Debug {
    fn source_id(&self) -> AudioSourceId;
    fn stop(&mut self);
    fn runtime_state(&self) -> AudioSourceRuntimeState;
    fn config_signature(&self) -> &CaptureConfigSignature;
}

pub trait AudioCaptureAdapter {
    fn start(
        &self,
        request: AudioCaptureStartRequest,
    ) -> Result<Box<dyn AudioSourceRuntime>, CaptureError>;
}

#[derive(Clone)]
pub struct AudioCaptureStartRequest {
    pub source: AudioSourceState,
    pub app: AppHandle,
    pub shared_state: SharedAudioEngineState,
    pub controls: Arc<LiveControls>,
    pub render_reference: Arc<RenderReference>,
}

/// Identity of a capture stream for the purpose of deciding when to physically restart
/// it. Gain, mute, the safety ceiling and the whole processor chain are deliberately
/// excluded — they live in [`LiveControls`] and are applied by the running capture thread
/// — so only changes that really need the device reopened (source type, device, or the
/// WebRTC voice processing mode) trigger a restart.
#[derive(Clone, Debug, PartialEq)]
pub struct CaptureConfigSignature {
    source_id: AudioSourceId,
    source_type: AudioSourceType,
    capture_device_id: Option<String>,
    webrtc_processing: WebRtcAudioProcessingSettings,
}

impl CaptureConfigSignature {
    fn from_source(source: &AudioSourceState) -> Self {
        Self {
            source_id: source.id,
            source_type: source.source_type.clone(),
            capture_device_id: source.capture_device_id.clone(),
            webrtc_processing: source.channel_strip.webrtc_processing.clone(),
        }
    }
}

#[derive(Clone, Debug, Error, PartialEq, Serialize)]
#[serde(tag = "code", content = "detail", rename_all = "camelCase")]
pub enum CaptureError {
    #[error("audio capture source is not implemented: {source_type:?}")]
    SourceNotImplemented { source_type: AudioSourceType },
    #[error("audio input device is unavailable: {message}")]
    DeviceUnavailable { message: String },
    #[error("audio input stream failed: {message}")]
    StreamFailed { message: String },
    #[error("audio processor chain failed: {message}")]
    ProcessorFailed { message: String },
}

#[derive(Debug)]
struct CpalInputRuntime {
    source_id: AudioSourceId,
    signature: CaptureConfigSignature,
    state: AudioSourceRuntimeState,
    stop_sender: SyncSender<()>,
}

impl AudioSourceRuntime for CpalInputRuntime {
    fn source_id(&self) -> AudioSourceId {
        self.source_id
    }

    fn stop(&mut self) {
        let _ = self.stop_sender.try_send(());
    }

    fn runtime_state(&self) -> AudioSourceRuntimeState {
        self.state.clone()
    }

    fn config_signature(&self) -> &CaptureConfigSignature {
        &self.signature
    }
}

impl Drop for CpalInputRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Debug)]
struct TestToneRuntime {
    source_id: AudioSourceId,
    signature: CaptureConfigSignature,
    state: AudioSourceRuntimeState,
    stop_flag: Arc<AtomicBool>,
}

impl AudioSourceRuntime for TestToneRuntime {
    fn source_id(&self) -> AudioSourceId {
        self.source_id
    }

    fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
    }

    fn runtime_state(&self) -> AudioSourceRuntimeState {
        self.state.clone()
    }

    fn config_signature(&self) -> &CaptureConfigSignature {
        &self.signature
    }
}

impl Drop for TestToneRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

struct MicrophoneCaptureAdapter;

impl AudioCaptureAdapter for MicrophoneCaptureAdapter {
    fn start(
        &self,
        request: AudioCaptureStartRequest,
    ) -> Result<Box<dyn AudioSourceRuntime>, CaptureError> {
        start_microphone_capture(request)
    }
}

struct TestToneCaptureAdapter;

impl AudioCaptureAdapter for TestToneCaptureAdapter {
    fn start(
        &self,
        request: AudioCaptureStartRequest,
    ) -> Result<Box<dyn AudioSourceRuntime>, CaptureError> {
        start_test_tone_capture(request)
    }
}

pub fn list_input_devices() -> Vec<AudioInputDevice> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|device| device.name().ok());
    let mut devices = Vec::new();
    if let Ok(input_devices) = host.input_devices() {
        for device in input_devices {
            let name = device
                .name()
                .unwrap_or_else(|_| "Unknown input".to_string());
            let config = device.default_input_config().ok();
            devices.push(AudioInputDevice {
                device_id: name.clone(),
                name: name.clone(),
                is_default: default_name.as_deref() == Some(name.as_str()),
                sample_rate: config.as_ref().map(|config| config.sample_rate().0),
                channel_count: config.as_ref().map(|config| config.channels()),
                format: config
                    .as_ref()
                    .map(|config| sample_format(config.sample_format()))
                    .unwrap_or_default(),
            });
        }
    }
    devices
}

pub fn list_output_devices() -> Vec<AudioOutputDevice> {
    #[cfg(target_os = "windows")]
    {
        platform::windows::list_output_devices().unwrap_or_default()
    }
    #[cfg(target_os = "linux")]
    {
        // Playback is owned by CPAL, so expose CPAL's device namespace here. PipeWire
        // node ids are resolved separately by the Linux loopback-capture adapter.
        cpal_output_devices()
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        cpal_output_devices()
    }
}

pub fn system_audio_runtime_readiness() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        platform::linux::runtime_readiness()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn cpal_output_devices() -> Vec<AudioOutputDevice> {
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|device| device.name().ok());
    let mut devices = Vec::new();
    if let Ok(output_devices) = host.output_devices() {
        for device in output_devices {
            let name = device
                .name()
                .unwrap_or_else(|_| "Unknown output".to_string());
            let config = device.default_output_config().ok();
            devices.push(AudioOutputDevice {
                device_id: name.clone(),
                name: name.clone(),
                is_default: default_name.as_deref() == Some(name.as_str()),
                sample_rate: config.as_ref().map(|config| config.sample_rate().0),
                channel_count: config.as_ref().map(|config| config.channels()),
                format: config
                    .as_ref()
                    .map(|config| sample_format(config.sample_format()))
                    .unwrap_or_default(),
            });
        }
    }
    devices
}

fn start_adapter_for_source(
    source: &AudioSourceState,
    app: AppHandle,
    shared_state: SharedAudioEngineState,
    controls: Arc<LiveControls>,
    render_reference: Arc<RenderReference>,
) -> Result<Box<dyn AudioSourceRuntime>, CaptureError> {
    let request = AudioCaptureStartRequest {
        source: source.clone(),
        app,
        shared_state,
        controls,
        render_reference,
    };
    match source.source_type {
        AudioSourceType::Microphone => MicrophoneCaptureAdapter.start(request),
        AudioSourceType::TestTone => TestToneCaptureAdapter.start(request),
        AudioSourceType::SystemAudio => platform_loopback_adapter().start(request),
        AudioSourceType::ScreenAudio => Err(CaptureError::SourceNotImplemented {
            source_type: source.source_type.clone(),
        }),
        AudioSourceType::AppAudio => {
            let process_id = source
                .capture_device_id
                .as_deref()
                .and_then(|id| id.parse::<u32>().ok());
            if let Some(pid) = process_id {
                platform_app_audio_adapter(pid).start(request)
            } else {
                Err(CaptureError::SourceNotImplemented {
                    source_type: source.source_type.clone(),
                })
            }
        }
        AudioSourceType::FileAudio | AudioSourceType::Unknown => {
            Err(CaptureError::SourceNotImplemented {
                source_type: source.source_type.clone(),
            })
        }
    }
}

fn start_microphone_capture(
    request: AudioCaptureStartRequest,
) -> Result<Box<dyn AudioSourceRuntime>, CaptureError> {
    let signature = CaptureConfigSignature::from_source(&request.source);
    let source_id = request.source.id;
    let (event_sender, event_receiver) = sync_channel(CAPTURE_EVENT_CAPACITY);
    let (stop_sender, stop_receiver) = sync_channel(1);
    let (ready_sender, ready_receiver) = sync_channel(1);
    spawn_capture_event_pump(
        request.app.clone(),
        Arc::clone(&request.shared_state),
        request.source.id,
        event_receiver,
    );

    let source = request.source.clone();
    let controls = Arc::clone(&request.controls);
    let render_reference = Arc::clone(&request.render_reference);
    thread::Builder::new()
        .name("raven-mic-capture".into())
        .spawn(move || {
            run_microphone_capture(
                source,
                controls,
                render_reference,
                event_sender,
                stop_receiver,
                ready_sender,
            );
        })
        .map_err(|error| CaptureError::StreamFailed {
            message: format!("could not start the capture thread: {error}"),
        })?;

    let state = ready_receiver
        .recv()
        .map_err(|error| CaptureError::StreamFailed {
            message: error.to_string(),
        })??;

    Ok(Box::new(CpalInputRuntime {
        source_id,
        signature,
        state,
        stop_sender,
    }))
}

/// An open microphone stream plus what the supervisor needs to know about it.
struct OpenedMicrophone {
    stream: cpal::Stream,
    state: AudioSourceRuntimeState,
    device_name: String,
    fallback: bool,
    failed: Arc<AtomicBool>,
}

enum CaptureSupervision {
    Stop,
    Restart,
}

/// Capture thread body: open the microphone, keep it running, and reopen it whenever the
/// stream fails, the system default moves (when following the default), or a preferred
/// device that was missing comes back. Only the very first open reports failure to the
/// caller; after that the source keeps retrying until it is stopped.
fn run_microphone_capture(
    source: AudioSourceState,
    controls: Arc<LiveControls>,
    render_reference: Arc<RenderReference>,
    events: SyncSender<CaptureEvent>,
    stop: Receiver<()>,
    ready: SyncSender<Result<AudioSourceRuntimeState, CaptureError>>,
) {
    let mut ready = Some(ready);
    let mut failures = 0_usize;
    loop {
        match open_microphone_stream(&source, &controls, &render_reference, &events) {
            Ok(opened) => {
                failures = 0;
                match ready.take() {
                    Some(ready) => {
                        let _ = ready.send(Ok(opened.state.clone()));
                    }
                    None => {
                        let _ = events.send(CaptureEvent::Runtime(opened.state.clone()));
                    }
                }
                let outcome = supervise_microphone(&source, &opened, &stop);
                let _ = opened.stream.pause();
                drop(opened);
                if matches!(outcome, CaptureSupervision::Stop) {
                    return;
                }
            }
            Err(error) => {
                if let Some(ready) = ready.take() {
                    let _ = ready.send(Err(error));
                    return;
                }
                let _ = events.send(CaptureEvent::Error(error.to_string()));
                let delay = CAPTURE_RETRY_DELAYS[failures.min(CAPTURE_RETRY_DELAYS.len() - 1)];
                failures += 1;
                if stop_requested_within(&stop, delay) {
                    return;
                }
            }
        }
    }
}

/// Wait up to `duration`; true when the source was stopped (or dropped) meanwhile.
fn stop_requested_within(stop: &Receiver<()>, duration: Duration) -> bool {
    !matches!(stop.recv_timeout(duration), Err(RecvTimeoutError::Timeout))
}

fn supervise_microphone(
    source: &AudioSourceState,
    opened: &OpenedMicrophone,
    stop: &Receiver<()>,
) -> CaptureSupervision {
    let mut last_probe = Instant::now();
    loop {
        if stop_requested_within(stop, CAPTURE_SUPERVISE_TICK) {
            return CaptureSupervision::Stop;
        }
        if opened.failed.load(Ordering::Relaxed) {
            return CaptureSupervision::Restart;
        }
        if last_probe.elapsed() < CAPTURE_DEVICE_PROBE_INTERVAL {
            continue;
        }
        last_probe = Instant::now();
        let host = cpal::default_host();
        let should_restart = match source.capture_device_id.as_deref() {
            // Standing in for a missing device: switch back once it is listed again.
            Some(preferred) if opened.fallback => find_input_device(&host, preferred).is_some(),
            Some(_) => false,
            // Following the system default: move with it.
            None => host
                .default_input_device()
                .and_then(|device| device.name().ok())
                .is_some_and(|current| current != opened.device_name),
        };
        if should_restart {
            return CaptureSupervision::Restart;
        }
    }
}

fn find_input_device(host: &cpal::Host, device_id: &str) -> Option<cpal::Device> {
    host.input_devices()
        .ok()?
        .find(|device| device.name().ok().as_deref() == Some(device_id))
}

/// Pick the capture device for a source: its chosen device when present, otherwise the
/// system default (flagged as a fallback so the UI can say so and the supervisor can
/// switch back later).
fn select_input_device(
    host: &cpal::Host,
    capture_device_id: Option<&str>,
) -> Result<(cpal::Device, bool), CaptureError> {
    let default_device = || {
        host.default_input_device()
            .ok_or_else(|| CaptureError::DeviceUnavailable {
                message: "no default input device".to_string(),
            })
    };
    match capture_device_id {
        Some(device_id) => match find_input_device(host, device_id) {
            Some(device) => Ok((device, false)),
            None => default_device()
                .map(|device| (device, true))
                .map_err(|_| CaptureError::DeviceUnavailable {
                    message: format!(
                        "selected input device `{device_id}` was not found and no default input is available"
                    ),
                }),
        },
        None => default_device().map(|device| (device, false)),
    }
}

fn open_microphone_stream(
    source: &AudioSourceState,
    controls: &Arc<LiveControls>,
    render_reference: &Arc<RenderReference>,
    events: &SyncSender<CaptureEvent>,
) -> Result<OpenedMicrophone, CaptureError> {
    let host = cpal::default_host();
    let (device, fallback) = select_input_device(&host, source.capture_device_id.as_deref())?;
    match open_input_device(
        &device,
        fallback,
        source,
        controls,
        render_reference,
        events,
    ) {
        Ok(opened) => Ok(opened),
        // The chosen device is listed but would not open (busy, driver error): use the
        // default rather than leaving the user without a microphone.
        Err(error) if !fallback && source.capture_device_id.is_some() => {
            let Some(default) = host.default_input_device() else {
                return Err(error);
            };
            if default.name().ok() == device.name().ok() {
                return Err(error);
            }
            open_input_device(&default, true, source, controls, render_reference, events)
                .map_err(|_| error)
        }
        Err(error) => Err(error),
    }
}

fn open_input_device(
    device: &cpal::Device,
    fallback: bool,
    source: &AudioSourceState,
    controls: &Arc<LiveControls>,
    render_reference: &Arc<RenderReference>,
    events: &SyncSender<CaptureEvent>,
) -> Result<OpenedMicrophone, CaptureError> {
    let device_name = device.name().unwrap_or_else(|_| "Audio input".to_string());
    let supported_config =
        device
            .default_input_config()
            .map_err(|error| CaptureError::DeviceUnavailable {
                message: error.to_string(),
            })?;
    let sample_rate = supported_config.sample_rate().0;
    let channel_count = supported_config.channels();
    let format = sample_format(supported_config.sample_format());
    let stream_config: cpal::StreamConfig = supported_config.clone().into();

    let mut processing_source = source.clone();
    processing_source.runtime.channel_count = Some(channel_count);
    let processing = SourceProcessingConfig::from_source(
        &processing_source,
        Arc::clone(controls),
        sample_rate,
        Arc::clone(render_reference),
    )?;
    let failed = Arc::new(AtomicBool::new(false));
    let stream = build_input_stream(
        device,
        &stream_config,
        supported_config.sample_format(),
        processing,
        events.clone(),
        Arc::clone(&failed),
    )?;
    stream.play().map_err(|error| CaptureError::StreamFailed {
        message: error.to_string(),
    })?;

    let mut state = running_runtime_state(
        source,
        sample_rate,
        channel_count,
        format,
        Some(device_name.clone()),
        Some(device_name.clone()),
    );
    state.fallback_device = fallback;
    Ok(OpenedMicrophone {
        stream,
        state,
        device_name,
        fallback,
        failed,
    })
}

fn start_test_tone_capture(
    request: AudioCaptureStartRequest,
) -> Result<Box<dyn AudioSourceRuntime>, CaptureError> {
    let signature = CaptureConfigSignature::from_source(&request.source);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = sync_channel(CAPTURE_EVENT_CAPACITY);
    spawn_capture_event_pump(
        request.app.clone(),
        Arc::clone(&request.shared_state),
        request.source.id,
        receiver,
    );

    let mut processing = SourceProcessingConfig::from_source(
        &request.source,
        Arc::clone(&request.controls),
        TEST_TONE_SAMPLE_RATE,
        Arc::clone(&request.render_reference),
    )?;
    let stop = Arc::clone(&stop_flag);
    let source_id = request.source.id;
    thread::spawn(move || {
        let mut phase = 0.0_f32;
        let phase_step = TAU * 440.0 / TEST_TONE_SAMPLE_RATE as f32;
        let mut samples = vec![0.0_f32; TEST_TONE_BLOCK_FRAMES * TEST_TONE_CHANNELS as usize];
        let mut last_meter = Instant::now();

        while !stop.load(Ordering::Relaxed) {
            for sample in &mut samples {
                *sample = phase.sin() * 0.2;
                phase += phase_step;
                if phase >= TAU {
                    phase -= TAU;
                }
            }
            match process_source_samples(&mut processing, &mut samples) {
                Ok(analysis) => {
                    if last_meter.elapsed() >= METER_INTERVAL {
                        let _ = sender.try_send(CaptureEvent::Health(analysis));
                        last_meter = Instant::now();
                    }
                }
                Err(error) => {
                    let _ = sender.try_send(CaptureEvent::Error(error.to_string()));
                    break;
                }
            }
            thread::sleep(Duration::from_millis(20));
        }
    });

    Ok(Box::new(TestToneRuntime {
        source_id,
        signature,
        state: running_runtime_state(
            &request.source,
            TEST_TONE_SAMPLE_RATE,
            TEST_TONE_CHANNELS,
            AudioSampleFormat::F32,
            Some("test-tone".to_string()),
            Some("Generated test tone".to_string()),
        ),
        stop_flag,
    }))
}

/// Build an input stream in whatever sample format the device natively offers. Samples
/// are converted to f32 for the processing chain.
fn build_input_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    format: cpal::SampleFormat,
    processing: SourceProcessingConfig,
    sender: SyncSender<CaptureEvent>,
    failed: Arc<AtomicBool>,
) -> Result<cpal::Stream, CaptureError> {
    match format {
        cpal::SampleFormat::F32 => {
            build_typed_input_stream::<f32>(device, config, processing, sender, failed)
        }
        cpal::SampleFormat::F64 => {
            build_typed_input_stream::<f64>(device, config, processing, sender, failed)
        }
        cpal::SampleFormat::I8 => {
            build_typed_input_stream::<i8>(device, config, processing, sender, failed)
        }
        cpal::SampleFormat::I16 => {
            build_typed_input_stream::<i16>(device, config, processing, sender, failed)
        }
        cpal::SampleFormat::I32 => {
            build_typed_input_stream::<i32>(device, config, processing, sender, failed)
        }
        cpal::SampleFormat::I64 => {
            build_typed_input_stream::<i64>(device, config, processing, sender, failed)
        }
        cpal::SampleFormat::U8 => {
            build_typed_input_stream::<u8>(device, config, processing, sender, failed)
        }
        cpal::SampleFormat::U16 => {
            build_typed_input_stream::<u16>(device, config, processing, sender, failed)
        }
        cpal::SampleFormat::U32 => {
            build_typed_input_stream::<u32>(device, config, processing, sender, failed)
        }
        cpal::SampleFormat::U64 => {
            build_typed_input_stream::<u64>(device, config, processing, sender, failed)
        }
        other => Err(CaptureError::StreamFailed {
            message: format!("unsupported input sample format {other:?}"),
        }),
    }
}

fn build_typed_input_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut processing: SourceProcessingConfig,
    sender: SyncSender<CaptureEvent>,
    failed: Arc<AtomicBool>,
) -> Result<cpal::Stream, CaptureError>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let mut buffer = Vec::new();
    let mut last_meter = Instant::now();
    let error_sender = sender.clone();
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                buffer.clear();
                buffer.extend(data.iter().map(|sample| f32::from_sample(*sample)));
                handle_input_block(&mut processing, &mut buffer, &sender, &mut last_meter);
            },
            move |error| {
                // The supervisor reopens the device; the event surfaces why it dropped.
                failed.store(true, Ordering::Relaxed);
                let _ = error_sender.try_send(CaptureEvent::Error(error.to_string()));
            },
            None,
        )
        .map_err(|error| CaptureError::StreamFailed {
            message: error.to_string(),
        })
}

fn handle_input_block(
    processing: &mut SourceProcessingConfig,
    samples: &mut Vec<f32>,
    sender: &SyncSender<CaptureEvent>,
    last_meter: &mut Instant,
) {
    let analysis = match process_source_samples(processing, samples) {
        Ok(analysis) => analysis,
        Err(error) => {
            let _ = sender.try_send(CaptureEvent::Error(error.to_string()));
            return;
        }
    };
    if last_meter.elapsed() >= METER_INTERVAL {
        let _ = sender.try_send(CaptureEvent::Health(analysis));
        *last_meter = Instant::now();
    }
}

#[derive(Debug)]
struct SourceProcessingConfig {
    controls: Arc<LiveControls>,
    sample_rate: u32,
    channel_count: usize,
    apm: Option<WebRtcApmRuntime>,
    safety: ChannelSafetyRuntime,
    latency_samples: u32,
    processor_cpu_estimate: Option<f32>,
    processor_chain: ProcessorChainRuntime,
    /// The [`LiveControls`] chain version this runtime chain reflects.
    chain_version: u64,
    /// Fader / mute gain applied to the previous sample, so changes ramp.
    applied_gain: f32,
}

impl SourceProcessingConfig {
    fn from_source(
        source: &AudioSourceState,
        controls: Arc<LiveControls>,
        sample_rate: u32,
        render_reference: Arc<RenderReference>,
    ) -> Result<Self, CaptureError> {
        let channel_count = source
            .runtime
            .channel_count
            .map(usize::from)
            .unwrap_or(1)
            .max(1);
        let mut safety = ChannelSafetyRuntime::new();
        safety.configure(sample_rate, channel_count);
        let chain_version = controls.chain_version();
        let applied_gain = fader_target(&controls);
        let mut processing = Self {
            controls,
            sample_rate,
            channel_count,
            apm: WebRtcApmRuntime::new(
                source.source_type.clone(),
                &source.channel_strip.webrtc_processing,
                sample_rate,
                channel_count,
                render_reference,
            )?,
            safety,
            latency_samples: 0,
            processor_cpu_estimate: None,
            processor_chain: ProcessorChainRuntime::empty(),
            chain_version,
            applied_gain,
        };
        processing.install_chain(&source.channel_strip.processor_chain);
        Ok(processing)
    }

    /// Build and prepare a chain for this stream's real format. A chain that cannot be
    /// built is replaced by a pass-through rather than stopping the capture.
    fn install_chain(&mut self, state: &ProcessorChainState) {
        let mut chain = ProcessorChainRuntime::from_state(state)
            .unwrap_or_else(|_| ProcessorChainRuntime::empty());
        let prepared = chain.prepare(AudioProcessorPrepareConfig::new(
            self.sample_rate,
            self.channel_count,
            CAPTURE_MAX_BLOCK_FRAMES,
        ));
        if prepared.is_err() {
            chain = ProcessorChainRuntime::empty();
        }
        self.processor_chain = chain;
        self.refresh_chain_stats(state);
    }

    fn refresh_chain_stats(&mut self, state: &ProcessorChainState) {
        self.latency_samples = chain_latency_samples(state) + self.safety.latency_frames() as u32;
        self.processor_cpu_estimate = Some(chain_cpu_estimate(state));
    }

    /// Pick up a chain edited since the last block. Settings on an unchanged set of
    /// processors are applied in place (filter memory and envelopes carry on); adding,
    /// removing or reordering processors swaps in a fresh chain.
    fn sync_live_chain(&mut self) {
        let version = self.controls.chain_version();
        if version == self.chain_version {
            return;
        }
        let Some(state) = self.controls.chain() else {
            return;
        };
        self.chain_version = version;
        if self.processor_chain.sync_state(&state) {
            self.refresh_chain_stats(&state);
        } else {
            self.install_chain(&state);
        }
    }

    /// Apply the fader and mute, moving toward the target gain at a bounded rate so a
    /// mute or a fast fader move never produces a click.
    fn apply_fader(&mut self, samples: &mut [f32]) {
        let target = fader_target(&self.controls);
        if self.applied_gain == target {
            if target == 0.0 {
                samples.fill(0.0);
            } else if target != 1.0 {
                for sample in samples.iter_mut() {
                    *sample *= target;
                }
            }
            return;
        }
        let step = FADER_SLEW_PER_MS * 1000.0 / self.sample_rate.max(1) as f32;
        let mut gain = self.applied_gain;
        for frame in samples.chunks_mut(self.channel_count.max(1)) {
            gain = if gain < target {
                (gain + step).min(target)
            } else {
                (gain - step).max(target)
            };
            for sample in frame {
                *sample *= gain;
            }
        }
        self.applied_gain = gain;
    }
}

/// The gain the fader and mute currently ask for.
fn fader_target(controls: &LiveControls) -> f32 {
    if controls.is_muted() {
        0.0
    } else {
        controls.gain_linear()
    }
}

struct WebRtcApmRuntime {
    processor: AudioProcessing,
    render_reference: Arc<RenderReference>,
    /// This canceller's position in the stream of played audio.
    render_cursor: RenderCursor,
    render_left: Vec<f32>,
    render_right: Vec<f32>,
    aec_enabled: bool,
    sample_rate: u32,
    channel_count: usize,
    frame_samples_per_channel: usize,
    pending: Vec<f32>,
}

impl std::fmt::Debug for WebRtcApmRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebRtcApmRuntime")
            .field("sample_rate", &self.sample_rate)
            .field("channel_count", &self.channel_count)
            .field("frame_samples_per_channel", &self.frame_samples_per_channel)
            .field("pending", &self.pending.len())
            .finish_non_exhaustive()
    }
}

impl WebRtcApmRuntime {
    fn new(
        source_type: AudioSourceType,
        settings: &WebRtcAudioProcessingSettings,
        sample_rate: u32,
        channel_count: usize,
        render_reference: Arc<RenderReference>,
    ) -> Result<Option<Self>, CaptureError> {
        let supports_apm = source_type == AudioSourceType::Microphone
            || (source_type == AudioSourceType::SystemAudio && settings.echo_cancellation);
        if !supports_apm || !apm_enabled(settings) {
            return Ok(None);
        }
        let channel_count = channel_count.max(1);
        // sonora operates on 10ms frames at the stream sample rate.
        let frame_samples_per_channel = (sample_rate / 100) as usize;
        let config = apm_config(&source_type, settings);
        let aec_enabled = config.echo_canceller.is_some();
        let mut processor = AudioProcessing::builder()
            .config(config)
            .capture_config(StreamConfig::new(sample_rate as _, channel_count as _))
            .render_config(StreamConfig::new(sample_rate as _, channel_count as _))
            .build();
        if aec_enabled {
            // AEC3 estimates the render delay internally, but the API requires an
            // initial value to be set when echo cancellation is enabled.
            processor
                .set_stream_delay_ms(0)
                .map_err(|error| CaptureError::ProcessorFailed {
                    message: format!("WebRTC APM stream-delay init failed: {error}"),
                })?;
        }
        Ok(Some(Self {
            processor,
            render_reference,
            render_cursor: RenderCursor::default(),
            render_left: Vec::new(),
            render_right: Vec::new(),
            aec_enabled,
            sample_rate,
            channel_count,
            frame_samples_per_channel,
            pending: Vec::new(),
        }))
    }

    /// Hand the canceller every 10 ms frame Raven has played since the last capture
    /// frame, in order and at the speaker's own sample rate. The canceller needs the far
    /// end as one unbroken stream to model the echo path.
    fn feed_render(&mut self) -> Result<(), CaptureError> {
        if !self.aec_enabled {
            return Ok(());
        }
        for _ in 0..MAX_RENDER_FRAMES_PER_CAPTURE {
            let Some(rate) = self.render_reference.next_frame(
                &mut self.render_cursor,
                &mut self.render_left,
                &mut self.render_right,
            ) else {
                break;
            };
            let config = StreamConfig::new(rate as _, 2);
            let mut out_left = vec![0.0_f32; self.render_left.len()];
            let mut out_right = vec![0.0_f32; self.render_right.len()];
            self.processor
                .process_render_f32_with_config(
                    &[self.render_left.as_slice(), self.render_right.as_slice()],
                    &config,
                    &config,
                    &mut [out_left.as_mut_slice(), out_right.as_mut_slice()],
                )
                .map_err(|error| CaptureError::ProcessorFailed {
                    message: format!("WebRTC APM render processing failed: {error}"),
                })?;
        }
        Ok(())
    }

    fn process_interleaved(&mut self, samples: &mut Vec<f32>) -> Result<(), CaptureError> {
        if samples.is_empty() {
            return Ok(());
        }
        self.pending.append(samples);
        let frame_samples = self
            .frame_samples_per_channel
            .saturating_mul(self.channel_count);
        if frame_samples == 0 {
            return Ok(());
        }

        let mut processed =
            Vec::with_capacity((self.pending.len() / frame_samples) * frame_samples);
        while self.pending.len() >= frame_samples {
            let frame: Vec<f32> = self.pending.drain(0..frame_samples).collect();
            let capture_in =
                deinterleave_frame(&frame, self.channel_count, self.frame_samples_per_channel);

            // Feed the render (far-end) reference so AEC can subtract it.
            self.feed_render()?;

            // Process the capture (near-end) frame in place.
            let mut capture_out =
                vec![vec![0.0_f32; self.frame_samples_per_channel]; self.channel_count];
            {
                let capture_src: Vec<&[f32]> = capture_in.iter().map(Vec::as_slice).collect();
                let mut capture_dst: Vec<&mut [f32]> =
                    capture_out.iter_mut().map(Vec::as_mut_slice).collect();
                self.processor
                    .process_capture_f32(&capture_src, &mut capture_dst)
                    .map_err(|error| CaptureError::ProcessorFailed {
                        message: format!("WebRTC APM capture processing failed: {error}"),
                    })?;
            }

            interleave_frame(&capture_out, &mut processed);
        }

        *samples = processed;
        Ok(())
    }
}

fn apm_enabled(settings: &WebRtcAudioProcessingSettings) -> bool {
    settings.noise_suppression || settings.echo_cancellation || settings.auto_gain_control
}

fn apm_config(
    source_type: &AudioSourceType,
    settings: &WebRtcAudioProcessingSettings,
) -> ApmConfig {
    let microphone = *source_type == AudioSourceType::Microphone;
    ApmConfig {
        high_pass_filter: (microphone
            && (settings.noise_suppression || settings.echo_cancellation))
            .then(HighPassFilter::default),
        echo_canceller: settings.echo_cancellation.then(EchoCanceller::default),
        noise_suppression: (microphone && settings.noise_suppression)
            .then(NoiseSuppression::default),
        gain_controller2: (microphone && settings.auto_gain_control).then(|| GainController2 {
            input_volume_controller: false,
            adaptive_digital: Some(AdaptiveDigital {
                headroom_db: 6.0,
                max_gain_db: 30.0,
                initial_gain_db: 8.0,
                max_gain_change_db_per_second: 3.0,
                max_output_noise_level_dbfs: -50.0,
            }),
            fixed_digital: FixedDigital { gain_db: 0.0 },
        }),
        ..ApmConfig::default()
    }
}

fn deinterleave_frame(interleaved: &[f32], channels: usize, frames: usize) -> Vec<Vec<f32>> {
    let channels = channels.max(1);
    let mut out = vec![vec![0.0; frames]; channels];
    for frame in 0..frames {
        for (channel, channel_out) in out.iter_mut().enumerate() {
            let index = frame * channels + channel;
            if let Some(sample) = interleaved.get(index) {
                channel_out[frame] = *sample;
            }
        }
    }
    out
}

fn interleave_frame(channels: &[Vec<f32>], out: &mut Vec<f32>) {
    let Some(first) = channels.first() else {
        return;
    };
    for frame in 0..first.len() {
        for channel in channels {
            out.push(channel[frame]);
        }
    }
}

fn process_source_samples(
    processing: &mut SourceProcessingConfig,
    samples: &mut Vec<f32>,
) -> Result<ChannelSafetyAnalysis, CaptureError> {
    if let Some(apm) = processing.apm.as_mut() {
        apm.process_interleaved(samples)?;
    }

    // Fader, mute, limiter ceiling and the processor chain are all read live, so edits
    // take effect on the running stream without reopening the device.
    processing.sync_live_chain();
    processing.apply_fader(samples);
    let ceiling_db = processing.controls.safety_ceiling_db();

    if samples.is_empty() {
        let meter = MeterState::default();
        return Ok(ChannelSafetyAnalysis {
            meter: meter.clone(),
            health: crate::audio::safety::health_from_meter(
                meter,
                ceiling_db,
                processing.latency_samples,
                processing.processor_cpu_estimate,
            ),
        });
    }
    let mut audio_buffer =
        AudioBuffer::from_interleaved(processing.channel_count, std::mem::take(samples)).map_err(
            |error| CaptureError::ProcessorFailed {
                message: error.to_string(),
            },
        )?;
    processing
        .processor_chain
        .process(&mut audio_buffer)
        .map_err(|error| CaptureError::ProcessorFailed {
            message: error.to_string(),
        })?;
    *samples = audio_buffer.into_samples();
    let analysis = processing.safety.analyze_and_limit(
        samples,
        ceiling_db,
        processing.latency_samples,
        processing.processor_cpu_estimate,
    );
    // The samples are now fully processed (gain → chain → safety limiter). If this source
    // is published, forward exactly these samples to the media engine — what peers hear is
    // what the user shaped here.
    processing
        .controls
        .push_to_sink(samples, processing.channel_count, processing.sample_rate);
    Ok(analysis)
}

fn spawn_capture_event_pump(
    app: AppHandle,
    shared_state: SharedAudioEngineState,
    source_id: AudioSourceId,
    receiver: Receiver<CaptureEvent>,
) {
    thread::spawn(move || {
        while let Ok(event) = receiver.recv() {
            let emission = {
                let Ok(mut engine) = shared_state.write() else {
                    break;
                };
                let Some(source) = engine
                    .mixer
                    .local_sources
                    .iter_mut()
                    .find(|source| source.id == source_id)
                else {
                    break;
                };
                match event {
                    CaptureEvent::Health(analysis) => {
                        source.channel_strip.meter = analysis.meter.clone();
                        source.channel_strip.health = analysis.health.clone();
                        CaptureEmission::Meter(AudioMeterUpdate::local(
                            source_id,
                            analysis.meter,
                            analysis.health,
                        ))
                    }
                    CaptureEvent::Error(message) => {
                        source.runtime.status = AudioSourceRuntimeStatus::Error;
                        source.runtime.error = Some(message);
                        source.runtime.updated_at = Some(now_unix_ms_string());
                        CaptureEmission::State(engine.snapshot())
                    }
                    CaptureEvent::Runtime(runtime) => {
                        source.runtime = runtime;
                        CaptureEmission::State(engine.snapshot())
                    }
                }
            };
            match emission {
                CaptureEmission::Meter(update) => {
                    let _ = app.emit(AUDIO_METER_CHANGED_EVENT, update);
                }
                CaptureEmission::State(snapshot) => {
                    let _ = app.emit(AUDIO_STATE_CHANGED_EVENT, snapshot);
                }
            }
        }
    });
}

enum CaptureEmission {
    Meter(AudioMeterUpdate),
    State(crate::audio::domain::AudioMixerState),
}

#[derive(Debug)]
enum CaptureEvent {
    Health(ChannelSafetyAnalysis),
    Error(String),
    /// The capture was (re)opened: replaces the source's runtime state, clearing any
    /// earlier error.
    Runtime(AudioSourceRuntimeState),
}

fn should_capture_source(source: &AudioSourceState) -> bool {
    source.enabled
}

fn inactive_runtime_state() -> AudioSourceRuntimeState {
    AudioSourceRuntimeState {
        status: AudioSourceRuntimeStatus::Inactive,
        updated_at: Some(now_unix_ms_string()),
        ..AudioSourceRuntimeState::default()
    }
}

fn starting_runtime_state(source: &AudioSourceState) -> AudioSourceRuntimeState {
    AudioSourceRuntimeState {
        status: AudioSourceRuntimeStatus::Starting,
        device_id: source.capture_device_id.clone(),
        updated_at: Some(now_unix_ms_string()),
        ..AudioSourceRuntimeState::default()
    }
}

fn running_runtime_state(
    source: &AudioSourceState,
    sample_rate: u32,
    channel_count: u16,
    format: AudioSampleFormat,
    device_id: Option<String>,
    device_name: Option<String>,
) -> AudioSourceRuntimeState {
    AudioSourceRuntimeState {
        status: AudioSourceRuntimeStatus::Running,
        sample_rate: Some(sample_rate),
        channel_count: Some(channel_count),
        format,
        device_id: device_id.or_else(|| source.capture_device_id.clone()),
        device_name,
        error: None,
        updated_at: Some(now_unix_ms_string()),
        fallback_device: false,
    }
}

fn errored_runtime_state(source: &AudioSourceState, message: String) -> AudioSourceRuntimeState {
    AudioSourceRuntimeState {
        status: AudioSourceRuntimeStatus::Error,
        device_id: source.capture_device_id.clone(),
        error: Some(message),
        updated_at: Some(now_unix_ms_string()),
        ..AudioSourceRuntimeState::default()
    }
}

fn sample_format(format: cpal::SampleFormat) -> AudioSampleFormat {
    match format {
        cpal::SampleFormat::F32 => AudioSampleFormat::F32,
        cpal::SampleFormat::I16 => AudioSampleFormat::I16,
        cpal::SampleFormat::U16 => AudioSampleFormat::U16,
        _ => AudioSampleFormat::Unknown,
    }
}

fn now_unix_ms_string() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

#[cfg(target_os = "windows")]
fn platform_loopback_adapter() -> platform::windows::WindowsLoopbackCaptureAdapter {
    platform::windows::WindowsLoopbackCaptureAdapter
}

#[cfg(target_os = "windows")]
fn platform_app_audio_adapter(process_id: u32) -> platform::windows::AppAudioCaptureAdapter {
    platform::windows::AppAudioCaptureAdapter { process_id }
}

#[cfg(target_os = "macos")]
fn platform_app_audio_adapter(process_id: u32) -> platform::macos::MacOsAppAudioCaptureAdapter {
    platform::macos::MacOsAppAudioCaptureAdapter { process_id }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn platform_app_audio_adapter(
    _process_id: u32,
) -> platform::unsupported::UnsupportedAppAudioCaptureAdapter {
    platform::unsupported::UnsupportedAppAudioCaptureAdapter
}

#[cfg(target_os = "macos")]
fn platform_loopback_adapter() -> platform::macos::MacOsLoopbackCaptureAdapter {
    platform::macos::MacOsLoopbackCaptureAdapter
}

#[cfg(target_os = "linux")]
fn platform_loopback_adapter() -> platform::linux::LinuxLoopbackCaptureAdapter {
    platform::linux::LinuxLoopbackCaptureAdapter
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn platform_loopback_adapter() -> platform::unsupported::UnsupportedLoopbackCaptureAdapter {
    platform::unsupported::UnsupportedLoopbackCaptureAdapter
}

pub mod platform {
    use super::*;

    #[cfg(target_os = "windows")]
    pub mod windows {
        use super::*;
        use std::sync::Arc;
        use std::thread;
        use std::time::{Duration, Instant};

        use ::windows::{
            core::{implement, Interface, PWSTR},
            Win32::{
                Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
                Foundation::{CloseHandle, BOOL, HANDLE, HWND, LPARAM},
                Graphics::Gdi::{
                    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject,
                    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
                },
                Media::Audio::{
                    eConsole, eRender, ActivateAudioInterfaceAsync,
                    IActivateAudioInterfaceAsyncOperation,
                    IActivateAudioInterfaceCompletionHandler,
                    IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient,
                    IAudioClient, IAudioSessionControl2, IAudioSessionEnumerator,
                    IAudioSessionManager2, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
                    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
                    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
                    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
                    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, DEVICE_STATE_ACTIVE,
                    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX, WAVE_FORMAT_PCM,
                },
                System::{
                    Com::StructuredStorage::PropVariantClear,
                    Com::{
                        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                        CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
                    },
                    Threading::{
                        CreateEventW, OpenProcess, QueryFullProcessImageNameW, SetEvent,
                        WaitForSingleObject, INFINITE, PROCESS_QUERY_LIMITED_INFORMATION,
                    },
                },
                UI::{
                    Shell::PropertiesSystem::{PSFormatForDisplayAlloc, PDFF_DEFAULT},
                    Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON},
                    WindowsAndMessaging::{
                        DestroyIcon, DrawIconEx, EnumWindows, GetWindowTextLengthW,
                        GetWindowThreadProcessId, IsWindowVisible, DI_NORMAL,
                    },
                },
            },
        };
        use base64::Engine as _;

        use crate::audio::domain::AppAudioSource;

        // Raw PROPVARIANT layout for VT_BLOB on x64 Windows.
        // Header: vt(u16) + 3×reserved(u16) = 8 bytes.
        // Data:   cbSize(u32) + pad(u32) + pBlobData(*mut u8) = 16 bytes.
        // Total = 24 bytes, matching sizeof(PROPVARIANT).
        #[repr(C)]
        struct BlobPropVar {
            vt: u16,
            reserved: [u16; 3],
            cb_size: u32,
            pad: u32,
            p_data: *mut u8,
        }
        unsafe impl Send for BlobPropVar {}

        struct SendHandle(HANDLE);
        unsafe impl Send for SendHandle {}
        unsafe impl Sync for SendHandle {}

        #[implement(IActivateAudioInterfaceCompletionHandler)]
        struct ActivationCallback {
            event: SendHandle,
        }

        impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationCallback_Impl {
            fn ActivateCompleted(
                &self,
                _activate_operation: Option<&IActivateAudioInterfaceAsyncOperation>,
            ) -> ::windows::core::Result<()> {
                unsafe {
                    let _ = SetEvent(self.event.0);
                }
                Ok(())
            }
        }

        pub struct WindowsLoopbackCaptureAdapter;

        impl AudioCaptureAdapter for WindowsLoopbackCaptureAdapter {
            fn start(
                &self,
                request: AudioCaptureStartRequest,
            ) -> Result<Box<dyn AudioSourceRuntime>, CaptureError> {
                start_system_audio_capture(request)
            }
        }

        pub struct AppAudioCaptureAdapter {
            pub process_id: u32,
        }

        impl AudioCaptureAdapter for AppAudioCaptureAdapter {
            fn start(
                &self,
                request: AudioCaptureStartRequest,
            ) -> Result<Box<dyn AudioSourceRuntime>, CaptureError> {
                start_app_audio_capture(request, self.process_id)
            }
        }

        #[derive(Debug)]
        struct WasapiLoopbackRuntime {
            source_id: AudioSourceId,
            signature: CaptureConfigSignature,
            state: AudioSourceRuntimeState,
            stop_sender: std::sync::mpsc::SyncSender<()>,
        }

        impl AudioSourceRuntime for WasapiLoopbackRuntime {
            fn source_id(&self) -> AudioSourceId {
                self.source_id
            }
            fn stop(&mut self) {
                let _ = self.stop_sender.try_send(());
            }
            fn runtime_state(&self) -> AudioSourceRuntimeState {
                self.state.clone()
            }
            fn config_signature(&self) -> &CaptureConfigSignature {
                &self.signature
            }
        }

        impl Drop for WasapiLoopbackRuntime {
            fn drop(&mut self) {
                self.stop();
            }
        }

        #[derive(Clone, Debug)]
        enum LoopbackTarget {
            SystemOutputExcludingProcess(u32),
            Process(u32),
        }

        fn start_system_audio_capture(
            request: AudioCaptureStartRequest,
        ) -> Result<Box<dyn AudioSourceRuntime>, CaptureError> {
            start_wasapi_loopback_capture(
                request,
                LoopbackTarget::SystemOutputExcludingProcess(std::process::id()),
            )
        }

        fn start_app_audio_capture(
            request: AudioCaptureStartRequest,
            process_id: u32,
        ) -> Result<Box<dyn AudioSourceRuntime>, CaptureError> {
            start_wasapi_loopback_capture(request, LoopbackTarget::Process(process_id))
        }

        fn start_wasapi_loopback_capture(
            request: AudioCaptureStartRequest,
            target: LoopbackTarget,
        ) -> Result<Box<dyn AudioSourceRuntime>, CaptureError> {
            let signature = CaptureConfigSignature::from_source(&request.source);
            let source_id = request.source.id;
            let source = request.source.clone();
            let controls = Arc::clone(&request.controls);
            let render_reference = Arc::clone(&request.render_reference);
            let (event_sender, event_receiver) =
                std::sync::mpsc::sync_channel(CAPTURE_EVENT_CAPACITY);
            let (stop_sender, stop_receiver) = std::sync::mpsc::sync_channel(1);
            let (ready_sender, ready_receiver) =
                std::sync::mpsc::sync_channel::<Result<AudioSourceRuntimeState, CaptureError>>(1);

            spawn_capture_event_pump(
                request.app.clone(),
                Arc::clone(&request.shared_state),
                source_id,
                event_receiver,
            );

            // All COM objects stay on this single spawned thread to satisfy !Send.
            thread::spawn(move || {
                unsafe {
                    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                }
                // Like the microphone, a loopback capture that fails mid-session is
                // reopened instead of going quiet. Only the first attempt reports failure
                // to the caller.
                let mut ready = Some(ready_sender);
                let mut failures = 0_usize;
                loop {
                    match unsafe { init_wasapi_loopback(&source, &target) } {
                        Ok((state, audio_client, capture_client, channel_count, is_float)) => {
                            failures = 0;
                            let sample_rate = state.sample_rate.unwrap_or(48_000);
                            match ready.take() {
                                Some(ready) => {
                                    let _ = ready.send(Ok(state));
                                }
                                None => {
                                    let _ = event_sender.send(CaptureEvent::Runtime(state));
                                }
                            }
                            // Build the processing for the stream's real layout: the
                            // voice processing and the chain are per-channel.
                            let mut processing_source = source.clone();
                            processing_source.runtime.channel_count = Some(channel_count);
                            let exit = match SourceProcessingConfig::from_source(
                                &processing_source,
                                Arc::clone(&controls),
                                sample_rate,
                                Arc::clone(&render_reference),
                            ) {
                                Ok(mut processing) => unsafe {
                                    run_capture_polling_loop(
                                        &capture_client,
                                        channel_count,
                                        is_float,
                                        &mut processing,
                                        &event_sender,
                                        &stop_receiver,
                                    )
                                },
                                Err(error) => LoopbackExit::Failed(error.to_string()),
                            };
                            unsafe {
                                let _ = audio_client.Stop();
                            }
                            match exit {
                                LoopbackExit::Stopped => break,
                                LoopbackExit::Failed(message) => {
                                    let _ = event_sender.send(CaptureEvent::Error(message));
                                }
                            }
                        }
                        Err(error) => {
                            if let Some(ready) = ready.take() {
                                let _ = ready.send(Err(error));
                                break;
                            }
                            let _ = event_sender.send(CaptureEvent::Error(error.to_string()));
                        }
                    }
                    failures += 1;
                    // An application that has exited will never come back under this
                    // process id; stop trying after a few attempts.
                    if matches!(target, LoopbackTarget::Process(_)) && failures > 5 {
                        break;
                    }
                    let delay =
                        CAPTURE_RETRY_DELAYS[(failures - 1).min(CAPTURE_RETRY_DELAYS.len() - 1)];
                    if stop_requested_within(&stop_receiver, delay) {
                        break;
                    }
                }
                unsafe {
                    CoUninitialize();
                }
            });

            let state = ready_receiver
                .recv()
                .map_err(|e| CaptureError::StreamFailed {
                    message: e.to_string(),
                })??;

            Ok(Box::new(WasapiLoopbackRuntime {
                source_id,
                signature,
                state,
                stop_sender,
            }))
        }

        // Safety: called from the COM-initialized capture thread only.
        unsafe fn init_wasapi_loopback(
            source: &AudioSourceState,
            target: &LoopbackTarget,
        ) -> Result<
            (
                AudioSourceRuntimeState,
                IAudioClient,
                IAudioCaptureClient,
                u16,
                bool,
            ),
            CaptureError,
        > {
            let map_err = |e: ::windows::core::Error| CaptureError::StreamFailed {
                message: e.to_string(),
            };

            let (audio_client, device_id, device_name) = match target {
                LoopbackTarget::Process(process_id) => (
                    activate_process_loopback_client(*process_id, false)?,
                    source.capture_device_id.clone(),
                    Some(format!("Process {process_id}")),
                ),
                LoopbackTarget::SystemOutputExcludingProcess(process_id) => (
                    activate_process_loopback_client(*process_id, true)?,
                    source.capture_device_id.clone(),
                    Some("System audio (Raven excluded)".to_string()),
                ),
            };

            // Prefer WebRTC's native format so shared audio is published untouched; fall
            // back to the format the virtual loopback device is documented with.
            let mut initialized = None;
            let mut last_error = None;
            for format in loopback_capture_formats() {
                match audio_client.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK,
                    2_000_000,
                    0,
                    &format,
                    None,
                ) {
                    Ok(()) => {
                        initialized = Some(format);
                        break;
                    }
                    Err(error) => last_error = Some(error),
                }
            }
            let Some(format) = initialized else {
                return Err(match last_error {
                    Some(error) => map_err(error),
                    None => CaptureError::StreamFailed {
                        message: "no loopback capture format is available".to_string(),
                    },
                });
            };
            let sample_rate = format.nSamplesPerSec;
            let channel_count = format.nChannels;
            let is_float = format.wFormatTag == WAVE_FORMAT_IEEE_FLOAT_TAG;

            let capture_client: IAudioCaptureClient = audio_client.GetService().map_err(map_err)?;
            audio_client.Start().map_err(map_err)?;

            let state = running_runtime_state(
                source,
                sample_rate,
                channel_count,
                if is_float {
                    AudioSampleFormat::F32
                } else {
                    AudioSampleFormat::I16
                },
                device_id,
                device_name,
            );
            Ok((state, audio_client, capture_client, channel_count, is_float))
        }

        unsafe fn activate_process_loopback_client(
            process_id: u32,
            exclude: bool,
        ) -> Result<IAudioClient, CaptureError> {
            let map_err = |e: ::windows::core::Error| CaptureError::StreamFailed {
                message: e.to_string(),
            };
            let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
                ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
                Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                    ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                        TargetProcessId: process_id,
                        ProcessLoopbackMode: if exclude {
                            PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
                        } else {
                            PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                        },
                    },
                },
            };
            let prop_var = BlobPropVar {
                vt: 65, // VT_BLOB
                reserved: [0; 3],
                cb_size: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                pad: 0,
                p_data: &mut params as *mut _ as *mut u8,
            };

            let event = CreateEventW(None, false, false, None).map_err(map_err)?;
            let callback: IActivateAudioInterfaceCompletionHandler = ActivationCallback {
                event: SendHandle(event),
            }
            .into();

            let op = ActivateAudioInterfaceAsync(
                VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                &IAudioClient::IID,
                Some(&prop_var as *const BlobPropVar as *const _),
                &callback,
            )
            .map_err(map_err)?;

            WaitForSingleObject(event, INFINITE);
            let _ = CloseHandle(event);

            let mut activate_hr = ::windows::core::HRESULT(0);
            let mut iface: Option<::windows::core::IUnknown> = None;
            op.GetActivateResult(&mut activate_hr, &mut iface)
                .map_err(map_err)?;
            if activate_hr.is_err() {
                return Err(CaptureError::StreamFailed {
                    message: format!("process loopback activation failed: {:?}", activate_hr),
                });
            }
            iface
                .ok_or(CaptureError::StreamFailed {
                    message: "activation returned no interface".to_string(),
                })?
                .cast()
                .map_err(map_err)
        }

        const WAVE_FORMAT_IEEE_FLOAT_TAG: u16 = 3;

        /// Capture formats to request from the process-loopback device, best first:
        /// 48 kHz float stereo (no conversion before publishing), then 44.1 kHz 16-bit.
        fn loopback_capture_formats() -> [WAVEFORMATEX; 2] {
            let format = |tag: u16, sample_rate: u32, bits: u16| {
                const CHANNELS: u16 = 2;
                let block_align = CHANNELS * (bits / 8);
                WAVEFORMATEX {
                    wFormatTag: tag,
                    nChannels: CHANNELS,
                    nSamplesPerSec: sample_rate,
                    nAvgBytesPerSec: sample_rate * block_align as u32,
                    nBlockAlign: block_align,
                    wBitsPerSample: bits,
                    cbSize: 0,
                }
            };
            [
                format(WAVE_FORMAT_IEEE_FLOAT_TAG, 48_000, 32),
                format(WAVE_FORMAT_PCM as u16, 44_100, 16),
            ]
        }

        enum LoopbackExit {
            Stopped,
            Failed(String),
        }

        // Safety: called from the COM-initialized capture thread only.
        unsafe fn run_capture_polling_loop(
            capture_client: &IAudioCaptureClient,
            channel_count: u16,
            is_float: bool,
            processing: &mut SourceProcessingConfig,
            sender: &std::sync::mpsc::SyncSender<CaptureEvent>,
            stop_receiver: &std::sync::mpsc::Receiver<()>,
        ) -> LoopbackExit {
            let mut last_meter = Instant::now();
            loop {
                match stop_receiver.try_recv() {
                    Ok(_) | Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        return LoopbackExit::Stopped
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => {}
                }
                let packet_size = match capture_client.GetNextPacketSize() {
                    Ok(n) => n,
                    Err(error) => {
                        return LoopbackExit::Failed(format!(
                            "system audio capture stopped: {error}"
                        ))
                    }
                };
                if packet_size == 0 {
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }
                let mut data_ptr: *mut u8 = std::ptr::null_mut();
                let mut frames_available = 0u32;
                let mut flags = 0u32;
                if let Err(error) = capture_client.GetBuffer(
                    &mut data_ptr,
                    &mut frames_available,
                    &mut flags,
                    None,
                    None,
                ) {
                    return LoopbackExit::Failed(format!("system audio capture stopped: {error}"));
                }
                if frames_available > 0 {
                    let is_silent = flags & 2 != 0; // AUDCLNT_BUFFERFLAGS_SILENT
                    let sample_count = frames_available as usize * channel_count as usize;
                    let mut samples: Vec<f32> = if is_silent {
                        vec![0.0f32; sample_count]
                    } else if is_float {
                        std::slice::from_raw_parts(data_ptr as *const f32, sample_count).to_vec()
                    } else {
                        std::slice::from_raw_parts(data_ptr as *const i16, sample_count)
                            .iter()
                            .map(|&s| s as f32 / i16::MAX as f32)
                            .collect()
                    };
                    if let Ok(analysis) = process_source_samples(processing, &mut samples) {
                        if last_meter.elapsed() >= METER_INTERVAL {
                            let _ = sender.try_send(CaptureEvent::Health(analysis));
                            last_meter = Instant::now();
                        }
                    }
                }
                let _ = capture_client.ReleaseBuffer(frames_available);
            }
        }

        pub fn list_app_audio_sources() -> Result<Vec<AppAudioSource>, CaptureError> {
            let mut sources: Vec<AppAudioSource> = Vec::new();
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                let result = collect_app_audio_sources(&mut sources);
                collect_visible_app_processes(&mut sources);
                CoUninitialize();
                result?;
            }
            sources.sort_by(|a, b| {
                b.has_audio_session
                    .cmp(&a.has_audio_session)
                    .then_with(|| a.display_name.cmp(&b.display_name))
            });
            Ok(sources)
        }

        pub fn list_output_devices() -> Result<Vec<AudioOutputDevice>, CaptureError> {
            let mut devices = Vec::new();
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                let result = collect_output_devices(&mut devices);
                CoUninitialize();
                result?;
            }
            Ok(devices)
        }

        unsafe fn collect_output_devices(
            out: &mut Vec<AudioOutputDevice>,
        ) -> Result<(), CaptureError> {
            let map_err = |e: ::windows::core::Error| CaptureError::StreamFailed {
                message: e.to_string(),
            };

            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(map_err)?;
            let default_id = enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .ok()
                .and_then(|device| device_id_string(&device));
            let collection = enumerator
                .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
                .map_err(map_err)?;
            let count = collection.GetCount().map_err(map_err)?;

            for i in 0..count {
                let device = collection.Item(i).map_err(map_err)?;
                let Some(device_id) = device_id_string(&device) else {
                    continue;
                };
                let name =
                    device_friendly_name(&device).unwrap_or_else(|| "Audio output".to_string());
                let config = output_device_mix_config(&device).unwrap_or_default();
                out.push(AudioOutputDevice {
                    is_default: default_id.as_deref() == Some(device_id.as_str()),
                    device_id,
                    name,
                    sample_rate: config.sample_rate,
                    channel_count: config.channel_count,
                    format: config.format,
                });
            }
            out.sort_by(|a, b| {
                b.is_default
                    .cmp(&a.is_default)
                    .then_with(|| a.name.cmp(&b.name))
            });
            Ok(())
        }

        #[derive(Default)]
        struct OutputDeviceMixConfig {
            sample_rate: Option<u32>,
            channel_count: Option<u16>,
            format: AudioSampleFormat,
        }

        unsafe fn output_device_mix_config(device: &IMMDevice) -> Option<OutputDeviceMixConfig> {
            let audio_client: IAudioClient = device.Activate(CLSCTX_ALL, None).ok()?;
            let format_ptr = audio_client.GetMixFormat().ok()?;
            let format = &*format_ptr;
            let config = OutputDeviceMixConfig {
                sample_rate: Some(format.nSamplesPerSec),
                channel_count: Some(format.nChannels),
                format: if format.wBitsPerSample == 32 {
                    AudioSampleFormat::F32
                } else if format.wBitsPerSample == 16 {
                    AudioSampleFormat::I16
                } else {
                    AudioSampleFormat::Unknown
                },
            };
            CoTaskMemFree(Some(format_ptr as *mut _));
            Some(config)
        }

        unsafe fn device_id_string(device: &IMMDevice) -> Option<String> {
            let id: PWSTR = device.GetId().ok()?;
            let value = pwstr_to_string(id);
            CoTaskMemFree(Some(id.0 as *mut _));
            value
        }

        unsafe fn device_friendly_name(device: &IMMDevice) -> Option<String> {
            let store = device.OpenPropertyStore(STGM_READ).ok()?;
            let mut value = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
            let display = PSFormatForDisplayAlloc(&PKEY_Device_FriendlyName, &value, PDFF_DEFAULT)
                .ok()
                .and_then(|ptr| {
                    let text = pwstr_to_string(ptr);
                    CoTaskMemFree(Some(ptr.0 as *mut _));
                    text
                });
            let _ = PropVariantClear(&mut value);
            display
        }

        unsafe fn pwstr_to_string(value: PWSTR) -> Option<String> {
            if value.is_null() {
                return None;
            }
            let mut len = 0usize;
            while *value.0.add(len) != 0 {
                len += 1;
            }
            if len == 0 {
                return None;
            }
            Some(String::from_utf16_lossy(std::slice::from_raw_parts(
                value.0, len,
            )))
        }

        unsafe fn collect_app_audio_sources(
            out: &mut Vec<AppAudioSource>,
        ) -> Result<(), CaptureError> {
            let map_err = |e: ::windows::core::Error| CaptureError::StreamFailed {
                message: e.to_string(),
            };

            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(map_err)?;
            let device = enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(map_err)?;
            let session_manager: IAudioSessionManager2 =
                device.Activate(CLSCTX_ALL, None).map_err(map_err)?;
            let session_enumerator: IAudioSessionEnumerator =
                session_manager.GetSessionEnumerator().map_err(map_err)?;
            let count = session_enumerator.GetCount().map_err(map_err)?;

            // Walk every audio session on the default render endpoint, regardless of
            // state (active OR inactive). A single misbehaving session must never abort
            // the whole enumeration, so per-session failures are skipped, not propagated
            // up via `?` — otherwise one bad session would empty the entire dropdown.
            for i in 0..count {
                let Ok(control) = session_enumerator.GetSession(i) else {
                    continue;
                };
                let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                    continue;
                };
                let pid = match control2.GetProcessId() {
                    Ok(p) if p != 0 => p,
                    _ => continue, // system / ownerless session
                };
                let Some(source) = build_app_source(pid, &control2) else {
                    continue;
                };
                // Collapse the many sessions a single app can own (e.g. Chrome's audio
                // service utility process plus per-renderer sessions) into one entry,
                // keyed by executable name.
                if out
                    .iter()
                    .any(|existing| existing.exe_name.eq_ignore_ascii_case(&source.exe_name))
                {
                    continue;
                }
                out.push(source);
            }
            Ok(())
        }

        unsafe fn collect_visible_app_processes(out: &mut Vec<AppAudioSource>) {
            unsafe extern "system" fn enum_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
                let out = &mut *(lparam.0 as *mut Vec<AppAudioSource>);
                if !IsWindowVisible(hwnd).as_bool() || GetWindowTextLengthW(hwnd) <= 0 {
                    return true.into();
                }

                let mut process_id = 0u32;
                GetWindowThreadProcessId(hwnd, Some(&mut process_id));
                if process_id == 0 {
                    return true.into();
                }

                if let Some(source) = build_app_source_from_process(process_id, false) {
                    merge_app_source(out, source);
                }
                true.into()
            }

            let out_ptr = out as *mut Vec<AppAudioSource>;
            let _ = EnumWindows(Some(enum_window), LPARAM(out_ptr as isize));
        }

        unsafe fn build_app_source(
            process_id: u32,
            control2: &IAudioSessionControl2,
        ) -> Option<AppAudioSource> {
            // Preferred: resolve the process image path (also lets us load an icon).
            // Fallback: sandboxed audio hosts (notably Chrome's audio service) refuse
            // OpenProcess/QueryFullProcessImageNameW, so we parse the executable path out
            // of the WASAPI session identifier instead of silently dropping the app.
            let exe_path = process_image_path(process_id)
                .or_else(|| exe_path_from_session_identifier(control2))?;
            build_app_source_from_path(process_id, exe_path, true)
        }

        unsafe fn build_app_source_from_process(
            process_id: u32,
            has_audio_session: bool,
        ) -> Option<AppAudioSource> {
            let exe_path = process_image_path(process_id)?;
            build_app_source_from_path(process_id, exe_path, has_audio_session)
        }

        unsafe fn build_app_source_from_path(
            process_id: u32,
            exe_path: String,
            has_audio_session: bool,
        ) -> Option<AppAudioSource> {
            let exe_name = file_stem_from_path(&exe_path)?;
            let display_name = friendly_name_from_stem(&exe_name);
            let icon_data_url = if exe_path.starts_with("\\Device\\") {
                None // device-relative path; SHGetFileInfoW can't load an icon from it
            } else {
                extract_icon_data_url(&exe_path)
            };
            Some(AppAudioSource {
                process_id,
                exe_name,
                display_name,
                icon_data_url,
                has_audio_session,
            })
        }

        fn merge_app_source(out: &mut Vec<AppAudioSource>, source: AppAudioSource) {
            if let Some(existing) = out
                .iter_mut()
                .find(|existing| existing.exe_name.eq_ignore_ascii_case(&source.exe_name))
            {
                if source.has_audio_session && !existing.has_audio_session {
                    existing.process_id = source.process_id;
                    existing.has_audio_session = true;
                }
                if existing.icon_data_url.is_none() {
                    existing.icon_data_url = source.icon_data_url;
                }
                return;
            }
            out.push(source);
        }

        unsafe fn process_image_path(process_id: u32) -> Option<String> {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;
            let mut path_buf = vec![0u16; 1024];
            let mut size = path_buf.len() as u32;
            let ok = QueryFullProcessImageNameW(
                handle,
                Default::default(),
                ::windows::core::PWSTR(path_buf.as_mut_ptr()),
                &mut size,
            )
            .is_ok();
            let _ = CloseHandle(handle);
            if !ok || size == 0 {
                return None;
            }
            Some(String::from_utf16_lossy(&path_buf[..size as usize]))
        }

        unsafe fn exe_path_from_session_identifier(
            control2: &IAudioSessionControl2,
        ) -> Option<String> {
            let raw: PWSTR = control2.GetSessionIdentifier().ok()?;
            let identifier = pwstr_to_string(raw);
            CoTaskMemFree(Some(raw.0 as *mut _));
            let identifier = identifier?;
            // Identifier looks like:
            //   {0.0.0...}.{guid}|\Device\HarddiskVolumeN\...\chrome.exe%b{guid}
            // Slice out the embedded executable path (everything up to ".exe").
            let exe_end = identifier.to_ascii_lowercase().find(".exe")? + 4;
            let path_part = &identifier[..exe_end];
            let start = path_part.rfind('|').map(|i| i + 1).unwrap_or(0);
            Some(path_part[start..].to_string())
        }

        fn file_stem_from_path(path: &str) -> Option<String> {
            let name = path.rsplit(['\\', '/']).next().unwrap_or(path);
            let stem = if name.to_ascii_lowercase().ends_with(".exe") {
                &name[..name.len() - 4]
            } else {
                name
            };
            if stem.is_empty() {
                None
            } else {
                Some(stem.to_string())
            }
        }

        fn friendly_name_from_stem(stem: &str) -> String {
            let mut chars = stem.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => stem.to_string(),
            }
        }

        unsafe fn extract_icon_data_url(exe_path: &str) -> Option<String> {
            let path_wide: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();
            let mut file_info: SHFILEINFOW = std::mem::zeroed();
            let result = SHGetFileInfoW(
                ::windows::core::PCWSTR(path_wide.as_ptr()),
                Default::default(),
                Some(&mut file_info),
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON,
            );
            if result == 0 || file_info.hIcon.is_invalid() {
                return None;
            }
            let icon = file_info.hIcon;
            let icon_data = icon_to_png_data_url(icon);
            let _ = DestroyIcon(icon);
            icon_data
        }

        unsafe fn icon_to_png_data_url(
            icon: ::windows::Win32::UI::WindowsAndMessaging::HICON,
        ) -> Option<String> {
            const SIZE: i32 = 32;
            let screen_dc = CreateCompatibleDC(None);
            if screen_dc.is_invalid() {
                return None;
            }

            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: SIZE,
                    biHeight: -SIZE,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    biSizeImage: (SIZE * SIZE * 4) as u32,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                bmiColors: [Default::default()],
            };
            let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
            let bmp = CreateDIBSection(screen_dc, &bmi, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
            if bmp.is_invalid() {
                let _ = DeleteDC(screen_dc);
                return None;
            }
            if bits.is_null() {
                let _ = DeleteObject(bmp);
                let _ = DeleteDC(screen_dc);
                return None;
            }

            let pixel_len = (SIZE * SIZE * 4) as usize;
            std::ptr::write_bytes(bits, 0, pixel_len);

            let old = SelectObject(screen_dc, bmp);
            let draw_result = DrawIconEx(screen_dc, 0, 0, icon, SIZE, SIZE, 0, None, DI_NORMAL);
            let pixels = std::slice::from_raw_parts(bits as *const u8, pixel_len).to_vec();

            let _ = SelectObject(screen_dc, old);
            let _ = DeleteObject(bmp);
            let _ = DeleteDC(screen_dc);

            if draw_result.is_err() {
                return None;
            }

            let has_alpha = pixels.chunks_exact(4).any(|pixel| pixel[3] != 0);
            let mut rgba = Vec::with_capacity(pixel_len);
            for pixel in pixels.chunks_exact(4) {
                let blue = pixel[0];
                let green = pixel[1];
                let red = pixel[2];
                let alpha = if has_alpha {
                    pixel[3]
                } else if red != 0 || green != 0 || blue != 0 {
                    255
                } else {
                    0
                };
                rgba.extend_from_slice(&[red, green, blue, alpha]);
            }
            let png_bytes = encode_png_rgba(&rgba, SIZE as u32, SIZE as u32)?;
            let encoded = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
            Some(format!("data:image/png;base64,{encoded}"))
        }

        fn encode_png_rgba(rgba: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
            let mut out = Vec::new();
            {
                let mut encoder = png::Encoder::new(&mut out, width, height);
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                let mut writer = encoder.write_header().ok()?;
                writer.write_image_data(rgba).ok()?;
            }
            Some(out)
        }
    }

    #[cfg(target_os = "macos")]
    pub mod macos {
        use super::*;

        use crate::audio::domain::AppAudioSource;
        use screencapturekit::prelude::*;

        const MACOS_CAPTURE_SAMPLE_RATE: u32 = 48_000;
        const MACOS_CAPTURE_CHANNELS: u16 = 2;
        const MACOS_CAPTURE_FORMAT: AudioSampleFormat = AudioSampleFormat::F32;

        pub struct MacOsLoopbackCaptureAdapter;

        impl AudioCaptureAdapter for MacOsLoopbackCaptureAdapter {
            fn start(
                &self,
                request: AudioCaptureStartRequest,
            ) -> Result<Box<dyn AudioSourceRuntime>, CaptureError> {
                start_screencapturekit_audio_capture(request, MacOsAudioTarget::System)
            }
        }

        pub struct MacOsAppAudioCaptureAdapter {
            pub process_id: u32,
        }

        impl AudioCaptureAdapter for MacOsAppAudioCaptureAdapter {
            fn start(
                &self,
                request: AudioCaptureStartRequest,
            ) -> Result<Box<dyn AudioSourceRuntime>, CaptureError> {
                start_screencapturekit_audio_capture(
                    request,
                    MacOsAudioTarget::Application {
                        process_id: self.process_id,
                    },
                )
            }
        }

        enum MacOsAudioTarget {
            System,
            Application { process_id: u32 },
        }

        #[derive(Debug)]
        struct ScreenCaptureKitAudioRuntime {
            source_id: AudioSourceId,
            signature: CaptureConfigSignature,
            state: AudioSourceRuntimeState,
            stream: Option<SCStream>,
        }

        impl AudioSourceRuntime for ScreenCaptureKitAudioRuntime {
            fn source_id(&self) -> AudioSourceId {
                self.source_id
            }

            fn stop(&mut self) {
                if let Some(stream) = self.stream.take() {
                    let _ = stream.stop_capture();
                }
            }

            fn runtime_state(&self) -> AudioSourceRuntimeState {
                self.state.clone()
            }

            fn config_signature(&self) -> &CaptureConfigSignature {
                &self.signature
            }
        }

        impl Drop for ScreenCaptureKitAudioRuntime {
            fn drop(&mut self) {
                self.stop();
            }
        }

        struct MacOsAudioHandler {
            state: Mutex<MacOsAudioHandlerState>,
            sender: SyncSender<CaptureEvent>,
            source_id: AudioSourceId,
        }

        struct MacOsAudioHandlerState {
            processing: SourceProcessingConfig,
            last_meter: Instant,
        }

        impl SCStreamOutputTrait for MacOsAudioHandler {
            fn did_output_sample_buffer(
                &self,
                sample_buffer: CMSampleBuffer,
                of_type: SCStreamOutputType,
            ) {
                if of_type != SCStreamOutputType::Audio {
                    return;
                }
                let Some(mut samples) = audio_samples_from_sample_buffer(&sample_buffer) else {
                    return;
                };
                let Ok(mut state) = self.state.lock() else {
                    return;
                };
                let MacOsAudioHandlerState {
                    processing,
                    last_meter,
                } = &mut *state;
                handle_input_block(
                    processing,
                    &mut samples,
                    &self.sender,
                    last_meter,
                    self.source_id,
                );
            }
        }

        fn start_screencapturekit_audio_capture(
            request: AudioCaptureStartRequest,
            target: MacOsAudioTarget,
        ) -> Result<Box<dyn AudioSourceRuntime>, CaptureError> {
            let signature = CaptureConfigSignature::from_source(&request.source);
            let source_id = request.source.id;
            let (filter, device_id, device_name) = content_filter_for_audio_target(
                &target,
                request.source.capture_device_id.as_deref(),
            )?;

            let mut processing_source = request.source.clone();
            processing_source.runtime.channel_count = Some(MACOS_CAPTURE_CHANNELS);
            let processing = SourceProcessingConfig::from_source(
                &processing_source,
                Arc::clone(&request.controls),
                MACOS_CAPTURE_SAMPLE_RATE,
                Arc::clone(&request.render_reference),
            )?;

            let (event_sender, event_receiver) = sync_channel(CAPTURE_EVENT_CAPACITY);
            spawn_capture_event_pump(
                request.app.clone(),
                Arc::clone(&request.shared_state),
                source_id,
                event_receiver,
            );

            let config = SCStreamConfiguration::new()
                .with_width(2)
                .with_height(2)
                .with_pixel_format(PixelFormat::BGRA)
                .with_queue_depth(3)
                .with_captures_audio(true)
                .with_excludes_current_process_audio(true)
                .with_sample_rate(MACOS_CAPTURE_SAMPLE_RATE as i32)
                .with_channel_count(MACOS_CAPTURE_CHANNELS as i32);

            let mut stream = SCStream::new(&filter, &config);
            let handler = MacOsAudioHandler {
                state: Mutex::new(MacOsAudioHandlerState {
                    processing,
                    last_meter: Instant::now(),
                }),
                sender: event_sender,
                source_id,
            };
            if stream
                .add_output_handler(handler, SCStreamOutputType::Audio)
                .is_none()
            {
                return Err(CaptureError::StreamFailed {
                    message: "ScreenCaptureKit rejected the audio output handler".to_string(),
                });
            }
            stream
                .start_capture()
                .map_err(|error| CaptureError::StreamFailed {
                    message: format!(
                        "failed to start macOS ScreenCaptureKit audio capture: {error}"
                    ),
                })?;

            Ok(Box::new(ScreenCaptureKitAudioRuntime {
                source_id,
                signature,
                state: running_runtime_state(
                    &request.source,
                    MACOS_CAPTURE_SAMPLE_RATE,
                    MACOS_CAPTURE_CHANNELS,
                    MACOS_CAPTURE_FORMAT,
                    device_id,
                    device_name,
                ),
                stream: Some(stream),
            }))
        }

        fn content_filter_for_audio_target(
            target: &MacOsAudioTarget,
            selected_device_name: Option<&str>,
        ) -> Result<(SCContentFilter, Option<String>, Option<String>), CaptureError> {
            let content = shareable_content()?;
            let display = content.displays().into_iter().next().ok_or_else(|| {
                CaptureError::DeviceUnavailable {
                    message: "ScreenCaptureKit reported no capturable displays".to_string(),
                }
            })?;

            match target {
                MacOsAudioTarget::System => {
                    let filter = SCContentFilter::create()
                        .with_display(&display)
                        .with_excluding_windows(&[])
                        .build();
                    let name = selected_device_name
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or("System audio")
                        .to_string();
                    Ok((
                        filter,
                        selected_device_name.map(ToOwned::to_owned),
                        Some(name),
                    ))
                }
                MacOsAudioTarget::Application { process_id } => {
                    let app = content
                        .applications()
                        .into_iter()
                        .find(|app| app.process_id() == *process_id as i32)
                        .ok_or_else(|| CaptureError::DeviceUnavailable {
                            message: format!(
                                "no ScreenCaptureKit application found for process {process_id}"
                            ),
                        })?;
                    let name = app.application_name();
                    let filter = SCContentFilter::create()
                        .with_display(&display)
                        .with_including_applications(&[&app], &[])
                        .build();
                    Ok((filter, Some(process_id.to_string()), Some(name)))
                }
            }
        }

        fn shareable_content() -> Result<SCShareableContent, CaptureError> {
            SCShareableContent::create()
                .with_exclude_desktop_windows(true)
                .with_on_screen_windows_only(true)
                .get()
                .map_err(|error| CaptureError::DeviceUnavailable {
                    message: format!(
                        "ScreenCaptureKit shareable content is unavailable. Grant Screen & System Audio Recording permission and restart Raven: {error}"
                    ),
                })
        }

        fn audio_samples_from_sample_buffer(sample: &CMSampleBuffer) -> Option<Vec<f32>> {
            let buffers = sample.audio_buffer_list()?;
            if buffers.num_buffers() == 0 {
                return None;
            }

            if buffers.num_buffers() == 1 {
                let buffer = buffers.get(0)?;
                return f32_samples_from_bytes(buffer.data());
            }

            let channels: Vec<Vec<f32>> = buffers
                .iter()
                .filter_map(|buffer| f32_samples_from_bytes(buffer.data()))
                .collect();
            if channels.is_empty() {
                return None;
            }
            let frames = channels.iter().map(Vec::len).min().unwrap_or(0);
            if frames == 0 {
                return None;
            }

            let mut interleaved = Vec::with_capacity(frames * channels.len());
            for frame in 0..frames {
                for channel in &channels {
                    interleaved.push(channel[frame]);
                }
            }
            Some(interleaved)
        }

        fn f32_samples_from_bytes(bytes: &[u8]) -> Option<Vec<f32>> {
            if bytes.is_empty() || bytes.len() % std::mem::size_of::<f32>() != 0 {
                return None;
            }
            Some(
                bytes
                    .chunks_exact(std::mem::size_of::<f32>())
                    .map(|chunk| f32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                    .collect(),
            )
        }

        pub fn list_app_audio_sources() -> Result<Vec<AppAudioSource>, CaptureError> {
            let content = shareable_content()?;
            let mut apps: Vec<AppAudioSource> = content
                .applications()
                .into_iter()
                .filter_map(|app| {
                    let process_id = u32::try_from(app.process_id()).ok()?;
                    if process_id == 0 {
                        return None;
                    }
                    let display_name = app.application_name();
                    if display_name.trim().is_empty() {
                        return None;
                    }
                    let bundle_id = app.bundle_identifier();
                    Some(AppAudioSource {
                        process_id,
                        exe_name: if bundle_id.trim().is_empty() {
                            display_name.clone()
                        } else {
                            bundle_id
                        },
                        display_name,
                        icon_data_url: None,
                        has_audio_session: true,
                    })
                })
                .collect();

            apps.sort_by(|a, b| {
                a.display_name
                    .to_lowercase()
                    .cmp(&b.display_name.to_lowercase())
                    .then(a.process_id.cmp(&b.process_id))
            });
            apps.dedup_by_key(|app| app.process_id);
            Ok(apps)
        }
    }

    #[cfg(target_os = "linux")]
    pub mod linux {
        use super::*;
        use std::io::Read;
        use std::process::{Child, ChildStdout, Command, Stdio};
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Mutex};
        use std::thread::{self, JoinHandle};

        pub struct LinuxLoopbackCaptureAdapter;

        impl AudioCaptureAdapter for LinuxLoopbackCaptureAdapter {
            fn start(
                &self,
                request: AudioCaptureStartRequest,
            ) -> Result<Box<dyn AudioSourceRuntime>, CaptureError> {
                start_pipewire_loopback_capture(request)
            }
        }

        const LOOPBACK_SAMPLE_RATE: u32 = 48_000;
        const LOOPBACK_CHANNELS: u16 = 2;
        const LOOPBACK_FORMAT: AudioSampleFormat = AudioSampleFormat::F32;

        pub fn runtime_readiness() -> Result<(), String> {
            if !command_available("pw-record") {
                return Err(
                    "System audio needs PipeWire tools (`pw-record`). Install `pipewire-bin`."
                        .to_string(),
                );
            }
            match list_output_devices() {
                Some(devices) if !devices.is_empty() => Ok(()),
                _ => {
                    Err("System audio needs a running PipeWire session and `pw-dump`.".to_string())
                }
            }
        }

        fn command_available(command: &str) -> bool {
            std::env::var_os("PATH")
                .map(|paths| std::env::split_paths(&paths).any(|path| path.join(command).is_file()))
                .unwrap_or(false)
        }

        #[derive(Debug)]
        struct PipeWireLoopbackRuntime {
            source_id: AudioSourceId,
            signature: CaptureConfigSignature,
            state: AudioSourceRuntimeState,
            stop: Arc<AtomicBool>,
            child: Arc<Mutex<Option<Child>>>,
            handle: Option<JoinHandle<()>>,
        }

        impl AudioSourceRuntime for PipeWireLoopbackRuntime {
            fn source_id(&self) -> AudioSourceId {
                self.source_id
            }

            fn stop(&mut self) {
                self.stop.store(true, Ordering::Relaxed);
                stop_child(&self.child);
                if let Some(handle) = self.handle.take() {
                    let _ = handle.join();
                }
            }

            fn runtime_state(&self) -> AudioSourceRuntimeState {
                self.state.clone()
            }

            fn config_signature(&self) -> &CaptureConfigSignature {
                &self.signature
            }
        }

        impl Drop for PipeWireLoopbackRuntime {
            fn drop(&mut self) {
                self.stop();
            }
        }

        fn start_pipewire_loopback_capture(
            request: AudioCaptureStartRequest,
        ) -> Result<Box<dyn AudioSourceRuntime>, CaptureError> {
            let signature = CaptureConfigSignature::from_source(&request.source);
            let source_id = request.source.id;
            let target = resolve_loopback_target(request.source.capture_device_id.as_deref())?;

            let mut processing_source = request.source.clone();
            processing_source.runtime.channel_count = Some(LOOPBACK_CHANNELS);
            let processing = SourceProcessingConfig::from_source(
                &processing_source,
                Arc::clone(&request.controls),
                LOOPBACK_SAMPLE_RATE,
                Arc::clone(&request.render_reference),
            )?;

            let (event_sender, event_receiver) = sync_channel(CAPTURE_EVENT_CAPACITY);
            spawn_capture_event_pump(
                request.app.clone(),
                Arc::clone(&request.shared_state),
                source_id,
                event_receiver,
            );

            let (child, stdout) = spawn_pw_record(target.as_deref())?;
            let stop = Arc::new(AtomicBool::new(false));
            let child = Arc::new(Mutex::new(Some(child)));
            let thread_stop = Arc::clone(&stop);
            let thread_child = Arc::clone(&child);
            let handle = thread::spawn(move || {
                read_pipewire_audio(
                    stdout,
                    processing,
                    event_sender,
                    source_id,
                    Arc::clone(&thread_stop),
                );
                thread_stop.store(true, Ordering::Relaxed);
                stop_child(&thread_child);
            });

            Ok(Box::new(PipeWireLoopbackRuntime {
                source_id,
                signature,
                state: running_runtime_state(
                    &request.source,
                    LOOPBACK_SAMPLE_RATE,
                    LOOPBACK_CHANNELS,
                    LOOPBACK_FORMAT,
                    target.clone(),
                    Some(
                        target
                            .as_deref()
                            .map(display_name_for_target)
                            .unwrap_or_else(|| "Default system audio".to_string()),
                    ),
                ),
                stop,
                child,
                handle: Some(handle),
            }))
        }

        fn spawn_pw_record(target: Option<&str>) -> Result<(Child, ChildStdout), CaptureError> {
            let mut command = Command::new("pw-record");
            command
                .arg("--record")
                .arg("--raw")
                .arg("--format=f32")
                .arg(format!("--rate={LOOPBACK_SAMPLE_RATE}"))
                .arg(format!("--channels={LOOPBACK_CHANNELS}"))
                .arg(r#"--properties={"stream.capture.sink":true}"#);
            if let Some(target) = target {
                command.arg(format!("--target={target}"));
            }
            let mut child = command
                .arg("-")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| CaptureError::StreamFailed {
                    message: format!(
                        "failed to launch pw-record for PipeWire system audio: {error}. \
                         Install PipeWire tools and ensure a session manager is running."
                    ),
                })?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| CaptureError::StreamFailed {
                    message: "PipeWire recorder did not expose stdout".to_string(),
                })?;
            Ok((child, stdout))
        }

        fn read_pipewire_audio(
            mut stdout: ChildStdout,
            mut processing: SourceProcessingConfig,
            sender: SyncSender<CaptureEvent>,
            source_id: AudioSourceId,
            stop: Arc<AtomicBool>,
        ) {
            let mut pending = Vec::with_capacity(16 * 1024);
            let mut chunk = [0u8; 16 * 1024];
            let mut last_meter = Instant::now();

            while !stop.load(Ordering::Relaxed) {
                let read = match stdout.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => read,
                    Err(error) => {
                        let _ = sender.try_send(CaptureEvent::Error(format!(
                            "PipeWire system audio read failed: {error}"
                        )));
                        break;
                    }
                };
                pending.extend_from_slice(&chunk[..read]);
                let complete_len = pending.len() - (pending.len() % std::mem::size_of::<f32>());
                if complete_len == 0 {
                    continue;
                }
                let complete: Vec<u8> = pending.drain(..complete_len).collect();
                let mut samples = Vec::with_capacity(complete.len() / std::mem::size_of::<f32>());
                for bytes in complete.chunks_exact(std::mem::size_of::<f32>()) {
                    samples.push(f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]));
                }
                handle_input_block(
                    &mut processing,
                    &mut samples,
                    &sender,
                    &mut last_meter,
                );
            }

            if !stop.load(Ordering::Relaxed) {
                let _ = sender.try_send(CaptureEvent::Error(
                    "PipeWire system audio stream ended".to_string(),
                ));
            }
        }

        fn stop_child(child: &Arc<Mutex<Option<Child>>>) {
            let Ok(mut guard) = child.lock() else {
                return;
            };
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }

        pub fn list_output_devices() -> Option<Vec<AudioOutputDevice>> {
            let output = Command::new("pw-dump").output().ok()?;
            if !output.status.success() {
                return None;
            }
            let value: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
            let default_sink = default_sink_name();
            let entries = value.as_array()?;
            let mut devices = Vec::new();

            for entry in entries {
                let props = entry
                    .get("info")
                    .and_then(|info| info.get("props"))
                    .and_then(|props| props.as_object());
                let Some(props) = props else {
                    continue;
                };
                if json_str(props, "media.class").as_deref() != Some("Audio/Sink") {
                    continue;
                }
                let node_name = json_str(props, "node.name")
                    .or_else(|| json_str(props, "object.path"))
                    .or_else(|| {
                        entry
                            .get("id")
                            .and_then(|id| id.as_u64())
                            .map(|id| id.to_string())
                    });
                let Some(node_name) = node_name else {
                    continue;
                };
                let display_name = json_str(props, "node.description")
                    .or_else(|| json_str(props, "node.nick"))
                    .unwrap_or_else(|| display_name_for_target(&node_name));
                let is_default = default_sink
                    .as_deref()
                    .map(|default| default == node_name)
                    .unwrap_or(false);
                devices.push(AudioOutputDevice {
                    device_id: node_name,
                    name: display_name,
                    is_default,
                    sample_rate: None,
                    channel_count: Some(LOOPBACK_CHANNELS),
                    format: LOOPBACK_FORMAT,
                });
            }

            if !devices.iter().any(|device| device.is_default) {
                if let Some(first) = devices.first_mut() {
                    first.is_default = true;
                }
            }
            Some(devices)
        }

        fn resolve_loopback_target(
            requested_device: Option<&str>,
        ) -> Result<Option<String>, CaptureError> {
            let Some(requested_device) = requested_device.filter(|value| !value.trim().is_empty())
            else {
                return Ok(None);
            };
            let devices = list_output_devices().ok_or_else(|| CaptureError::DeviceUnavailable {
                message: "PipeWire output devices could not be enumerated with pw-dump".to_string(),
            })?;
            let requested_is_default = cpal::default_host()
                .default_output_device()
                .and_then(|device| device.name().ok())
                .map(|name| name.eq_ignore_ascii_case(requested_device))
                .unwrap_or(false);
            devices
                .into_iter()
                .find(|device| {
                    device.device_id.eq_ignore_ascii_case(requested_device)
                        || device.name.eq_ignore_ascii_case(requested_device)
                        || (requested_is_default && device.is_default)
                })
                .map(|device| Some(device.device_id))
                .ok_or_else(|| CaptureError::DeviceUnavailable {
                    message: format!(
                        "selected output `{requested_device}` has no matching PipeWire sink"
                    ),
                })
        }

        fn default_sink_name() -> Option<String> {
            let output = Command::new("pactl")
                .args(["get-default-sink"])
                .output()
                .ok()?;
            if !output.status.success() {
                return None;
            }
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            (!value.is_empty()).then_some(value)
        }

        fn json_str(
            props: &serde_json::Map<String, serde_json::Value>,
            key: &str,
        ) -> Option<String> {
            props
                .get(key)
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .map(ToOwned::to_owned)
        }

        fn display_name_for_target(target: &str) -> String {
            let last = target
                .rsplit(['.', '/', ':'])
                .find(|part| !part.trim().is_empty())
                .unwrap_or(target);
            last.replace('_', " ").replace('-', " ")
        }
    }

    pub mod unsupported {
        use super::*;

        pub struct UnsupportedLoopbackCaptureAdapter;

        impl AudioCaptureAdapter for UnsupportedLoopbackCaptureAdapter {
            fn start(
                &self,
                request: AudioCaptureStartRequest,
            ) -> Result<Box<dyn AudioSourceRuntime>, CaptureError> {
                Err(CaptureError::SourceNotImplemented {
                    source_type: request.source.source_type,
                })
            }
        }

        pub struct UnsupportedAppAudioCaptureAdapter;

        impl AudioCaptureAdapter for UnsupportedAppAudioCaptureAdapter {
            fn start(
                &self,
                request: AudioCaptureStartRequest,
            ) -> Result<Box<dyn AudioSourceRuntime>, CaptureError> {
                Err(CaptureError::SourceNotImplemented {
                    source_type: request.source.source_type,
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::domain::{AudioProcessorKind, AudioProcessorState, ParticipantId};
    use crate::audio::processor::meter_samples;

    #[test]
    fn microphone_agc_uses_active_upstream_style_adaptive_defaults() {
        let config = apm_config(
            &AudioSourceType::Microphone,
            &WebRtcAudioProcessingSettings::default(),
        );
        let agc = config.gain_controller2.expect("AGC2 enabled");
        let adaptive = agc.adaptive_digital.expect("adaptive digital enabled");
        assert!(!agc.input_volume_controller);
        assert_eq!(agc.fixed_digital.gain_db, 0.0);
        assert_eq!(adaptive.headroom_db, 6.0);
        assert_eq!(adaptive.max_gain_db, 30.0);
        assert_eq!(adaptive.initial_gain_db, 8.0);
        assert_eq!(adaptive.max_gain_change_db_per_second, 3.0);
        assert_eq!(adaptive.max_output_noise_level_dbfs, -50.0);
    }

    #[test]
    fn microphone_agc_lifts_quiet_voice_without_clipping_or_hidden_bypass_gain() {
        let render_reference = Arc::new(RenderReference::default());
        let mut runtime = WebRtcApmRuntime::new(
            AudioSourceType::Microphone,
            &WebRtcAudioProcessingSettings {
                noise_suppression: false,
                echo_cancellation: false,
                auto_gain_control: true,
            },
            48_000,
            1,
            Arc::clone(&render_reference),
        )
        .expect("build microphone APM")
        .expect("AGC runtime enabled");
        let mut quiet_voice: Vec<f32> = (0..48_000)
            .map(|sample| {
                let time = sample as f32 / 48_000.0;
                let envelope = 0.65 + 0.35 * (std::f32::consts::TAU * 4.0 * time).sin();
                envelope
                    * 0.008
                    * ((std::f32::consts::TAU * 180.0 * time).sin()
                        + 0.35 * (std::f32::consts::TAU * 360.0 * time).sin())
            })
            .collect();
        let input_rms = meter_samples(&quiet_voice).rms_db.0;
        runtime
            .process_interleaved(&mut quiet_voice)
            .expect("process quiet voice");
        let output = meter_samples(&quiet_voice);
        assert!(output.rms_db.0 > input_rms + 3.0);
        assert!(output.peak_db.0 <= 0.0);

        let bypass = WebRtcApmRuntime::new(
            AudioSourceType::Microphone,
            &WebRtcAudioProcessingSettings {
                noise_suppression: false,
                echo_cancellation: false,
                auto_gain_control: false,
            },
            48_000,
            1,
            render_reference,
        )
        .expect("build bypass");
        assert!(bypass.is_none());
    }

    #[test]
    fn system_share_uses_echo_cancellation_without_voice_gain_or_suppression() {
        let config = apm_config(
            &AudioSourceType::SystemAudio,
            &WebRtcAudioProcessingSettings {
                noise_suppression: false,
                echo_cancellation: true,
                auto_gain_control: false,
            },
        );
        assert!(config.echo_canceller.is_some());
        assert!(config.noise_suppression.is_none());
        assert!(config.gain_controller2.is_none());
        assert!(config.high_pass_filter.is_none());
    }

    #[test]
    fn system_share_echo_path_consumes_raven_render_reference() {
        let render_reference = Arc::new(RenderReference::default());
        let mut runtime = WebRtcApmRuntime::new(
            AudioSourceType::SystemAudio,
            &WebRtcAudioProcessingSettings {
                noise_suppression: false,
                echo_cancellation: true,
                auto_gain_control: false,
            },
            48_000,
            2,
            Arc::clone(&render_reference),
        )
        .expect("build system-audio APM")
        .expect("echo runtime enabled");

        let mut input_echo_energy = 0.0_f32;
        let mut output_echo_energy = 0.0_f32;
        let mut output_program_energy = 0.0_f32;
        for block in 0..300 {
            let mut render = Vec::with_capacity(960);
            let mut capture = Vec::with_capacity(960);
            let mut echo_basis = Vec::with_capacity(960);
            let mut program_basis = Vec::with_capacity(960);
            for frame in 0..480 {
                let sample = block * 480 + frame;
                let time = sample as f32 / 48_000.0;
                let echo = 0.08 * (std::f32::consts::TAU * 440.0 * time).sin();
                let program = 0.02 * (std::f32::consts::TAU * 997.0 * time).sin();
                render.extend_from_slice(&[echo, echo]);
                capture.extend_from_slice(&[echo + program, echo + program]);
                echo_basis.extend_from_slice(&[echo, echo]);
                program_basis.extend_from_slice(&[program, program]);
            }
            render_reference.push_stereo(&render, 48_000);
            runtime
                .process_interleaved(&mut capture)
                .expect("cancel Raven render audio");
            if block >= 200 {
                input_echo_energy += echo_basis.iter().map(|sample| sample * sample).sum::<f32>();
                output_echo_energy += capture
                    .iter()
                    .zip(&echo_basis)
                    .map(|(output, echo)| output * echo)
                    .sum::<f32>()
                    .abs();
                output_program_energy += capture
                    .iter()
                    .zip(&program_basis)
                    .map(|(output, program)| output * program)
                    .sum::<f32>()
                    .abs();
            }
        }
        assert!(output_echo_energy < input_echo_energy * 0.75);
        assert!(output_program_energy > 0.01);
    }

    #[derive(Debug)]
    struct FakeRuntime {
        source_id: AudioSourceId,
        signature: CaptureConfigSignature,
        stopped: Arc<AtomicBool>,
    }

    impl AudioSourceRuntime for FakeRuntime {
        fn source_id(&self) -> AudioSourceId {
            self.source_id
        }

        fn stop(&mut self) {
            self.stopped.store(true, Ordering::Relaxed);
        }

        fn runtime_state(&self) -> AudioSourceRuntimeState {
            AudioSourceRuntimeState {
                status: AudioSourceRuntimeStatus::Running,
                ..AudioSourceRuntimeState::default()
            }
        }

        fn config_signature(&self) -> &CaptureConfigSignature {
            &self.signature
        }
    }

    #[test]
    fn processor_chain_applies_to_capture_samples() {
        let mut gain = AudioProcessorState::new(AudioProcessorKind::Gain, "Gain");
        gain.parameters.gain_db = Some(GainDb::new(-6.0));
        let source = AudioSourceState {
            owner_id: ParticipantId::new(),
            source_type: AudioSourceType::TestTone,
            channel_strip: crate::audio::domain::LocalChannelStripState {
                processor_chain: ProcessorChainState {
                    processors: vec![gain],
                },
                ..crate::audio::domain::LocalChannelStripState::default()
            },
            ..AudioSourceState::default()
        };
        let controls = LiveControls::new(1.0, false);
        let mut processing = SourceProcessingConfig::from_source(
            &source,
            controls,
            48_000,
            Arc::new(RenderReference::default()),
        )
        .expect("build processing config");
        let mut samples = vec![1.0; 480];

        process_source_samples(&mut processing, &mut samples).expect("process samples");

        // The safety limiter's look-ahead delays the output slightly; after it, the
        // chain's -6 dB is what comes out.
        let delay = processing.safety.latency_frames();
        assert!(samples[..delay].iter().all(|sample| *sample == 0.0));
        assert!(samples[delay..]
            .iter()
            .all(|sample| (sample - 0.5011872).abs() < 0.000_01));
    }

    fn tone_source(chain: Vec<AudioProcessorState>) -> AudioSourceState {
        AudioSourceState {
            owner_id: ParticipantId::new(),
            source_type: AudioSourceType::TestTone,
            channel_strip: crate::audio::domain::LocalChannelStripState {
                processor_chain: ProcessorChainState { processors: chain },
                ..crate::audio::domain::LocalChannelStripState::default()
            },
            ..AudioSourceState::default()
        }
    }

    fn steady_output(processing: &mut SourceProcessingConfig, level: f32) -> f32 {
        let mut samples = vec![level; 4_800];
        process_source_samples(processing, &mut samples).expect("process samples");
        *samples.last().expect("samples")
    }

    #[test]
    fn editing_a_processor_does_not_change_the_capture_signature() {
        let mut gain = AudioProcessorState::new(AudioProcessorKind::Gain, "Gain");
        gain.parameters.gain_db = Some(GainDb::new(-6.0));
        let source = tone_source(vec![gain.clone()]);

        let mut edited = source.clone();
        edited.channel_strip.processor_chain.processors[0]
            .parameters
            .gain_db = Some(GainDb::new(-12.0));
        let mut extended = source.clone();
        extended
            .channel_strip
            .processor_chain
            .processors
            .push(AudioProcessorState::new(
                AudioProcessorKind::Compressor,
                "Compressor",
            ));
        let mut ceiling = source.clone();
        ceiling.channel_strip.safety_limiter_ceiling_db = GainDb::new(-3.0);

        let signature = CaptureConfigSignature::from_source(&source);
        assert_eq!(signature, CaptureConfigSignature::from_source(&edited));
        assert_eq!(signature, CaptureConfigSignature::from_source(&extended));
        assert_eq!(signature, CaptureConfigSignature::from_source(&ceiling));
    }

    #[test]
    fn chain_edits_reach_a_running_capture_without_restarting_it() {
        let mut gain = AudioProcessorState::new(AudioProcessorKind::Gain, "Gain");
        gain.parameters.gain_db = Some(GainDb::new(-6.0));
        let source = tone_source(vec![gain.clone()]);
        let controls = LiveControls::new(1.0, false);
        controls.set_chain(&source.channel_strip.processor_chain);
        let mut processing = SourceProcessingConfig::from_source(
            &source,
            Arc::clone(&controls),
            48_000,
            Arc::new(RenderReference::default()),
        )
        .expect("build processing config");
        assert!((steady_output(&mut processing, 0.5) - 0.2505936).abs() < 1e-4);

        // A knob is turned: same processor, new value.
        let mut edited = source.channel_strip.processor_chain.clone();
        edited.processors[0].parameters.gain_db = Some(GainDb::new(-12.0));
        controls.set_chain(&edited);
        assert!((steady_output(&mut processing, 0.5) - 0.1255943).abs() < 1e-4);

        // The processor is switched off, then removed altogether.
        edited.processors[0].enabled = false;
        controls.set_chain(&edited);
        assert!((steady_output(&mut processing, 0.5) - 0.5).abs() < 1e-4);
        controls.set_chain(&ProcessorChainState::default());
        assert!((steady_output(&mut processing, 0.5) - 0.5).abs() < 1e-4);
    }

    #[test]
    fn the_safety_ceiling_follows_the_live_control() {
        let source = tone_source(Vec::new());
        let controls = LiveControls::new(1.0, false);
        let mut processing = SourceProcessingConfig::from_source(
            &source,
            Arc::clone(&controls),
            48_000,
            Arc::new(RenderReference::default()),
        )
        .expect("build processing config");

        controls.set_safety_ceiling_db(GainDb::new(-6.0));
        let limited = steady_output(&mut processing, 1.0);
        assert!((limited - db_to_linear(GainDb::new(-6.0))).abs() < 1e-3);

        // Raising the ceiling lets the gain come back up over the limiter's release time.
        controls.set_safety_ceiling_db(GainDb::new(-0.5));
        let mut relaxed = 0.0;
        for _ in 0..10 {
            relaxed = steady_output(&mut processing, 1.0);
        }
        assert!((relaxed - db_to_linear(GainDb::new(-0.5))).abs() < 1e-3);
    }

    #[test]
    fn muting_ramps_to_exact_silence_and_unmuting_ramps_back() {
        let source = tone_source(Vec::new());
        let controls = LiveControls::new(1.0, false);
        let mut processing = SourceProcessingConfig::from_source(
            &source,
            Arc::clone(&controls),
            48_000,
            Arc::new(RenderReference::default()),
        )
        .expect("build processing config");
        steady_output(&mut processing, 0.5);

        controls.set_muted(true);
        let mut fading = vec![0.5_f32; 480];
        processing.apply_fader(&mut fading);
        assert!(fading[0] > 0.45, "mute must not be an instant cut");
        assert_eq!(*fading.last().expect("samples"), 0.0);
        // Once muted, nothing leaves the capture stage at all.
        let mut muted = vec![0.5_f32; 480];
        processing.apply_fader(&mut muted);
        assert!(muted.iter().all(|sample| *sample == 0.0));

        controls.set_muted(false);
        let mut returning = vec![0.5_f32; 480];
        processing.apply_fader(&mut returning);
        assert!(returning[0] < 0.05);
        assert_eq!(*returning.last().expect("samples"), 0.5);
    }

    #[test]
    fn webrtc_processing_changes_capture_signature() {
        let source =
            AudioSourceState::new(ParticipantId::new(), AudioSourceType::Microphone, "Mic");
        let mut changed = source.clone();
        changed.channel_strip.webrtc_processing.noise_suppression = false;

        assert_ne!(
            CaptureConfigSignature::from_source(&source),
            CaptureConfigSignature::from_source(&changed)
        );
    }

    #[test]
    fn meter_updates_from_simulated_samples() {
        let meter = meter_samples(&[0.5, -0.25, 0.25, -0.5]);

        assert!(meter.peak_db.0 < 0.0);
        assert!(meter.rms_db.0 < 0.0);
        assert!(!meter.clipping);
    }

    #[test]
    fn manager_stops_runtime_when_source_becomes_inactive() {
        let mut manager = CaptureRuntimeManager::default();
        let source = AudioSourceState::new(ParticipantId::new(), AudioSourceType::TestTone, "Tone");
        let source_id = source.id;
        let stopped = Arc::new(AtomicBool::new(false));
        manager.insert_for_test(Box::new(FakeRuntime {
            source_id,
            signature: CaptureConfigSignature::from_source(&source),
            stopped: Arc::clone(&stopped),
        }));

        let mut sources = vec![AudioSourceState {
            enabled: false,
            ..source
        }];
        manager.reconcile_without_start_for_test(&mut sources);

        assert!(stopped.load(Ordering::Relaxed));
        assert!(!manager.contains(source_id));
        assert_eq!(
            sources[0].runtime.status,
            AudioSourceRuntimeStatus::Inactive
        );
    }
}
