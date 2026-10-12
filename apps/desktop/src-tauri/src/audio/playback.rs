//! Playback half of the native audio engine.
//!
//! Every subscribed remote track is read by the engine, shaped by the receiver's own
//! strip, and pushed here as interleaved stereo at the output device's sample rate. This
//! module owns what happens next:
//!
//! - a per-track [`PlayoutBuffer`] that absorbs scheduling jitter while keeping latency
//!   bounded (prime, re-prime after an underrun, trim when a reader bursts);
//! - the mix bus (sum, master mute, soft limiter) rendered inside the device callback;
//! - the output **worker**, which opens the device in *its* native channel layout and
//!   sample format, follows default-device changes, falls back to the system default when
//!   the chosen speaker disappears, returns to it when it comes back, and never gives up
//!   while a session is active;
//! - the [`RenderReference`] echo cancellation reads to learn what Raven played.

use std::collections::{HashMap, VecDeque};
use std::f32::consts::TAU;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, FromSample, Sample, SizedSample, Stream};
use tauri::{AppHandle, Emitter};

use crate::audio::capture::list_output_devices;
use crate::audio::domain::{AudioOutputDevice, AudioPlaybackStatus};
use crate::audio::state::{SharedAudioEngineState, AUDIO_STATE_CHANGED_EVENT};

/// The mix bus is always stereo; the device stream maps it onto the endpoint's real
/// channel count.
pub(crate) const BUS_CHANNELS: usize = 2;

/// Audio a track buffers before it starts (or resumes) playing. Covers the jitter between
/// the reader task and the device callback.
const PLAYOUT_TARGET_MS: usize = 30;
/// Above this a reader has burst after a stall; the buffer is trimmed back to the target
/// so the delay is not carried for the rest of the call.
const PLAYOUT_MAX_MS: usize = 120;
/// Length of the crossfade used when trimming, so the jump is not a click.
const PLAYOUT_TRIM_FADE_MS: usize = 5;

/// How often the worker re-checks the default device / a missing preferred device.
const DEVICE_PROBE_INTERVAL: Duration = Duration::from_secs(2);
const WORKER_TICK: Duration = Duration::from_millis(50);
/// Backoff between failed attempts to open a speaker. The last delay repeats forever.
const OPEN_RETRY_DELAYS: [Duration; 3] = [
    Duration::from_millis(250),
    Duration::from_secs(1),
    Duration::from_secs(3),
];

/// Master mute / unmute ramp, so deafening never clicks.
const MASTER_RAMP_MS: f32 = 6.0;
/// Release time of the mix-bus limiter.
const LIMITER_RELEASE_MS: f32 = 180.0;

// ---------------------------------------------------------------------------
// Render reference
// ---------------------------------------------------------------------------

/// How much played audio is kept for echo cancellation.
const RENDER_HISTORY_MS: u64 = 500;
/// A reader further behind than this has stalled (or only just started); it skips ahead
/// rather than feeding the canceller a burst of stale audio.
const RENDER_MAX_LAG_MS: u64 = 120;
/// Where a (re)synchronised reader starts, relative to the newest played audio.
const RENDER_RESYNC_LAG_MS: u64 = 20;

/// What Raven actually played, kept as one continuous stream for echo cancellation.
///
/// An echo canceller models the path from speaker to microphone, so it must be given the
/// played signal in order and without gaps or repeats. Each consumer therefore holds a
/// [`RenderCursor`] and reads successive 10 ms frames; handing out "the most recent
/// samples" instead duplicates and skips audio whenever capture and playback blocks do
/// not line up, and the canceller never converges.
#[derive(Debug, Default)]
pub struct RenderReference {
    ring: Mutex<RenderRing>,
}

#[derive(Debug)]
struct RenderRing {
    /// Interleaved stereo at `sample_rate`.
    samples: VecDeque<f32>,
    sample_rate: u32,
    /// Stereo frames written since the rate last changed.
    written: u64,
    /// Bumped when the rate changes; cursors from an older epoch resynchronise.
    epoch: u64,
}

impl Default for RenderRing {
    fn default() -> Self {
        Self {
            samples: VecDeque::new(),
            sample_rate: 48_000,
            written: 0,
            epoch: 0,
        }
    }
}

/// One consumer's position in the render stream.
#[derive(Clone, Copy, Debug, Default)]
pub struct RenderCursor {
    next_frame: u64,
    epoch: u64,
    synced: bool,
}

impl RenderReference {
    pub(crate) fn push_stereo(&self, interleaved_stereo: &[f32], sample_rate: u32) {
        if interleaved_stereo.is_empty() || sample_rate == 0 {
            return;
        }
        let Ok(mut ring) = self.ring.lock() else {
            return;
        };
        if ring.sample_rate != sample_rate {
            ring.samples.clear();
            ring.sample_rate = sample_rate;
            ring.written = 0;
            ring.epoch += 1;
        }
        ring.samples.extend(interleaved_stereo.iter().copied());
        ring.written += (interleaved_stereo.len() / BUS_CHANNELS) as u64;
        let max_samples = (sample_rate as u64 * RENDER_HISTORY_MS / 1000) as usize * BUS_CHANNELS;
        if ring.samples.len() > max_samples {
            let overflow = ring.samples.len() - max_samples;
            ring.samples.drain(..overflow);
        }
    }

