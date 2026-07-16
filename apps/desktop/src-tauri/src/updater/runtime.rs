use super::model::{
    can_transition, now_ms, AccessMode, CoarseError, DiagnosticEntry, DownloadedArtifact,
    MeteredConnection, PersistedUpdaterState, ServiceAccess, UpdatePhase, UpdaterSnapshot,
    STATE_SCHEMA_VERSION,
};
use fs2::FileExt;
use regex::Regex;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex as AsyncMutex;

#[derive(Clone)]
pub struct UpdaterRuntime(pub Arc<UpdaterRuntimeInner>);

pub struct UpdaterRuntimeInner {
    pub app: AppHandle,
    pub current_version: String,
    pub state: Mutex<PersistedUpdaterState>,
    pub operation: AsyncMutex<()>,
    pub state_path: PathBuf,
    pub state_backup_path: PathBuf,
    pub staging_dir: PathBuf,
    pub verified_release: Mutex<Option<String>>,
    pub active_session: AtomicBool,
    pub active_session_reason: Mutex<String>,
    pub close_install_in_progress: AtomicBool,
    pub allow_exit_after_install: AtomicBool,
    pub lock_file: File,
}

impl UpdaterRuntime {
    pub fn initialize(app: &AppHandle) -> Result<Self, String> {
        let updates_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| redact(&error.to_string()))?
            .join("updates");
        let staging_dir = updates_dir.join("staging");
        fs::create_dir_all(&staging_dir).map_err(|error| redact(&error.to_string()))?;
        let state_path = updates_dir.join("state-v1.json");
        let state_backup_path = updates_dir.join("state-v1.backup.json");
        let lock_path = updates_dir.join("state-v1.lock");
        let lock_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(lock_path)
            .map_err(|error| redact(&error.to_string()))?;
        lock_file
            .try_lock_exclusive()
            .map_err(|_| "Another Raven process owns the desktop updater state.".to_string())?;
        let current_version = app.package_info().version.to_string();
        let mut state = load_state(&state_path)
            .or_else(|| load_state(&state_backup_path))
            .unwrap_or_default();
        recover_state(&mut state, &staging_dir, &current_version);
        let runtime = Self(Arc::new(UpdaterRuntimeInner {
            app: app.clone(),
            current_version,
            state: Mutex::new(state),
            operation: AsyncMutex::new(()),
            state_path,
            state_backup_path,
            staging_dir,
            verified_release: Mutex::new(None),
            active_session: AtomicBool::new(false),
            active_session_reason: Mutex::new(String::new()),
            close_install_in_progress: AtomicBool::new(false),
            allow_exit_after_install: AtomicBool::new(false),
            lock_file,
        }));
        runtime.persist()?;
        Ok(runtime)
    }

    pub fn snapshot(&self) -> UpdaterSnapshot {
        let state = self.0.state.lock().expect("updater state poisoned").clone();
        let verified_release = self
            .0
            .verified_release
            .lock()
            .expect("verified release state poisoned")
            .clone();
        let verified_in_current_process = state
            .downloaded
            .as_ref()
            .map(|downloaded| verified_release.as_deref() == Some(downloaded.release_id.as_str()))
            .unwrap_or(false);
        let update_access = state.update_access.clone();
        let server_access = state.server_context.compatibility.access();
        let access = if server_access.mode > update_access.mode {
            server_access
        } else {
            update_access
        };
        UpdaterSnapshot {
            schema_version: state.schema_version,
            current_version: self.0.current_version.clone(),
            endpoint: super::UPDATE_ENDPOINT,
            platform: platform(),
            architecture: architecture(),
            rollout_bucket: state.rollout_bucket,
            settings: state.settings,
            phase: state.phase,
            phase_changed_at_ms: state.phase_changed_at_ms,
            available: state.available,
            downloaded: state.downloaded,
            progress: state.progress,
            verified_in_current_process,
            install_on_close: state.install_on_close,
            active_session: self.0.active_session.load(Ordering::SeqCst),
            active_session_reason: self
                .0
                .active_session_reason
                .lock()
                .expect("active session reason poisoned")
                .clone(),
            metered_connection: metered_connection(),
            last_successful_check_at_ms: state.last_successful_check_at_ms,
            last_check_attempt_at_ms: state.last_check_attempt_at_ms,
            next_automatic_check_at_ms: state.next_automatic_check_at_ms,
            endpoint_status: state.endpoint_status,
            rollout_eligibility: state.rollout_eligibility,
            verification_status: state.verification_status,
            installation_status: state.installation_status,
            compatibility: state.server_context.compatibility,
            access,
            last_error: state.last_error,
            retry_attempt: state.retry_attempt,
            logs: state.logs,
        }
    }

    pub fn mutate<F>(&self, action: F) -> Result<UpdaterSnapshot, String>
    where
        F: FnOnce(&mut PersistedUpdaterState) -> Result<(), String>,
    {
        {
            let mut state = self.0.state.lock().expect("updater state poisoned");
            action(&mut state)?;
            self.persist_locked(&state)?;
        }
        let snapshot = self.snapshot();
        let _ = self.0.app.emit("raven-updater-state", &snapshot);
        Ok(snapshot)
    }

    pub fn transition(&self, phase: UpdatePhase) -> Result<UpdaterSnapshot, String> {
        self.mutate(|state| {
            if !can_transition(state.phase, phase) {
                return Err(format!(
                    "The updater cannot move from {:?} to {:?}.",
                    state.phase, phase
                ));
            }
            state.phase = phase;
            state.phase_changed_at_ms = now_ms();
            Ok(())
        })
    }

    pub fn force_phase(&self, phase: UpdatePhase) -> Result<UpdaterSnapshot, String> {
        self.mutate(|state| {
            state.phase = phase;
            state.phase_changed_at_ms = now_ms();
            Ok(())
        })
    }

    pub fn set_active_session(&self, active: bool, reason: String) -> UpdaterSnapshot {
        self.0.active_session.store(active, Ordering::SeqCst);
        *self
            .0
            .active_session_reason
            .lock()
            .expect("active session reason poisoned") = redact(&reason);
        let snapshot = self.snapshot();
        let _ = self.0.app.emit("raven-updater-state", &snapshot);
        snapshot
    }

    pub fn set_verified_release(&self, release_id: Option<String>) {
        *self
            .0
            .verified_release
            .lock()
            .expect("verified release state poisoned") = release_id;
    }

    pub fn staging_path(&self, file_name: &str) -> Result<PathBuf, String> {
        if file_name.is_empty()
            || file_name.len() > 160
            || !file_name.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
            })
        {
            return Err("The staged update file name is invalid.".to_string());
        }
        Ok(self.0.staging_dir.join(file_name))
    }

    pub fn record_log(&self, level: &str, event: &str, message: &str) -> Result<(), String> {
        self.mutate(|state| {
            push_log(state, level, event, message);
            Ok(())
        })?;
        Ok(())
    }

    pub fn record_error(
        &self,
        phase: UpdatePhase,
        category: &str,
        message: &str,
        action: &str,
        retryable: bool,
    ) -> Result<UpdaterSnapshot, String> {
        self.mutate(|state| {
            state.phase = phase;
            state.phase_changed_at_ms = now_ms();
            state.progress = None;
            state.last_error = Some(CoarseError {
                category: category.to_string(),
                message: redact(message),
                action: action.to_string(),
                current_installation_safe: !matches!(
                    phase,
                    UpdatePhase::BlockedVersion | UpdatePhase::UnsupportedVersion
                ) && state.update_access.mode == AccessMode::Allowed,
                communication_or_privacy_affected: false,
                retryable,
                at_ms: now_ms(),
            });
            push_log(state, "error", category, message);
            Ok(())
        })
    }

    pub fn persist(&self) -> Result<(), String> {
        let state = self.0.state.lock().expect("updater state poisoned");
        self.persist_locked(&state)
    }

    fn persist_locked(&self, state: &PersistedUpdaterState) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(state).map_err(|error| redact(&error.to_string()))?;
        let temp_path = self.0.state_path.with_extension("json.tmp");
        {
            let mut file = File::create(&temp_path).map_err(|error| redact(&error.to_string()))?;
            file.write_all(&bytes)
                .map_err(|error| redact(&error.to_string()))?;
            file.sync_all()
                .map_err(|error| redact(&error.to_string()))?;
        }
        if self.0.state_path.exists() {
            fs::copy(&self.0.state_path, &self.0.state_backup_path)
                .map_err(|error| redact(&error.to_string()))?;
            fs::remove_file(&self.0.state_path).map_err(|error| redact(&error.to_string()))?;
        }
        fs::rename(&temp_path, &self.0.state_path).map_err(|error| redact(&error.to_string()))?;
        Ok(())
    }
}

