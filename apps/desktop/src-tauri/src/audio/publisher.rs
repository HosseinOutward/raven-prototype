use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::audio::domain::{
    AudioSourceId, AudioSourceType, GainDb, ParticipantId, PublishedTrackId,
    PublishedTrackMetadata, WebRtcAudioProcessingSettings,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioTrackSource {
    pub source_id: AudioSourceId,
    pub participant_id: ParticipantId,
    pub source_type: AudioSourceType,
    pub display_name: String,
    pub device_name: Option<String>,
    pub app_name: Option<String>,
    pub app_exe_name: Option<String>,
    pub app_icon_data_url: Option<String>,
    pub default_gain_db: GainDb,
    pub muted: bool,
    pub webrtc_processing: WebRtcAudioProcessingSettings,
}

impl Default for AudioTrackSource {
    fn default() -> Self {
        Self {
            source_id: AudioSourceId::new(),
            participant_id: ParticipantId::new(),
            source_type: AudioSourceType::Unknown,
            display_name: "Unknown source".to_string(),
            device_name: None,
            app_name: None,
            app_exe_name: None,
            app_icon_data_url: None,
            default_gain_db: GainDb::UNITY,
            muted: false,
            webrtc_processing: WebRtcAudioProcessingSettings::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MediaTrackPublication {
    pub source_id: AudioSourceId,
    pub track_id: PublishedTrackId,
    pub webrtc_track_id: String,
    pub source_type: AudioSourceType,
    pub display_name: String,
}

impl MediaTrackPublication {
    pub fn new(source: &AudioTrackSource, track_id: PublishedTrackId) -> Self {
        Self {
            source_id: source.source_id,
            track_id,
            webrtc_track_id: stable_webrtc_track_id(track_id),
            source_type: source.source_type.clone(),
            display_name: source.display_name.clone(),
        }
    }
}

impl Default for MediaTrackPublication {
    fn default() -> Self {
        Self::new(&AudioTrackSource::default(), PublishedTrackId::new())
    }
}

pub trait MediaTrackPublisher {
    fn publish_audio_source(
        &mut self,
        source: AudioTrackSource,
        preferred_track_id: Option<PublishedTrackId>,
    ) -> Result<MediaTrackPublication, MediaTrackPublisherError>;

    fn unpublish_audio_source(
        &mut self,
        source_id: AudioSourceId,
    ) -> Result<Option<MediaTrackPublication>, MediaTrackPublisherError>;
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum AudioTrackPublishInstruction {
    Publish {
        source: AudioTrackSource,
        track: PublishedTrackMetadata,
        #[serde(rename = "webrtcTrackId")]
        webrtc_track_id: String,
    },
    Unpublish {
        #[serde(rename = "sourceId")]
        source_id: AudioSourceId,
        #[serde(rename = "trackId")]
        track_id: PublishedTrackId,
        #[serde(rename = "webrtcTrackId")]
        webrtc_track_id: Option<String>,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PlaceholderMediaTrackPublisher {
    publications: HashMap<AudioSourceId, MediaTrackPublication>,
}

impl PlaceholderMediaTrackPublisher {
    pub fn publication(&self, source_id: AudioSourceId) -> Option<&MediaTrackPublication> {
        self.publications.get(&source_id)
    }
}

impl MediaTrackPublisher for PlaceholderMediaTrackPublisher {
    fn publish_audio_source(
        &mut self,
        source: AudioTrackSource,
        preferred_track_id: Option<PublishedTrackId>,
    ) -> Result<MediaTrackPublication, MediaTrackPublisherError> {
        if let Some(existing) = self.publications.get_mut(&source.source_id) {
            existing.source_type = source.source_type;
            existing.display_name = source.display_name;
            return Ok(existing.clone());
        }

        let publication = MediaTrackPublication::new(
            &source,
            preferred_track_id.unwrap_or_else(PublishedTrackId::new),
        );
        self.publications
            .insert(source.source_id, publication.clone());
        Ok(publication)
    }

    fn unpublish_audio_source(
        &mut self,
        source_id: AudioSourceId,
    ) -> Result<Option<MediaTrackPublication>, MediaTrackPublisherError> {
        Ok(self.publications.remove(&source_id))
    }
}

#[derive(Clone, Debug, Error, PartialEq, Serialize)]
#[serde(tag = "code", content = "detail", rename_all = "camelCase")]
pub enum MediaTrackPublisherError {
    #[error("media publisher is not connected")]
    PublisherNotConnected,
    #[error("audio track source is not available")]
    SourceUnavailable { source_id: AudioSourceId },
}

pub fn stable_webrtc_track_id(track_id: PublishedTrackId) -> String {
    format!("raven-audio-{track_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn publishes_each_source_as_an_independent_track() {
        let mut publisher = PlaceholderMediaTrackPublisher::default();
        let participant_id = ParticipantId::new();
        let mic = AudioTrackSource {
            participant_id,
            source_type: AudioSourceType::Microphone,
            display_name: "Microphone".to_string(),
            ..AudioTrackSource::default()
        };
        let music = AudioTrackSource {
            participant_id,
            source_type: AudioSourceType::FileAudio,
            display_name: "Music".to_string(),
            ..AudioTrackSource::default()
        };

        let mic_publication = publisher
            .publish_audio_source(mic, None)
            .expect("publish mic source");
        let music_publication = publisher
            .publish_audio_source(music, None)
            .expect("publish music source");

        assert_ne!(mic_publication.source_id, music_publication.source_id);
        assert_ne!(mic_publication.track_id, music_publication.track_id);
        assert_eq!(mic_publication.source_type, AudioSourceType::Microphone);
        assert_eq!(music_publication.source_type, AudioSourceType::FileAudio);
    }

    #[test]
    fn repeated_publish_reuses_existing_track_identity() {
        let mut publisher = PlaceholderMediaTrackPublisher::default();
        let source = AudioTrackSource {
            source_type: AudioSourceType::TestTone,
            display_name: "Tone".to_string(),
            ..AudioTrackSource::default()
        };

        let first = publisher
            .publish_audio_source(source.clone(), None)
            .expect("first publish");
        let second = publisher
            .publish_audio_source(source, None)
            .expect("second publish");

        assert_eq!(first.track_id, second.track_id);
        assert_eq!(first.webrtc_track_id, second.webrtc_track_id);
    }

    #[test]
    fn unpublishes_only_the_requested_source() {
        let mut publisher = PlaceholderMediaTrackPublisher::default();
        let mic = AudioTrackSource {
            source_type: AudioSourceType::Microphone,
            display_name: "Mic".to_string(),
            ..AudioTrackSource::default()
        };
        let music = AudioTrackSource {
            source_type: AudioSourceType::FileAudio,
            display_name: "Music".to_string(),
            ..AudioTrackSource::default()
        };
        let mic_id = mic.source_id;
        let music_id = music.source_id;
        publisher
            .publish_audio_source(mic, None)
            .expect("publish mic");
        publisher
            .publish_audio_source(music, None)
            .expect("publish music");

        let unpublished = publisher
            .unpublish_audio_source(music_id)
            .expect("unpublish music")
            .expect("music publication");

        assert_eq!(unpublished.source_id, music_id);
        assert!(publisher.publication(mic_id).is_some());
        assert!(publisher.publication(music_id).is_none());
    }

    #[test]
    fn publish_instruction_shape_is_frontend_friendly() {
        let source = AudioTrackSource {
            source_type: AudioSourceType::Microphone,
            display_name: "Mic".to_string(),
            ..AudioTrackSource::default()
        };
        let track = PublishedTrackMetadata::new(
            source.source_id,
            source.participant_id,
            source.source_type.clone(),
            source.display_name.clone(),
        );
        let instruction = AudioTrackPublishInstruction::Publish {
            source,
            track,
            webrtc_track_id: "raven-audio-track".to_string(),
        };

        let value = serde_json::to_value(instruction).expect("serialize instruction");

        assert_eq!(value["action"], json!("publish"));
        assert!(value["source"]["sourceId"].as_str().is_some());
        assert!(value["track"]["trackId"].as_str().is_some());
        assert_eq!(value["webrtcTrackId"], json!("raven-audio-track"));
    }
}