    /// Copy the next 10 ms of played audio for this consumer into `left` / `right` and
    /// return its sample rate, or `None` when nothing new has been played yet.
    pub fn next_frame(
        &self,
        cursor: &mut RenderCursor,
        left: &mut Vec<f32>,
        right: &mut Vec<f32>,
    ) -> Option<u32> {
        let ring = self.ring.lock().ok()?;
        let rate = u64::from(ring.sample_rate);
        let frame_len = rate / 100;
        if frame_len == 0 {
            return None;
        }
        let oldest = ring.written - (ring.samples.len() / BUS_CHANNELS) as u64;
        let stale = !cursor.synced
            || cursor.epoch != ring.epoch
            || cursor.next_frame < oldest
            || cursor.next_frame > ring.written
            || ring.written - cursor.next_frame > rate * RENDER_MAX_LAG_MS / 1000;
        if stale {
            let lag = rate * RENDER_RESYNC_LAG_MS / 1000;
            cursor.next_frame = ring.written.saturating_sub(lag).max(oldest);
            cursor.epoch = ring.epoch;
            cursor.synced = true;
        }
        if ring.written - cursor.next_frame < frame_len {
            return None;
        }
        let start = (cursor.next_frame - oldest) as usize * BUS_CHANNELS;
        left.clear();
        right.clear();
        for frame in 0..frame_len as usize {
            left.push(ring.samples[start + frame * BUS_CHANNELS]);
            right.push(ring.samples[start + frame * BUS_CHANNELS + 1]);
        }
        cursor.next_frame += frame_len;
        Some(ring.sample_rate)
    }
}

// ---------------------------------------------------------------------------
// Per-track playout buffer
// ---------------------------------------------------------------------------

/// Buffer sizes, in interleaved samples, derived from the current bus sample rate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PlayoutLimits {
    target: usize,
    max: usize,
    fade: usize,
}

impl PlayoutLimits {
    fn for_rate(sample_rate: u32) -> Self {
        let per_ms = sample_rate as usize * BUS_CHANNELS / 1000;
        Self {
            target: (per_ms * PLAYOUT_TARGET_MS).max(BUS_CHANNELS),
            max: (per_ms * PLAYOUT_MAX_MS).max(BUS_CHANNELS * 2),
            fade: per_ms * PLAYOUT_TRIM_FADE_MS,
        }
    }
}

/// Jitter buffer between one reader task and the device callback.
///
/// A plain queue lets latency ratchet upward: every underrun plays silence, then the late
/// audio is queued behind it and stays there. This buffer instead waits until `target` is
/// available before it (re)starts, and cuts back to `target` once it exceeds `max`.
#[derive(Debug, Default)]
struct PlayoutBuffer {
    queue: VecDeque<f32>,
    playing: bool,
    underruns: u64,
    trims: u64,
}

impl PlayoutBuffer {
    fn push(&mut self, samples: &[f32], limits: PlayoutLimits) {
        self.queue.extend(samples.iter().copied());
        if self.queue.len() > limits.max {
            self.trim_to_target(limits);
        }
    }

    /// Drop the oldest audio down to `target`, crossfading the old head into the new one.
    fn trim_to_target(&mut self, limits: PlayoutLimits) {
        let excess = self.queue.len().saturating_sub(limits.target);
        let drop = excess - (excess % BUS_CHANNELS);
        if drop == 0 {
            return;
        }
        let remaining = self.queue.len() - drop;
        let fade_frames = limits.fade.min(drop).min(remaining) / BUS_CHANNELS;
        for frame in 0..fade_frames {
            let mix = (frame + 1) as f32 / (fade_frames + 1) as f32;
            for channel in 0..BUS_CHANNELS {
                let index = frame * BUS_CHANNELS + channel;
                let old = self.queue[index];
                let new = self.queue[drop + index];
                self.queue[drop + index] = old * (1.0 - mix) + new * mix;
            }
        }
        self.queue.drain(..drop);
        self.trims += 1;
    }

    /// Add this track into `out` (interleaved stereo). Returns nothing while priming.
    fn mix_into(&mut self, out: &mut [f32], limits: PlayoutLimits) {
        if !self.playing {
            if self.queue.len() < limits.target {
                return;
            }
            self.playing = true;
        }
        let count = out.len().min(self.queue.len());
        let (front, back) = self.queue.as_slices();
        let from_front = count.min(front.len());
        for (target, sample) in out[..from_front].iter_mut().zip(&front[..from_front]) {
            *target += *sample;
        }
        let from_back = count - from_front;
        for (target, sample) in out[from_front..count].iter_mut().zip(&back[..from_back]) {
            *target += *sample;
        }
        self.queue.drain(..count);
        if count < out.len() {
            // Ran dry mid-callback: rebuild the cushion before resuming so one late frame
            // does not turn into a string of micro-dropouts.
            self.playing = false;
            self.underruns += 1;
        }
    }

    fn reset(&mut self) {
        self.queue.clear();
        self.playing = false;
    }
}

// ---------------------------------------------------------------------------
// Mix bus
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct MixBus {
    tracks: Mutex<HashMap<String, PlayoutBuffer>>,
    sample_rate: AtomicU32,
    muted: AtomicBool,
}

impl Default for MixBus {
    fn default() -> Self {
        Self {
            tracks: Mutex::new(HashMap::new()),
            sample_rate: AtomicU32::new(48_000),
            muted: AtomicBool::new(false),
        }
    }
}

/// Callback-side state: sums the tracks, applies master mute and the bus limiter.
struct BusRenderer {
    bus: Arc<MixBus>,
    reference: Arc<RenderReference>,
    sample_rate: u32,
    limits: PlayoutLimits,
    master_gain: f32,
    limiter_gain: f32,
}

impl BusRenderer {
    fn new(bus: Arc<MixBus>, reference: Arc<RenderReference>, sample_rate: u32) -> Self {
        let master_gain = if bus.muted.load(Ordering::Relaxed) {
            0.0
        } else {
            1.0
        };
        Self {
            bus,
            reference,
            sample_rate,
            limits: PlayoutLimits::for_rate(sample_rate),
            master_gain,
            limiter_gain: 1.0,
        }
    }