fn load_state(path: &Path) -> Option<PersistedUpdaterState> {
    let bytes = fs::read(path).ok()?;
    let state: PersistedUpdaterState = serde_json::from_slice(&bytes).ok()?;
    if state.schema_version != STATE_SCHEMA_VERSION
        || uuid::Uuid::parse_str(&state.installation_id).is_err()
        || state.rollout_bucket >= 10_000
    {
        return None;
    }
    Some(state)
}

fn recover_state(state: &mut PersistedUpdaterState, staging_dir: &Path, current_version: &str) {
    if let Ok(entries) = fs::read_dir(staging_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file()
                && path.extension().and_then(|value| value.to_str()) == Some("partial")
            {
                let _ = fs::remove_file(path);
            }
        }
    }
    state.schema_version = STATE_SCHEMA_VERSION;
    state.progress = None;
    state.retry_attempt = 0;
    match state.phase {
        UpdatePhase::Checking => {
            state.phase = UpdatePhase::CheckFailed;
            state.last_error = Some(interrupted_error(
                "check_interrupted",
                "The previous update check ended when Raven closed.",
                "Check again when the connection is available.",
            ));
        }
        UpdatePhase::Downloading => {
            state.phase = UpdatePhase::DownloadFailed;
            state.verification_status = "not_verified".to_string();
            state.last_error = Some(interrupted_error(
                "download_interrupted",
                "The previous update download did not finish.",
                "Download the update again. Raven did not install a partial file.",
            ));
        }
        UpdatePhase::Installing => {
            state.phase = UpdatePhase::InstallationFailed;
            state.last_error = Some(interrupted_error(
                "installation_interrupted",
                "Raven could not confirm that the previous installation completed.",
                "Check the current version, then retry or use manual recovery.",
            ));
        }
        _ => {}
    }
    if let Some(downloaded) = state.downloaded.clone() {
        let valid = validate_staged_file(staging_dir, &downloaded);
        if !valid {
            let _ = fs::remove_file(staging_dir.join(&downloaded.staging_file));
            state.downloaded = None;
            state.install_on_close = false;
            state.verification_status = "invalid_after_restart".to_string();
            state.phase = UpdatePhase::VerificationFailed;
            state.last_error = Some(interrupted_error(
                "staged_artifact_invalid",
                "The staged update no longer matches its verified size and hash.",
                "Download the update again. The invalid staged file was removed.",
            ));
        } else if matches!(
            state.phase,
            UpdatePhase::Downloaded | UpdatePhase::AwaitingRestart
        ) {
            state.phase = UpdatePhase::AwaitingRestart;
            state.verification_status = "revalidation_required".to_string();
        }
    }
    if let Some(mut pending) = state.pending_installation.clone() {
        if current_version == pending.to_version {
            pending.startup_health_attempts = pending.startup_health_attempts.saturating_add(1);
            if pending.startup_health_attempts > 1 {
                state.phase = UpdatePhase::InstallationFailed;
                state.installation_status = if pending.rollback_attempted {
                    "rollback_startup_failed"
                } else {
                    "startup_failed"
                }
                .to_string();
                state.last_error = Some(interrupted_error(
                    if pending.rollback_attempted {
                        "rollback_startup_failed"
                    } else {
                        "post_update_startup_failed"
                    },
                    if pending.rollback_attempted {
                        "The approved rollback target also failed its early startup health check."
                    } else {
                        "The newly installed Raven version did not pass its early startup health check."
                    },
                    if pending.rollback_attempted {
                        "Use the signed manual recovery installer. Raven will not attempt another automatic rollback."
                    } else {
                        "Raven will request the exact backend-approved rollback target if rollback remains safe."
                    },
                ));
            } else {
                state.phase = UpdatePhase::Idle;
                state.installation_status = "awaiting_startup_health".to_string();
                state.last_error = None;
            }
            state.pending_installation = Some(pending);
            state.install_on_close = false;
        } else if current_version == pending.from_version {
            state.phase = UpdatePhase::InstallationFailed;
            state.installation_status = "not_applied".to_string();
            state.last_error = Some(interrupted_error(
                "installation_not_applied",
                "The requested update did not replace this Raven version.",
                "Retry the update or use the signed manual recovery installer.",
            ));
        }
    }
    state.phase_changed_at_ms = now_ms();
    push_log(
        state,
        "info",
        "state_recovered",
        "Updater state was checked during startup.",
    );
}

