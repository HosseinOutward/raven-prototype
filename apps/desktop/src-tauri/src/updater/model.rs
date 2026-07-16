use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

pub const STATE_SCHEMA_VERSION: u32 = 1;
pub const ALPHA_CONSENT_VERSION: &str = "closed-alpha-2026-07-12";

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdatePhase {
    #[default]
    Idle,
    Checking,
    Available,
    Downloading,
    Downloaded,
    AwaitingRestart,
    Installing,
    Deferred,
    Paused,
    CheckFailed,
    DownloadFailed,
    VerificationFailed,
    InstallationFailed,
    UnsupportedVersion,
    BlockedVersion,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateChannel {
    Stable,
    #[default]
    Alpha,
}

impl UpdateChannel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Alpha => "alpha",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateCohort {
    Internal,
    #[default]
    Friends,
}

impl UpdateCohort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Internal => "internal",
            Self::Friends => "friends",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MeteredBehavior {
    #[default]
    Ask,
    Never,
    Allow,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MeteredConnection {
    #[default]
    Unknown,
    Unmetered,
    Metered,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateClassification {
    #[default]
    Optional,
    Recommended,
    Required,
    Blocked,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Ord, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessMode {
    #[default]
    Allowed,
    Required,
    Unsupported,
    Blocked,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ServiceAccess {
    pub mode: AccessMode,
    pub reason_code: String,
    pub message: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CompatibilitySummary {
    pub status: String,
    pub reason_code: String,
    pub message: String,
    pub client_version: String,
    pub server_version: String,
    pub protocol_version: i32,
    pub minimum_client_version: String,
    pub recommended_client_version: String,
    pub minimum_server_version: String,
    pub maximum_server_version: String,
    pub required_capabilities: Vec<String>,
    pub missing_capabilities: Vec<String>,
    pub grace_ends_at: Option<String>,
}

impl CompatibilitySummary {
    pub fn access(&self) -> ServiceAccess {
        let status = self.status.trim().to_ascii_lowercase();
        let mode = match status.as_str() {
            "blocked" | "unsafe" => AccessMode::Blocked,
            "upgrade_required" | "required" => AccessMode::Required,
            "unsupported" | "server_too_old" | "server_too_new" | "incompatible" => {
                AccessMode::Unsupported
            }
            _ => AccessMode::Allowed,
        };
        ServiceAccess {
            mode,
            reason_code: self.reason_code.clone(),
            message: self.message.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ConsentSettings {
    pub delivery_accepted: bool,
    pub delivery_consent_version: String,
    pub delivery_accepted_at_ms: Option<u64>,
    pub aggregate_outcomes: bool,
    pub detailed_diagnostics: bool,
}

impl Default for ConsentSettings {
    fn default() -> Self {
        Self {
            delivery_accepted: false,
            delivery_consent_version: String::new(),
            delivery_accepted_at_ms: None,
            aggregate_outcomes: false,
            detailed_diagnostics: false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UpdateSettings {
    pub channel: UpdateChannel,
    pub cohort: UpdateCohort,
    pub automatic_download: bool,
    pub metered_behavior: MeteredBehavior,
    pub consent: ConsentSettings,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            channel: UpdateChannel::Alpha,
            cohort: UpdateCohort::Friends,
            automatic_download: true,
            metered_behavior: MeteredBehavior::Ask,
            consent: ConsentSettings::default(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub release_id: String,
    pub version: String,
    pub notes: String,
    pub published_at: Option<String>,
    pub classification: UpdateClassification,
    pub size: u64,
    pub sha256: String,
    pub signature_present: bool,
    pub eligible: bool,
    pub rollout_bucket: u16,
    pub decision: String,
    pub reason_code: String,
    pub message: String,
    pub compatibility: CompatibilitySummary,
    pub local_data_schema_version: i32,
    pub local_migration_reversible: bool,
    pub rollback_safe: bool,
    pub approved_rollback_release_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DownloadedArtifact {
    pub release_id: String,
    pub version: String,
    pub staging_file: String,
    pub size: u64,
    pub sha256: String,
    pub verified_at_ms: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
    pub percent: Option<u8>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CoarseError {
    pub category: String,
    pub message: String,
    pub action: String,
    pub current_installation_safe: bool,
    pub communication_or_privacy_affected: bool,
    pub retryable: bool,
    pub at_ms: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DiagnosticEntry {
    pub at_ms: u64,
    pub level: String,
    pub event: String,
    pub message: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ServerContext {
    pub server_version: String,
    pub protocol_version: i32,
    pub capabilities: Vec<String>,
    pub compatibility: CompatibilitySummary,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PendingInstallation {
    pub release_id: String,
    pub from_version: String,
    pub to_version: String,
    pub attempted_at_ms: u64,
    pub local_data_schema_version: i32,
    pub local_migration_reversible: bool,
    pub rollback_safe: bool,
    pub approved_rollback_release_id: Option<String>,
    pub startup_health_attempts: u8,
    pub rollback_attempted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PersistedUpdaterState {
    pub schema_version: u32,
    pub installation_id: String,
    pub rollout_bucket: u16,
    pub settings: UpdateSettings,
    pub phase: UpdatePhase,
    pub phase_changed_at_ms: u64,
    pub available: Option<AvailableUpdate>,
    pub downloaded: Option<DownloadedArtifact>,
    pub progress: Option<DownloadProgress>,
    pub install_on_close: bool,
    pub last_successful_check_at_ms: Option<u64>,
    pub last_check_attempt_at_ms: Option<u64>,
    pub next_automatic_check_at_ms: Option<u64>,
    pub endpoint_status: String,
    pub rollout_eligibility: String,
    pub verification_status: String,
    pub installation_status: String,
    pub update_access: ServiceAccess,
    pub server_context: ServerContext,
    pub last_error: Option<CoarseError>,
    pub retry_attempt: u8,
    pub logs: Vec<DiagnosticEntry>,
    pub pending_installation: Option<PendingInstallation>,
}

impl Default for PersistedUpdaterState {
    fn default() -> Self {
        let installation_id = uuid::Uuid::new_v4().to_string();
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            rollout_bucket: rollout_bucket(&installation_id),
            installation_id,
            settings: UpdateSettings::default(),
            phase: UpdatePhase::Idle,
            phase_changed_at_ms: now_ms(),
            available: None,
            downloaded: None,
            progress: None,
            install_on_close: false,
            last_successful_check_at_ms: None,
            last_check_attempt_at_ms: None,
            next_automatic_check_at_ms: None,
            endpoint_status: "not_checked".to_string(),
            rollout_eligibility: "unknown".to_string(),
            verification_status: "not_checked".to_string(),
            installation_status: "not_started".to_string(),
            update_access: ServiceAccess::default(),
            server_context: ServerContext::default(),
            last_error: None,
            retry_attempt: 0,
            logs: Vec::new(),
            pending_installation: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsPatch {
    pub channel: Option<UpdateChannel>,
    pub cohort: Option<UpdateCohort>,
    pub automatic_download: Option<bool>,
    pub metered_behavior: Option<MeteredBehavior>,
    pub delivery_accepted: Option<bool>,
    pub aggregate_outcomes: Option<bool>,
    pub detailed_diagnostics: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterSnapshot {
    pub schema_version: u32,
    pub current_version: String,
    pub endpoint: &'static str,
    pub platform: &'static str,
    pub architecture: &'static str,
    pub rollout_bucket: u16,
    pub settings: UpdateSettings,
    pub phase: UpdatePhase,
    pub phase_changed_at_ms: u64,
    pub available: Option<AvailableUpdate>,
    pub downloaded: Option<DownloadedArtifact>,
    pub progress: Option<DownloadProgress>,
    pub verified_in_current_process: bool,
    pub install_on_close: bool,
    pub active_session: bool,
    pub active_session_reason: String,
    pub metered_connection: MeteredConnection,
    pub last_successful_check_at_ms: Option<u64>,
    pub last_check_attempt_at_ms: Option<u64>,
    pub next_automatic_check_at_ms: Option<u64>,
    pub endpoint_status: String,
    pub rollout_eligibility: String,
    pub verification_status: String,
    pub installation_status: String,
    pub compatibility: CompatibilitySummary,
    pub access: ServiceAccess,
    pub last_error: Option<CoarseError>,
    pub retry_attempt: u8,
    pub logs: Vec<DiagnosticEntry>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub fn rollout_bucket(installation_id: &str) -> u16 {
    let mut hasher = Sha256::new();
    hasher.update(b"raven-rollout-v1\0");
    hasher.update(installation_id.as_bytes());
    let digest = hasher.finalize();
    let prefix = u64::from_be_bytes(digest[..8].try_into().unwrap_or([0; 8]));
    (prefix % 10_000) as u16
}

pub fn can_transition(from: UpdatePhase, to: UpdatePhase) -> bool {
    if from == to {
        return true;
    }
    if matches!(
        to,
        UpdatePhase::BlockedVersion | UpdatePhase::UnsupportedVersion
    ) {
        return true;
    }
    matches!(
        (from, to),
        (UpdatePhase::Idle, UpdatePhase::Checking)
            | (UpdatePhase::Checking, UpdatePhase::Idle)
            | (UpdatePhase::Checking, UpdatePhase::Available)
            | (UpdatePhase::Checking, UpdatePhase::Paused)
            | (UpdatePhase::Checking, UpdatePhase::CheckFailed)
            | (UpdatePhase::Available, UpdatePhase::Checking)
            | (UpdatePhase::Available, UpdatePhase::Downloading)
            | (UpdatePhase::Available, UpdatePhase::Deferred)
            | (UpdatePhase::Available, UpdatePhase::Paused)
            | (UpdatePhase::Downloading, UpdatePhase::Downloaded)
            | (UpdatePhase::Downloading, UpdatePhase::DownloadFailed)
            | (UpdatePhase::Downloading, UpdatePhase::VerificationFailed)
            | (UpdatePhase::Downloading, UpdatePhase::Deferred)
            | (UpdatePhase::Downloaded, UpdatePhase::AwaitingRestart)
            | (UpdatePhase::Downloaded, UpdatePhase::Checking)
            | (UpdatePhase::Downloaded, UpdatePhase::VerificationFailed)
            | (UpdatePhase::AwaitingRestart, UpdatePhase::Installing)
            | (UpdatePhase::AwaitingRestart, UpdatePhase::Deferred)
            | (UpdatePhase::AwaitingRestart, UpdatePhase::Checking)
            | (
                UpdatePhase::AwaitingRestart,
                UpdatePhase::InstallationFailed
            )
            | (UpdatePhase::Deferred, UpdatePhase::Checking)
            | (UpdatePhase::Deferred, UpdatePhase::Downloading)
            | (UpdatePhase::Deferred, UpdatePhase::Downloaded)
            | (UpdatePhase::Deferred, UpdatePhase::AwaitingRestart)
            | (UpdatePhase::Deferred, UpdatePhase::Installing)
            | (UpdatePhase::Deferred, UpdatePhase::Paused)
            | (UpdatePhase::Paused, UpdatePhase::Checking)
            | (UpdatePhase::Paused, UpdatePhase::Available)
            | (UpdatePhase::Paused, UpdatePhase::Idle)
            | (UpdatePhase::CheckFailed, UpdatePhase::Checking)
            | (UpdatePhase::CheckFailed, UpdatePhase::Idle)
            | (UpdatePhase::DownloadFailed, UpdatePhase::Checking)
            | (UpdatePhase::DownloadFailed, UpdatePhase::Downloading)
            | (UpdatePhase::DownloadFailed, UpdatePhase::Idle)
            | (UpdatePhase::VerificationFailed, UpdatePhase::Checking)
            | (UpdatePhase::VerificationFailed, UpdatePhase::Downloading)
            | (UpdatePhase::VerificationFailed, UpdatePhase::Idle)
            | (UpdatePhase::InstallationFailed, UpdatePhase::Checking)
            | (UpdatePhase::InstallationFailed, UpdatePhase::Installing)
            | (UpdatePhase::InstallationFailed, UpdatePhase::Idle)
            | (UpdatePhase::UnsupportedVersion, UpdatePhase::Checking)
            | (UpdatePhase::BlockedVersion, UpdatePhase::Checking)
            | (UpdatePhase::Installing, UpdatePhase::Idle)
            | (UpdatePhase::Installing, UpdatePhase::InstallationFailed)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rollout_bucket_is_stable_and_matches_backend_vector() {
        assert_eq!(rollout_bucket("00000000-0000-4000-8000-000000000000"), 1723);
        assert_eq!(rollout_bucket("00000000-0000-4000-8000-000000000000"), 1723);
    }

    #[test]
    fn percentage_expansion_keeps_existing_installations() {
        let ids = (0..1000)
            .map(|value| format!("install-{value}"))
            .collect::<Vec<_>>();
        let five = ids
            .iter()
            .filter(|id| rollout_bucket(id) < 500)
            .collect::<Vec<_>>();
        let twenty_five = ids
            .iter()
            .filter(|id| rollout_bucket(id) < 2500)
            .collect::<Vec<_>>();
        assert!(five.iter().all(|id| twenty_five.contains(id)));
    }

    #[test]
    fn transition_matrix_rejects_install_without_verified_download() {
        assert!(!can_transition(
            UpdatePhase::Available,
            UpdatePhase::Installing
        ));
        assert!(!can_transition(UpdatePhase::Idle, UpdatePhase::Installing));
        assert!(can_transition(
            UpdatePhase::AwaitingRestart,
            UpdatePhase::Installing
        ));
    }

    #[test]
    fn compatibility_maps_to_service_access() {
        let mut compatibility = CompatibilitySummary::default();
        compatibility.status = "upgrade_required".to_string();
        assert_eq!(compatibility.access().mode, AccessMode::Required);
        compatibility.status = "server_too_old".to_string();
        assert_eq!(compatibility.access().mode, AccessMode::Unsupported);
    }
}