    /// Fill `out` (interleaved stereo, pre-zeroed) with the mixed bus.
    fn render(&mut self, out: &mut [f32]) {
        if let Ok(mut tracks) = self.bus.tracks.lock() {
            for buffer in tracks.values_mut() {
                buffer.mix_into(out, self.limits);
            }
        }
        self.master_gain = apply_master_gain(
            out,
            self.master_gain,
            if self.bus.muted.load(Ordering::Relaxed) {
                0.0
            } else {
                1.0
            },
            self.sample_rate,
        );
        self.limiter_gain = limit_bus(out, self.limiter_gain, self.sample_rate);
        // The canceller must see exactly what reached the speaker, post mute and limiter.
        self.reference.push_stereo(out, self.sample_rate);
    }
}

/// Ramp the master gain toward `target` and return the gain reached at the end of the block.
fn apply_master_gain(out: &mut [f32], mut gain: f32, target: f32, sample_rate: u32) -> f32 {
    if gain == target {
        if target != 1.0 {
            for sample in out.iter_mut() {
                *sample *= target;
            }
        }
        return gain;
    }
    let step = 1.0 / (sample_rate as f32 * MASTER_RAMP_MS / 1000.0).max(1.0);
    for frame in out.chunks_mut(BUS_CHANNELS) {
        gain = if gain < target {
            (gain + step).min(target)
        } else {
            (gain - step).max(target)
        };
        for sample in frame {
            *sample *= gain;
        }
    }
    gain
}

/// Keep the summed bus inside full scale without hard clipping: the gain drops to fit the
/// loudest sample of the block and recovers slowly. Returns the gain for the next block.
fn limit_bus(out: &mut [f32], previous_gain: f32, sample_rate: u32) -> f32 {
    let frames = out.len() / BUS_CHANNELS;
    if frames == 0 {
        return previous_gain;
    }
    let peak = out
        .iter()
        .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
    let needed = if peak > 1.0 { 1.0 / peak } else { 1.0 };
    let release =
        1.0 - (-(frames as f32) / (sample_rate as f32 * LIMITER_RELEASE_MS / 1000.0)).exp();
    let recovered = previous_gain + (1.0 - previous_gain) * release;
    let gain = needed.min(recovered);
    if gain >= 1.0 && previous_gain >= 1.0 {
        return 1.0;
    }
    // Glide from the previous gain over a short head so the change is not a step, but
    // never let the head exceed what this block needs.
    let head = frames.min(32);
    for (index, frame) in out.chunks_mut(BUS_CHANNELS).enumerate() {
        let frame_gain = if index < head {
            let mix = (index + 1) as f32 / head as f32;
            (previous_gain + (gain - previous_gain) * mix).min(needed)
        } else {
            gain
        };
        for sample in frame {
            *sample = (*sample * frame_gain).clamp(-1.0, 1.0);
        }
    }
    gain
}

// ---------------------------------------------------------------------------
// Output mixer + device worker
// ---------------------------------------------------------------------------

/// Sums every subscribed remote track into the chosen output device.
pub struct OutputMixer {
    bus: Arc<MixBus>,
    render_reference: Arc<RenderReference>,
    running: Arc<AtomicBool>,
    reopen: Arc<AtomicBool>,
    selected_device_id: Arc<Mutex<Option<String>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl std::fmt::Debug for OutputMixer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutputMixer")
            .field("sample_rate", &self.sample_rate())
            .field("running", &self.is_running())
            .finish_non_exhaustive()
    }
}

