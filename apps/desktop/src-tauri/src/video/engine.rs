//! Native video media engine.
//!
//! Owns both native video roles: the `<userId>#video` publisher and the base-identity
//! viewer that selectively receives remote video plus RTC self-preview. JavaScript never
//! opens a LiveKit room; it only presents bounded native frame streams.
//!
//! Capture backends push planar I420 frames into a per-source [`VideoPublishSink`], which
//! forwards them straight to a LiveKit [`NativeVideoSource`]. The published track is named
//! `raven-video-<trackId>` so peers can recognise it; Raven may also subscribe to it
//! when the user explicitly selects RTC-based self preview.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use futures_util::StreamExt;
use livekit::options::{TrackPublishOptions, VideoEncoding};
use livekit::prelude::{
    ConnectionQuality, LocalTrack, LocalVideoTrack, RemoteTrack, Room, RoomEvent, RoomOptions,
    TrackKind, TrackSource,
};
use livekit::webrtc::prelude::VideoBuffer;
use livekit::webrtc::stats::RtcStats;
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use livekit::webrtc::video_stream::native::NativeVideoStream;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::runtime::Runtime;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::video::capture::VideoFrameSink;
use crate::video::convert::I420Frame;
use crate::video::domain::{
    PublishedVideoTrackId, RemoteVideoTrackState, SelfPreviewMode, VideoConnectionQuality,
    VideoParticipantState, VideoPresentationSettings, VideoQualityProfile, VideoSourceId,
    VideoSourceState, VideoTrackSource,
};
use crate::video::state::{SharedVideoEngineState, VIDEO_STATE_CHANGED_EVENT};
use crate::video::stream::{VideoFrameHub, VideoFramePublisher};

fn lk_track_source(source: VideoTrackSource) -> TrackSource {
    match source {
        VideoTrackSource::Camera => TrackSource::Camera,
        VideoTrackSource::Screenshare => TrackSource::Screenshare,
    }
}

/// Stable LiveKit/WebRTC track name for a published video track.
pub fn stable_video_track_id(track_id: PublishedVideoTrackId) -> String {
    format!("raven-video-{track_id}")
}

/// Capture-side sink for one published source: receives I420 frames on the capture thread
/// and forwards them to the LiveKit native source. Frame copies respect the destination
/// buffer's plane strides (which may be padded for alignment).
pub struct VideoPublishSink {
    source: NativeVideoSource,
    started: Instant,
}

impl VideoPublishSink {
    fn new(source: NativeVideoSource) -> Self {
        Self {
            source,
            started: Instant::now(),
        }
    }
}

impl std::fmt::Debug for VideoPublishSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VideoPublishSink").finish_non_exhaustive()
    }
}

impl VideoFrameSink for VideoPublishSink {
    fn push_frame(&self, frame: I420Frame) {
        let mut buffer = I420Buffer::new(frame.width, frame.height);
        let (stride_y, stride_u, stride_v) = buffer.strides();
        let (dst_y, dst_u, dst_v) = buffer.data_mut();

        copy_plane(
            &frame.y,
            frame.width as usize,
            dst_y,
            stride_y as usize,
            frame.height as usize,
        );
        let cw = frame.chroma_width() as usize;
        let ch = frame.chroma_height() as usize;
        copy_plane(&frame.u, cw, dst_u, stride_u as usize, ch);
        copy_plane(&frame.v, cw, dst_v, stride_v as usize, ch);

        let timestamp_us = self.started.elapsed().as_micros() as i64;
        let vframe = VideoFrame {
            rotation: VideoRotation::VideoRotation0,
            timestamp_us,
            frame_metadata: None,
            buffer,
        };
        self.source.capture_frame(&vframe);
    }
}

/// Copy a tightly-packed source plane into a (possibly padded) destination plane.
fn copy_plane(src: &[u8], src_width: usize, dst: &mut [u8], dst_stride: usize, rows: usize) {
    for row in 0..rows {
        let s = row * src_width;
        let d = row * dst_stride;
        let n = src_width.min(dst_stride);
        if s + n <= src.len() && d + n <= dst.len() {
            dst[d..d + n].copy_from_slice(&src[s..s + n]);
        }
    }
}

struct RoomConnection {
    room: Arc<Room>,
    event_loop: JoinHandle<()>,
}

struct ViewerConnection {
    room: Arc<Room>,
    event_loop: JoinHandle<()>,
    readers: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
    connected: Arc<AtomicBool>,
}