fn validate_staged_file(staging_dir: &Path, downloaded: &DownloadedArtifact) -> bool {
    let path = staging_dir.join(&downloaded.staging_file);
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if metadata.len() != downloaded.size {
        return false;
    }
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let Ok(read) = file.read(&mut buffer) else {
            return false;
        };
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(&downloaded.sha256)
}

fn interrupted_error(category: &str, message: &str, action: &str) -> CoarseError {
    CoarseError {
        category: category.to_string(),
        message: message.to_string(),
        action: action.to_string(),
        current_installation_safe: true,
        communication_or_privacy_affected: false,
        retryable: true,
        at_ms: now_ms(),
    }
}

pub fn push_log(state: &mut PersistedUpdaterState, level: &str, event: &str, message: &str) {
    state.logs.push(DiagnosticEntry {
        at_ms: now_ms(),
        level: level.to_string(),
        event: event.to_string(),
        message: redact(message),
    });
    if state.logs.len() > 100 {
        state.logs.drain(..state.logs.len() - 100);
    }
}

pub fn redact(value: &str) -> String {
    let mut redacted = value.to_string();
    let patterns = [
        (
            r"(?i)(authorization|cookie|token|password|secret|access[_-]?key|session[_-]?id)\s*[:=]\s*[^\s,;]+",
            "$1=<redacted>",
        ),
        (r"(?i)https://[^\s?]+\?[^\s]+", "<url-query-redacted>"),
        (r"(?i)[a-z]:\\users\\[^\\\s]+", r"C:\Users\<redacted>"),
        (r"/home/[^/\s]+", "/home/<redacted>"),
        (r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "<ip-redacted>"),
    ];
    for (pattern, replacement) in patterns {
        if let Ok(regex) = Regex::new(pattern) {
            redacted = regex.replace_all(&redacted, replacement).into_owned();
        }
    }
    redacted
}