impl OutputMixer {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            bus: Arc::new(MixBus::default()),
            render_reference: Arc::new(RenderReference::default()),
            running: Arc::new(AtomicBool::new(false)),
            reopen: Arc::new(AtomicBool::new(false)),
            selected_device_id: Arc::new(Mutex::new(None)),
            worker: Mutex::new(None),
        })
    }

    /// Sample rate of the mix bus (the open device's rate). Readers resample to this.
    pub fn sample_rate(&self) -> u32 {
        self.bus.sample_rate.load(Ordering::Relaxed)
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn render_reference(&self) -> Arc<RenderReference> {
        Arc::clone(&self.render_reference)
    }

    /// Start the output worker. Returns immediately; the worker reports the device it
    /// opened (or why it could not) through session health, and keeps retrying, so a
    /// missing or busy speaker never blocks joining or publishing.
    pub(crate) fn start(self: &Arc<Self>, app: &AppHandle, shared: &SharedAudioEngineState) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let worker = OutputWorker {
            bus: Arc::clone(&self.bus),
            reference: Arc::clone(&self.render_reference),
            running: Arc::clone(&self.running),
            reopen: Arc::clone(&self.reopen),
            selected_device_id: Arc::clone(&self.selected_device_id),
            app: app.clone(),
            shared: Arc::clone(shared),
        };
        let handle = thread::Builder::new()
            .name("raven-audio-output".into())
            .spawn(move || worker.run());
        match handle {
            Ok(handle) => {
                if let Ok(mut slot) = self.worker.lock() {
                    *slot = Some(handle);
                }
            }
            Err(error) => {
                self.running.store(false, Ordering::SeqCst);
                eprintln!("[audio-engine] could not start the output worker: {error}");
            }
        }
    }

    pub(crate) fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        let handle = self.worker.lock().ok().and_then(|mut slot| slot.take());
        if let Some(handle) = handle {
            let _ = handle.join();
        }
        if let Ok(mut tracks) = self.bus.tracks.lock() {
            tracks.clear();
        }
    }

    /// Choose the speaker (or `None` to follow the system default). An unknown device is
    /// rejected; a known one is applied by the worker without interrupting the session.
    pub(crate) fn set_device(
        &self,
        device_id: Option<String>,
    ) -> Result<Option<AudioOutputDevice>, String> {
        let normalized = device_id.and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        });
        let selected = match normalized.as_deref() {
            Some(id) => Some(
                output_device_by_id(id)
                    .ok_or_else(|| "Speaker is no longer available.".to_string())?,
            ),
            None => None,
        };
        let next = selected.as_ref().map(|device| device.device_id.clone());
        let mut current = self
            .selected_device_id
            .lock()
            .map_err(|_| "Audio output state is unavailable.".to_string())?;
        if *current != next {
            *current = next;
            self.reopen.store(true, Ordering::SeqCst);
        }
        drop(current);
        Ok(selected.or_else(default_output_device))
    }

    pub fn selected_device(&self) -> Option<AudioOutputDevice> {
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

    fn preferred_device_id(&self) -> Option<String> {
        self.selected_device_id
            .lock()
            .ok()
            .and_then(|id| id.clone())
    }

    /// Master output mute (deafen). Tracks keep flowing and metering; only the speaker
    /// feed is silenced, so undeafening is instant.
    pub fn set_muted(&self, muted: bool) {
        self.bus.muted.store(muted, Ordering::Relaxed);
    }

    pub fn is_muted(&self) -> bool {
        self.bus.muted.load(Ordering::Relaxed)
    }

    /// Play the speaker test tone. Blocks for the tone's duration.
    pub fn play_test_tone(&self, device_id: Option<String>) -> Result<(), String> {
        let target = device_id
            .filter(|value| !value.trim().is_empty())
            .or_else(|| self.preferred_device_id());
        play_tones(target.as_deref(), UiSound::SpeakerTest)
    }

    /// Play a short interface sound on the chosen speaker. Blocks for its duration.
    pub fn play_ui_sound(&self, sound: UiSound) -> Result<(), String> {
        if self.is_muted() {
            return Ok(());
        }
        play_tones(self.preferred_device_id().as_deref(), sound)
    }

    pub(crate) fn ensure_track(&self, key: &str) {
        if let Ok(mut tracks) = self.bus.tracks.lock() {
            tracks.entry(key.to_string()).or_default();
        }
    }

    pub(crate) fn push(&self, key: &str, stereo: &[f32]) {
        let limits = PlayoutLimits::for_rate(self.sample_rate());
        if let Ok(mut tracks) = self.bus.tracks.lock() {
            tracks
                .entry(key.to_string())
                .or_default()
                .push(stereo, limits);
        }
    }

    /// Drop a track's queued audio (its stream was recreated at a new sample rate).
    pub(crate) fn reset_track(&self, key: &str) {
        if let Ok(mut tracks) = self.bus.tracks.lock() {
            if let Some(buffer) = tracks.get_mut(key) {
                buffer.reset();
            }
        }
    }

    pub(crate) fn remove_track(&self, key: &str) {
        if let Ok(mut tracks) = self.bus.tracks.lock() {
            tracks.remove(key);
        }
    }
}

struct OutputWorker {
    bus: Arc<MixBus>,
    reference: Arc<RenderReference>,
    running: Arc<AtomicBool>,
    reopen: Arc<AtomicBool>,
    selected_device_id: Arc<Mutex<Option<String>>>,
    app: AppHandle,
    shared: SharedAudioEngineState,
}

struct OpenedOutput {
    /// Held for its lifetime: dropping it closes the device.
    _stream: Stream,
    error: Arc<Mutex<Option<String>>>,
    device_name: String,
    sample_rate: u32,
}

/// Why the supervising loop handed control back to the worker.
enum SuperviseOutcome {
    Stopped,
    Reopen,
    StreamFailed(String),
}

impl OutputWorker {
    fn alive(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    fn run(self) {
        let mut failures = 0_usize;
        while self.alive() {
            self.reopen.store(false, Ordering::SeqCst);
            let preferred = self
                .selected_device_id
                .lock()
                .ok()
                .and_then(|id| id.clone());
            match self.open(preferred.as_deref()) {
                Ok((opened, fallback)) => {
                    failures = 0;
                    self.adopt_sample_rate(opened.sample_rate);
                    self.report(
                        AudioPlaybackStatus::Running,
                        Some(opened.device_name.clone()),
                        fallback,
                        None,
                    );
                    let outcome = self.supervise(&opened, preferred.as_deref(), fallback);
                    drop(opened);
                    match outcome {
                        SuperviseOutcome::Stopped => break,
                        SuperviseOutcome::Reopen => {}
                        SuperviseOutcome::StreamFailed(error) => {
                            eprintln!("[audio-engine] output stream error: {error}");
                            self.report(AudioPlaybackStatus::Recovering, None, false, Some(error));
                        }
                    }
                }
                Err(error) => {
                    let status = if failures < OPEN_RETRY_DELAYS.len() {
                        AudioPlaybackStatus::Recovering
                    } else {
                        AudioPlaybackStatus::Error
                    };
                    self.report(status, None, false, Some(error));
                    let delay = OPEN_RETRY_DELAYS[failures.min(OPEN_RETRY_DELAYS.len() - 1)];
                    failures += 1;
                    self.wait(delay);
                }
            }
        }
    }

    /// Open the preferred speaker, or the system default when it is unavailable. Returns
    /// the stream and whether it is a fallback.
    fn open(&self, preferred: Option<&str>) -> Result<(OpenedOutput, bool), String> {
        let Some(preferred) = preferred else {
            return self.open_device(None).map(|opened| (opened, false));
        };
        match self.open_device(Some(preferred)) {
            Ok(opened) => Ok((opened, false)),
            Err(preferred_error) => match self.open_device(None) {
                Ok(opened) => Ok((opened, true)),
                Err(_) => Err(preferred_error),
            },
        }
    }

    fn open_device(&self, device_id: Option<&str>) -> Result<OpenedOutput, String> {
        open_output_stream(
            device_id,
            Arc::clone(&self.bus),
            Arc::clone(&self.reference),
        )
    }

    /// Readers resample to the bus rate; when it changes, queued audio at the old rate is
    /// discarded and each reader recreates its stream on its next frame.
    fn adopt_sample_rate(&self, sample_rate: u32) {
        let previous = self.bus.sample_rate.swap(sample_rate, Ordering::SeqCst);
        if previous != sample_rate {
            if let Ok(mut tracks) = self.bus.tracks.lock() {
                for buffer in tracks.values_mut() {
                    buffer.reset();
                }
            }
        }
    }

    fn supervise(
        &self,
        opened: &OpenedOutput,
        preferred: Option<&str>,
        fallback: bool,
    ) -> SuperviseOutcome {
        let mut last_probe = Instant::now();
        loop {
            if !self.alive() {
                return SuperviseOutcome::Stopped;
            }
            if self.reopen.load(Ordering::SeqCst) {
                return SuperviseOutcome::Reopen;
            }
            let error = opened.error.lock().ok().and_then(|mut error| error.take());
            if let Some(error) = error {
                return SuperviseOutcome::StreamFailed(error);
            }
            if last_probe.elapsed() >= DEVICE_PROBE_INTERVAL {
                last_probe = Instant::now();
                let should_reopen = match preferred {
                    // On the default as a stand-in: go back once the chosen speaker returns.
                    Some(preferred) if fallback => output_device_by_id(preferred).is_some(),
                    Some(_) => false,
                    // Following the default: move with it.
                    None => {
                        default_output_name().is_some_and(|current| current != opened.device_name)
                    }
                };
                if should_reopen {
                    return SuperviseOutcome::Reopen;
                }
            }
            thread::sleep(WORKER_TICK);
        }
    }

    /// Sleep that ends early when the session stops or a new device is chosen.
    fn wait(&self, duration: Duration) {
        let deadline = Instant::now() + duration;
        while self.alive() && !self.reopen.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::sleep(WORKER_TICK);
        }
    }