struct PublishEntry {
    track_sid: livekit::prelude::TrackSid,
    track: LocalTrack,
    source: VideoTrackSource,
    sink: Arc<VideoPublishSink>,
    profile: VideoQualityProfile,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoNetworkTotals {
    pub camera_sent_bytes: u64,
    pub screen_share_sent_bytes: u64,
    pub camera_received_bytes: u64,
    pub screen_share_received_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoQualityDimensions {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoScreenShareTransmitQuality {
    pub configured: VideoQualityDimensions,
    pub max_bitrate_bps: u64,
    pub outbound: Option<VideoOutboundQuality>,
    pub remote_loss_fraction: Option<f64>,
    pub round_trip_time_ms: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoOutboundQuality {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub target_bitrate_bps: f64,
    pub limitation: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoScreenShareReceiveQuality {
    pub inbound: Option<VideoQualityDimensions>,
    pub loss_fraction: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoQualityReport {
    pub screen_share_transmit: Option<VideoScreenShareTransmitQuality>,
    pub screen_share_receive: Option<VideoScreenShareReceiveQuality>,
}

pub async fn measure_video_network_totals(
    published_tracks: Vec<(VideoTrackSource, LocalTrack)>,
    subscribed_tracks: Vec<(VideoTrackSource, RemoteTrack)>,
) -> Result<VideoNetworkTotals, String> {
    let mut totals = VideoNetworkTotals::default();
    for (source, track) in published_tracks {
        let stats = track.get_stats().await.map_err(|error| error.to_string())?;
        let sent_bytes: u64 = stats
            .iter()
            .filter_map(|stat| match stat {
                RtcStats::OutboundRtp(outbound) => Some(outbound.sent.bytes_sent),
                _ => None,
            })
            .sum();
        match source {
            VideoTrackSource::Camera => totals.camera_sent_bytes += sent_bytes,
            VideoTrackSource::Screenshare => totals.screen_share_sent_bytes += sent_bytes,
        }
    }
    for (source, track) in subscribed_tracks {
        let stats = track.get_stats().await.map_err(|error| error.to_string())?;
        let received_bytes: u64 = stats
            .iter()
            .filter_map(|stat| match stat {
                RtcStats::InboundRtp(inbound) => Some(inbound.inbound.bytes_received),
                _ => None,
            })
            .sum();
        match source {
            VideoTrackSource::Camera => totals.camera_received_bytes += received_bytes,
            VideoTrackSource::Screenshare => totals.screen_share_received_bytes += received_bytes,
        }
    }
    Ok(totals)
}

pub async fn measure_video_quality_report(
    published_screen_shares: Vec<(LocalTrack, VideoQualityProfile)>,
    subscribed_screen_shares: Vec<RemoteTrack>,
) -> Result<VideoQualityReport, String> {
    let screen_share_transmit =
        if let Some((track, profile)) = published_screen_shares.into_iter().next() {
            let tuning = profile.publish_tuning(VideoTrackSource::Screenshare);
            let stats = track.get_stats().await.map_err(|error| error.to_string())?;
            let outbound = stats.iter().find_map(|stat| match stat {
                RtcStats::OutboundRtp(value) => Some(VideoOutboundQuality {
                    width: value.outbound.frame_width,
                    height: value.outbound.frame_height,
                    fps: value.outbound.frames_per_second,
                    target_bitrate_bps: value.outbound.target_bitrate,
                    limitation: format!("{:?}", value.outbound.quality_limitation_reason)
                        .to_lowercase(),
                }),
                _ => None,
            });
            let remote_feedback = stats.iter().find_map(|stat| match stat {
                RtcStats::RemoteInboundRtp(value) => Some((
                    value.remote_inbound.fraction_lost,
                    value.remote_inbound.round_trip_time * 1_000.0,
                )),
                _ => None,
            });
            Some(VideoScreenShareTransmitQuality {
                configured: VideoQualityDimensions {
                    width: tuning.width,
                    height: tuning.height,
                    fps: tuning.frame_rate,
                },
                max_bitrate_bps: tuning.max_bitrate_bps,
                outbound,
                remote_loss_fraction: remote_feedback.map(|(loss, _)| loss),
                round_trip_time_ms: remote_feedback.map(|(_, rtt)| rtt),
            })
        } else {
            None
        };

    let mut inbound = None;
    let mut packets_received = 0_u64;
    let mut packets_lost = 0_i64;
    for track in subscribed_screen_shares {
        let stats = track.get_stats().await.map_err(|error| error.to_string())?;
        for stat in stats {
            if let RtcStats::InboundRtp(value) = stat {
                packets_received += value.received.packets_received;
                packets_lost += value.received.packets_lost.max(0);
                let next = VideoQualityDimensions {
                    width: value.inbound.frame_width,
                    height: value.inbound.frame_height,
                    fps: value.inbound.frames_per_second,
                };
                if inbound
                    .as_ref()
                    .map(|current: &VideoQualityDimensions| {
                        next.width.saturating_mul(next.height)
                            > current.width.saturating_mul(current.height)
                    })
                    .unwrap_or(true)
                {
                    inbound = Some(next);
                }
            }
        }
    }
    let received_or_lost = packets_received + packets_lost.max(0) as u64;
    let screen_share_receive = inbound.map(|inbound| VideoScreenShareReceiveQuality {
        inbound: Some(inbound),
        loss_fraction: (received_or_lost > 0)
            .then_some(packets_lost.max(0) as f64 / received_or_lost as f64),
    });

    Ok(VideoQualityReport {
        screen_share_transmit,
        screen_share_receive,
    })
}

/// The native video media engine. Stored inside `VideoEngineState`.
pub struct VideoEngine {
    runtime: Option<Runtime>,
    connection: Option<RoomConnection>,
    viewer: Option<ViewerConnection>,
    publications: HashMap<VideoSourceId, PublishEntry>,
    remote_preferences: HashMap<String, bool>,
    hub: VideoFrameHub,
    presentation: Arc<RwLock<VideoPresentationSettings>>,
}

impl std::fmt::Debug for VideoEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VideoEngine")
            .field("connected", &self.connection.is_some())
            .field("viewer_connected", &self.viewer.is_some())
            .field("publications", &self.publications.len())
            .finish_non_exhaustive()
    }
}

impl VideoEngine {
    pub fn new(hub: VideoFrameHub, presentation: Arc<RwLock<VideoPresentationSettings>>) -> Self {
        Self {
            runtime: None,
            connection: None,
            viewer: None,
            publications: HashMap::new(),
            remote_preferences: HashMap::new(),
            hub,
            presentation,
        }
    }

    fn runtime(&mut self) -> &Runtime {
        if self.runtime.is_none() {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("failed to build video engine tokio runtime");
            self.runtime = Some(runtime);
        }
        self.runtime.as_ref().unwrap()
    }

    pub fn is_connected(&self) -> bool {
        self.connection.is_some()
    }

    pub fn is_viewer_connected(&self) -> bool {
        self.viewer
            .as_ref()
            .is_some_and(|viewer| viewer.connected.load(Ordering::Acquire))
    }

    pub fn published_tracks(&self) -> Vec<(VideoTrackSource, LocalTrack)> {
        self.publications
            .values()
            .map(|entry| (entry.source, entry.track.clone()))
            .collect()
    }

    pub fn subscribed_tracks(&self) -> Vec<(VideoTrackSource, RemoteTrack)> {
        let Some(viewer) = self.viewer.as_ref() else {
            return Vec::new();
        };
        viewer
            .room
            .remote_participants()
            .values()
            .flat_map(|participant| participant.track_publications().into_values())
            .filter_map(|publication| {
                let source = video_track_source(publication.source())?;
                let track = publication.track()?;
                matches!(track, RemoteTrack::Video(_)).then_some((source, track))
            })
            .collect()
    }

    pub fn published_screen_share_tracks(&self) -> Vec<(LocalTrack, VideoQualityProfile)> {
        self.publications
            .values()
            .filter(|entry| matches!(entry.source, VideoTrackSource::Screenshare))
            .map(|entry| (entry.track.clone(), entry.profile.clone()))
            .collect()
    }

    pub fn subscribed_screen_share_tracks(&self) -> Vec<RemoteTrack> {
        self.subscribed_tracks()
            .into_iter()
            .filter_map(|(source, track)| {
                matches!(source, VideoTrackSource::Screenshare).then_some(track)
            })
            .collect()
    }

    /// Connect the video sidecar to a LiveKit room. Blocks briefly on the network
    /// handshake (called from a synchronous Tauri command thread).
    pub fn connect(
        &mut self,
        app: &AppHandle,
        shared: &SharedVideoEngineState,
        url: &str,
        publisher_token: &str,
        viewer_token: &str,
    ) -> Result<(), String> {
        if self.connection.is_some() || self.viewer.is_some() {
            self.disconnect();
        }

        let mut options = RoomOptions::default();
        // The publisher role never subscribes; the separate native viewer below owns receive.
        options.auto_subscribe = false;
        let (room, events) = {
            let runtime = self.runtime();
            runtime
                .block_on(Room::connect(url, publisher_token, options))
                .map_err(|error| error.to_string())?
        };
        let room = Arc::new(room);
        let event_loop = self.spawn_event_loop(events);

        self.connection = Some(RoomConnection { room, event_loop });

        let mut viewer_options = RoomOptions::default();
        viewer_options.auto_subscribe = false;
        let (viewer_room, viewer_events) = {
            let runtime = self.runtime();
            runtime
                .block_on(Room::connect(url, viewer_token, viewer_options))
                .map_err(|error| {
                    self.disconnect();
                    error.to_string()
                })?
        };
        let viewer_room = Arc::new(viewer_room);
        let readers = Arc::new(Mutex::new(HashMap::new()));
        let viewer_connected = Arc::new(AtomicBool::new(true));
        let viewer_event_loop = self.spawn_viewer_event_loop(
            app,
            shared,
            Arc::clone(&viewer_room),
            viewer_events,
            &readers,
            &viewer_connected,
        );
        self.viewer = Some(ViewerConnection {
            room: Arc::clone(&viewer_room),
            event_loop: viewer_event_loop,
            readers,
            connected: viewer_connected,
        });
        self.apply_viewer_subscriptions(SelfPreviewMode::Local);
        Ok(())
    }

    pub fn disconnect(&mut self) {
        self.publications.clear();
        if let Some(connection) = self.connection.take() {
            connection.event_loop.abort();
            let room = connection.room.clone();
            if let Some(runtime) = self.runtime.as_ref() {
                let _ = runtime.block_on(room.close());
            }
        }
        if let Some(viewer) = self.viewer.take() {
            viewer.event_loop.abort();
            for (stream_id, reader) in viewer.readers.lock().unwrap().drain() {
                reader.abort();
                self.hub.remove_stream(&stream_id);
            }
            if let Some(runtime) = self.runtime.as_ref() {
                let _ = runtime.block_on(viewer.room.close());
            }
        }
        self.remote_preferences.clear();
    }

    pub fn set_self_preview_mode(&mut self, mode: SelfPreviewMode) {
        self.apply_viewer_subscriptions(mode);
    }

    pub fn set_remote_video_receiving(
        &mut self,
        participant_id: &str,
        source: VideoTrackSource,
        receiving: bool,
        self_preview_mode: SelfPreviewMode,
    ) {
        self.remote_preferences
            .insert(subscription_key(participant_id, source), receiving);
        self.apply_viewer_subscriptions(self_preview_mode);
    }

    fn apply_viewer_subscriptions(&mut self, self_preview_mode: SelfPreviewMode) {
        let Some(viewer) = self.viewer.as_ref() else {
            return;
        };
        let room = Arc::clone(&viewer.room);
        let local_identity =
            base_participant_identity(&room.local_participant().identity().0).to_string();
        let preferences = self.remote_preferences.clone();
        let updates: Vec<_> = room
            .remote_participants()
            .values()
            .flat_map(|participant| {
                let identity = participant.identity().0;
                let participant_id = base_participant_identity(&identity).to_string();
                let local_identity = &local_identity;
                let preferences = &preferences;
                participant
                    .track_publications()
                    .values()
                    .filter_map(move |publication| {
                        let source = video_track_source(publication.source())?;
                        let desired = should_receive_video(
                            local_identity,
                            &identity,
                            publication.kind(),
                            Some(source),
                            self_preview_mode,
                            preferences
                                .get(&subscription_key(&participant_id, source))
                                .copied(),
                        );
                        (publication.is_desired() != desired)
                            .then_some((publication.clone(), desired))
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        if updates.is_empty() {
            return;
        }
        let runtime = self.runtime();
        let _guard = runtime.enter();
        for (publication, desired) in updates {
            publication.set_subscribed(desired);
        }
    }

    /// Sink map handed to the capture manager so it knows where to push captured frames.
    pub fn sink_map(&self) -> HashMap<VideoSourceId, Arc<dyn VideoFrameSink>> {
        self.publications
            .iter()
            .map(|(id, entry)| (*id, Arc::clone(&entry.sink) as Arc<dyn VideoFrameSink>))
            .collect()
    }

    /// Reconcile published LiveKit tracks against which local sources are marked
    /// `publishing`. Called under the state write lock after every mutation.
    pub fn reconcile_publications(&mut self, sources: &[VideoSourceState]) -> Result<(), String> {
        let Some(connection) = self.connection.as_ref() else {
            self.publications.clear();
            return Ok(());
        };
        let room = Arc::clone(&connection.room);

        let desired: HashMap<VideoSourceId, &VideoSourceState> = sources
            .iter()
            .filter(|source| source.publishing)
            .map(|source| (source.id, source))
            .collect();

        // Unpublish sources that are no longer publishing.
        let stale: Vec<VideoSourceId> = self
            .publications
            .iter()
            .filter_map(|(id, entry)| {
                let desired_source = desired.get(id)?;
                if entry.profile != desired_source.profile {
                    Some(*id)
                } else {
                    None
                }
            })
            .chain(
                self.publications
                    .keys()
                    .copied()
                    .filter(|id| !desired.contains_key(id)),
            )
            .collect();
        for id in stale {
            if let Some(entry) = self.publications.remove(&id) {
                let room = Arc::clone(&room);
                let sid = entry.track_sid.clone();
                if let Some(runtime) = self.runtime.as_ref() {
                    let _ = runtime.block_on(room.local_participant().unpublish_track(&sid));
                }
            }
        }

        // Publish newly-publishing sources.
        let to_publish: Vec<VideoSourceState> = desired
            .values()
            .filter(|source| !self.publications.contains_key(&source.id))
            .map(|source| (*source).clone())
            .collect();
        let mut first_error = None;
        for source in to_publish {
            if let Err(error) = self.publish_source(&room, &source) {
                eprintln!("[video-engine] publish failed for {}: {error}", source.id);
                first_error.get_or_insert_with(|| {
                    format!("could not publish video source {}: {error}", source.id)
                });
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn publish_source(
        &mut self,
        room: &Arc<Room>,
        source: &VideoSourceState,
    ) -> Result<(), String> {
        let track_id = source
            .published_track
            .as_ref()
            .map(|track| track.track_id)
            .unwrap_or_default();
        let webrtc_track_id = stable_video_track_id(track_id);

        let profile = source.profile.clone();
        let track_source = VideoTrackSource::from_kind(source.kind);
        let publish_tuning = profile.publish_tuning(track_source);
        let width = publish_tuning.width.max(2);
        let height = publish_tuning.height.max(2);
        let is_screencast = matches!(track_source, VideoTrackSource::Screenshare);

        // `NativeVideoSource::new` spawns an internal keep-alive task via the LiveKit
        // runtime, so it must run inside a Tokio context. Tauri commands execute on the
        // (non-async) main thread, so enter the engine runtime explicitly before creating
        // the source; the guard is dropped before `block_on` to avoid a nested context.
        let (native, track) = {
            let runtime = self.runtime();
            let _guard = runtime.enter();
            let native = NativeVideoSource::new(VideoResolution { width, height }, is_screencast);
            let track = LocalVideoTrack::create_video_track(
                &webrtc_track_id,
                RtcVideoSource::Native(native.clone()),
            );
            (native, track)
        };

        let publish_options = TrackPublishOptions {
            source: lk_track_source(publish_tuning.source),
            stream: format!("raven-video-source-{}", source.id),
            video_encoding: Some(VideoEncoding {
                max_bitrate: publish_tuning.max_bitrate_bps,
                max_framerate: publish_tuning.frame_rate,
            }),
            simulcast: publish_tuning.simulcast,
            ..Default::default()
        };

        let runtime = self.runtime();
        let local_track = LocalTrack::Video(track);
        let publication = runtime
            .block_on(
                room.local_participant()
                    .publish_track(local_track.clone(), publish_options),
            )
            .map_err(|error| error.to_string())?;
        let track_sid = publication.sid();

        let sink = Arc::new(VideoPublishSink::new(native));
        self.publications.insert(
            source.id,
            PublishEntry {
                track_sid,
                track: local_track,
                source: track_source,
                sink,
                profile,
            },
        );
        Ok(())
    }

    fn spawn_viewer_event_loop(
        &mut self,
        app: &AppHandle,
        shared: &SharedVideoEngineState,
        room: Arc<Room>,
        mut events: mpsc::UnboundedReceiver<RoomEvent>,
        readers: &Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
        connected: &Arc<AtomicBool>,
    ) -> JoinHandle<()> {
        let app = app.clone();
        // A weak state reference prevents `state -> engine -> task -> state` from
        // forming a cycle if the app shuts down without an explicit leave command.
        let shared = Arc::downgrade(shared);
        let readers = Arc::clone(readers);
        let connected = Arc::clone(connected);
        let hub = self.hub.clone();
        let presentation = Arc::clone(&self.presentation);
        let runtime = self.runtime().handle().clone();
        self.runtime().spawn(async move {
            let Some(initial_state) = shared.upgrade() else {
                return;
            };
            reflect_viewer_state(&app, &initial_state, &room);
            drop(initial_state);
            while let Some(event) = events.recv().await {
                let Some(shared_state) = shared.upgrade() else {
                    break;
                };
                match event {
                    RoomEvent::TrackPublished {
                        publication,
                        participant,
                    } => {
                        let desired = desired_viewer_subscription(
                            &shared_state,
                            &room,
                            &participant.identity().0,
                            publication.kind(),
                            publication.source(),
                        );
                        if publication.is_desired() != desired {
                            publication.set_subscribed(desired);
                        }
                    }
                    RoomEvent::TrackSubscribed {
                        track, publication, ..
                    } => {
                        let RemoteTrack::Video(video_track) = track else {
                            publication.set_subscribed(false);
                            continue;
                        };
                        let stream_id = remote_stream_id(&publication.sid().to_string());
                        let source = video_track_source(publication.source())
                            .unwrap_or(VideoTrackSource::Camera);
                        let publisher = VideoFramePublisher::new(
                            stream_id.clone(),
                            hub.clone(),
                            Arc::clone(&presentation),
                            source,
                        );
                        let mut stream = NativeVideoStream::new(video_track.rtc_track());
                        let reader = runtime.spawn(async move {
                            while let Some(frame) = stream.next().await {
                                if !publisher.wants_frame() {
                                    continue;
                                }
                                let buffer = frame.buffer.to_i420();
                                publisher
                                    .submit_reusing(|recycled| tight_i420_frame(&buffer, recycled));
                            }
                        });
                        if let Some(previous) = readers.lock().unwrap().insert(stream_id, reader) {
                            previous.abort();
                        }
                    }
                    RoomEvent::TrackUnsubscribed { publication, .. }
                    | RoomEvent::TrackUnpublished { publication, .. } => {
                        let stream_id = remote_stream_id(&publication.sid().to_string());
                        if let Some(reader) = readers.lock().unwrap().remove(&stream_id) {
                            reader.abort();
                        }
                        hub.remove_stream(&stream_id);
                    }
                    RoomEvent::ParticipantDisconnected(participant) => {
                        let track_ids: Vec<String> = participant
                            .track_publications()
                            .values()
                            .filter(|publication| publication.kind() == TrackKind::Video)
                            .map(|publication| remote_stream_id(&publication.sid().to_string()))
                            .collect();
                        let mut active_readers = readers.lock().unwrap();
                        for stream_id in track_ids {
                            if let Some(reader) = active_readers.remove(&stream_id) {
                                reader.abort();
                            }
                            hub.remove_stream(&stream_id);
                        }
                    }
                    RoomEvent::Reconnecting => {
                        connected.store(false, Ordering::Release);
                    }
                    RoomEvent::Reconnected => {
                        connected.store(true, Ordering::Release);
                    }
                    RoomEvent::Disconnected { .. } => {
                        connected.store(false, Ordering::Release);
                        for (stream_id, reader) in readers.lock().unwrap().drain() {
                            reader.abort();
                            hub.remove_stream(&stream_id);
                        }
                        clear_viewer_state(&app, &shared_state);
                        break;
                    }
                    _ => {}
                }
                reflect_viewer_state(&app, &shared_state, &room);
            }
            connected.store(false, Ordering::Release);
            if let Some(shared_state) = shared.upgrade() {
                clear_viewer_state(&app, &shared_state);
            }
        })
    }

    fn spawn_event_loop(
        &mut self,
        mut events: mpsc::UnboundedReceiver<RoomEvent>,
    ) -> JoinHandle<()> {
        // Drain events so the unbounded receiver does not grow without bound. The video
        // sidecar does not subscribe, so there is nothing to act on here.
        self.runtime()
            .spawn(async move { while events.recv().await.is_some() {} })
    }
}

fn clear_viewer_state(app: &AppHandle, shared: &SharedVideoEngineState) {
    let snapshot = {
        let Ok(mut state) = shared.write() else {
            return;
        };
        state.mixer.viewer_connected = false;
        state.mixer.participants.clear();
        state.mixer.remote_tracks.clear();
        state.snapshot()
    };
    let _ = app.emit(VIDEO_STATE_CHANGED_EVENT, snapshot);
}

fn desired_viewer_subscription(
    shared: &SharedVideoEngineState,
    room: &Room,
    participant_identity: &str,
    kind: TrackKind,
    source: TrackSource,
) -> bool {
    let source = video_track_source(source);
    let participant_id = base_participant_identity(participant_identity);
    let local_id = base_participant_identity(&room.local_participant().identity().0).to_string();
    let Ok(state) = shared.read() else {
        return false;
    };
    let preference = source.and_then(|source| {
        state
            .engine
            .remote_preferences
            .get(&subscription_key(participant_id, source))
            .copied()
    });
    should_receive_video(
        &local_id,
        participant_identity,
        kind,
        source,
        state.mixer.self_preview_mode,
        preference,
    )
}

fn should_receive_video(
    local_id: &str,
    participant_identity: &str,
    kind: TrackKind,
    source: Option<VideoTrackSource>,
    self_preview_mode: SelfPreviewMode,
    remote_preference: Option<bool>,
) -> bool {
    if kind != TrackKind::Video || source.is_none() || participant_identity.ends_with("#audio") {
        return false;
    }
    if base_participant_identity(participant_identity) == base_participant_identity(local_id) {
        return self_preview_mode == SelfPreviewMode::Rtc;
    }
    remote_preference.unwrap_or(true)
}

fn reflect_viewer_state(app: &AppHandle, shared: &SharedVideoEngineState, room: &Room) {
    let local_id = base_participant_identity(&room.local_participant().identity().0).to_string();
    let mut participants = BTreeMap::<String, VideoParticipantState>::new();
    participants.insert(
        local_id.clone(),
        VideoParticipantState {
            participant_id: local_id.clone(),
            display_name: room.local_participant().name(),
            is_local: true,
            audio_muted: true,
            speaking: room.local_participant().is_speaking(),
            connection_quality: connection_quality(room.local_participant().connection_quality()),
        },
    );
    let mut tracks = Vec::new();
    for participant in room.remote_participants().values() {
        let identity = participant.identity().0;
        let participant_id = base_participant_identity(&identity).to_string();
        let is_self = participant_id == local_id;
        let display_name = if participant.name().is_empty() {
            participant_id.clone()
        } else {
            participant.name()
        };
        let entry = participants
            .entry(participant_id.clone())
            .or_insert_with(|| VideoParticipantState {
                participant_id: participant_id.clone(),
                display_name: display_name.clone(),
                is_local: is_self,
                audio_muted: true,
                speaking: false,
                connection_quality: VideoConnectionQuality::Unknown,
            });
        if entry.display_name.is_empty() || entry.display_name == entry.participant_id {
            entry.display_name = display_name.clone();
        }
        entry.speaking |= participant.is_speaking();
        entry.connection_quality = worse_quality(
            entry.connection_quality,
            connection_quality(participant.connection_quality()),
        );

        for publication in participant.track_publications().values() {
            if publication.kind() == TrackKind::Audio
                && publication.source() == TrackSource::Microphone
                && !publication.is_muted()
            {
                entry.audio_muted = false;
            }
            let Some(source) = video_track_source(publication.source()) else {
                continue;
            };
            if publication.kind() != TrackKind::Video {
                continue;
            }
            tracks.push(RemoteVideoTrackState {
                stream_id: remote_stream_id(&publication.sid().to_string()),
                participant_id: participant_id.clone(),
                display_name: display_name.clone(),
                source,
                muted: publication.is_muted(),
                subscribed: publication.is_subscribed(),
                desired: publication.is_desired(),
                is_self,
            });
        }
    }
    tracks.sort_by(|left, right| {
        left.participant_id
            .cmp(&right.participant_id)
            .then_with(|| format!("{:?}", left.source).cmp(&format!("{:?}", right.source)))
    });
    let snapshot = {
        let Ok(mut state) = shared.write() else {
            return;
        };
        state.mixer.viewer_connected = true;
        state.mixer.participants = participants.into_values().collect();
        state.mixer.remote_tracks = tracks;
        state.snapshot()
    };
    let _ = app.emit(VIDEO_STATE_CHANGED_EVENT, snapshot);
}

fn tight_i420_frame(buffer: &I420Buffer, recycled: Option<I420Frame>) -> I420Frame {
    let width = buffer.width();
    let height = buffer.height();
    let chroma_width = buffer.chroma_width();
    let chroma_height = buffer.chroma_height();
    let (stride_y, stride_u, stride_v) = buffer.strides();
    let (source_y, source_u, source_v) = buffer.data();
    let mut output = recycled.unwrap_or(I420Frame {
        width,
        height,
        y: Vec::new(),
        u: Vec::new(),
        v: Vec::new(),
    });
    output.width = width;
    output.height = height;
    copy_tight_plane(source_y, stride_y, width, height, &mut output.y);
    copy_tight_plane(
        source_u,
        stride_u,
        chroma_width,
        chroma_height,
        &mut output.u,
    );
    copy_tight_plane(
        source_v,
        stride_v,
        chroma_width,
        chroma_height,
        &mut output.v,
    );
    output
}

fn copy_tight_plane(source: &[u8], stride: u32, width: u32, height: u32, output: &mut Vec<u8>) {
    output.resize((width * height) as usize, 0);
    for row in 0..height as usize {
        let source_start = row * stride as usize;
        let target_start = row * width as usize;
        let count = width as usize;
        if source_start + count <= source.len() {
            output[target_start..target_start + count]
                .copy_from_slice(&source[source_start..source_start + count]);
        }
    }
}

fn video_track_source(source: TrackSource) -> Option<VideoTrackSource> {
    match source {
        TrackSource::Camera => Some(VideoTrackSource::Camera),
        TrackSource::Screenshare => Some(VideoTrackSource::Screenshare),
        _ => None,
    }
}

fn base_participant_identity(identity: &str) -> &str {
    identity
        .strip_suffix("#audio")
        .or_else(|| identity.strip_suffix("#video"))
        .unwrap_or(identity)
}

fn subscription_key(participant_id: &str, source: VideoTrackSource) -> String {
    format!("{participant_id}:{source:?}")
}

fn remote_stream_id(track_sid: &str) -> String {
    format!("remote-{track_sid}")
}

fn connection_quality(quality: ConnectionQuality) -> VideoConnectionQuality {
    match quality {
        ConnectionQuality::Excellent => VideoConnectionQuality::Excellent,
        ConnectionQuality::Good => VideoConnectionQuality::Good,
        ConnectionQuality::Poor => VideoConnectionQuality::Poor,
        ConnectionQuality::Lost => VideoConnectionQuality::Lost,
    }
}

fn worse_quality(
    left: VideoConnectionQuality,
    right: VideoConnectionQuality,
) -> VideoConnectionQuality {
    fn rank(value: VideoConnectionQuality) -> u8 {
        match value {
            VideoConnectionQuality::Lost => 5,
            VideoConnectionQuality::Poor => 4,
            VideoConnectionQuality::Unknown => 3,
            VideoConnectionQuality::Good => 2,
            VideoConnectionQuality::Excellent => 1,
        }
    }
    if rank(right) > rank(left) {
        right
    } else {
        left
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn self_video_is_received_only_for_rtc_preview() {
        assert!(!should_receive_video(
            "person",
            "person#video",
            TrackKind::Video,
            Some(VideoTrackSource::Camera),
            SelfPreviewMode::Local,
            None,
        ));
        assert!(should_receive_video(
            "person",
            "person#video",
            TrackKind::Video,
            Some(VideoTrackSource::Camera),
            SelfPreviewMode::Rtc,
            None,
        ));
    }

    #[test]
    fn audio_and_audio_sidecars_never_enter_the_video_viewer() {
        assert!(!should_receive_video(
            "person",
            "other",
            TrackKind::Audio,
            Some(VideoTrackSource::Camera),
            SelfPreviewMode::Rtc,
            None,
        ));
        assert!(!should_receive_video(
            "person",
            "other#audio",
            TrackKind::Video,
            Some(VideoTrackSource::Camera),
            SelfPreviewMode::Rtc,
            None,
        ));
    }

    #[test]
    fn remote_video_defaults_on_and_respects_native_preferences() {
        assert!(should_receive_video(
            "person",
            "other#video",
            TrackKind::Video,
            Some(VideoTrackSource::Screenshare),
            SelfPreviewMode::Local,
            None,
        ));
        assert!(!should_receive_video(
            "person",
            "other#video",
            TrackKind::Video,
            Some(VideoTrackSource::Camera),
            SelfPreviewMode::Local,
            Some(false),
        ));
    }
}
