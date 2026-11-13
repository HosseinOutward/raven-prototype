//! The MobileNative camera backend. The raven-mobile-native plugin runs CameraX, which
//! delivers upright RGBA frames; a worker converts them to I420 with the shared
//! converter, off the CameraX analyzer thread. Reporting is host-tested; capture
//! compiles only for Android.

use std::sync::Mutex;
use std::time::Instant;
#[cfg(mobile)]
use std::{
    sync::atomic::{AtomicBool, Ordering},
    sync::mpsc::{sync_channel, Receiver, RecvTimeoutError},
    sync::Arc,
    thread::{self, JoinHandle},
    time::Duration,
};

#[cfg(mobile)]
use raven_mobile_native::camera::CameraFrame;

use crate::video::domain::{VideoSourceRuntimeState, VideoSourceRuntimeStatus};
#[cfg(mobile)]
use crate::video::{
    capture::{
        CaptureEvent, CaptureEvents, VideoCaptureError, VideoCaptureSignature, VideoFrameSink,
        VideoSourceRuntime,
    },
    convert::{packed_to_i420, I420Frame, PackedFormat},
    domain::{CameraDevice, VideoSourceId, VideoSourceState},
};

/// The cameras CameraX reports, front-facing first.
#[cfg(mobile)]
pub fn list_cameras(app: &tauri::AppHandle) -> Result<Vec<CameraDevice>, String> {
    let mut cameras = raven_mobile_native::camera::CameraHandle::new(app).list_cameras()?;
    cameras.sort_by_key(|camera| !camera.front_facing);
    Ok(cameras
        .into_iter()
        .map(|camera| CameraDevice {
            id: camera.id,
            name: camera.name,
        })
        .collect())
}

#[cfg(mobile)]
#[derive(Debug)]
struct CameraRuntime {
    source_id: VideoSourceId,
    signature: VideoCaptureSignature,
    report: Arc<Mutex<RuntimeReport>>,
    session: raven_mobile_native::camera::CameraSession<tauri::Wry>,
    worker: Option<JoinHandle<()>>,
    stopping: Arc<AtomicBool>,
}

#[derive(Debug)]
struct RuntimeReport {
    state: VideoSourceRuntimeState,
    last_event_at: Option<Instant>,
}

impl RuntimeReport {
    fn starting() -> Self {
        Self {
            state: VideoSourceRuntimeState {
                status: VideoSourceRuntimeStatus::Starting,
                ..VideoSourceRuntimeState::default()
            },
            last_event_at: None,
        }
    }
}

/// The camera's own frame rate, smoothed from CameraX timestamps.
#[cfg(mobile)]
#[derive(Debug, Default)]
struct FrameTiming {
    last_timestamp_ns: Option<i64>,
    measured_fps: Option<f32>,
}

#[cfg(mobile)]
impl FrameTiming {
    fn observe(&mut self, timestamp_ns: i64) {
        let elapsed = self
            .last_timestamp_ns
            .and_then(|previous| timestamp_ns.checked_sub(previous))
            .filter(|elapsed| *elapsed > 0);
        if let Some(elapsed) = elapsed {
            let fps = 1_000_000_000.0 / elapsed as f32;
            // Ignore clock jumps and implausible intervals.
            if (1.0..=120.0).contains(&fps) {
                self.measured_fps = Some(
                    self.measured_fps
                        .map_or(fps, |current| current * 0.8 + fps * 0.2),
                );
            }
        }
        self.last_timestamp_ns = Some(timestamp_ns);
    }
}

#[cfg(mobile)]
impl VideoSourceRuntime for CameraRuntime {
    fn source_id(&self) -> VideoSourceId {
        self.source_id
    }

    fn stop(&mut self) {
        // Kotlin unbinds CameraX and joins its analyzer before this returns.
        if let Err(error) = self.session.stop() {
            eprintln!("[video] Android camera stop failed: {error}");
        }
        self.stopping.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        if let Ok(mut report) = self.report.lock() {
            report.state = VideoSourceRuntimeState::default();
        }
    }

    fn runtime_state(&self) -> VideoSourceRuntimeState {
        self.report
            .lock()
            .map(|report| report.state.clone())
            .unwrap_or_default()
    }

    fn signature(&self) -> &VideoCaptureSignature {
        &self.signature
    }
}