    fn report(
        &self,
        status: AudioPlaybackStatus,
        device_name: Option<String>,
        fallback: bool,
        error: Option<String>,
    ) {
        if !self.alive() {
            return;
        }
        let mut snapshot = None;
        for _ in 0..20 {
            if let Ok(mut guard) = self.shared.try_write() {
                let session = &mut guard.mixer.session;
                session.playback_status = status.clone();
                session.playback_error = error.clone();
                session.output_fallback = fallback;
                if device_name.is_some() || status != AudioPlaybackStatus::Recovering {
                    session.output_device_name = device_name.clone();
                }
                snapshot = Some(guard.snapshot());
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        if let Some(snapshot) = snapshot {
            let _ = self.app.emit(AUDIO_STATE_CHANGED_EVENT, snapshot);
        }
    }
}

fn open_output_stream(
    selected_device_id: Option<&str>,
    bus: Arc<MixBus>,
    reference: Arc<RenderReference>,
) -> Result<OpenedOutput, String> {
    let (device, _) = resolve_output_device(selected_device_id)?;
    let device_name = device.name().unwrap_or_else(|_| "Speaker".to_string());
    // Use the endpoint's own format. Shared-mode WASAPI (and plain ALSA hardware devices)
    // accept only their mix format, so forcing stereo f32 fails on mono hands-free
    // headsets and surround endpoints.
    let supported = device
        .default_output_config()
        .map_err(|error| format!("Speaker format is unavailable: {error}"))?;
    let sample_rate = supported.sample_rate().0;
    let stream_error = Arc::new(Mutex::new(None));
    let callback_error = Arc::clone(&stream_error);
    let mut renderer = BusRenderer::new(bus, reference, sample_rate);
    let stream = build_bus_output_stream(
        &device,
        &supported,
        move |out| renderer.render(out),
        move |error| {
            if let Ok(mut slot) = callback_error.lock() {
                *slot = Some(error.to_string());
            }
        },
    )
    .map_err(|error| format!("Speaker could not be opened: {error}"))?;
    stream
        .play()
        .map_err(|error| format!("Speaker playback could not start: {error}"))?;
    Ok(OpenedOutput {
        _stream: stream,
        error: stream_error,
        device_name,
        sample_rate,
    })
}

/// Build an output stream in the device's native channel count and sample format, fed by
/// a callback that renders interleaved **stereo f32**.
fn build_bus_output_stream(
    device: &Device,
    supported: &cpal::SupportedStreamConfig,
    render: impl FnMut(&mut [f32]) + Send + 'static,
    on_error: impl FnMut(cpal::StreamError) + Send + 'static,
) -> Result<Stream, String> {
    let config = supported.config();
    let built = match supported.sample_format() {
        cpal::SampleFormat::F32 => build_typed_output::<f32>(device, &config, render, on_error),
        cpal::SampleFormat::F64 => build_typed_output::<f64>(device, &config, render, on_error),
        cpal::SampleFormat::I8 => build_typed_output::<i8>(device, &config, render, on_error),
        cpal::SampleFormat::I16 => build_typed_output::<i16>(device, &config, render, on_error),
        cpal::SampleFormat::I32 => build_typed_output::<i32>(device, &config, render, on_error),
        cpal::SampleFormat::I64 => build_typed_output::<i64>(device, &config, render, on_error),
        cpal::SampleFormat::U8 => build_typed_output::<u8>(device, &config, render, on_error),
        cpal::SampleFormat::U16 => build_typed_output::<u16>(device, &config, render, on_error),
        cpal::SampleFormat::U32 => build_typed_output::<u32>(device, &config, render, on_error),
        cpal::SampleFormat::U64 => build_typed_output::<u64>(device, &config, render, on_error),
        other => return Err(format!("unsupported speaker sample format {other:?}")),
    };
    built.map_err(|error| error.to_string())
}

fn build_typed_output<T>(
    device: &Device,
    config: &cpal::StreamConfig,
    mut render: impl FnMut(&mut [f32]) + Send + 'static,
    on_error: impl FnMut(cpal::StreamError) + Send + 'static,
) -> Result<Stream, cpal::BuildStreamError>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = usize::from(config.channels).max(1);
    let mut bus: Vec<f32> = Vec::new();
    device.build_output_stream(
        config,
        move |data: &mut [T], _| {
            let frames = data.len() / channels;
            bus.clear();
            bus.resize(frames * BUS_CHANNELS, 0.0);
            render(&mut bus);
            write_bus_to_device(&bus, data, channels);
        },
        on_error,
        None,
    )
}

/// Map interleaved stereo onto a device frame layout: mono gets the average, wider
/// layouts get front left/right and silence elsewhere.
fn write_bus_to_device<T>(bus: &[f32], out: &mut [T], channels: usize)
where
    T: Sample + FromSample<f32>,
{
    let channels = channels.max(1);
    let mut bus_frames = bus.chunks_exact(BUS_CHANNELS);
    for frame in out.chunks_mut(channels) {
        let (left, right) = bus_frames
            .next()
            .map(|pair| (pair[0], pair[1]))
            .unwrap_or((0.0, 0.0));
        if frame.len() == 1 {
            frame[0] = T::from_sample((left + right) * 0.5);
            continue;
        }
        frame[0] = T::from_sample(left);
        frame[1] = T::from_sample(right);
        for extra in &mut frame[2..] {
            *extra = T::EQUILIBRIUM;
        }
    }
}

// ---------------------------------------------------------------------------
// Device lookup
// ---------------------------------------------------------------------------

fn default_output_name() -> Option<String> {
    cpal::default_host()
        .default_output_device()
        .and_then(|device| device.name().ok())
}

fn default_output_device() -> Option<AudioOutputDevice> {
    let devices = list_output_devices();
    devices
        .iter()
        .find(|device| device.is_default)
        .cloned()
        .or_else(|| devices.into_iter().next())
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

// ---------------------------------------------------------------------------
// Interface sounds
// ---------------------------------------------------------------------------

/// Short generated sounds played straight to the chosen speaker, outside the mix bus.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiSound {
    /// The speaker test in Media Setup.
    SpeakerTest,
    /// Someone is about to enter the room you are in.
    Knock,
}

#[derive(Clone, Copy, Debug)]
struct Tone {
    frequency_hz: f32,
    duration_ms: u32,
}

impl UiSound {
    fn tones(self) -> &'static [Tone] {
        match self {
            UiSound::SpeakerTest => &[Tone {
                frequency_hz: 660.0,
                duration_ms: 420,
            }],
            UiSound::Knock => &[
                Tone {
                    frequency_hz: 587.33,
                    duration_ms: 110,
                },
                Tone {
                    frequency_hz: 783.99,
                    duration_ms: 170,
                },
            ],
        }
    }

