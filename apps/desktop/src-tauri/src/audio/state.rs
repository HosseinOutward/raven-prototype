use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{Arc, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use thiserror::Error;

use crate::audio::capture::{
    list_input_devices, list_output_devices, system_audio_runtime_readiness, CaptureRuntimeManager,
};
use crate::audio::domain::{
    AudioConnectionStatus, AudioInputDevice, AudioMixerState, AudioOutputDevice,
    AudioPlaybackStatus, AudioPreset, AudioPresetDefinition, AudioPresetTarget, AudioProcessorId,
    AudioProcessorKind, AudioProcessorParameters, AudioProcessorState, AudioSourceId,
    AudioSourceState, AudioSourceType, AudioSubscriptionStatus, ChannelHealthState, GainDb,
    MeterState, ParticipantId, ProcessorChainState, PublishedTrackId, PublishedTrackMetadata,
    PublishedTrackMetadataPatch, RemoteAudioTrackState, RemoteParticipantAudioState,
    TrackLifecycleEvent, WebRtcAudioProcessingSettings,
};
use crate::audio::engine::{measure_audio_network_totals, AudioEngine, AudioNetworkTotals};
use crate::audio::processor::{
    AudioParameterValue, AudioProcessorRuntime, ProcessorChainRuntime, ProcessorRuntime,
};
use crate::audio::publisher::{
    AudioTrackPublishInstruction, AudioTrackSource, MediaTrackPublisher, MediaTrackPublisherError,
    PlaceholderMediaTrackPublisher,
};
use crate::audio::safety::{
    chain_cpu_estimate, chain_latency_samples, clamp_channel_gain, clamp_safety_limiter_ceiling,
    health_from_meter,
};

pub const AUDIO_STATE_CHANGED_EVENT: &str = "audio-state-changed";
pub const AUDIO_METER_CHANGED_EVENT: &str = "audio-meter-changed";
pub const AUDIO_TRACK_PUBLISH_INSTRUCTION_EVENT: &str = "audio-track-publish-instruction";
const USER_PRESETS_FILE_NAME: &str = "audio-presets.json";

pub type SharedAudioEngineState = Arc<RwLock<AudioEngineState>>;

pub fn new_shared_audio_engine_state() -> SharedAudioEngineState {
    Arc::new(RwLock::new(AudioEngineState::default()))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioCapabilityReport {
    pub os: String,
    pub issues: Vec<String>,
    pub supported_source_types: Vec<AudioSourceType>,
    pub supports_microphone: bool,
    pub supports_system_audio: bool,
    pub supports_app_audio: bool,
    pub supports_screen_audio: bool,
    pub supports_test_tone: bool,
    pub supports_input_devices: bool,
    pub supports_output_devices: bool,
    pub supports_app_audio_process_list: bool,
}

#[derive(Debug)]
pub struct AudioEngineState {
    pub mixer: AudioMixerState,
    pub publisher: PlaceholderMediaTrackPublisher,
    pub user_presets: Vec<AudioPresetDefinition>,
    pub user_presets_loaded: bool,
    pub capture: CaptureRuntimeManager,
    pub engine: AudioEngine,
    /// LiveKit username per remote participant id, used as the Incoming Tracks group header.
    /// Not serialized into the mixer snapshot; it feeds `refresh_remote_participants`.
    pub remote_owner_names: HashMap<ParticipantId, String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AudioPublishMutation {
    pub source: AudioSourceState,
    pub instruction: AudioTrackPublishInstruction,
}

impl AudioEngineState {
    pub fn snapshot(&self) -> AudioMixerState {
        self.mixer.clone()
    }

    pub fn list_presets(&self) -> Vec<AudioPresetDefinition> {
        let mut presets = built_in_audio_presets();
        presets.extend(self.user_presets.clone());
        presets
    }

    pub fn apply_preset_to_local_channel(
        &mut self,
        source_id: AudioSourceId,
        preset_id: &str,
    ) -> Result<AudioSourceState, AudioStateError> {
        let preset = self.preset_by_id(preset_id)?;
        let source = self.local_source_mut(source_id)?;
        validate_preset_for_local_source(&preset, &source.source_type)?;

        source.channel_strip.gain_db = preset.gain_db;
        source.channel_strip.mute.muted = preset.muted;
        source.channel_strip.mute.muted_by_user = preset.muted;
        source.channel_strip.processor_chain = clone_chain_for_channel(&preset.processor_chain);
        source.channel_strip.preset = legacy_preset_marker(&preset);
        source.channel_strip.preset_id = Some(preset.preset_id.clone());
        refresh_local_channel_health(source);

        let event = if let Some(track) = &mut source.published_track {
            track.default_gain_db = preset.gain_db;
            track.muted = preset.muted;
            track.updated_at = Some(now_unix_ms_string());
            Some(TrackLifecycleEvent::TrackMetadataUpdated {
                track: track.clone(),
            })
        } else {
            None
        };
        let source = source.clone();
        if let Some(event) = event {
            self.mixer.track_events.push(event);
        }
        Ok(source)
    }

    pub fn apply_preset_to_remote_track(
        &mut self,
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
        preset_id: &str,
    ) -> Result<RemoteAudioTrackState, AudioStateError> {
        let preset = self.preset_by_id(preset_id)?;
        let remote = self.remote_track_mut(remote_participant_id, remote_track_id)?;
        validate_preset_for_remote_track(&preset, &remote.track.source_type)?;

        remote.receiver_channel_strip.gain_db = preset.gain_db;
        remote.receiver_channel_strip.mute.muted = preset.muted;
        remote.receiver_channel_strip.mute.muted_by_user = preset.muted;
        remote.receiver_channel_strip.processor_chain =
            clone_chain_for_channel(&preset.processor_chain);
        remote.receiver_channel_strip.preset = legacy_preset_marker(&preset);
        remote.receiver_channel_strip.preset_id = Some(preset.preset_id.clone());
        remote.preference.gain_db = preset.gain_db;
        remote.preference.muted = preset.muted;
        remote.preference.processor_chain = remote.receiver_channel_strip.processor_chain.clone();
        refresh_remote_channel_health(remote);

        let remote = remote.clone();
        self.refresh_remote_participants();
        Ok(remote)
    }

    pub fn save_local_channel_as_preset(
        &mut self,
        source_id: AudioSourceId,
        name: String,
        description: String,
        target: AudioPresetTarget,
    ) -> Result<AudioPresetDefinition, AudioStateError> {
        let source = self.local_source_mut(source_id)?;
        let preset = preset_from_parts(
            name,
            description,
            target,
            source.channel_strip.gain_db,
            source.channel_strip.mute.muted,
            &source.channel_strip.processor_chain,
        )?;
        validate_preset_for_local_source(&preset, &source.source_type)?;
        self.user_presets.push(preset.clone());
        Ok(preset)
    }

    pub fn save_remote_track_as_preset(
        &mut self,
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
        name: String,
        description: String,
        target: AudioPresetTarget,
    ) -> Result<AudioPresetDefinition, AudioStateError> {
        let remote = self.remote_track_mut(remote_participant_id, remote_track_id)?;
        let preset = preset_from_parts(
            name,
            description,
            target,
            remote.receiver_channel_strip.gain_db,
            remote.receiver_channel_strip.mute.muted,
            &remote.receiver_channel_strip.processor_chain,
        )?;
        validate_preset_for_remote_track(&preset, &remote.track.source_type)?;
        self.user_presets.push(preset.clone());
        Ok(preset)
    }

    pub fn delete_user_preset(
        &mut self,
        preset_id: &str,
    ) -> Result<AudioPresetDefinition, AudioStateError> {
        if built_in_audio_presets()
            .iter()
            .any(|preset| preset.preset_id == preset_id)
        {
            return Err(AudioStateError::BuiltInPresetMutationNotAllowed {
                preset_id: preset_id.to_string(),
            });
        }
        let index = self
            .user_presets
            .iter()
            .position(|preset| preset.preset_id == preset_id)
            .ok_or(AudioStateError::PresetNotFound {
                preset_id: preset_id.to_string(),
            })?;
        let removed = self.user_presets.remove(index);
        for source in &mut self.mixer.local_sources {
            if source.channel_strip.preset_id.as_deref() == Some(preset_id) {
                source.channel_strip.preset_id = None;
                source.channel_strip.preset = AudioPreset::Custom;
            }
        }
        for remote in &mut self.mixer.remote_tracks {
            if remote.receiver_channel_strip.preset_id.as_deref() == Some(preset_id) {
                remote.receiver_channel_strip.preset_id = None;
                remote.receiver_channel_strip.preset = AudioPreset::Custom;
            }
        }
        self.refresh_remote_participants();
        Ok(removed)
    }

    pub fn rename_user_preset(
        &mut self,
        preset_id: &str,
        name: String,
    ) -> Result<AudioPresetDefinition, AudioStateError> {
        let name = normalize_preset_name(name)?;
        if built_in_audio_presets()
            .iter()
            .any(|preset| preset.preset_id == preset_id)
        {
            return Err(AudioStateError::BuiltInPresetMutationNotAllowed {
                preset_id: preset_id.to_string(),
            });
        }
        let preset = self
            .user_presets
            .iter_mut()
            .find(|preset| preset.preset_id == preset_id)
            .ok_or(AudioStateError::PresetNotFound {
                preset_id: preset_id.to_string(),
            })?;
        preset.name = name;
        preset.updated_at = Some(now_unix_ms_string());
        Ok(preset.clone())
    }

    pub fn reset_local_channel_processor_chain(
        &mut self,
        source_id: AudioSourceId,
    ) -> Result<AudioSourceState, AudioStateError> {
        let source = self.local_source_mut(source_id)?;
        source.channel_strip.processor_chain = ProcessorChainState::default();
        source.channel_strip.preset = AudioPreset::Neutral;
        source.channel_strip.preset_id = None;
        refresh_local_channel_health(source);
        Ok(source.clone())
    }

    pub fn reset_local_channel_to_safe_defaults(
        &mut self,
        source_id: AudioSourceId,
    ) -> Result<AudioSourceState, AudioStateError> {
        let source_type = self.local_source_mut(source_id)?.source_type.clone();
        if matches!(source_type, AudioSourceType::Microphone) {
            let _ = self.apply_preset_to_local_channel(source_id, "clean-meeting-voice")?;
        } else {
            let _ = self.apply_preset_to_local_channel(source_id, "flat-no-processing")?;
        }
        let source = self.local_source_mut(source_id)?;
        source.channel_strip.gain_db = GainDb::UNITY;
        source.channel_strip.mute.muted = false;
        source.channel_strip.mute.muted_by_user = false;
        source.channel_strip.safety_limiter_ceiling_db = GainDb::new(-1.0);
        refresh_local_channel_health(source);
        Ok(source.clone())
    }

    pub fn reset_remote_track_processor_chain(
        &mut self,
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
    ) -> Result<RemoteAudioTrackState, AudioStateError> {
        let remote = self.remote_track_mut(remote_participant_id, remote_track_id)?;
        remote.receiver_channel_strip.processor_chain = ProcessorChainState::default();
        remote.receiver_channel_strip.preset = AudioPreset::Neutral;
        remote.receiver_channel_strip.preset_id = None;
        remote.preference.processor_chain = ProcessorChainState::default();
        refresh_remote_channel_health(remote);
        let remote = remote.clone();
        self.refresh_remote_participants();
        Ok(remote)
    }

    pub fn reset_remote_track_to_safe_defaults(
        &mut self,
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
    ) -> Result<RemoteAudioTrackState, AudioStateError> {
        let remote = self.remote_track_mut(remote_participant_id, remote_track_id)?;
        remote.receiver_channel_strip.gain_db = GainDb::UNITY;
        remote.receiver_channel_strip.mute.muted = false;
        remote.receiver_channel_strip.mute.muted_by_user = false;
        remote.receiver_channel_strip.safety_limiter_ceiling_db = GainDb::new(-1.0);
        for processor in &mut remote.receiver_channel_strip.processor_chain.processors {
            processor.enabled = false;
        }
        remote.preference.gain_db = GainDb::UNITY;
        remote.preference.muted = false;
        remote.preference.processor_chain = remote.receiver_channel_strip.processor_chain.clone();
        refresh_remote_channel_health(remote);
        let remote = remote.clone();
        self.refresh_remote_participants();
        Ok(remote)
    }

    pub fn add_local_source(
        &mut self,
        source_type: AudioSourceType,
        display_name: impl Into<String>,
    ) -> AudioSourceState {
        let source = AudioSourceState::new(
            self.local_participant_id(),
            source_type,
            display_name.into(),
        );
        self.mixer.local_sources.push(source.clone());
        source
    }

    pub fn remove_local_source(
        &mut self,
        source_id: AudioSourceId,
    ) -> Result<AudioSourceState, AudioStateError> {
        let index = self
            .mixer
            .local_sources
            .iter()
            .position(|source| source.id == source_id)
            .ok_or(AudioStateError::SourceNotFound { source_id })?;

        let removed = self.mixer.local_sources.remove(index);
        let _ = self.publisher.unpublish_audio_source(source_id)?;
        if let Some(track) = removed.published_track.clone() {
            self.mixer
                .track_events
                .push(TrackLifecycleEvent::TrackUnpublished { track });
        }

        Ok(removed)
    }

    pub fn rename_local_source(
        &mut self,
        source_id: AudioSourceId,
        display_name: impl Into<String>,
    ) -> Result<AudioSourceState, AudioStateError> {
        let source = self.local_source_mut(source_id)?;
        source.display_name = display_name.into();

        let event = if let Some(track) = &mut source.published_track {
            track.display_name = source.display_name.clone();
            track.updated_at = Some(now_unix_ms_string());
            Some(TrackLifecycleEvent::TrackMetadataUpdated {
                track: track.clone(),
            })
        } else {
            None
        };
        let source = source.clone();
        if let Some(event) = event {
            self.mixer.track_events.push(event);
        }

        Ok(source)
    }

    pub fn set_local_source_enabled(
        &mut self,
        source_id: AudioSourceId,
        enabled: bool,
    ) -> Result<AudioSourceState, AudioStateError> {
        let source = self.local_source_mut(source_id)?;
        source.enabled = enabled;
        Ok(source.clone())
    }

    pub fn set_local_source_capture_device(
        &mut self,
        source_id: AudioSourceId,
        capture_device_id: Option<String>,
    ) -> Result<AudioSourceState, AudioStateError> {
        let source = self.local_source_mut(source_id)?;
        source.capture_device_id = capture_device_id.filter(|value| !value.trim().is_empty());
        Ok(source.clone())
    }

    pub fn set_local_channel_gain(
        &mut self,
        source_id: AudioSourceId,
        gain_db: GainDb,
    ) -> Result<AudioSourceState, AudioStateError> {
        let source = self.local_source_mut(source_id)?;
        source.channel_strip.gain_db = clamp_channel_gain(gain_db);
        refresh_local_channel_health(source);
        Ok(source.clone())
    }

    pub fn set_local_safety_limiter_ceiling(
        &mut self,
        source_id: AudioSourceId,
        ceiling_db: GainDb,
    ) -> Result<AudioSourceState, AudioStateError> {
        let source = self.local_source_mut(source_id)?;
        source.channel_strip.safety_limiter_ceiling_db = clamp_safety_limiter_ceiling(ceiling_db);
        refresh_local_channel_health(source);
        Ok(source.clone())
    }

    pub fn set_local_channel_mute(
        &mut self,
        source_id: AudioSourceId,
        muted: bool,
    ) -> Result<AudioSourceState, AudioStateError> {
        let source = self.local_source_mut(source_id)?;
        source.channel_strip.mute.muted = muted;
        source.channel_strip.mute.muted_by_user = muted;
        refresh_local_channel_health(source);

        let event = if let Some(track) = &mut source.published_track {
            track.muted = muted;
            track.updated_at = Some(now_unix_ms_string());
            Some(if muted {
                TrackLifecycleEvent::TrackMuted {
                    track_id: track.track_id,
                }
            } else {
                TrackLifecycleEvent::TrackUnmuted {
                    track_id: track.track_id,
                }
            })
        } else {
            None
        };
        let source = source.clone();
        if let Some(event) = event {
            self.mixer.track_events.push(event);
        }

        Ok(source)
    }

    pub fn set_local_webrtc_processing(
        &mut self,
        source_id: AudioSourceId,
        processing: WebRtcAudioProcessingSettings,
    ) -> Result<(AudioSourceState, Option<AudioTrackPublishInstruction>), AudioStateError> {
        let source = self.local_source_mut(source_id)?;
        source.channel_strip.webrtc_processing = processing;
        let source = source.clone();
        let instruction =
            source
                .published_track
                .clone()
                .map(|track| AudioTrackPublishInstruction::Publish {
                    source: audio_track_source_from_source(&source),
                    webrtc_track_id: track.webrtc_track_id.clone().unwrap_or_else(|| {
                        crate::audio::publisher::stable_webrtc_track_id(track.track_id)
                    }),
                    track,
                });
        Ok((source, instruction))
    }

    pub fn publish_local_source_metadata(
        &mut self,
        source_id: AudioSourceId,
    ) -> Result<AudioSourceState, AudioStateError> {
        Ok(self.publish_audio_source(source_id)?.source)
    }

    pub fn publish_audio_source(
        &mut self,
        source_id: AudioSourceId,
    ) -> Result<AudioPublishMutation, AudioStateError> {
        let index = self.local_source_index(source_id)?;
        let source_snapshot = self.mixer.local_sources[index].clone();
        let existing_track = source_snapshot.published_track.clone();
        let source_descriptor = audio_track_source_from_source(&source_snapshot);
        let publication = self.publisher.publish_audio_source(
            source_descriptor.clone(),
            existing_track.as_ref().map(|track| track.track_id),
        )?;

        let now = now_unix_ms_string();
        let mut track = existing_track.unwrap_or_else(|| {
            PublishedTrackMetadata::new(
                source_snapshot.id,
                source_snapshot.owner_id,
                source_snapshot.source_type.clone(),
                source_snapshot.display_name.clone(),
            )
        });
        let was_published = self.mixer.local_sources[index].published_track.is_some();
        if !was_published {
            track.created_at = Some(now.clone());
        }
        track.track_id = publication.track_id;
        track.source_id = source_snapshot.id;
        track.participant_id = source_snapshot.owner_id;
        track.source_type = source_snapshot.source_type.clone();
        track.display_name = source_snapshot.display_name.clone();
        track.device_name = source_snapshot.runtime.device_name.clone();
        track.app_name = (source_snapshot.source_type == AudioSourceType::AppAudio)
            .then(|| source_snapshot.display_name.clone());
        track.default_gain_db = source_snapshot.channel_strip.gain_db;
        track.muted = source_snapshot.channel_strip.mute.muted;
        track.webrtc_track_id = Some(publication.webrtc_track_id.clone());
        track.updated_at = Some(now);

        let source = &mut self.mixer.local_sources[index];
        source.publishing = true;
        source.published_track = Some(track.clone());
        let source = source.clone();
        if was_published {
            self.mixer
                .track_events
                .push(TrackLifecycleEvent::TrackMetadataUpdated {
                    track: track.clone(),
                });
        } else {
            self.mixer
                .track_events
                .push(TrackLifecycleEvent::TrackPublished {
                    track: track.clone(),
                });
        }

        Ok(AudioPublishMutation {
            source,
            instruction: AudioTrackPublishInstruction::Publish {
                source: source_descriptor,
                track,
                webrtc_track_id: publication.webrtc_track_id,
            },
        })
    }

    pub fn unpublish_local_source_metadata(
        &mut self,
        source_id: AudioSourceId,
    ) -> Result<AudioSourceState, AudioStateError> {
        Ok(self.unpublish_audio_source(source_id)?.source)
    }

    pub fn unpublish_audio_source(
        &mut self,
        source_id: AudioSourceId,
    ) -> Result<AudioPublishMutation, AudioStateError> {
        let source = self.local_source_mut(source_id)?;
        let track = source
            .published_track
            .take()
            .ok_or(AudioStateError::SourceNotPublished {
                source_id: source.id,
            })?;
        source.publishing = false;
        let source = source.clone();
        let _ = self.publisher.unpublish_audio_source(source_id)?;
        self.mixer
            .track_events
            .push(TrackLifecycleEvent::TrackUnpublished {
                track: track.clone(),
            });
        Ok(AudioPublishMutation {
            source,
            instruction: AudioTrackPublishInstruction::Unpublish {
                source_id,
                track_id: track.track_id,
                webrtc_track_id: track.webrtc_track_id,
            },
        })
    }

    pub fn update_published_track_metadata(
        &mut self,
        track_id: PublishedTrackId,
        patch: PublishedTrackMetadataPatch,
    ) -> Result<AudioSourceState, AudioStateError> {
        let source = self
            .mixer
            .local_sources
            .iter_mut()
            .find(|source| {
                source
                    .published_track
                    .as_ref()
                    .is_some_and(|track| track.track_id == track_id)
            })
            .ok_or(AudioStateError::PublishedTrackNotFound { track_id })?;

        let track = source
            .published_track
            .as_mut()
            .ok_or(AudioStateError::PublishedTrackNotFound { track_id })?;

        if let Some(display_name) = patch.display_name {
            track.display_name = display_name;
        }
        if let Some(device_name) = patch.device_name {
            track.device_name = Some(device_name);
        }
        if let Some(app_name) = patch.app_name {
            track.app_name = Some(app_name);
        }
        if let Some(app_exe_name) = patch.app_exe_name {
            track.app_exe_name = Some(app_exe_name);
        }
        if let Some(app_icon_data_url) = patch.app_icon_data_url {
            track.app_icon_data_url = Some(app_icon_data_url);
        }
        if let Some(controllable) = patch.controllable {
            track.controllable = controllable;
        }
        if let Some(default_gain_db) = patch.default_gain_db {
            track.default_gain_db = default_gain_db;
        }
        if let Some(muted) = patch.muted {
            track.muted = muted;
            source.channel_strip.mute.muted = muted;
            source.channel_strip.mute.muted_by_user = muted;
        }
        if let Some(codec) = patch.codec {
            track.codec = Some(codec);
        }
        if let Some(encoding) = patch.encoding {
            track.encoding = Some(encoding);
        }
        if let Some(webrtc_track_id) = patch.webrtc_track_id {
            track.webrtc_track_id = Some(webrtc_track_id);
        }
        track.updated_at = Some(now_unix_ms_string());

        let event = TrackLifecycleEvent::TrackMetadataUpdated {
            track: track.clone(),
        };
        let source = source.clone();
        self.mixer.track_events.push(event);
        Ok(source)
    }

    pub fn add_or_update_remote_track(
        &mut self,
        metadata: PublishedTrackMetadata,
    ) -> RemoteAudioTrackState {
        let participant_id = metadata.participant_id;
        let track_id = metadata.track_id;
        let remote_track = if let Some(existing) =
            self.mixer.remote_tracks.iter_mut().find(|remote| {
                remote.track.participant_id == participant_id && remote.track.track_id == track_id
            }) {
            existing.track = metadata;
            existing.subscribed = true;
            existing.subscription_status = AudioSubscriptionStatus::Subscribed;
            existing.clone()
        } else {
            let remote_track = RemoteAudioTrackState::new(metadata);
            self.mixer.remote_tracks.push(remote_track.clone());
            remote_track
        };
        self.refresh_remote_participants();
        remote_track
    }

    pub fn remove_remote_track(
        &mut self,
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
    ) -> Result<RemoteAudioTrackState, AudioStateError> {
        let index = self.remote_track_index(remote_participant_id, remote_track_id)?;
        let removed = self.mixer.remote_tracks.remove(index);
        self.refresh_remote_participants();
        Ok(removed)
    }

    /// Drop every remote track owned by a participant (e.g. when their audio sidecar
    /// disconnects from the LiveKit room).
    pub fn remove_remote_participant(&mut self, remote_participant_id: ParticipantId) {
        self.mixer
            .remote_tracks
            .retain(|remote| remote.track.participant_id != remote_participant_id);
        self.remote_owner_names.remove(&remote_participant_id);
        self.refresh_remote_participants();
    }

    pub fn set_remote_track_subscription_status(
        &mut self,
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
        status: AudioSubscriptionStatus,
    ) {
        if let Some(remote) = self.mixer.remote_tracks.iter_mut().find(|remote| {
            remote.track.participant_id == remote_participant_id
                && remote.track.track_id == remote_track_id
        }) {
            remote.subscribed = status == AudioSubscriptionStatus::Subscribed;
            remote.subscription_status = status;
        }
        self.refresh_remote_participants();
    }

    /// Keep the receiver's view of a remote publication in sync with LiveKit's
    /// mute lifecycle. This is separate from the receiver-local mute control:
    /// the former describes whether the owner is sending audio, while the latter
    /// describes whether this peer chooses to hear it.
    pub fn set_remote_track_muted(
        &mut self,
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
        muted: bool,
    ) {
        if let Ok(remote) = self.remote_track_mut(remote_participant_id, remote_track_id) {
            remote.track.muted = muted;
            self.refresh_remote_participants();
        }
    }

    /// Record a remote participant's LiveKit username so the Incoming Tracks group shows
    /// their name instead of a raw id.
    pub fn set_remote_owner_name(&mut self, remote_participant_id: ParticipantId, name: String) {
        if name.is_empty() {
            return;
        }
        let changed = self
            .remote_owner_names
            .get(&remote_participant_id)
            .map(|existing| existing != &name)
            .unwrap_or(true);
        if changed {
            self.remote_owner_names.insert(remote_participant_id, name);
            self.refresh_remote_participants();
        }
    }

    /// Apply the owner-shared metadata (precise source type + human display name) onto a
    /// subscribed remote track, so each incoming track shows what the owner is actually
    /// sharing (e.g. "Chrome" app audio, or which microphone).
    pub fn update_remote_track_meta(
        &mut self,
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
        source_type: AudioSourceType,
        display_name: String,
        device_name: Option<String>,
        app_name: Option<String>,
        app_exe_name: Option<String>,
        app_icon_data_url: Option<String>,
    ) {
        if let Ok(remote) = self.remote_track_mut(remote_participant_id, remote_track_id) {
            remote.track.source_type = source_type;
            if !display_name.is_empty() {
                remote.track.display_name = display_name;
            }
            remote.track.device_name = device_name;
            remote.track.app_name = app_name;
            remote.track.app_exe_name = app_exe_name;
            remote.track.app_icon_data_url = app_icon_data_url;
            self.refresh_remote_participants();
        }
    }

    /// Update the live meter for a subscribed remote track. The native engine computes this
    /// from the audio it actually plays out, so the Incoming Tracks meters move with the
    /// received signal. Silently ignores tracks that have since been removed.
    pub fn set_remote_track_meter(
        &mut self,
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
        meter: MeterState,
    ) {
        if let Ok(remote) = self.remote_track_mut(remote_participant_id, remote_track_id) {
            remote.receiver_channel_strip.meter = meter;
            refresh_remote_channel_health(remote);
            self.refresh_remote_participants();
        }
    }

    pub fn set_remote_track_gain(
        &mut self,
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
        gain_db: GainDb,
    ) -> Result<RemoteAudioTrackState, AudioStateError> {
        let remote = self.remote_track_mut(remote_participant_id, remote_track_id)?;
        let gain_db = clamp_channel_gain(gain_db);
        remote.receiver_channel_strip.gain_db = gain_db;
        remote.preference.gain_db = gain_db;
        refresh_remote_channel_health(remote);
        let remote = remote.clone();
        self.refresh_remote_participants();
        Ok(remote)
    }

    pub fn set_remote_safety_limiter_ceiling(
        &mut self,
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
        ceiling_db: GainDb,
    ) -> Result<RemoteAudioTrackState, AudioStateError> {
        let remote = self.remote_track_mut(remote_participant_id, remote_track_id)?;
        remote.receiver_channel_strip.safety_limiter_ceiling_db =
            clamp_safety_limiter_ceiling(ceiling_db);
        refresh_remote_channel_health(remote);
        let remote = remote.clone();
        self.refresh_remote_participants();
        Ok(remote)
    }

    pub fn set_remote_track_mute(
        &mut self,
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
        muted: bool,
    ) -> Result<RemoteAudioTrackState, AudioStateError> {
        let remote = self.remote_track_mut(remote_participant_id, remote_track_id)?;
        remote.receiver_channel_strip.mute.muted = muted;
        remote.receiver_channel_strip.mute.muted_by_user = muted;
        remote.preference.muted = muted;
        refresh_remote_channel_health(remote);
        let remote = remote.clone();
        self.refresh_remote_participants();
        Ok(remote)
    }

    pub fn add_processor_to_remote_track(
        &mut self,
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
        kind: AudioProcessorKind,
    ) -> Result<RemoteAudioTrackState, AudioStateError> {
        let remote = self.remote_track_mut(remote_participant_id, remote_track_id)?;
        let processor =
            AudioProcessorState::new(kind.clone(), default_processor_display_name(&kind));
        remote
            .receiver_channel_strip
            .processor_chain
            .processors
            .push(processor);
        remote.preference.processor_chain = remote.receiver_channel_strip.processor_chain.clone();
        refresh_remote_channel_health(remote);
        let remote = remote.clone();
        self.refresh_remote_participants();
        Ok(remote)
    }

    pub fn set_remote_processor_enabled(
        &mut self,
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
        processor_id: AudioProcessorId,
        enabled: bool,
    ) -> Result<RemoteAudioTrackState, AudioStateError> {
        let remote = self.remote_track_mut(remote_participant_id, remote_track_id)?;
        let processor = remote
            .receiver_channel_strip
            .processor_chain
            .processors
            .iter_mut()
            .find(|processor| processor.id == processor_id)
            .ok_or(AudioStateError::RemoteProcessorNotFound {
                remote_participant_id,
                remote_track_id,
                processor_id,
            })?;
        processor.enabled = enabled;
        remote.preference.processor_chain = remote.receiver_channel_strip.processor_chain.clone();
        refresh_remote_channel_health(remote);
        let remote = remote.clone();
        self.refresh_remote_participants();
        Ok(remote)
    }

    pub fn remove_processor_from_remote_track(
        &mut self,
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
        processor_id: AudioProcessorId,
    ) -> Result<RemoteAudioTrackState, AudioStateError> {
        let remote = self.remote_track_mut(remote_participant_id, remote_track_id)?;
        let processors = &mut remote.receiver_channel_strip.processor_chain.processors;
        let index = processors
            .iter()
            .position(|processor| processor.id == processor_id)
            .ok_or(AudioStateError::RemoteProcessorNotFound {
                remote_participant_id,
                remote_track_id,
                processor_id,
            })?;
        processors.remove(index);
        remote.preference.processor_chain = remote.receiver_channel_strip.processor_chain.clone();
        refresh_remote_channel_health(remote);
        let remote = remote.clone();
        self.refresh_remote_participants();
        Ok(remote)
    }

    pub fn reorder_remote_processors(
        &mut self,
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
        ordered_processor_ids: Vec<AudioProcessorId>,
    ) -> Result<RemoteAudioTrackState, AudioStateError> {
        let remote = self.remote_track_mut(remote_participant_id, remote_track_id)?;
        let processors = &mut remote.receiver_channel_strip.processor_chain.processors;
        if ordered_processor_ids.len() != processors.len() {
            return Err(AudioStateError::RemoteProcessorOrderInvalid {
                remote_participant_id,
                remote_track_id,
                message: "ordered processor ids must include every processor exactly once"
                    .to_string(),
            });
        }

        let mut reordered = Vec::with_capacity(processors.len());
        for processor_id in &ordered_processor_ids {
            if reordered
                .iter()
                .any(|processor: &AudioProcessorState| processor.id == *processor_id)
            {
                return Err(AudioStateError::RemoteProcessorOrderInvalid {
                    remote_participant_id,
                    remote_track_id,
                    message: "ordered processor ids must not contain duplicates".to_string(),
                });
            }
            let processor = processors
                .iter()
                .find(|processor| processor.id == *processor_id)
                .cloned()
                .ok_or(AudioStateError::RemoteProcessorNotFound {
                    remote_participant_id,
                    remote_track_id,
                    processor_id: *processor_id,
                })?;
            reordered.push(processor);
        }

        *processors = reordered;
        remote.preference.processor_chain = remote.receiver_channel_strip.processor_chain.clone();
        refresh_remote_channel_health(remote);
        let remote = remote.clone();
        self.refresh_remote_participants();
        Ok(remote)
    }

    pub fn set_remote_processor_parameter(
        &mut self,
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
        processor_id: AudioProcessorId,
        name: &str,
        value: AudioParameterValue,
    ) -> Result<RemoteAudioTrackState, AudioStateError> {
        let remote = self.remote_track_mut(remote_participant_id, remote_track_id)?;
        let processor = remote
            .receiver_channel_strip
            .processor_chain
            .processors
            .iter_mut()
            .find(|processor| processor.id == processor_id)
            .ok_or(AudioStateError::RemoteProcessorNotFound {
                remote_participant_id,
                remote_track_id,
                processor_id,
            })?;

        let mut runtime = ProcessorRuntime::from_state(processor.clone()).map_err(|error| {
            AudioStateError::RemoteProcessorParameterInvalid {
                remote_participant_id,
                remote_track_id,
                processor_id,
                message: error.to_string(),
            }
        })?;
        runtime.set_parameter(name, value).map_err(|error| {
            AudioStateError::RemoteProcessorParameterInvalid {
                remote_participant_id,
                remote_track_id,
                processor_id,
                message: error.to_string(),
            }
        })?;
        *processor = runtime.state().clone();
        remote.preference.processor_chain = remote.receiver_channel_strip.processor_chain.clone();
        refresh_remote_channel_health(remote);
        let remote = remote.clone();
        self.refresh_remote_participants();
        Ok(remote)
    }

    pub fn set_processor_enabled(
        &mut self,
        source_id: AudioSourceId,
        processor_id: AudioProcessorId,
        enabled: bool,
    ) -> Result<AudioSourceState, AudioStateError> {
        let source = self.local_source_mut(source_id)?;
        let processor = source
            .channel_strip
            .processor_chain
            .processors
            .iter_mut()
            .find(|processor| processor.id == processor_id)
            .ok_or(AudioStateError::ProcessorNotFound {
                source_id,
                processor_id,
            })?;

        processor.enabled = enabled;
        refresh_local_channel_health(source);
        Ok(source.clone())
    }

    pub fn add_processor_to_local_channel(
        &mut self,
        source_id: AudioSourceId,
        kind: AudioProcessorKind,
    ) -> Result<AudioSourceState, AudioStateError> {
        let source = self.local_source_mut(source_id)?;
        let processor =
            AudioProcessorState::new(kind.clone(), default_processor_display_name(&kind));
        source
            .channel_strip
            .processor_chain
            .processors
            .push(processor);
        refresh_local_channel_health(source);
        Ok(source.clone())
    }

    pub fn remove_processor_from_local_channel(
        &mut self,
        source_id: AudioSourceId,
        processor_id: AudioProcessorId,
    ) -> Result<AudioSourceState, AudioStateError> {
        let source = self.local_source_mut(source_id)?;
        let processors = &mut source.channel_strip.processor_chain.processors;
        let index = processors
            .iter()
            .position(|processor| processor.id == processor_id)
            .ok_or(AudioStateError::ProcessorNotFound {
                source_id,
                processor_id,
            })?;
        processors.remove(index);
        refresh_local_channel_health(source);
        Ok(source.clone())
    }

    pub fn reorder_processors(
        &mut self,
        source_id: AudioSourceId,
        ordered_processor_ids: Vec<AudioProcessorId>,
    ) -> Result<AudioSourceState, AudioStateError> {
        let source = self.local_source_mut(source_id)?;
        let processors = &mut source.channel_strip.processor_chain.processors;
        if ordered_processor_ids.len() != processors.len() {
            return Err(AudioStateError::ProcessorOrderInvalid {
                source_id,
                message: "ordered processor ids must include every processor exactly once"
                    .to_string(),
            });
        }

        let mut reordered = Vec::with_capacity(processors.len());
        for processor_id in &ordered_processor_ids {
            if reordered
                .iter()
                .any(|processor: &AudioProcessorState| processor.id == *processor_id)
            {
                return Err(AudioStateError::ProcessorOrderInvalid {
                    source_id,
                    message: "ordered processor ids must not contain duplicates".to_string(),
                });
            }
            let processor = processors
                .iter()
                .find(|processor| processor.id == *processor_id)
                .cloned()
                .ok_or(AudioStateError::ProcessorNotFound {
                    source_id,
                    processor_id: *processor_id,
                })?;
            reordered.push(processor);
        }

        *processors = reordered;
        refresh_local_channel_health(source);
        Ok(source.clone())
    }

    pub fn set_processor_parameter(
        &mut self,
        source_id: AudioSourceId,
        processor_id: AudioProcessorId,
        name: &str,
        value: AudioParameterValue,
    ) -> Result<AudioSourceState, AudioStateError> {
        let source = self.local_source_mut(source_id)?;
        let processor = source
            .channel_strip
            .processor_chain
            .processors
            .iter_mut()
            .find(|processor| processor.id == processor_id)
            .ok_or(AudioStateError::ProcessorNotFound {
                source_id,
                processor_id,
            })?;

        let mut runtime = ProcessorRuntime::from_state(processor.clone()).map_err(|error| {
            AudioStateError::ProcessorParameterInvalid {
                source_id,
                processor_id,
                message: error.to_string(),
            }
        })?;
        runtime.set_parameter(name, value).map_err(|error| {
            AudioStateError::ProcessorParameterInvalid {
                source_id,
                processor_id,
                message: error.to_string(),
            }
        })?;
        *processor = runtime.state().clone();
        refresh_local_channel_health(source);

        Ok(source.clone())
    }

    fn preset_by_id(&self, preset_id: &str) -> Result<AudioPresetDefinition, AudioStateError> {
        self.list_presets()
            .into_iter()
            .find(|preset| preset.preset_id == preset_id)
            .ok_or(AudioStateError::PresetNotFound {
                preset_id: preset_id.to_string(),
            })
    }

    fn local_source_mut(
        &mut self,
        source_id: AudioSourceId,
    ) -> Result<&mut AudioSourceState, AudioStateError> {
        self.mixer
            .local_sources
            .iter_mut()
            .find(|source| source.id == source_id)
            .ok_or(AudioStateError::SourceNotFound { source_id })
    }

    fn local_source_index(&self, source_id: AudioSourceId) -> Result<usize, AudioStateError> {
        self.mixer
            .local_sources
            .iter()
            .position(|source| source.id == source_id)
            .ok_or(AudioStateError::SourceNotFound { source_id })
    }

    fn remote_track_mut(
        &mut self,
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
    ) -> Result<&mut RemoteAudioTrackState, AudioStateError> {
        self.mixer
            .remote_tracks
            .iter_mut()
            .find(|remote| {
                remote.track.participant_id == remote_participant_id
                    && remote.track.track_id == remote_track_id
            })
            .ok_or(AudioStateError::RemoteTrackNotFound {
                remote_participant_id,
                remote_track_id,
            })
    }

    fn remote_track_index(
        &self,
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
    ) -> Result<usize, AudioStateError> {
        self.mixer
            .remote_tracks
            .iter()
            .position(|remote| {
                remote.track.participant_id == remote_participant_id
                    && remote.track.track_id == remote_track_id
            })
            .ok_or(AudioStateError::RemoteTrackNotFound {
                remote_participant_id,
                remote_track_id,
            })
    }

    fn refresh_remote_participants(&mut self) {
        let mut participants: Vec<RemoteParticipantAudioState> = Vec::new();
        for remote in &self.mixer.remote_tracks {
            if let Some(participant) = participants
                .iter_mut()
                .find(|participant| participant.participant_id == remote.track.participant_id)
            {
                participant.tracks.push(remote.clone());
            } else {
                participants.push(RemoteParticipantAudioState {
                    participant_id: remote.track.participant_id,
                    display_name: self
                        .remote_owner_names
                        .get(&remote.track.participant_id)
                        .cloned(),
                    tracks: vec![remote.clone()],
                });
            }
        }
        self.mixer.remote_participants = participants;
    }

    fn local_participant_id(&mut self) -> ParticipantId {
        *self
            .mixer
            .local_participant_id
            .get_or_insert_with(ParticipantId::new)
    }
}

impl Default for AudioEngineState {
    fn default() -> Self {
        Self {
            mixer: AudioMixerState {
                local_participant_id: Some(ParticipantId::new()),
                local_sources: Vec::new(),
                remote_tracks: Vec::new(),
                remote_participants: Vec::new(),
                track_events: Vec::new(),
                session: Default::default(),
            },
            publisher: PlaceholderMediaTrackPublisher::default(),
            user_presets: Vec::new(),
            user_presets_loaded: false,
            capture: CaptureRuntimeManager::default(),
            engine: AudioEngine::default(),
            remote_owner_names: HashMap::new(),
        }
    }
}

#[derive(Clone, Debug, Error, PartialEq, Serialize)]
#[serde(tag = "code", content = "detail", rename_all = "camelCase")]
pub enum AudioStateError {
    #[error("audio source not found")]
    SourceNotFound { source_id: AudioSourceId },
    #[error("audio processor not found")]
    ProcessorNotFound {
        source_id: AudioSourceId,
        processor_id: AudioProcessorId,
    },
    #[error("audio source is not published")]
    SourceNotPublished { source_id: AudioSourceId },
    #[error("published audio track not found")]
    PublishedTrackNotFound { track_id: PublishedTrackId },
    #[error("remote audio track not found")]
    RemoteTrackNotFound {
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
    },
    #[error("remote audio processor not found")]
    RemoteProcessorNotFound {
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
        processor_id: AudioProcessorId,
    },
    #[error("invalid remote audio processor parameter")]
    RemoteProcessorParameterInvalid {
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
        processor_id: AudioProcessorId,
        message: String,
    },
    #[error("invalid remote audio processor order")]
    RemoteProcessorOrderInvalid {
        remote_participant_id: ParticipantId,
        remote_track_id: PublishedTrackId,
        message: String,
    },
    #[error("media publisher failed")]
    MediaPublisherFailed { message: String },
    #[error("invalid audio processor parameter")]
    ProcessorParameterInvalid {
        source_id: AudioSourceId,
        processor_id: AudioProcessorId,
        message: String,
    },
    #[error("invalid audio processor order")]
    ProcessorOrderInvalid {
        source_id: AudioSourceId,
        message: String,
    },
    #[error("audio preset not found")]
    PresetNotFound { preset_id: String },
    #[error("built-in audio presets cannot be renamed or deleted")]
    BuiltInPresetMutationNotAllowed { preset_id: String },
    #[error("audio preset target does not apply to this channel")]
    PresetTargetMismatch {
        preset_id: String,
        target: AudioPresetTarget,
        channel: String,
    },
    #[error("audio preset name is invalid")]
    PresetNameInvalid { message: String },
    #[error("audio preset storage failed")]
    PresetStorageFailed { message: String },
    #[error("invalid audio channel health target")]
    ChannelHealthTargetInvalid { message: String },
    #[error("audio state lock is poisoned")]
    StatePoisoned,
    #[error("failed to emit audio state change")]
    EventEmitFailed { message: String },
}

impl From<MediaTrackPublisherError> for AudioStateError {
    fn from(error: MediaTrackPublisherError) -> Self {
        Self::MediaPublisherFailed {
            message: error.to_string(),
        }
    }
}

#[tauri::command]
pub fn audio_get_state(
    state: State<'_, SharedAudioEngineState>,
) -> Result<AudioMixerState, AudioStateError> {
    let guard = state.read().map_err(|_| AudioStateError::StatePoisoned)?;
    Ok(guard.snapshot())
}

#[tauri::command]
pub async fn audio_get_network_totals(
    state: State<'_, SharedAudioEngineState>,
) -> Result<AudioNetworkTotals, AudioStateError> {
    let room = {
        let guard = state.read().map_err(|_| AudioStateError::StatePoisoned)?;
        guard.engine.connected_room()
    };
    let Some(room) = room else {
        return Ok(AudioNetworkTotals::default());
    };
    measure_audio_network_totals(room)
        .await
        .map_err(|message| AudioStateError::MediaPublisherFailed { message })
}

#[tauri::command]
pub fn audio_get_capabilities() -> NativeAudioCapabilityReport {
    let mut supported_source_types = vec![AudioSourceType::Microphone, AudioSourceType::TestTone];
    let mut issues = Vec::new();

    let system_audio_available = match system_audio_runtime_readiness() {
        Ok(()) => cfg!(any(
            target_os = "windows",
            target_os = "linux",
            target_os = "macos"
        )),
        Err(issue) => {
            issues.push(issue);
            false
        }
    };

    if system_audio_available {
        supported_source_types.insert(1, AudioSourceType::SystemAudio);
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        supported_source_types.insert(2, AudioSourceType::AppAudio);
    }

    NativeAudioCapabilityReport {
        os: std::env::consts::OS.to_string(),
        issues,
        supported_source_types,
        supports_microphone: true,
        supports_system_audio: system_audio_available,
        supports_app_audio: cfg!(any(target_os = "windows", target_os = "macos")),
        supports_screen_audio: false,
        supports_test_tone: true,
        supports_input_devices: true,
        supports_output_devices: true,
        supports_app_audio_process_list: cfg!(any(target_os = "windows", target_os = "macos")),
    }
}

#[tauri::command]
pub fn audio_list_input_devices() -> Result<Vec<AudioInputDevice>, AudioStateError> {
    Ok(list_input_devices())
}

#[tauri::command]
pub fn audio_list_output_devices() -> Result<Vec<AudioOutputDevice>, AudioStateError> {
    Ok(list_output_devices())
}

#[tauri::command]
pub fn audio_set_output_device(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    device_id: Option<String>,
) -> Result<Option<AudioOutputDevice>, AudioStateError> {
    let shared = Arc::clone(state.inner());
    let (selected, snapshot) = {
        let mut guard = state.write().map_err(|_| AudioStateError::StatePoisoned)?;
        let selected = guard
            .engine
            .set_output_device(&app, &shared, device_id)
            .map_err(|message| AudioStateError::MediaPublisherFailed { message })?;
        guard.mixer.session.playback_status = if guard.engine.is_connected() {
            AudioPlaybackStatus::Running
        } else {
            AudioPlaybackStatus::Stopped
        };
        guard.mixer.session.error = None;
        (selected, guard.snapshot())
    };
    emit_audio_state_changed(&app, &snapshot)?;
    Ok(selected)
}

#[tauri::command]
pub fn audio_get_selected_output_device(
    state: State<'_, SharedAudioEngineState>,
) -> Result<Option<AudioOutputDevice>, AudioStateError> {
    let guard = state.read().map_err(|_| AudioStateError::StatePoisoned)?;
    Ok(guard.engine.selected_output_device())
}

#[tauri::command]
pub fn audio_test_output_device(
    state: State<'_, SharedAudioEngineState>,
    device_id: Option<String>,
) -> Result<(), AudioStateError> {
    let guard = state.read().map_err(|_| AudioStateError::StatePoisoned)?;
    guard
        .engine
        .play_test_tone(device_id)
        .map_err(|message| AudioStateError::MediaPublisherFailed { message })
}

#[tauri::command]
pub fn audio_set_remote_audio_receiving(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    enabled: bool,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.engine.set_remote_audio_receiving(enabled);
        if !enabled {
            engine.mixer.session.eligible_remote_track_count = 0;
            engine.mixer.session.active_remote_track_count = 0;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn audio_list_app_audio_sources() -> Result<Vec<crate::audio::domain::AppAudioSource>, String> {
    #[cfg(target_os = "windows")]
    {
        crate::audio::capture::platform::windows::list_app_audio_sources()
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        crate::audio::capture::platform::macos::list_app_audio_sources().map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Ok(vec![])
    }
}

#[tauri::command]
pub fn audio_list_presets(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
) -> Result<Vec<AudioPresetDefinition>, AudioStateError> {
    let mut guard = state.write().map_err(|_| AudioStateError::StatePoisoned)?;
    ensure_user_presets_loaded(&app, &mut guard)?;
    Ok(guard.list_presets())
}

#[tauri::command]
pub fn audio_apply_preset_to_local_channel(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
    preset_id: String,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        ensure_user_presets_loaded(&app, engine)?;
        engine.apply_preset_to_local_channel(source_id, &preset_id)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_apply_preset_to_remote_track(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    remote_participant_id: ParticipantId,
    remote_track_id: PublishedTrackId,
    preset_id: String,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        ensure_user_presets_loaded(&app, engine)?;
        engine.apply_preset_to_remote_track(remote_participant_id, remote_track_id, &preset_id)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_save_local_channel_as_preset(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
    name: String,
    description: String,
    target: AudioPresetTarget,
) -> Result<Vec<AudioPresetDefinition>, AudioStateError> {
    let presets = {
        let mut guard = state.write().map_err(|_| AudioStateError::StatePoisoned)?;
        ensure_user_presets_loaded(&app, &mut guard)?;
        guard.save_local_channel_as_preset(source_id, name, description, target)?;
        save_user_presets(&app, &guard.user_presets)?;
        guard.list_presets()
    };
    Ok(presets)
}

#[tauri::command]
pub fn audio_save_remote_track_as_preset(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    remote_participant_id: ParticipantId,
    remote_track_id: PublishedTrackId,
    name: String,
    description: String,
    target: AudioPresetTarget,
) -> Result<Vec<AudioPresetDefinition>, AudioStateError> {
    let presets = {
        let mut guard = state.write().map_err(|_| AudioStateError::StatePoisoned)?;
        ensure_user_presets_loaded(&app, &mut guard)?;
        guard.save_remote_track_as_preset(
            remote_participant_id,
            remote_track_id,
            name,
            description,
            target,
        )?;
        save_user_presets(&app, &guard.user_presets)?;
        guard.list_presets()
    };
    Ok(presets)
}

#[tauri::command]
pub fn audio_delete_user_preset(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    preset_id: String,
) -> Result<Vec<AudioPresetDefinition>, AudioStateError> {
    let (snapshot, presets) = {
        let mut guard = state.write().map_err(|_| AudioStateError::StatePoisoned)?;
        ensure_user_presets_loaded(&app, &mut guard)?;
        guard.delete_user_preset(&preset_id)?;
        save_user_presets(&app, &guard.user_presets)?;
        (guard.snapshot(), guard.list_presets())
    };
    emit_audio_state_changed(&app, &snapshot)?;
    Ok(presets)
}

#[tauri::command]
pub fn audio_rename_user_preset(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    preset_id: String,
    name: String,
) -> Result<Vec<AudioPresetDefinition>, AudioStateError> {
    let presets = {
        let mut guard = state.write().map_err(|_| AudioStateError::StatePoisoned)?;
        ensure_user_presets_loaded(&app, &mut guard)?;
        guard.rename_user_preset(&preset_id, name)?;
        save_user_presets(&app, &guard.user_presets)?;
        guard.list_presets()
    };
    Ok(presets)
}

#[tauri::command]
pub fn audio_reset_local_channel_processor_chain(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.reset_local_channel_processor_chain(source_id)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_reset_local_channel_to_safe_defaults(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.reset_local_channel_to_safe_defaults(source_id)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_reset_remote_track_to_safe_defaults(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    remote_participant_id: ParticipantId,
    remote_track_id: PublishedTrackId,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.reset_remote_track_to_safe_defaults(remote_participant_id, remote_track_id)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_set_local_safety_limiter_ceiling(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
    ceiling_db: GainDb,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.set_local_safety_limiter_ceiling(source_id, ceiling_db)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_set_remote_safety_limiter_ceiling(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    remote_participant_id: ParticipantId,
    remote_track_id: PublishedTrackId,
    ceiling_db: GainDb,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.set_remote_safety_limiter_ceiling(
            remote_participant_id,
            remote_track_id,
            ceiling_db,
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_get_channel_health(
    state: State<'_, SharedAudioEngineState>,
    source_id: Option<AudioSourceId>,
    remote_participant_id: Option<ParticipantId>,
    remote_track_id: Option<PublishedTrackId>,
) -> Result<ChannelHealthState, AudioStateError> {
    let guard = state.read().map_err(|_| AudioStateError::StatePoisoned)?;
    if let Some(source_id) = source_id {
        return guard
            .mixer
            .local_sources
            .iter()
            .find(|source| source.id == source_id)
            .map(|source| source.channel_strip.health.clone())
            .ok_or(AudioStateError::SourceNotFound { source_id });
    }
    let remote_participant_id =
        remote_participant_id.ok_or_else(|| AudioStateError::ChannelHealthTargetInvalid {
            message: "remoteParticipantId is required when sourceId is not provided".to_string(),
        })?;
    let remote_track_id =
        remote_track_id.ok_or_else(|| AudioStateError::ChannelHealthTargetInvalid {
            message: "remoteTrackId is required when sourceId is not provided".to_string(),
        })?;
    guard
        .mixer
        .remote_tracks
        .iter()
        .find(|remote| {
            remote.track.participant_id == remote_participant_id
                && remote.track.track_id == remote_track_id
        })
        .map(|remote| remote.receiver_channel_strip.health.clone())
        .ok_or(AudioStateError::RemoteTrackNotFound {
            remote_participant_id,
            remote_track_id,
        })
}

#[tauri::command]
pub fn audio_reset_remote_track_processor_chain(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    remote_participant_id: ParticipantId,
    remote_track_id: PublishedTrackId,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.reset_remote_track_processor_chain(remote_participant_id, remote_track_id)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_add_local_source(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_type: AudioSourceType,
    display_name: String,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.add_local_source(source_type, display_name);
        Ok(())
    })
}

#[tauri::command]
pub fn audio_remove_local_source(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.remove_local_source(source_id)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_rename_local_source(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
    display_name: String,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.rename_local_source(source_id, display_name)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_set_local_source_enabled(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
    enabled: bool,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.set_local_source_enabled(source_id, enabled)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_set_local_source_capture_device(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
    capture_device_id: Option<String>,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.set_local_source_capture_device(source_id, capture_device_id)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_set_local_channel_gain(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
    gain_db: GainDb,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.set_local_channel_gain(source_id, gain_db)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_set_local_channel_mute(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
    muted: bool,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.set_local_channel_mute(source_id, muted)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_set_local_webrtc_processing(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
    processing: WebRtcAudioProcessingSettings,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state_with_instruction(&app, &state, |engine| {
        engine
            .set_local_webrtc_processing(source_id, processing)
            .map(|(_, instruction)| instruction)
    })
}

#[tauri::command]
pub fn audio_publish_local_source_metadata(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state_with_instruction(&app, &state, |engine| {
        engine
            .publish_audio_source(source_id)
            .map(|mutation| Some(mutation.instruction))
    })
}

#[tauri::command]
pub fn audio_unpublish_local_source_metadata(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state_with_instruction(&app, &state, |engine| {
        engine
            .unpublish_audio_source(source_id)
            .map(|mutation| Some(mutation.instruction))
    })
}

#[tauri::command]
pub fn audio_publish_audio_source(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state_with_instruction(&app, &state, |engine| {
        engine
            .publish_audio_source(source_id)
            .map(|mutation| Some(mutation.instruction))
    })
}

#[tauri::command]
pub fn audio_unpublish_audio_source(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state_with_instruction(&app, &state, |engine| {
        engine
            .unpublish_audio_source(source_id)
            .map(|mutation| Some(mutation.instruction))
    })
}

/// Connect the Rust audio sidecar to the nest's LiveKit room. The frontend fetches a
/// token scoped to the `<userId>#audio` identity and hands it here; from this point the
/// native engine owns all audio publish/subscribe/playback.
#[tauri::command]
pub fn audio_connect_room(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    url: String,
    token: String,
) -> Result<AudioMixerState, AudioStateError> {
    let shared = Arc::clone(state.inner());
    let (updated, media_error) = {
        let mut guard = state.write().map_err(|_| AudioStateError::StatePoisoned)?;
        guard.mixer.session.connection_status = AudioConnectionStatus::Connecting;
        guard.mixer.session.playback_status = AudioPlaybackStatus::Starting;
        guard.mixer.session.error = None;
        if let Err(message) = guard.engine.connect(&app, &shared, &url, &token) {
            guard.mixer.session.connection_status = AudioConnectionStatus::Error;
            guard.mixer.session.playback_status = AudioPlaybackStatus::Error;
            guard.mixer.session.error = Some(message.clone());
            let snapshot = guard.snapshot();
            drop(guard);
            emit_audio_state_changed(&app, &snapshot)?;
            return Err(AudioStateError::MediaPublisherFailed { message });
        }
        guard.mixer.session.connection_status = AudioConnectionStatus::Connected;
        guard.mixer.session.playback_status = AudioPlaybackStatus::Running;
        let AudioEngineState {
            mixer,
            capture,
            engine,
            ..
        } = &mut *guard;
        let publication_error = engine.reconcile_publications(&mixer.local_sources).err();
        let sinks = engine.sink_map();
        let render_reference = engine.render_reference();
        let capture_error = capture.reconcile(
            &app,
            Arc::clone(&shared),
            &mut mixer.local_sources,
            &sinks,
            render_reference,
        );
        (
            guard.snapshot(),
            publication_error
                .or(capture_error)
                .map(|message| AudioStateError::MediaPublisherFailed { message }),
        )
    };
    emit_audio_state_changed(&app, &updated)?;
    if let Some(error) = media_error {
        return Err(error);
    }
    Ok(updated)
}

/// Disconnect the audio sidecar (on leaving the nest). Unpublishes everything, stops
/// playback, and clears subscribed remote tracks.
#[tauri::command]
pub fn audio_disconnect_room(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
) -> Result<AudioMixerState, AudioStateError> {
    let shared = Arc::clone(state.inner());
    let updated = {
        let mut guard = state.write().map_err(|_| AudioStateError::StatePoisoned)?;
        guard.engine.disconnect();
        guard.mixer.remote_tracks.clear();
        guard.mixer.remote_participants.clear();
        guard.mixer.session = Default::default();
        let AudioEngineState {
            mixer,
            capture,
            engine,
            ..
        } = &mut *guard;
        let _ = engine.reconcile_publications(&mixer.local_sources);
        let sinks = engine.sink_map();
        let render_reference = engine.render_reference();
        let _ = capture.reconcile(
            &app,
            Arc::clone(&shared),
            &mut mixer.local_sources,
            &sinks,
            render_reference,
        );
        guard.snapshot()
    };
    emit_audio_state_changed(&app, &updated)?;
    Ok(updated)
}

#[tauri::command]
pub fn audio_update_published_track_metadata(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    track_id: PublishedTrackId,
    patch: PublishedTrackMetadataPatch,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.update_published_track_metadata(track_id, patch)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_add_or_update_remote_track(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    metadata: PublishedTrackMetadata,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.add_or_update_remote_track(metadata);
        Ok(())
    })
}

#[tauri::command]
pub fn audio_remove_remote_track(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    remote_participant_id: ParticipantId,
    remote_track_id: PublishedTrackId,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.remove_remote_track(remote_participant_id, remote_track_id)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_set_remote_track_gain(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    remote_participant_id: ParticipantId,
    remote_track_id: PublishedTrackId,
    gain_db: GainDb,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.set_remote_track_gain(remote_participant_id, remote_track_id, gain_db)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_set_remote_track_mute(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    remote_participant_id: ParticipantId,
    remote_track_id: PublishedTrackId,
    muted: bool,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.set_remote_track_mute(remote_participant_id, remote_track_id, muted)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_add_processor_to_remote_track(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    remote_participant_id: ParticipantId,
    remote_track_id: PublishedTrackId,
    kind: AudioProcessorKind,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.add_processor_to_remote_track(remote_participant_id, remote_track_id, kind)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_set_remote_processor_enabled(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    remote_participant_id: ParticipantId,
    remote_track_id: PublishedTrackId,
    processor_id: AudioProcessorId,
    enabled: bool,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.set_remote_processor_enabled(
            remote_participant_id,
            remote_track_id,
            processor_id,
            enabled,
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_remove_processor_from_remote_track(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    remote_participant_id: ParticipantId,
    remote_track_id: PublishedTrackId,
    processor_id: AudioProcessorId,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.remove_processor_from_remote_track(
            remote_participant_id,
            remote_track_id,
            processor_id,
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_update_remote_processor_parameter(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    remote_participant_id: ParticipantId,
    remote_track_id: PublishedTrackId,
    processor_id: AudioProcessorId,
    parameter_name: String,
    value: AudioParameterValue,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.set_remote_processor_parameter(
            remote_participant_id,
            remote_track_id,
            processor_id,
            &parameter_name,
            value,
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_reorder_remote_processors(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    remote_participant_id: ParticipantId,
    remote_track_id: PublishedTrackId,
    ordered_processor_ids: Vec<AudioProcessorId>,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.reorder_remote_processors(
            remote_participant_id,
            remote_track_id,
            ordered_processor_ids,
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_set_processor_enabled(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
    processor_id: AudioProcessorId,
    enabled: bool,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.set_processor_enabled(source_id, processor_id, enabled)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_add_processor_to_local_channel(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
    kind: AudioProcessorKind,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.add_processor_to_local_channel(source_id, kind)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_remove_processor_from_local_channel(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
    processor_id: AudioProcessorId,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.remove_processor_from_local_channel(source_id, processor_id)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_reorder_processors(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
    ordered_processor_ids: Vec<AudioProcessorId>,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.reorder_processors(source_id, ordered_processor_ids)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_set_processor_parameter(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
    processor_id: AudioProcessorId,
    name: String,
    value: AudioParameterValue,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.set_processor_parameter(source_id, processor_id, &name, value)?;
        Ok(())
    })
}

#[tauri::command]
pub fn audio_update_processor_parameter(
    app: AppHandle,
    state: State<'_, SharedAudioEngineState>,
    source_id: AudioSourceId,
    processor_id: AudioProcessorId,
    parameter_name: String,
    value: AudioParameterValue,
) -> Result<AudioMixerState, AudioStateError> {
    mutate_audio_state(&app, &state, |engine| {
        engine.set_processor_parameter(source_id, processor_id, &parameter_name, value)?;
        Ok(())
    })
}

fn mutate_audio_state(
    app: &AppHandle,
    state: &SharedAudioEngineState,
    mutation: impl FnOnce(&mut AudioEngineState) -> Result<(), AudioStateError>,
) -> Result<AudioMixerState, AudioStateError> {
    let (updated, media_error) = {
        let mut guard = state.write().map_err(|_| AudioStateError::StatePoisoned)?;
        mutation(&mut guard)?;
        let shared = Arc::clone(state);
        let AudioEngineState {
            mixer,
            capture,
            engine,
            ..
        } = &mut *guard;
        // Reconcile published LiveKit tracks first so the capture manager can attach the
        // matching publish sinks to the (possibly already running) capture threads.
        let publication_error = engine.reconcile_publications(&mixer.local_sources).err();
        let sinks = engine.sink_map();
        let render_reference = engine.render_reference();
        let capture_error = capture.reconcile(
            app,
            shared,
            &mut mixer.local_sources,
            &sinks,
            render_reference,
        );
        (
            guard.snapshot(),
            publication_error
                .or(capture_error)
                .map(|message| AudioStateError::MediaPublisherFailed { message }),
        )
    };

    emit_audio_state_changed(app, &updated)?;
    if let Some(error) = media_error {
        return Err(error);
    }
    Ok(updated)
}

fn mutate_audio_state_with_instruction(
    app: &AppHandle,
    state: &SharedAudioEngineState,
    mutation: impl FnOnce(
        &mut AudioEngineState,
    ) -> Result<Option<AudioTrackPublishInstruction>, AudioStateError>,
) -> Result<AudioMixerState, AudioStateError> {
    let (updated, instruction, media_error) = {
        let mut guard = state.write().map_err(|_| AudioStateError::StatePoisoned)?;
        let instruction = mutation(&mut guard)?;
        let shared = Arc::clone(state);
        let AudioEngineState {
            mixer,
            capture,
            engine,
            ..
        } = &mut *guard;
        let publication_error = engine.reconcile_publications(&mixer.local_sources).err();
        let sinks = engine.sink_map();
        let render_reference = engine.render_reference();
        let capture_error = capture.reconcile(
            app,
            shared,
            &mut mixer.local_sources,
            &sinks,
            render_reference,
        );
        (
            guard.snapshot(),
            instruction,
            publication_error
                .or(capture_error)
                .map(|message| AudioStateError::MediaPublisherFailed { message }),
        )
    };

    emit_audio_state_changed(app, &updated)?;
    if let Some(error) = media_error {
        return Err(error);
    }
    if let Some(instruction) = instruction {
        emit_audio_track_publish_instruction(app, &instruction)?;
    }
    Ok(updated)
}

/// Add a fully-configured local audio source and publish it in one shot, returning its id.
///
/// Used by the native **video** engine: when a screen / window share opts to also capture
/// audio, the shared audio must appear as a normal channel in the audio mixer. This runs
/// the exact same capture + publish reconcile and emits `audio-state-changed` as the
/// individual audio commands, so the new strip shows up and is transmitted immediately.
///
/// `capture_device_id` carries the platform target: `None` for system audio (default
/// loopback), or the process id string for per-app audio.
pub fn add_and_publish_shared_audio_source(
    app: &AppHandle,
    state: &SharedAudioEngineState,
    source_type: AudioSourceType,
    display_name: String,
    capture_device_id: Option<String>,
) -> Result<AudioSourceId, AudioStateError> {
    let (updated, new_id, instruction, media_error) = {
        let mut guard = state.write().map_err(|_| AudioStateError::StatePoisoned)?;
        let processing = match source_type {
            AudioSourceType::SystemAudio => Some(WebRtcAudioProcessingSettings {
                noise_suppression: false,
                echo_cancellation: true,
                auto_gain_control: false,
            }),
            AudioSourceType::AppAudio => Some(WebRtcAudioProcessingSettings {
                noise_suppression: false,
                echo_cancellation: false,
                auto_gain_control: false,
            }),
            _ => None,
        };
        let new_id = guard.add_local_source(source_type, display_name).id;
        if let Some(processing) = processing {
            guard.set_local_webrtc_processing(new_id, processing)?;
        }
        if capture_device_id.is_some() {
            guard.set_local_source_capture_device(new_id, capture_device_id)?;
        }
        let instruction = guard.publish_audio_source(new_id)?.instruction;

        let shared = Arc::clone(state);
        let AudioEngineState {
            mixer,
            capture,
            engine,
            ..
        } = &mut *guard;
        let publication_error = engine.reconcile_publications(&mixer.local_sources).err();
        let sinks = engine.sink_map();
        let render_reference = engine.render_reference();
        let capture_error = capture.reconcile(
            app,
            shared,
            &mut mixer.local_sources,
            &sinks,
            render_reference,
        );
        (
            guard.snapshot(),
            new_id,
            instruction,
            publication_error
                .or(capture_error)
                .map(|message| AudioStateError::MediaPublisherFailed { message }),
        )
    };
    emit_audio_state_changed(app, &updated)?;
    if let Some(error) = media_error {
        return Err(error);
    }
    emit_audio_track_publish_instruction(app, &instruction)?;
    Ok(new_id)
}

/// Remove a local audio source previously created by [`add_and_publish_shared_audio_source`].
/// Tolerates an already-removed source so video teardown is idempotent.
pub fn remove_shared_audio_source(
    app: &AppHandle,
    state: &SharedAudioEngineState,
    source_id: AudioSourceId,
) -> Result<(), AudioStateError> {
    mutate_audio_state(app, state, |engine| {
        let _ = engine.remove_local_source(source_id);
        Ok(())
    })?;
    Ok(())
}

fn emit_audio_state_changed(
    app: &AppHandle,
    state: &AudioMixerState,
) -> Result<(), AudioStateError> {
    app.emit(AUDIO_STATE_CHANGED_EVENT, state.clone())
        .map_err(|error| AudioStateError::EventEmitFailed {
            message: error.to_string(),
        })
}

fn emit_audio_track_publish_instruction(
    app: &AppHandle,
    instruction: &AudioTrackPublishInstruction,
) -> Result<(), AudioStateError> {
    app.emit(AUDIO_TRACK_PUBLISH_INSTRUCTION_EVENT, instruction.clone())
        .map_err(|error| AudioStateError::EventEmitFailed {
            message: error.to_string(),
        })
}

fn default_processor_display_name(kind: &AudioProcessorKind) -> &'static str {
    match kind {
        AudioProcessorKind::Gain => "Gain",
        AudioProcessorKind::Mute => "Mute",
        AudioProcessorKind::Meter => "Meter",
        AudioProcessorKind::HighPassFilter => "High-pass filter",
        AudioProcessorKind::Limiter => "Limiter",
        AudioProcessorKind::NoiseGate => "Noise gate",
        AudioProcessorKind::Eq => "EQ",
        AudioProcessorKind::Compressor => "Compressor",
        AudioProcessorKind::LowPassFilter => "Low-pass filter",
        AudioProcessorKind::Custom => "Custom processor",
        AudioProcessorKind::Unknown => "Processor",
    }
}

fn refresh_local_channel_health(source: &mut AudioSourceState) {
    let latency_samples = chain_latency_samples(&source.channel_strip.processor_chain);
    let processor_cpu_estimate = Some(chain_cpu_estimate(&source.channel_strip.processor_chain));
    let mut health = health_from_meter(
        source.channel_strip.meter.clone(),
        source.channel_strip.safety_limiter_ceiling_db,
        latency_samples,
        processor_cpu_estimate,
    );
    health.clipping_count = source.channel_strip.health.clipping_count;
    health.recent_clipping = source.channel_strip.health.recent_clipping;
    source.channel_strip.health = health;
}

fn refresh_remote_channel_health(remote: &mut RemoteAudioTrackState) {
    let latency_samples = chain_latency_samples(&remote.receiver_channel_strip.processor_chain);
    let processor_cpu_estimate = Some(chain_cpu_estimate(
        &remote.receiver_channel_strip.processor_chain,
    ));
    let mut health = health_from_meter(
        remote.receiver_channel_strip.meter.clone(),
        remote.receiver_channel_strip.safety_limiter_ceiling_db,
        latency_samples,
        processor_cpu_estimate,
    );
    health.clipping_count = remote.receiver_channel_strip.health.clipping_count;
    health.recent_clipping = remote.receiver_channel_strip.health.recent_clipping;
    remote.receiver_channel_strip.health = health;
}

fn built_in_audio_presets() -> Vec<AudioPresetDefinition> {
    vec![
        audio_preset(
            "broadcast-mic",
            "Broadcast Mic",
            "Voice-forward microphone chain with cleanup, compression, limiting, and metering.",
            AudioPresetTarget::LocalMicrophone,
            0.0,
            false,
            vec![
                processor_with_parameters(
                    AudioProcessorKind::HighPassFilter,
                    AudioProcessorParameters {
                        cutoff_hz: Some(90.0),
                        ..AudioProcessorParameters::default()
                    },
                ),
                processor_with_parameters(
                    AudioProcessorKind::NoiseGate,
                    AudioProcessorParameters {
                        threshold_db: Some(GainDb::new(-48.0)),
                        attack_ms: Some(4.0),
                        release_ms: Some(120.0),
                        ..AudioProcessorParameters::default()
                    },
                ),
                processor_with_parameters(
                    AudioProcessorKind::Compressor,
                    AudioProcessorParameters {
                        threshold_db: Some(GainDb::new(-20.0)),
                        ratio: Some(3.5),
                        attack_ms: Some(8.0),
                        release_ms: Some(140.0),
                        ..AudioProcessorParameters::default()
                    },
                ),
                processor_with_parameters(
                    AudioProcessorKind::Limiter,
                    AudioProcessorParameters {
                        threshold_db: Some(GainDb::new(-1.0)),
                        release_ms: Some(60.0),
                        ..AudioProcessorParameters::default()
                    },
                ),
                AudioProcessorState::new(AudioProcessorKind::Meter, "Meter"),
            ],
        ),
        audio_preset(
            "clean-meeting-voice",
            "Clean Meeting Voice",
            "Light voice processing for calls with low coloration.",
            AudioPresetTarget::AnyAudioChannel,
            0.0,
            false,
            vec![
                processor_with_parameters(
                    AudioProcessorKind::HighPassFilter,
                    AudioProcessorParameters {
                        cutoff_hz: Some(75.0),
                        ..AudioProcessorParameters::default()
                    },
                ),
                processor_with_parameters(
                    AudioProcessorKind::Compressor,
                    AudioProcessorParameters {
                        threshold_db: Some(GainDb::new(-22.0)),
                        ratio: Some(2.0),
                        attack_ms: Some(12.0),
                        release_ms: Some(120.0),
                        ..AudioProcessorParameters::default()
                    },
                ),
                AudioProcessorState::new(AudioProcessorKind::Meter, "Meter"),
            ],
        ),
        audio_preset(
            "noisy-room-voice",
            "Noisy Room Voice",
            "Stronger gate and limiter for speech in inconsistent room noise.",
            AudioPresetTarget::AnyAudioChannel,
            -1.0,
            false,
            vec![
                processor_with_parameters(
                    AudioProcessorKind::HighPassFilter,
                    AudioProcessorParameters {
                        cutoff_hz: Some(110.0),
                        ..AudioProcessorParameters::default()
                    },
                ),
                processor_with_parameters(
                    AudioProcessorKind::NoiseGate,
                    AudioProcessorParameters {
                        threshold_db: Some(GainDb::new(-38.0)),
                        attack_ms: Some(3.0),
                        release_ms: Some(180.0),
                        ..AudioProcessorParameters::default()
                    },
                ),
                processor_with_parameters(
                    AudioProcessorKind::Compressor,
                    AudioProcessorParameters {
                        threshold_db: Some(GainDb::new(-24.0)),
                        ratio: Some(3.0),
                        attack_ms: Some(8.0),
                        release_ms: Some(160.0),
                        ..AudioProcessorParameters::default()
                    },
                ),
                processor_with_parameters(
                    AudioProcessorKind::Limiter,
                    AudioProcessorParameters {
                        threshold_db: Some(GainDb::new(-2.0)),
                        release_ms: Some(80.0),
                        ..AudioProcessorParameters::default()
                    },
                ),
            ],
        ),
        audio_preset(
            "screen-audio-low",
            "Screen Audio Low",
            "Keeps shared screen or system audio under voices.",
            AudioPresetTarget::LocalScreenAudio,
            -12.0,
            false,
            vec![
                processor_with_parameters(
                    AudioProcessorKind::Gain,
                    AudioProcessorParameters {
                        gain_db: Some(GainDb::new(-6.0)),
                        ..AudioProcessorParameters::default()
                    },
                ),
                processor_with_parameters(
                    AudioProcessorKind::Limiter,
                    AudioProcessorParameters {
                        threshold_db: Some(GainDb::new(-3.0)),
                        release_ms: Some(90.0),
                        ..AudioProcessorParameters::default()
                    },
                ),
                AudioProcessorState::new(AudioProcessorKind::Meter, "Meter"),
            ],
        ),
        audio_preset(
            "background-music",
            "Background Music",
            "Lower gain and metering for music under conversation.",
            AudioPresetTarget::LocalMusic,
            -16.0,
            false,
            vec![
                processor_with_parameters(
                    AudioProcessorKind::Gain,
                    AudioProcessorParameters {
                        gain_db: Some(GainDb::new(-4.0)),
                        ..AudioProcessorParameters::default()
                    },
                ),
                processor_with_parameters(
                    AudioProcessorKind::Limiter,
                    AudioProcessorParameters {
                        threshold_db: Some(GainDb::new(-3.0)),
                        release_ms: Some(120.0),
                        ..AudioProcessorParameters::default()
                    },
                ),
                AudioProcessorState::new(AudioProcessorKind::Meter, "Meter"),
            ],
        ),
        audio_preset(
            "presentation-screen-audio",
            "Presentation Screen Audio",
            "Moderate screen-share level with ceiling control.",
            AudioPresetTarget::LocalScreenAudio,
            -6.0,
            false,
            vec![
                processor_with_parameters(
                    AudioProcessorKind::Compressor,
                    AudioProcessorParameters {
                        threshold_db: Some(GainDb::new(-12.0)),
                        ratio: Some(1.8),
                        attack_ms: Some(20.0),
                        release_ms: Some(180.0),
                        ..AudioProcessorParameters::default()
                    },
                ),
                processor_with_parameters(
                    AudioProcessorKind::Limiter,
                    AudioProcessorParameters {
                        threshold_db: Some(GainDb::new(-1.5)),
                        release_ms: Some(100.0),
                        ..AudioProcessorParameters::default()
                    },
                ),
                AudioProcessorState::new(AudioProcessorKind::Meter, "Meter"),
            ],
        ),
        audio_preset(
            "flat-no-processing",
            "Flat/No Processing",
            "Unity gain, unmuted, and no processor chain.",
            AudioPresetTarget::AnyAudioChannel,
            0.0,
            false,
            Vec::new(),
        ),
    ]
}

fn audio_preset(
    preset_id: &str,
    name: &str,
    description: &str,
    target: AudioPresetTarget,
    gain_db: f32,
    muted: bool,
    processors: Vec<AudioProcessorState>,
) -> AudioPresetDefinition {
    AudioPresetDefinition {
        preset_id: preset_id.to_string(),
        name: name.to_string(),
        description: description.to_string(),
        target,
        gain_db: GainDb::new(gain_db),
        muted,
        processor_chain: ProcessorChainState { processors },
        built_in: true,
        user_created: false,
        created_at: None,
        updated_at: None,
    }
}

fn processor_with_parameters(
    kind: AudioProcessorKind,
    parameters: AudioProcessorParameters,
) -> AudioProcessorState {
    AudioProcessorState::with_parameters(
        kind.clone(),
        default_processor_display_name(&kind),
        parameters,
    )
}

fn preset_from_parts(
    name: String,
    description: String,
    target: AudioPresetTarget,
    gain_db: GainDb,
    muted: bool,
    processor_chain: &ProcessorChainState,
) -> Result<AudioPresetDefinition, AudioStateError> {
    ProcessorChainRuntime::from_state(processor_chain).map_err(|error| {
        AudioStateError::PresetNameInvalid {
            message: format!("processor chain is invalid: {error}"),
        }
    })?;
    let now = now_unix_ms_string();
    Ok(AudioPresetDefinition {
        preset_id: format!("user-{}", uuid::Uuid::new_v4()),
        name: normalize_preset_name(name)?,
        description: description.trim().to_string(),
        target,
        gain_db,
        muted,
        processor_chain: clone_chain_for_preset(processor_chain),
        built_in: false,
        user_created: true,
        created_at: Some(now.clone()),
        updated_at: Some(now),
    })
}

fn normalize_preset_name(name: String) -> Result<String, AudioStateError> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AudioStateError::PresetNameInvalid {
            message: "name is required".to_string(),
        });
    }
    Ok(name)
}

fn clone_chain_for_preset(chain: &ProcessorChainState) -> ProcessorChainState {
    ProcessorChainState {
        processors: chain.processors.clone(),
    }
}

fn clone_chain_for_channel(chain: &ProcessorChainState) -> ProcessorChainState {
    ProcessorChainState {
        processors: chain
            .processors
            .iter()
            .cloned()
            .map(|mut processor| {
                processor.id = AudioProcessorId::new();
                processor
            })
            .collect(),
    }
}

fn validate_preset_for_local_source(
    preset: &AudioPresetDefinition,
    source_type: &AudioSourceType,
) -> Result<(), AudioStateError> {
    let applies = match preset.target {
        AudioPresetTarget::AnyAudioChannel => true,
        AudioPresetTarget::LocalMicrophone => matches!(source_type, AudioSourceType::Microphone),
        AudioPresetTarget::LocalScreenAudio => matches!(
            source_type,
            AudioSourceType::ScreenAudio | AudioSourceType::SystemAudio | AudioSourceType::AppAudio
        ),
        AudioPresetTarget::LocalMusic => matches!(source_type, AudioSourceType::FileAudio),
        AudioPresetTarget::RemoteVoice | AudioPresetTarget::RemoteMusic => false,
    };
    if applies {
        Ok(())
    } else {
        Err(AudioStateError::PresetTargetMismatch {
            preset_id: preset.preset_id.clone(),
            target: preset.target.clone(),
            channel: format!("local {source_type:?}"),
        })
    }
}

fn validate_preset_for_remote_track(
    preset: &AudioPresetDefinition,
    source_type: &AudioSourceType,
) -> Result<(), AudioStateError> {
    let applies = match preset.target {
        AudioPresetTarget::AnyAudioChannel => true,
        AudioPresetTarget::RemoteVoice => matches!(source_type, AudioSourceType::Microphone),
        AudioPresetTarget::RemoteMusic => matches!(source_type, AudioSourceType::FileAudio),
        AudioPresetTarget::LocalMicrophone
        | AudioPresetTarget::LocalScreenAudio
        | AudioPresetTarget::LocalMusic => false,
    };
    if applies {
        Ok(())
    } else {
        Err(AudioStateError::PresetTargetMismatch {
            preset_id: preset.preset_id.clone(),
            target: preset.target.clone(),
            channel: format!("remote {source_type:?}"),
        })
    }
}

fn legacy_preset_marker(preset: &AudioPresetDefinition) -> AudioPreset {
    match preset.preset_id.as_str() {
        "broadcast-mic" | "clean-meeting-voice" | "noisy-room-voice" => AudioPreset::Voice,
        "screen-audio-low" | "presentation-screen-audio" => AudioPreset::ScreenShare,
        "background-music" => AudioPreset::Music,
        "flat-no-processing" => AudioPreset::Neutral,
        _ => AudioPreset::Custom,
    }
}

fn ensure_user_presets_loaded(
    app: &AppHandle,
    engine: &mut AudioEngineState,
) -> Result<(), AudioStateError> {
    if engine.user_presets_loaded {
        return Ok(());
    }
    engine.user_presets = load_user_presets(app)?;
    engine.user_presets_loaded = true;
    Ok(())
}

fn user_presets_path(app: &AppHandle) -> Result<std::path::PathBuf, AudioStateError> {
    let app_data_dir =
        app.path()
            .app_data_dir()
            .map_err(|error| AudioStateError::PresetStorageFailed {
                message: error.to_string(),
            })?;
    Ok(app_data_dir.join(USER_PRESETS_FILE_NAME))
}

fn load_user_presets(app: &AppHandle) -> Result<Vec<AudioPresetDefinition>, AudioStateError> {
    load_user_presets_from_path(&user_presets_path(app)?)
}

fn save_user_presets(
    app: &AppHandle,
    presets: &[AudioPresetDefinition],
) -> Result<(), AudioStateError> {
    save_user_presets_to_path(&user_presets_path(app)?, presets)
}

fn load_user_presets_from_path(path: &Path) -> Result<Vec<AudioPresetDefinition>, AudioStateError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(path).map_err(|error| AudioStateError::PresetStorageFailed {
        message: error.to_string(),
    })?;
    let mut presets: Vec<AudioPresetDefinition> =
        serde_json::from_slice(&bytes).map_err(|error| AudioStateError::PresetStorageFailed {
            message: error.to_string(),
        })?;
    for preset in &mut presets {
        preset.built_in = false;
        preset.user_created = true;
        if preset.preset_id.trim().is_empty() {
            preset.preset_id = format!("user-{}", uuid::Uuid::new_v4());
        }
    }
    Ok(presets)
}

fn save_user_presets_to_path(
    path: &Path,
    presets: &[AudioPresetDefinition],
) -> Result<(), AudioStateError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| AudioStateError::PresetStorageFailed {
            message: error.to_string(),
        })?;
    }
    let user_presets: Vec<_> = presets
        .iter()
        .filter(|preset| preset.user_created && !preset.built_in)
        .cloned()
        .collect();
    let bytes = serde_json::to_vec_pretty(&user_presets).map_err(|error| {
        AudioStateError::PresetStorageFailed {
            message: error.to_string(),
        }
    })?;
    fs::write(path, bytes).map_err(|error| AudioStateError::PresetStorageFailed {
        message: error.to_string(),
    })
}

fn now_unix_ms_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn audio_track_source_from_source(source: &AudioSourceState) -> AudioTrackSource {
    AudioTrackSource {
        source_id: source.id,
        participant_id: source.owner_id,
        source_type: source.source_type.clone(),
        display_name: source.display_name.clone(),
        device_name: source.runtime.device_name.clone(),
        app_name: (source.source_type == AudioSourceType::AppAudio)
            .then(|| source.display_name.clone()),
        app_exe_name: None,
        app_icon_data_url: None,
        default_gain_db: source.channel_strip.gain_db,
        muted: source.channel_strip.mute.muted,
        webrtc_processing: source.channel_strip.webrtc_processing.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::domain::{AudioProcessorKind, AudioProcessorState};

    #[test]
    fn adds_and_mutates_local_source_state() {
        let mut engine = AudioEngineState::default();
        let source = engine.add_local_source(AudioSourceType::Microphone, "Desk mic");

        assert_eq!(engine.mixer.local_sources.len(), 1);
        assert_eq!(engine.mixer.local_sources[0].display_name, "Desk mic");
        assert!(engine.mixer.local_sources[0].enabled);
        assert_eq!(
            engine.mixer.local_sources[0].channel_strip.gain_db,
            GainDb::UNITY
        );
        assert!(!engine.mixer.local_sources[0].channel_strip.mute.muted);
        assert_eq!(
            engine.mixer.local_sources[0].channel_strip.meter.peak_db,
            GainDb::MUTED_FLOOR
        );

        let renamed = engine
            .rename_local_source(source.id, "Boom mic")
            .expect("rename source");
        assert_eq!(renamed.display_name, "Boom mic");

        let disabled = engine
            .set_local_source_enabled(source.id, false)
            .expect("disable source");
        assert!(!disabled.enabled);

        let gained = engine
            .set_local_channel_gain(source.id, GainDb::new(-6.0))
            .expect("set source gain");
        assert_eq!(gained.channel_strip.gain_db, GainDb::new(-6.0));

        let muted = engine
            .set_local_channel_mute(source.id, true)
            .expect("set source mute");
        assert!(muted.channel_strip.mute.muted);
        assert!(muted.channel_strip.mute.muted_by_user);
    }

    #[test]
    fn creates_supported_placeholder_sources_with_default_channel_strips() {
        let mut engine = AudioEngineState::default();
        let source_types = [
            AudioSourceType::Microphone,
            AudioSourceType::FileAudio,
            AudioSourceType::TestTone,
            AudioSourceType::ScreenAudio,
            AudioSourceType::SystemAudio,
        ];

        for source_type in &source_types {
            let source = engine.add_local_source(source_type.clone(), format!("{source_type:?}"));
            assert_eq!(&source.source_type, source_type);
            assert!(source.enabled);
            assert_eq!(source.channel_strip.gain_db, GainDb::UNITY);
            assert!(!source.channel_strip.mute.muted);
            assert!(source.channel_strip.processor_chain.processors.is_empty());
            assert_eq!(source.channel_strip.meter.peak_db, GainDb::MUTED_FLOOR);
            assert_eq!(source.channel_strip.meter.rms_db, GainDb::MUTED_FLOOR);
        }

        let mut ids: Vec<_> = engine
            .mixer
            .local_sources
            .iter()
            .map(|source| source.id)
            .collect();
        ids.sort_by_key(|id| format!("{id:?}"));
        ids.dedup();
        assert_eq!(ids.len(), source_types.len());
    }

    #[test]
    fn removes_local_source_state() {
        let mut engine = AudioEngineState::default();
        let source = engine.add_local_source(AudioSourceType::SystemAudio, "System");

        let removed = engine
            .remove_local_source(source.id)
            .expect("remove local source");

        assert_eq!(removed.id, source.id);
        assert!(engine.mixer.local_sources.is_empty());
    }

    #[test]
    fn publishes_multiple_local_sources_as_independent_tracks() {
        let mut engine = AudioEngineState::default();
        let microphone =
            engine.add_local_source(AudioSourceType::Microphone, "Soroush / Microphone");
        let screen_audio =
            engine.add_local_source(AudioSourceType::ScreenAudio, "Soroush / Screen Audio");

        let published_mic = engine
            .publish_local_source_metadata(microphone.id)
            .expect("publish microphone");
        let published_screen = engine
            .publish_local_source_metadata(screen_audio.id)
            .expect("publish screen audio");
        let mic_track = published_mic.published_track.expect("microphone track");
        let screen_track = published_screen
            .published_track
            .expect("screen audio track");

        assert_ne!(mic_track.track_id, screen_track.track_id);
        assert_eq!(mic_track.participant_id, screen_track.participant_id);
        assert_eq!(mic_track.source_type, AudioSourceType::Microphone);
        assert_eq!(screen_track.source_type, AudioSourceType::ScreenAudio);
        assert_eq!(mic_track.display_name, "Soroush / Microphone");
        assert_eq!(screen_track.display_name, "Soroush / Screen Audio");
        assert_eq!(engine.mixer.local_sources.len(), 2);
        assert_eq!(engine.mixer.track_events.len(), 2);
        assert!(matches!(
            engine.mixer.track_events[0],
            TrackLifecycleEvent::TrackPublished { .. }
        ));
    }

    #[test]
    fn publish_unpublish_updates_source_lifecycle_state() {
        let mut engine = AudioEngineState::default();
        let source = engine.add_local_source(AudioSourceType::FileAudio, "Music");
        engine
            .set_local_channel_gain(source.id, GainDb::new(-12.0))
            .expect("set default gain before publish");
        engine
            .set_local_channel_mute(source.id, true)
            .expect("set mute before publish");

        let published = engine
            .publish_local_source_metadata(source.id)
            .expect("publish source metadata");
        let track = published.published_track.expect("published track");

        assert!(published.publishing);
        assert_eq!(track.source_type, AudioSourceType::FileAudio);
        assert_eq!(track.display_name, "Music");
        assert_eq!(track.default_gain_db, GainDb::new(-12.0));
        assert!(track.muted);
        assert!(track.created_at.is_some());
        assert!(track.updated_at.is_some());

        let unpublished = engine
            .unpublish_local_source_metadata(source.id)
            .expect("unpublish source metadata");
        assert!(!unpublished.publishing);
        assert!(unpublished.published_track.is_none());
        assert!(matches!(
            engine.mixer.track_events.last(),
            Some(TrackLifecycleEvent::TrackUnpublished { .. })
        ));
    }

    #[test]
    fn repeated_publish_does_not_duplicate_track_state() {
        let mut engine = AudioEngineState::default();
        let source = engine.add_local_source(AudioSourceType::TestTone, "Tone");

        let first = engine
            .publish_audio_source(source.id)
            .expect("first publish")
            .source
            .published_track
            .expect("first track");
        let second = engine
            .publish_audio_source(source.id)
            .expect("second publish")
            .source
            .published_track
            .expect("second track");

        assert_eq!(first.track_id, second.track_id);
        assert_eq!(first.webrtc_track_id, second.webrtc_track_id);
        assert_eq!(engine.mixer.local_sources.len(), 1);
        assert_eq!(
            engine
                .mixer
                .local_sources
                .iter()
                .filter(|source| source.published_track.is_some())
                .count(),
            1
        );
    }

    #[test]
    fn local_webrtc_processing_is_source_specific_and_republished_when_live() {
        let mut engine = AudioEngineState::default();
        let mic = engine.add_local_source(AudioSourceType::Microphone, "Desk mic");
        let music = engine.add_local_source(AudioSourceType::FileAudio, "Music");
        engine
            .publish_audio_source(mic.id)
            .expect("publish microphone");

        let (updated, instruction) = engine
            .set_local_webrtc_processing(
                mic.id,
                WebRtcAudioProcessingSettings {
                    noise_suppression: false,
                    echo_cancellation: true,
                    auto_gain_control: false,
                },
            )
            .expect("set mic processing");

        assert_eq!(updated.id, mic.id);
        assert!(!updated.channel_strip.webrtc_processing.noise_suppression);
        assert!(updated.channel_strip.webrtc_processing.echo_cancellation);
        assert!(!updated.channel_strip.webrtc_processing.auto_gain_control);
        assert_eq!(
            engine
                .mixer
                .local_sources
                .iter()
                .find(|source| source.id == music.id)
                .expect("music source")
                .channel_strip
                .webrtc_processing,
            WebRtcAudioProcessingSettings::default()
        );

        match instruction.expect("published source should re-emit publish instruction") {
            AudioTrackPublishInstruction::Publish { source, .. } => {
                assert_eq!(source.source_id, mic.id);
                assert!(!source.webrtc_processing.noise_suppression);
                assert!(source.webrtc_processing.echo_cancellation);
                assert!(!source.webrtc_processing.auto_gain_control);
            }
            AudioTrackPublishInstruction::Unpublish { .. } => {
                panic!("expected publish instruction")
            }
        }
    }

    #[test]
    fn updates_published_track_metadata_from_patch() {
        let mut engine = AudioEngineState::default();
        let source = engine.add_local_source(AudioSourceType::AppAudio, "App");
        let published = engine
            .publish_local_source_metadata(source.id)
            .expect("publish source metadata");
        let track_id = published.published_track.expect("published track").track_id;

        let updated = engine
            .update_published_track_metadata(
                track_id,
                PublishedTrackMetadataPatch {
                    display_name: Some("Browser audio".to_string()),
                    default_gain_db: Some(GainDb::new(-6.0)),
                    muted: Some(true),
                    codec: Some("opus".to_string()),
                    encoding: Some("stereo".to_string()),
                    ..PublishedTrackMetadataPatch::default()
                },
            )
            .expect("update published track metadata");
        let track = updated.published_track.expect("updated track");

        assert_eq!(track.track_id, track_id);
        assert_eq!(track.display_name, "Browser audio");
        assert_eq!(track.default_gain_db, GainDb::new(-6.0));
        assert!(track.muted);
        assert_eq!(track.codec.as_deref(), Some("opus"));
        assert_eq!(track.encoding.as_deref(), Some("stereo"));
        assert!(updated.channel_strip.mute.muted);
        assert!(matches!(
            engine.mixer.track_events.last(),
            Some(TrackLifecycleEvent::TrackMetadataUpdated { .. })
        ));
    }

    #[test]
    fn two_remote_tracks_from_same_participant_have_independent_receiver_gains() {
        let mut engine = AudioEngineState::default();
        let participant_id = ParticipantId::new();
        let mic = PublishedTrackMetadata::new(
            AudioSourceId::new(),
            participant_id,
            AudioSourceType::Microphone,
            "Soroush / Mic",
        );
        let music = PublishedTrackMetadata::new(
            AudioSourceId::new(),
            participant_id,
            AudioSourceType::FileAudio,
            "Soroush / Music",
        );
        let mic_id = mic.track_id;
        let music_id = music.track_id;
        engine.add_or_update_remote_track(mic);
        engine.add_or_update_remote_track(music);

        engine
            .set_remote_track_gain(participant_id, mic_id, GainDb::new(0.0))
            .expect("set mic gain");
        engine
            .set_remote_track_gain(participant_id, music_id, GainDb::new(-12.0))
            .expect("set music gain");

        let mic = engine
            .mixer
            .remote_tracks
            .iter()
            .find(|track| track.track.track_id == mic_id)
            .expect("mic track");
        let music = engine
            .mixer
            .remote_tracks
            .iter()
            .find(|track| track.track.track_id == music_id)
            .expect("music track");

        assert_eq!(mic.receiver_channel_strip.gain_db, GainDb::new(0.0));
        assert_eq!(music.receiver_channel_strip.gain_db, GainDb::new(-12.0));
        assert_eq!(engine.mixer.remote_participants.len(), 1);
        assert_eq!(engine.mixer.remote_participants[0].tracks.len(), 2);
    }

    #[test]
    fn remote_track_owner_mute_state_updates_by_participant_and_track() {
        let mut engine = AudioEngineState::default();
        let participant_id = ParticipantId::new();
        let mut first = PublishedTrackMetadata::new(
            AudioSourceId::new(),
            participant_id,
            AudioSourceType::Microphone,
            "Remote mic",
        );
        first.muted = true;
        let mut second = PublishedTrackMetadata::new(
            AudioSourceId::new(),
            participant_id,
            AudioSourceType::Microphone,
            "Remote mic 2",
        );
        second.muted = true;
        let first_id = first.track_id;
        let second_id = second.track_id;
        engine.add_or_update_remote_track(first);
        engine.add_or_update_remote_track(second);

        engine.set_remote_track_muted(participant_id, first_id, false);

        let first = engine
            .mixer
            .remote_tracks
            .iter()
            .find(|track| track.track.track_id == first_id)
            .expect("first remote mic");
        let second = engine
            .mixer
            .remote_tracks
            .iter()
            .find(|track| track.track.track_id == second_id)
            .expect("second remote mic");
        assert!(!first.track.muted);
        assert!(second.track.muted);
        assert_eq!(engine.mixer.remote_participants[0].tracks.len(), 2);
    }

    #[test]
    fn receiver_gain_does_not_mutate_published_track_metadata() {
        let mut engine = AudioEngineState::default();
        let participant_id = ParticipantId::new();
        let mut metadata = PublishedTrackMetadata::new(
            AudioSourceId::new(),
            participant_id,
            AudioSourceType::ScreenAudio,
            "Soroush / Screen",
        );
        metadata.default_gain_db = GainDb::new(0.0);
        let track_id = metadata.track_id;
        engine.add_or_update_remote_track(metadata);

        let updated = engine
            .set_remote_track_gain(participant_id, track_id, GainDb::new(-3.0))
            .expect("set receiver gain");

        assert_eq!(updated.receiver_channel_strip.gain_db, GainDb::new(-3.0));
        assert_eq!(updated.preference.gain_db, GainDb::new(-3.0));
        assert_eq!(updated.track.default_gain_db, GainDb::new(0.0));
    }

    #[test]
    fn removing_remote_track_cleans_up_receiver_channel_state() {
        let mut engine = AudioEngineState::default();
        let participant_id = ParticipantId::new();
        let metadata = PublishedTrackMetadata::new(
            AudioSourceId::new(),
            participant_id,
            AudioSourceType::Microphone,
            "Remote mic",
        );
        let track_id = metadata.track_id;
        engine.add_or_update_remote_track(metadata);
        engine
            .set_remote_track_mute(participant_id, track_id, true)
            .expect("mute remote track");

        let removed = engine
            .remove_remote_track(participant_id, track_id)
            .expect("remove remote track");

        assert_eq!(removed.track.track_id, track_id);
        assert!(engine.mixer.remote_tracks.is_empty());
        assert!(engine.mixer.remote_participants.is_empty());
    }

    #[test]
    fn remote_processor_chain_state_is_independent_per_track() {
        let mut engine = AudioEngineState::default();
        let participant_id = ParticipantId::new();
        let mic = PublishedTrackMetadata::new(
            AudioSourceId::new(),
            participant_id,
            AudioSourceType::Microphone,
            "Mic",
        );
        let music = PublishedTrackMetadata::new(
            AudioSourceId::new(),
            participant_id,
            AudioSourceType::FileAudio,
            "Music",
        );
        let mic_id = mic.track_id;
        let music_id = music.track_id;
        engine.add_or_update_remote_track(mic);
        engine.add_or_update_remote_track(music);

        let mic = engine
            .add_processor_to_remote_track(participant_id, mic_id, AudioProcessorKind::Gain)
            .expect("add remote mic gain");
        let processor_id = mic.receiver_channel_strip.processor_chain.processors[0].id;
        engine
            .set_remote_processor_parameter(
                participant_id,
                mic_id,
                processor_id,
                "gainDb",
                AudioParameterValue::Number(-6.0),
            )
            .expect("set remote processor gain");

        let mic = engine
            .mixer
            .remote_tracks
            .iter()
            .find(|track| track.track.track_id == mic_id)
            .expect("mic track");
        let music = engine
            .mixer
            .remote_tracks
            .iter()
            .find(|track| track.track.track_id == music_id)
            .expect("music track");

        assert_eq!(
            mic.receiver_channel_strip.processor_chain.processors.len(),
            1
        );
        assert_eq!(
            mic.receiver_channel_strip.processor_chain.processors[0]
                .parameters
                .gain_db,
            Some(GainDb::new(-6.0))
        );
        assert!(music
            .receiver_channel_strip
            .processor_chain
            .processors
            .is_empty());
    }

    #[test]
    fn toggles_processor_enabled_state() {
        let mut engine = AudioEngineState::default();
        let source = engine.add_local_source(AudioSourceType::FileAudio, "Music");
        let processor = AudioProcessorState::new(AudioProcessorKind::Compressor, "Compressor");
        let processor_id = processor.id;
        engine.mixer.local_sources[0]
            .channel_strip
            .processor_chain
            .processors
            .push(processor);

        let updated = engine
            .set_processor_enabled(source.id, processor_id, false)
            .expect("disable processor");

        assert!(!updated.channel_strip.processor_chain.processors[0].enabled);
    }

    #[test]
    fn adds_removes_and_reorders_channel_processors() {
        let mut engine = AudioEngineState::default();
        let source = engine.add_local_source(AudioSourceType::Microphone, "Mic");
        let with_gain = engine
            .add_processor_to_local_channel(source.id, AudioProcessorKind::Gain)
            .expect("add gain");
        let gain_id = with_gain.channel_strip.processor_chain.processors[0].id;
        let with_meter = engine
            .add_processor_to_local_channel(source.id, AudioProcessorKind::Meter)
            .expect("add meter");
        let meter_id = with_meter.channel_strip.processor_chain.processors[1].id;

        let reordered = engine
            .reorder_processors(source.id, vec![meter_id, gain_id])
            .expect("reorder processors");
        let ids: Vec<_> = reordered
            .channel_strip
            .processor_chain
            .processors
            .iter()
            .map(|processor| processor.id)
            .collect();
        assert_eq!(ids, vec![meter_id, gain_id]);

        let removed = engine
            .remove_processor_from_local_channel(source.id, meter_id)
            .expect("remove meter");
        assert_eq!(removed.channel_strip.processor_chain.processors.len(), 1);
        assert_eq!(
            removed.channel_strip.processor_chain.processors[0].id,
            gain_id
        );
    }

    #[test]
    fn validates_and_updates_processor_parameters_in_channel_state() {
        let mut engine = AudioEngineState::default();
        let source = engine.add_local_source(AudioSourceType::FileAudio, "Music");
        let processor = AudioProcessorState::new(AudioProcessorKind::Gain, "Trim");
        let processor_id = processor.id;
        engine.mixer.local_sources[0]
            .channel_strip
            .processor_chain
            .processors
            .push(processor);

        let updated = engine
            .set_processor_parameter(
                source.id,
                processor_id,
                "gainDb",
                AudioParameterValue::Number(-12.0),
            )
            .expect("set processor gain");
        assert_eq!(
            updated.channel_strip.processor_chain.processors[0]
                .parameters
                .gain_db,
            Some(GainDb::new(-12.0))
        );

        let error = engine
            .set_processor_parameter(
                source.id,
                processor_id,
                "gainDb",
                AudioParameterValue::Bool(true),
            )
            .expect_err("invalid gain parameter type");
        assert!(matches!(
            error,
            AudioStateError::ProcessorParameterInvalid { .. }
        ));
    }

    #[test]
    fn applying_preset_replaces_local_chain_deterministically() {
        let mut engine = AudioEngineState::default();
        let source = engine.add_local_source(AudioSourceType::Microphone, "Mic");
        engine
            .add_processor_to_local_channel(source.id, AudioProcessorKind::Gain)
            .expect("add existing processor");

        let updated = engine
            .apply_preset_to_local_channel(source.id, "broadcast-mic")
            .expect("apply preset");
        let kinds: Vec<_> = updated
            .channel_strip
            .processor_chain
            .processors
            .iter()
            .map(|processor| processor.kind.clone())
            .collect();

        assert_eq!(
            kinds,
            vec![
                AudioProcessorKind::HighPassFilter,
                AudioProcessorKind::NoiseGate,
                AudioProcessorKind::Compressor,
                AudioProcessorKind::Limiter,
                AudioProcessorKind::Meter,
            ]
        );
        assert_eq!(
            updated.channel_strip.preset_id.as_deref(),
            Some("broadcast-mic")
        );
        assert_eq!(updated.channel_strip.gain_db, GainDb::UNITY);
        assert!(!updated.channel_strip.mute.muted);
    }

    #[test]
    fn built_in_presets_cannot_be_deleted() {
        let mut engine = AudioEngineState::default();

        let error = engine
            .delete_user_preset("broadcast-mic")
            .expect_err("built-in delete should fail");

        assert!(matches!(
            error,
            AudioStateError::BuiltInPresetMutationNotAllowed { .. }
        ));
    }

    #[test]
    fn user_presets_persist_and_reload_from_json() {
        let path = std::env::temp_dir().join(format!(
            "raven-audio-presets-test-{}.json",
            uuid::Uuid::new_v4()
        ));
        let preset = audio_preset(
            "user-test",
            "Saved voice",
            "Saved from test",
            AudioPresetTarget::AnyAudioChannel,
            -3.0,
            false,
            vec![AudioProcessorState::new(AudioProcessorKind::Meter, "Meter")],
        );

        save_user_presets_to_path(
            &path,
            &[AudioPresetDefinition {
                built_in: false,
                user_created: true,
                ..preset.clone()
            }],
        )
        .expect("save presets");
        let loaded = load_user_presets_from_path(&path).expect("load presets");
        let _ = std::fs::remove_file(&path);

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].preset_id, "user-test");
        assert!(!loaded[0].built_in);
        assert!(loaded[0].user_created);
        assert_eq!(loaded[0].processor_chain.processors.len(), 1);
    }

    #[test]
    fn preset_target_validation_rejects_wrong_channel_type() {
        let mut engine = AudioEngineState::default();
        let source = engine.add_local_source(AudioSourceType::FileAudio, "Music");

        let error = engine
            .apply_preset_to_local_channel(source.id, "broadcast-mic")
            .expect_err("mic preset should not apply to music");

        assert!(matches!(
            error,
            AudioStateError::PresetTargetMismatch { .. }
        ));
    }

    #[test]
    fn preset_apply_snapshot_reflects_remote_channel_state() {
        let mut engine = AudioEngineState::default();
        let participant_id = ParticipantId::new();
        let metadata = PublishedTrackMetadata::new(
            AudioSourceId::new(),
            participant_id,
            AudioSourceType::Microphone,
            "Remote mic",
        );
        let track_id = metadata.track_id;
        engine.add_or_update_remote_track(metadata);

        engine
            .apply_preset_to_remote_track(participant_id, track_id, "clean-meeting-voice")
            .expect("apply remote preset");
        let snapshot = engine.snapshot();
        let remote = &snapshot.remote_tracks[0];

        assert_eq!(
            remote.receiver_channel_strip.preset_id.as_deref(),
            Some("clean-meeting-voice")
        );
        assert_eq!(
            remote
                .receiver_channel_strip
                .processor_chain
                .processors
                .len(),
            3
        );
        assert_eq!(snapshot.remote_participants[0].tracks.len(), 1);
    }

    #[test]
    fn reset_to_safe_defaults_produces_known_safe_state() {
        let mut engine = AudioEngineState::default();
        let source = engine.add_local_source(AudioSourceType::Microphone, "Mic");
        engine
            .set_local_channel_gain(source.id, GainDb::new(99.0))
            .expect("clamp high gain");
        engine
            .set_local_safety_limiter_ceiling(source.id, GainDb::new(0.0))
            .expect("clamp safety ceiling");
        engine
            .add_processor_to_local_channel(source.id, AudioProcessorKind::Gain)
            .expect("add processor");

        let reset = engine
            .reset_local_channel_to_safe_defaults(source.id)
            .expect("reset safe defaults");

        assert_eq!(reset.channel_strip.gain_db, GainDb::UNITY);
        assert!(!reset.channel_strip.mute.muted);
        assert_eq!(
            reset.channel_strip.safety_limiter_ceiling_db,
            GainDb::new(-1.0)
        );
        assert_eq!(
            reset.channel_strip.preset_id.as_deref(),
            Some("clean-meeting-voice")
        );
        assert!(reset.channel_strip.health.safety_limiter_active);
        assert!(reset.channel_strip.health.processor_cpu_estimate.is_some());
    }

    #[test]
    fn reports_missing_source_and_processor_ids() {
        let mut engine = AudioEngineState::default();
        let missing_source_id = AudioSourceId::new();
        let missing_processor_id = AudioProcessorId::new();

        let source_error = engine
            .set_local_channel_mute(missing_source_id, true)
            .expect_err("missing source should error");
        assert_eq!(
            source_error,
            AudioStateError::SourceNotFound {
                source_id: missing_source_id
            }
        );

        let source = engine.add_local_source(AudioSourceType::TestTone, "Tone");
        let processor_error = engine
            .set_processor_enabled(source.id, missing_processor_id, false)
            .expect_err("missing processor should error");
        assert_eq!(
            processor_error,
            AudioStateError::ProcessorNotFound {
                source_id: source.id,
                processor_id: missing_processor_id
            }
        );
    }
}