#[cfg(mobile)]
pub(crate) fn start(
    source: &VideoSourceState,
    signature: VideoCaptureSignature,
    sink: Arc<dyn VideoFrameSink>,
    app: tauri::AppHandle,
    events: Option<CaptureEvents>,
) -> Result<Box<dyn VideoSourceRuntime>, VideoCaptureError> {
    let epoch = crate::mobile_native::media::require_camera(&app)
        .map_err(|message| VideoCaptureError::StreamFailed { message })?;
    // One pending frame bounds memory and latency: CameraX closes its ImageProxy after
    // copying, and the analyzer never waits for conversion or LiveKit publication.
    let (sender, receiver) = sync_channel::<CameraFrame>(1);
    let stopping = Arc::new(AtomicBool::new(false));
    let report = Arc::new(Mutex::new(RuntimeReport::starting()));
    let timing = Arc::new(Mutex::new(FrameTiming::default()));

    let worker_stopping = Arc::clone(&stopping);
    let worker_report = Arc::clone(&report);
    let worker_timing = Arc::clone(&timing);
    let source_id = source.id;
    let worker = thread::Builder::new()
        .name(format!("raven-camera-{source_id}"))
        .spawn(move || {
            while let Some(frame) = receive_frame(&receiver, &worker_stopping) {
                if !sink.frame_due() {
                    continue;
                }
                let Some(frame) = to_i420(frame) else {
                    continue;
                };
                let fps = worker_timing
                    .lock()
                    .ok()
                    .and_then(|timing| timing.measured_fps);
                if report_frame(&worker_report, frame.width, frame.height, fps) {
                    if let Some(events) = &events {
                        events.notify(source_id, CaptureEvent::StateChanged);
                    }
                }
                sink.push_frame(frame);
            }
        })
        .map_err(|error| VideoCaptureError::StreamFailed {
            message: format!("could not start Android camera worker: {error}"),
        })?;

    let callback_app = app.clone();
    let callback: Arc<dyn Fn(CameraFrame) + Send + Sync> = Arc::new(move |frame| {
        // A leave, background or revoked permission ends delivery immediately.
        if !crate::mobile_native::media::epoch_matches(&callback_app, epoch)
            || crate::mobile_native::media::require_camera(&callback_app).is_err()
        {
            return;
        }
        if let Ok(mut timing) = timing.lock() {
            timing.observe(frame.timestamp_ns);
        }
        // Drop the frame while the worker is busy, or after the runtime stopped.
        let _ = sender.try_send(frame);
    });
    let session = match raven_mobile_native::camera::CameraHandle::new(&app).start_camera(
        &source.target_id,
        source.profile.width,
        source.profile.height,
        callback,
    ) {
        Ok(session) => session,
        Err(message) => {
            // A failed start may leave the callback, and its sender, with the plugin, so
            // the flag rather than a disconnect ends the worker.
            stopping.store(true, Ordering::Release);
            let _ = worker.join();
            return Err(VideoCaptureError::StreamFailed { message });
        }
    };
    Ok(Box::new(CameraRuntime {
        source_id,
        signature,
        report,
        session,
        worker: Some(worker),
        stopping,
    }))
}

/// Record a converted frame. Returns whether the UI should hear about it: the first
/// frame, new dimensions, a first FPS reading, or FPS drift (at most once a second).
fn report_frame(
    report: &Mutex<RuntimeReport>,
    width: u32,
    height: u32,
    measured_fps: Option<f32>,
) -> bool {
    let Ok(mut report) = report.lock() else {
        return false;
    };
    let now = Instant::now();
    let state = &report.state;
    let changed = state.status != VideoSourceRuntimeStatus::Running
        || state.width != Some(width)
        || state.height != Some(height)
        || (state.fps.is_none() && measured_fps.is_some());
    let fps_drifted = matches!(
        (state.fps, measured_fps),
        (Some(previous), Some(current)) if (previous - current).abs() >= 2.0
    ) && report
        .last_event_at
        .is_none_or(|last| now.duration_since(last).as_secs_f32() >= 1.0);
    report.state.status = VideoSourceRuntimeStatus::Running;
    report.state.width = Some(width);
    report.state.height = Some(height);
    report.state.fps = measured_fps;
    let notify = changed || fps_drifted;
    if notify {
        report.last_event_at = Some(now);
    }
    notify
}

#[cfg(mobile)]
fn receive_frame(receiver: &Receiver<CameraFrame>, stopping: &AtomicBool) -> Option<CameraFrame> {
    while !stopping.load(Ordering::Acquire) {
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(frame) => return Some(frame),
            Err(RecvTimeoutError::Disconnected) => return None,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
    None
}

/// CameraX may leave the last RGBA row unpadded; the converter expects whole rows.
#[cfg(mobile)]
fn to_i420(mut frame: CameraFrame) -> Option<I420Frame> {
    let rows = frame.row_stride.checked_mul(frame.height as usize)?;
    if frame.rgba.len() < rows {
        frame.rgba.resize(rows, 0);
    }
    packed_to_i420(
        &frame.rgba,
        frame.width,
        frame.height,
        frame.row_stride,
        PackedFormat::Rgba,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_reports_only_observed_dimensions_and_measured_fps() {
        let report = Mutex::new(RuntimeReport::starting());
        assert!(report_frame(&report, 640, 480, None));
        let state = report.lock().unwrap().state.clone();
        assert_eq!(state.status, VideoSourceRuntimeStatus::Running);
        assert_eq!((state.width, state.height), (Some(640), Some(480)));
        assert_eq!(state.fps, None);

        assert!(report_frame(&report, 640, 480, Some(29.97)));
        assert_eq!(report.lock().unwrap().state.fps, Some(29.97));
    }
}