    fn level(self) -> f32 {
        match self {
            UiSound::SpeakerTest => 0.18,
            UiSound::Knock => 0.11,
        }
    }
}

/// Stateful generator for a tone sequence; each tone gets its own fade in / out.
struct ToneRenderer {
    tones: &'static [Tone],
    level: f32,
    sample_rate: f32,
    tone_index: usize,
    frame_in_tone: usize,
}

impl ToneRenderer {
    fn new(sound: UiSound, sample_rate: u32) -> Self {
        Self {
            tones: sound.tones(),
            level: sound.level(),
            sample_rate: sample_rate.max(1) as f32,
            tone_index: 0,
            frame_in_tone: 0,
        }
    }

    fn total_duration(sound: UiSound) -> Duration {
        Duration::from_millis(
            sound
                .tones()
                .iter()
                .map(|tone| u64::from(tone.duration_ms))
                .sum(),
        )
    }

    fn render(&mut self, out: &mut [f32]) {
        for frame in out.chunks_mut(BUS_CHANNELS) {
            let sample = self.next_sample();
            for channel in frame {
                *channel = sample;
            }
        }
    }

    fn next_sample(&mut self) -> f32 {
        let Some(tone) = self.tones.get(self.tone_index) else {
            return 0.0;
        };
        let total = (self.sample_rate * tone.duration_ms as f32 / 1000.0).round() as usize;
        if self.frame_in_tone >= total.max(1) {
            self.tone_index += 1;
            self.frame_in_tone = 0;
            return self.next_sample();
        }
        let progress = self.frame_in_tone as f32 / total.max(1) as f32;
        let envelope = if progress < 0.08 {
            progress / 0.08
        } else if progress > 0.8 {
            ((1.0 - progress) / 0.2).clamp(0.0, 1.0)
        } else {
            1.0
        };
        let phase = TAU * tone.frequency_hz * self.frame_in_tone as f32 / self.sample_rate;
        self.frame_in_tone += 1;
        phase.sin() * self.level * envelope
    }
}

