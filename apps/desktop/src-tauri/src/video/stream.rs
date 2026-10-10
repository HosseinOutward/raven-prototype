//! Bounded native-video presentation for the WebView.
//!
//! Frames never cross Tauri's JSON/event bridge. Rust encodes at most one pending JPEG per
//! visible stream and exposes it through a loopback-only multipart stream. The WebView owns
//! only an `<img>` presentation surface; LiveKit, decoding, backpressure, and frame lifetime
//! remain native.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use mozjpeg::{ColorSpace, Compress};
use serde::Serialize;
use uuid::Uuid;

use crate::video::convert::{resize_i420_filtered_reusing, I420Frame};
use crate::video::domain::{VideoPresentationSettings, VideoTrackSource};

const BOUNDARY: &str = "ravenframe";
type EncodedFrame = Arc<Vec<u8>>;
type StreamSubscribers = HashMap<Uuid, SyncSender<EncodedFrame>>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStreamEndpoint {
    pub base_url: String,
}

#[derive(Clone, Default)]
pub struct VideoFrameHub {
    subscribers: Arc<Mutex<HashMap<String, StreamSubscribers>>>,
}

impl std::fmt::Debug for VideoFrameHub {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("VideoFrameHub")
            .finish_non_exhaustive()
    }
}

impl VideoFrameHub {
    fn subscribe(&self, stream_id: &str) -> (Uuid, Receiver<EncodedFrame>) {
        let (sender, receiver) = sync_channel(1);
        let subscriber_id = Uuid::new_v4();
        self.subscribers
            .lock()
            .expect("video frame subscribers poisoned")
            .entry(stream_id.to_string())
            .or_default()
            .insert(subscriber_id, sender);
        (subscriber_id, receiver)
    }

    fn unsubscribe(&self, stream_id: &str, subscriber_id: Uuid) {
        let Ok(mut streams) = self.subscribers.lock() else {
            return;
        };
        let Some(subscribers) = streams.get_mut(stream_id) else {
            return;
        };
        subscribers.remove(&subscriber_id);
        if subscribers.is_empty() {
            streams.remove(stream_id);
        }
    }

    pub fn has_subscribers(&self, stream_id: &str) -> bool {
        self.subscribers
            .lock()
            .map(|streams| {
                streams
                    .get(stream_id)
                    .is_some_and(|items| !items.is_empty())
            })
            .unwrap_or(false)
    }

    pub fn publish(&self, stream_id: &str, jpeg: Vec<u8>) {
        let frame = Arc::new(jpeg);
        let Ok(mut streams) = self.subscribers.lock() else {
            return;
        };
        let Some(subscribers) = streams.get_mut(stream_id) else {
            return;
        };
        subscribers.retain(
            |_, subscriber| match subscriber.try_send(Arc::clone(&frame)) {
                Ok(()) | Err(TrySendError::Full(_)) => true,
                Err(TrySendError::Disconnected(_)) => false,
            },
        );
        if subscribers.is_empty() {
            streams.remove(stream_id);
        }
    }

    pub fn remove_stream(&self, stream_id: &str) {
        if let Ok(mut streams) = self.subscribers.lock() {
            streams.remove(stream_id);
        }
    }
}

#[derive(Clone, Debug)]
pub struct VideoFrameService {
    hub: VideoFrameHub,
    endpoint: VideoStreamEndpoint,
}

impl VideoFrameService {
    pub fn start() -> io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let token = Uuid::new_v4().simple().to_string();
        let hub = VideoFrameHub::default();
        let server_hub = hub.clone();
        let server_token = token.clone();
        thread::Builder::new()
            .name("raven-video-frame-server".to_string())
            .spawn(move || {
                for connection in listener.incoming() {
                    let Ok(stream) = connection else {
                        continue;
                    };
                    let hub = server_hub.clone();
                    let token = server_token.clone();
                    let _ = thread::Builder::new()
                        .name("raven-video-frame-client".to_string())
                        .spawn(move || serve_connection(stream, &token, hub));
                }
            })?;
        Ok(Self {
            hub,
            endpoint: VideoStreamEndpoint {
                base_url: format!("http://{address}/{token}"),
            },
        })
    }

    pub fn hub(&self) -> VideoFrameHub {
        self.hub.clone()
    }

    pub fn endpoint(&self) -> VideoStreamEndpoint {
        self.endpoint.clone()
    }
}

