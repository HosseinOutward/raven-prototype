//! Local video preview bridge.
//!
//! Raven publishes native camera and screen frames from Rust. When local preview is
//! selected, this module mirrors a bounded copy of those same frames to the native frame
//! service without subscribing to the user's own LiveKit video sidecar.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use crate::video::capture::VideoFrameSink;
use crate::video::convert::I420Frame;
use crate::video::domain::{VideoPresentationSettings, VideoSourceId};
use crate::video::stream::{VideoFrameHub, VideoFramePublisher};

#[derive(Clone)]
pub struct VideoPreviewController {
    enabled: Arc<AtomicBool>,
    hub: VideoFrameHub,
    settings: Arc<RwLock<VideoPresentationSettings>>,
    sinks: Arc<Mutex<HashMap<VideoSourceId, CachedPreviewSink>>>,
}

impl std::fmt::Debug for VideoPreviewController {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("VideoPreviewController")
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct CachedPreviewSink {
    publish: Arc<dyn VideoFrameSink>,
    sink: Arc<dyn VideoFrameSink>,
}

impl VideoPreviewController {
    pub fn new(hub: VideoFrameHub, settings: Arc<RwLock<VideoPresentationSettings>>) -> Self {
        Self {
            enabled: Arc::new(AtomicBool::new(false)),
            hub,
            settings,
            sinks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn wrap_publish_sinks(
        &self,
        publish_sinks: HashMap<VideoSourceId, Arc<dyn VideoFrameSink>>,
    ) -> HashMap<VideoSourceId, Arc<dyn VideoFrameSink>> {
        let Ok(mut cached) = self.sinks.lock() else {
            return publish_sinks;
        };
        cached.retain(|source_id, _| publish_sinks.contains_key(source_id));
        publish_sinks
            .into_iter()
            .map(|(source_id, publish)| {
                if let Some(existing) = cached.get(&source_id) {
                    if Arc::ptr_eq(&existing.publish, &publish) {
                        return (source_id, Arc::clone(&existing.sink));
                    }
                }
                let publish_for_cache = Arc::clone(&publish);
                let sink: Arc<dyn VideoFrameSink> = Arc::new(PreviewingVideoFrameSink {
                    publish,
                    enabled: Arc::clone(&self.enabled),
                    preview: VideoFramePublisher::new(
                        format!("local-{source_id}"),
                        self.hub.clone(),
                        Arc::clone(&self.settings),
                    ),
                });
                cached.insert(
                    source_id,
                    CachedPreviewSink {
                        publish: publish_for_cache,
                        sink: Arc::clone(&sink),
                    },
                );
                (source_id, sink)
            })
            .collect()
    }
}

struct PreviewingVideoFrameSink {
    publish: Arc<dyn VideoFrameSink>,
    enabled: Arc<AtomicBool>,
    preview: VideoFramePublisher,
}

impl std::fmt::Debug for PreviewingVideoFrameSink {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreviewingVideoFrameSink")
            .field("stream_id", &self.preview.stream_id())
            .finish_non_exhaustive()
    }
}

impl VideoFrameSink for PreviewingVideoFrameSink {
    fn push_frame(&self, frame: I420Frame) {
        if self.enabled.load(Ordering::Relaxed) && self.preview.wants_frame() {
            self.preview.submit_copy(&frame);
            self.publish.push_frame(frame);
        } else {
            self.publish.push_frame(frame);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct NullSink;

    impl VideoFrameSink for NullSink {
        fn push_frame(&self, _frame: I420Frame) {}
    }

    #[test]
    fn state_only_reconciliation_reuses_the_same_preview_sink() {
        let controller = VideoPreviewController::new(
            VideoFrameHub::default(),
            Arc::new(RwLock::new(VideoPresentationSettings::default())),
        );
        let source_id = VideoSourceId::new();
        let publish: Arc<dyn VideoFrameSink> = Arc::new(NullSink);
        let first =
            controller.wrap_publish_sinks(HashMap::from([(source_id, Arc::clone(&publish))]));
        let second = controller.wrap_publish_sinks(HashMap::from([(source_id, publish)]));
        assert!(Arc::ptr_eq(
            first.get(&source_id).unwrap(),
            second.get(&source_id).unwrap()
        ));
    }
}