fn play_tones(device_id: Option<&str>, sound: UiSound) -> Result<(), String> {
    // A sound for the chosen speaker still plays if that speaker is gone: use the default.
    let (device, _) = resolve_output_device(device_id).or_else(|error| {
        if device_id.is_some() {
            resolve_output_device(None)
        } else {
            Err(error)
        }
    })?;
    let supported = device
        .default_output_config()
        .map_err(|error| format!("Speaker could not be opened: {error}"))?;
    let mut renderer = ToneRenderer::new(sound, supported.sample_rate().0);
    let stream = build_bus_output_stream(
        &device,
        &supported,
        move |out| renderer.render(out),
        |error| eprintln!("[audio-engine] interface sound stream error: {error}"),
    )
    .map_err(|error| format!("Sound could not start: {error}"))?;
    stream
        .play()
        .map_err(|error| format!("Sound could not play: {error}"))?;
    thread::sleep(ToneRenderer::total_duration(sound) + Duration::from_millis(80));
    drop(stream);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> PlayoutLimits {
        PlayoutLimits::for_rate(48_000)
    }

    fn mixed(buffer: &mut PlayoutBuffer, frames: usize) -> Vec<f32> {
        let mut out = vec![0.0; frames * BUS_CHANNELS];
        buffer.mix_into(&mut out, limits());
        out
    }

    fn played(reference: &RenderReference, frames: usize, value: f32) {
        reference.push_stereo(&vec![value; frames * BUS_CHANNELS], 48_000);
    }

    #[test]
    fn render_frames_are_read_in_order_without_gaps_or_repeats() {
        let reference = RenderReference::default();
        let mut cursor = RenderCursor::default();
        let (mut left, mut right) = (Vec::new(), Vec::new());

        // Playback delivers odd-sized blocks; capture reads whole 10 ms frames.
        let ramp: Vec<f32> = (0..2_000).flat_map(|n| [n as f32, -(n as f32)]).collect();
        reference.push_stereo(&ramp[..700 * 2], 48_000);
        reference.push_stereo(&ramp[700 * 2..], 48_000);

        let mut seen = Vec::new();
        while let Some(rate) = reference.next_frame(&mut cursor, &mut left, &mut right) {
            assert_eq!(rate, 48_000);
            assert_eq!(left.len(), 480);
            assert!(left.iter().zip(&right).all(|(l, r)| *l == -*r));
            seen.extend_from_slice(&left);
        }
        // A new reader starts a little behind the newest audio and then advances
        // strictly one sample at a time.
        assert!(seen.len() >= 480);
        assert!(seen.windows(2).all(|pair| pair[1] == pair[0] + 1.0));

        // Nothing new was played: nothing is handed out twice.
        assert!(reference
            .next_frame(&mut cursor, &mut left, &mut right)
            .is_none());
        played(&reference, 480, 9.0);
        assert!(reference
            .next_frame(&mut cursor, &mut left, &mut right)
            .is_some());
        assert!(reference
            .next_frame(&mut cursor, &mut left, &mut right)
            .is_none());
    }

    #[test]
    fn a_reader_that_fell_behind_skips_ahead_instead_of_replaying_stale_audio() {
        let reference = RenderReference::default();
        let mut cursor = RenderCursor::default();
        let (mut left, mut right) = (Vec::new(), Vec::new());
        played(&reference, 480, 1.0);
        assert!(reference
            .next_frame(&mut cursor, &mut left, &mut right)
            .is_some());

        // The capture side stalls for 400 ms while playback continues.
        played(&reference, 48_000 * 2 / 5, 2.0);
        let mut frames = 0;
        while reference
            .next_frame(&mut cursor, &mut left, &mut right)
            .is_some()
        {
            frames += 1;
        }
        assert!(frames <= 3, "replayed {frames} stale frames after a stall");
    }

    #[test]
    fn a_rate_change_restarts_every_reader_on_the_new_stream() {
        let reference = RenderReference::default();
        let mut cursor = RenderCursor::default();
        let (mut left, mut right) = (Vec::new(), Vec::new());
        played(&reference, 960, 1.0);
        while reference
            .next_frame(&mut cursor, &mut left, &mut right)
            .is_some()
        {}

        reference.push_stereo(&vec![3.0; 441 * 4 * BUS_CHANNELS], 44_100);
        let rate = reference.next_frame(&mut cursor, &mut left, &mut right);
        assert_eq!(rate, Some(44_100));
        assert_eq!(left.len(), 441);
        assert!(left.iter().all(|sample| *sample == 3.0));
    }

    #[test]
    fn playout_waits_for_the_target_before_it_starts() {
        let mut buffer = PlayoutBuffer::default();
        let ten_ms = vec![0.5; 480 * BUS_CHANNELS];

        buffer.push(&ten_ms, limits());
        assert!(mixed(&mut buffer, 480).iter().all(|sample| *sample == 0.0));
        assert_eq!(
            buffer.queue.len(),
            ten_ms.len(),
            "priming must not consume audio"
        );

        buffer.push(&ten_ms, limits());
        buffer.push(&ten_ms, limits());
        assert!(mixed(&mut buffer, 480).iter().all(|sample| *sample == 0.5));
    }

    #[test]
    fn an_underrun_re_primes_instead_of_stuttering() {
        let mut buffer = PlayoutBuffer::default();
        buffer.push(&vec![0.5; 480 * 3 * BUS_CHANNELS], limits());
        mixed(&mut buffer, 480 * 3);
        assert!(
            buffer.playing,
            "a block that was fully served keeps playing"
        );

        // The next callback finds nothing: that is the underrun.
        assert!(mixed(&mut buffer, 480).iter().all(|sample| *sample == 0.0));
        assert_eq!(buffer.underruns, 1);
        assert!(!buffer.playing);

        // A late 5 ms frame is held back until the cushion is rebuilt...
        buffer.push(&vec![0.5; 240 * BUS_CHANNELS], limits());
        assert!(mixed(&mut buffer, 480).iter().all(|sample| *sample == 0.0));
        assert_eq!(buffer.underruns, 1, "priming is not another underrun");

        // ...and playback resumes once it is.
        buffer.push(&vec![0.5; 480 * 3 * BUS_CHANNELS], limits());
        assert!(mixed(&mut buffer, 480).iter().all(|sample| *sample == 0.5));
    }

    #[test]
    fn a_partial_block_counts_as_an_underrun_and_stops_playback() {
        let mut buffer = PlayoutBuffer::default();
        buffer.push(&vec![0.5; 480 * 3 * BUS_CHANNELS], limits());
        let out = mixed(&mut buffer, 480 * 4);
        assert!(out[..480 * 3 * BUS_CHANNELS]
            .iter()
            .all(|sample| *sample == 0.5));
        assert!(out[480 * 3 * BUS_CHANNELS..]
            .iter()
            .all(|sample| *sample == 0.0));
        assert_eq!(buffer.underruns, 1);
        assert!(!buffer.playing);
    }

    #[test]
    fn a_reader_burst_is_trimmed_back_to_the_target() {
        let mut buffer = PlayoutBuffer::default();
        let limits = limits();
        buffer.push(&vec![0.25; limits.max + 960], limits);
        assert_eq!(buffer.queue.len(), limits.target);
        assert_eq!(buffer.trims, 1);
        assert_eq!(buffer.queue.len() % BUS_CHANNELS, 0);
    }

    #[test]
    fn latency_never_exceeds_the_cap_under_sustained_overproduction() {
        let mut buffer = PlayoutBuffer::default();
        let limits = limits();
        for _ in 0..500 {
            // The reader delivers 11 ms for every 10 ms the device consumes.
            buffer.push(&vec![0.1; 528 * BUS_CHANNELS], limits);
            mixed(&mut buffer, 480);
            assert!(buffer.queue.len() <= limits.max);
        }
    }

    #[test]
    fn stereo_bus_maps_to_mono_stereo_and_surround_layouts() {
        let bus = [0.5_f32, -0.25, 1.0, 1.0];

        let mut mono = [0.0_f32; 2];
        write_bus_to_device(&bus, &mut mono, 1);
        assert_eq!(mono, [0.125, 1.0]);

        let mut stereo = [0.0_f32; 4];
        write_bus_to_device(&bus, &mut stereo, 2);
        assert_eq!(stereo, bus);

        let mut surround = [9.0_f32; 12];
        write_bus_to_device(&bus, &mut surround, 6);
        assert_eq!(&surround[..6], &[0.5, -0.25, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(&surround[6..], &[1.0, 1.0, 0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn bus_is_converted_to_integer_device_formats() {
        let bus = [1.0_f32, -1.0];
        let mut signed = [0_i16; 2];
        write_bus_to_device(&bus, &mut signed, 2);
        assert!(signed[0] > 32_000 && signed[1] < -32_000);

        let mut unsigned = [0_u16; 4];
        write_bus_to_device(&[0.0, 0.0], &mut unsigned, 4);
        assert!(unsigned.iter().all(|sample| *sample == u16::EQUILIBRIUM));
    }

    #[test]
    fn limiter_keeps_a_hot_mix_inside_full_scale_and_recovers() {
        let mut block = vec![1.8_f32; 960];
        let gain = limit_bus(&mut block, 1.0, 48_000);
        assert!(gain < 1.0);
        assert!(block.iter().all(|sample| sample.abs() <= 1.0));

        let mut quiet = vec![0.1_f32; 960];
        let mut recovering = gain;
        for _ in 0..200 {
            recovering = limit_bus(&mut quiet, recovering, 48_000);
            quiet.fill(0.1);
        }
        assert!(recovering > 0.99);
    }

    #[test]
    fn limiter_leaves_a_normal_mix_untouched() {
        let mut block = vec![0.4_f32, -0.6, 0.9, -1.0];
        let before = block.clone();
        assert_eq!(limit_bus(&mut block, 1.0, 48_000), 1.0);
        assert_eq!(block, before);
    }

    #[test]
    fn master_mute_ramps_to_silence_and_back() {
        let mut block = vec![1.0_f32; 2 * 4800];
        let gain = apply_master_gain(&mut block, 1.0, 0.0, 48_000);
        assert_eq!(gain, 0.0);
        assert!(block[0] > 0.9, "mute must ramp, not step");
        assert_eq!(*block.last().unwrap(), 0.0);

        let mut silent = vec![1.0_f32; 64];
        assert_eq!(apply_master_gain(&mut silent, 0.0, 0.0, 48_000), 0.0);
        assert!(silent.iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn an_unknown_selected_speaker_is_rejected_instead_of_using_the_default() {
        let result = resolve_output_device(Some("raven-test-device-that-does-not-exist"));
        assert!(result.is_err());
    }

    #[test]
    fn opening_an_unknown_selected_device_reports_an_error() {
        let result = open_output_stream(
            Some("raven-test-device-that-does-not-exist"),
            Arc::new(MixBus::default()),
            Arc::new(RenderReference::default()),
        );
        assert!(result.is_err());
    }

    #[test]
    fn choosing_an_unknown_speaker_keeps_the_current_selection() {
        let mixer = OutputMixer::new();
        assert!(mixer
            .set_device(Some("raven-test-device-that-does-not-exist".into()))
            .is_err());
        assert_eq!(mixer.preferred_device_id(), None);
        assert!(!mixer.reopen.load(Ordering::SeqCst));
    }

    #[test]
    fn interface_sounds_are_finite_and_silent_after_they_end() {
        for sound in [UiSound::SpeakerTest, UiSound::Knock] {
            let mut renderer = ToneRenderer::new(sound, 48_000);
            let total = (ToneRenderer::total_duration(sound).as_secs_f32() * 48_000.0) as usize;
            let mut audio = vec![0.0_f32; (total + 4_800) * BUS_CHANNELS];
            renderer.render(&mut audio);
            assert!(audio
                .iter()
                .all(|sample| sample.abs() <= sound.level() + 1e-3));
            assert!(audio[..total].iter().any(|sample| sample.abs() > 0.01));
            assert!(audio[(total + 96) * BUS_CHANNELS..]
                .iter()
                .all(|sample| *sample == 0.0));
        }
    }
}