fn serve_connection(mut stream: TcpStream, token: &str, hub: VideoFrameHub) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let mut request = [0_u8; 4096];
    let Ok(read) = stream.read(&mut request) else {
        return;
    };
    let first_line = String::from_utf8_lossy(&request[..read])
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    let path = first_line.split_whitespace().nth(1).unwrap_or_default();
    let prefix = format!("/{token}/");
    if !first_line.starts_with("GET ") || !path.starts_with(&prefix) {
        let _ = stream
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }
    let stream_id = path[prefix.len()..]
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .trim_end_matches(".mjpg");
    if stream_id.is_empty()
        || !stream_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        let _ = stream.write_all(
            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
    }

    let (subscriber_id, receiver) = hub.subscribe(stream_id);
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary={BOUNDARY}\r\nCache-Control: no-store, no-cache, must-revalidate\r\nPragma: no-cache\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(headers.as_bytes()).is_err() {
        hub.unsubscribe(stream_id, subscriber_id);
        return;
    }
    loop {
        match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(frame) => {
                let part = format!(
                    "--{BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
                    frame.len()
                );
                if stream.write_all(part.as_bytes()).is_err()
                    || stream.write_all(&frame).is_err()
                    || stream.write_all(b"\r\n").is_err()
                    || stream.flush().is_err()
                {
                    break;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {
                let mut probe = [0_u8; 1];
                match stream.peek(&mut probe) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                        ) => {}
                    Err(_) => break,
                }
            }
        }
    }
    hub.unsubscribe(stream_id, subscriber_id);
}

pub struct VideoFramePublisher {
    stream_id: String,
    source: VideoTrackSource,
    hub: VideoFrameHub,
    settings: Arc<RwLock<VideoPresentationSettings>>,
    sender: SyncSender<I420Frame>,
    last_submitted: Mutex<Option<Instant>>,
    encoder_busy: Arc<AtomicBool>,
    recycled_frame: Arc<Mutex<Option<I420Frame>>>,
}

impl std::fmt::Debug for VideoFramePublisher {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("VideoFramePublisher")
            .field("stream_id", &self.stream_id)
            .finish_non_exhaustive()
    }
}

impl VideoFramePublisher {
    pub fn new(
        stream_id: impl Into<String>,
        hub: VideoFrameHub,
        settings: Arc<RwLock<VideoPresentationSettings>>,
        source: VideoTrackSource,
    ) -> Self {
        let stream_id = stream_id.into();
        let worker_id = stream_id.clone();
        let worker_hub = hub.clone();
        let worker_settings = Arc::clone(&settings);
        let (sender, receiver) = sync_channel::<I420Frame>(1);
        let encoder_busy = Arc::new(AtomicBool::new(false));
        let worker_busy = Arc::clone(&encoder_busy);
        let recycled_frame = Arc::new(Mutex::new(None));
        let worker_recycled = Arc::clone(&recycled_frame);
        let _ = thread::Builder::new()
            .name(format!("raven-video-present-{worker_id}"))
            .spawn(move || {
                let mut resized = empty_i420_frame();
                let mut rgb = Vec::new();
                while let Ok(frame) = receiver.recv() {
                    let settings = worker_settings
                        .read()
                        .map(|value| value.clone())
                        .unwrap_or_default();
                    if let Some(jpeg) =
                        encode_frame(&frame, &settings, source, &mut resized, &mut rgb)
                    {
                        worker_hub.publish(&worker_id, jpeg);
                    }
                    if let Ok(mut recycled) = worker_recycled.lock() {
                        *recycled = Some(frame);
                    }
                    worker_busy.store(false, Ordering::Release);
                }
                worker_hub.remove_stream(&worker_id);
            });
        Self {
            stream_id,
            source,
            hub,
            settings,
            sender,
            last_submitted: Mutex::new(None),
            encoder_busy,
            recycled_frame,
        }
    }

    pub fn stream_id(&self) -> &str {
        &self.stream_id
    }

    pub fn wants_frame(&self) -> bool {
        if !self.hub.has_subscribers(&self.stream_id) {
            return false;
        }
        let fps = self
            .settings
            .read()
            .map(|settings| settings.limits_for(self.source).2)
            .unwrap_or(15)
            .max(1);
        let now = Instant::now();
        let Ok(mut last) = self.last_submitted.lock() else {
            return false;
        };
        if last.is_some_and(|previous| {
            now.duration_since(previous) < Duration::from_secs_f64(1.0 / fps as f64)
        }) {
            return false;
        }
        if self
            .encoder_busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }
        *last = Some(now);
        true
    }

    pub fn submit_reusing(&self, build: impl FnOnce(Option<I420Frame>) -> I420Frame) {
        let recycled = self
            .recycled_frame
            .lock()
            .ok()
            .and_then(|mut slot| slot.take());
        let frame = build(recycled);
        if let Err(error) = self.sender.try_send(frame) {
            let frame = match error {
                TrySendError::Full(frame) | TrySendError::Disconnected(frame) => frame,
            };
            if let Ok(mut recycled) = self.recycled_frame.lock() {
                *recycled = Some(frame);
            }
            self.encoder_busy.store(false, Ordering::Release);
        }
    }

    pub fn submit_copy(&self, frame: &I420Frame) {
        self.submit_reusing(|recycled| copy_i420_reusing(frame, recycled));
    }
}