pub fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unsupported"
    }
}

pub fn architecture() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else {
        "unsupported"
    }
}

pub fn access_for_classification(
    classification: super::model::UpdateClassification,
    reason_code: &str,
    message: &str,
) -> ServiceAccess {
    let mode = match classification {
        super::model::UpdateClassification::Required => AccessMode::Required,
        super::model::UpdateClassification::Blocked => AccessMode::Blocked,
        _ => AccessMode::Allowed,
    };
    ServiceAccess {
        mode,
        reason_code: reason_code.to_string(),
        message: message.to_string(),
    }
}

#[cfg(windows)]
fn metered_connection() -> MeteredConnection {
    use windows::Networking::Connectivity::{NetworkCostType, NetworkInformation};
    let Ok(profile) = NetworkInformation::GetInternetConnectionProfile() else {
        return MeteredConnection::Unknown;
    };
    let Ok(cost) = profile.GetConnectionCost() else {
        return MeteredConnection::Unknown;
    };
    match cost.NetworkCostType() {
        Ok(NetworkCostType::Unrestricted) => MeteredConnection::Unmetered,
        Ok(NetworkCostType::Fixed) | Ok(NetworkCostType::Variable) => MeteredConnection::Metered,
        _ => MeteredConnection::Unknown,
    }
}

#[cfg(not(windows))]
fn metered_connection() -> MeteredConnection {
    MeteredConnection::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redaction_removes_sensitive_headers_paths_queries_and_addresses() {
        let input = "Authorization: Bearer-secret https://updates.test/file?token=value C:\\Users\\alice\\file 192.168.1.4 password=hunter2";
        let output = redact(input);
        assert!(!output.contains("Bearer-secret"));
        assert!(!output.contains("token=value"));
        assert!(!output.contains("alice"));
        assert!(!output.contains("192.168.1.4"));
        assert!(!output.contains("hunter2"));
    }
}