fn copy_i420_reusing(source: &I420Frame, recycled: Option<I420Frame>) -> I420Frame {
    let mut target = recycled.unwrap_or(I420Frame {
        width: source.width,
        height: source.height,
        y: Vec::new(),
        u: Vec::new(),
        v: Vec::new(),
    });
    target.width = source.width;
    target.height = source.height;
    target.y.clear();
    target.y.extend_from_slice(&source.y);
    target.u.clear();
    target.u.extend_from_slice(&source.u);
    target.v.clear();
    target.v.extend_from_slice(&source.v);
    target
}

fn encode_frame(
    frame: &I420Frame,
    settings: &VideoPresentationSettings,
    source: VideoTrackSource,
    resized: &mut I420Frame,
    rgb: &mut Vec<u8>,
) -> Option<Vec<u8>> {
    let (max_width, max_height, _, quality) = settings.limits_for(source);
    let (width, height) = fit_dimensions(frame.width, frame.height, max_width, max_height);
    let prepared = if frame.width == width && frame.height == height {
        frame
    } else {
        resize_i420_filtered_reusing(frame, width, height, resized);
        resized
    };
    i420_to_rgb_reusing(prepared, rgb);
    let mut compressor = Compress::new(ColorSpace::JCS_RGB);
    compressor.set_size(width as usize, height as usize);
    compressor.set_quality(quality);
    let mut compressor = compressor.start_compress(Vec::new()).ok()?;
    compressor.write_scanlines(rgb).ok()?;
    compressor.finish().ok()
}

fn empty_i420_frame() -> I420Frame {
    I420Frame {
        width: 2,
        height: 2,
        y: Vec::new(),
        u: Vec::new(),
        v: Vec::new(),
    }
}

fn i420_to_rgb_reusing(frame: &I420Frame, rgb: &mut Vec<u8>) {
    let width = frame.width as usize;
    let height = frame.height as usize;
    let chroma_width = frame.chroma_width() as usize;
    rgb.resize(width * height * 3, 0);
    for row in 0..height {
        for column in 0..width {
            let y = frame.y[row * width + column] as i32;
            let chroma_index = (row / 2) * chroma_width + (column / 2);
            let u = frame.u[chroma_index] as i32;
            let v = frame.v[chroma_index] as i32;
            let c = (y - 16).max(0);
            let d = u - 128;
            let e = v - 128;
            let offset = (row * width + column) * 3;
            rgb[offset] = ((298 * c + 409 * e + 128) >> 8).clamp(0, 255) as u8;
            rgb[offset + 1] = ((298 * c - 100 * d - 208 * e + 128) >> 8).clamp(0, 255) as u8;
            rgb[offset + 2] = ((298 * c + 516 * d + 128) >> 8).clamp(0, 255) as u8;
        }
    }
}

fn fit_dimensions(width: u32, height: u32, max_width: u32, max_height: u32) -> (u32, u32) {
    let width = width.max(2);
    let height = height.max(2);
    let scale = (max_width as f64 / width as f64)
        .min(max_height as f64 / height as f64)
        .min(1.0);
    let output_width = ((width as f64 * scale).round() as u32).max(2);
    let output_height = ((height as f64 * scale).round() as u32).max(2);
    (
        output_width.saturating_sub(output_width % 2).max(2),
        output_height.saturating_sub(output_height % 2).max(2),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presentation_dimensions_are_bounded_without_upscaling() {
        assert_eq!(fit_dimensions(1920, 1080, 960, 540), (960, 540));
        assert_eq!(fit_dimensions(320, 180, 960, 540), (320, 180));
    }

    #[test]
    fn screenshares_keep_a_1080p_local_presentation_independent_of_camera_preference() {
        let settings = VideoPresentationSettings::default();
        assert_eq!(
            settings.limits_for(VideoTrackSource::Camera),
            (960, 540, 15, 76.0)
        );
        assert_eq!(
            settings.limits_for(VideoTrackSource::Screenshare),
            (1920, 1080, 10, 92.0)
        );
    }

    #[test]
    fn disconnected_or_slow_consumers_never_create_an_unbounded_queue() {
        let hub = VideoFrameHub::default();
        let (_, receiver) = hub.subscribe("track");
        hub.publish("track", vec![1]);
        hub.publish("track", vec![2]);
        assert_eq!(&*receiver.recv().unwrap(), &[1]);
    }

    #[test]
    fn explicit_unsubscribe_releases_idle_stream_state() {
        let hub = VideoFrameHub::default();
        let (subscriber_id, _receiver) = hub.subscribe("track");
        assert!(hub.has_subscribers("track"));
        hub.unsubscribe("track", subscriber_id);
        assert!(!hub.has_subscribers("track"));
    }
}
