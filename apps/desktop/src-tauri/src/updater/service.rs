use super::{
    model::{
        now_ms, AccessMode, AvailableUpdate, CompatibilitySummary, DownloadProgress,
        DownloadedArtifact, MeteredBehavior, MeteredConnection, PendingInstallation,
        PersistedUpdaterState, ServerContext, UpdateClassification, UpdatePhase,
        UpdateSettingsPatch, UpdaterSnapshot, ALPHA_CONSENT_VERSION,
    },
    runtime::{
        access_for_classification, architecture, platform, push_log, redact, UpdaterRuntime,
    },
    DECISION_ENDPOINT, DIAGNOSTICS_ENDPOINT, OUTCOMES_ENDPOINT, REVALIDATE_ENDPOINT,
    ROLLBACK_ENDPOINT, UPDATE_ENDPOINT,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    sync::atomic::Ordering,
    time::Duration,
};
use tauri::Emitter;
use tauri_plugin_updater::{Update, UpdaterExt};

const CHECK_ATTEMPTS: u8 = 4;
const DOWNLOAD_ATTEMPTS: u8 = 3;
const CHECK_INTERVAL_MS: u64 = 6 * 60 * 60 * 1000;
const CHECK_JITTER_WINDOW_MS: u64 = 45 * 60 * 1000;
const FAILED_CHECK_INTERVAL_MS: u64 = 60 * 60 * 1000;
const MIN_FREE_SPACE_HEADROOM: u64 = 64 * 1024 * 1024;
const CLIENT_PROTOCOL_VERSION: i32 = 1;

pub async fn check(runtime: UpdaterRuntime, automatic: bool) -> Result<UpdaterSnapshot, String> {
    let Ok(_operation) = runtime.0.operation.try_lock() else {
        return Err("Another update operation is already in progress.".to_string());
    };
    check_locked(&runtime, automatic).await
}

async fn check_locked(
    runtime: &UpdaterRuntime,
    automatic: bool,
) -> Result<UpdaterSnapshot, String> {
    let consent = runtime
        .0
        .state
        .lock()
        .expect("updater state poisoned")
        .settings
        .consent
        .delivery_accepted;
    if !consent {
        return Err("Accept the closed-alpha update delivery terms before Raven contacts the update service.".to_string());
    }
    runtime.mutate(|state| {
        state.phase = UpdatePhase::Checking;
        state.phase_changed_at_ms = now_ms();
        state.last_check_attempt_at_ms = Some(now_ms());
        state.endpoint_status = "checking".to_string();
        state.last_error = None;
        state.retry_attempt = 0;
        push_log(
            state,
            "info",
            if automatic {
                "automatic_check"
            } else {
                "manual_check"
            },
            "Raven started an update check.",
        );
        Ok(())
    })?;

    let next = next_check_at(runtime, CHECK_INTERVAL_MS);
    let mut policy_requires_manifest = false;
    match fetch_policy_decision_with_retry(runtime, CHECK_ATTEMPTS).await {
        Ok(decision) => {
            let disposition = apply_policy_decision(runtime, &decision, next)?;
            if disposition.terminal {
                report_outcome(
                    runtime,
                    "check",
                    "success",
                    "",
                    disposition.release_id.as_deref(),
                )
                .await;
                return Ok(runtime.snapshot());
            }
            policy_requires_manifest = true;
        }
        Err(error) => {
            runtime.mutate(|state| {
                state.endpoint_status = "policy_unreachable_manifest_checking".to_string();
                push_log(
                    state,
                    "warning",
                    "policy_check_failed",
                    &format!(
                        "The JSON policy decision was unavailable; Raven is still checking the signed Tauri manifest endpoint: {}",
                        redact(&error)
                    ),
                );
                Ok(())
            })?;
        }
    }

    let update = match fetch_update_with_retry(runtime, CHECK_ATTEMPTS).await {
        Ok(update) => update,
        Err(error) => {
            let next = now_ms().saturating_add(FAILED_CHECK_INTERVAL_MS);
            let error_phase = match runtime.snapshot().access.mode {
                AccessMode::Blocked => UpdatePhase::BlockedVersion,
                AccessMode::Required | AccessMode::Unsupported => UpdatePhase::UnsupportedVersion,
                AccessMode::Allowed => UpdatePhase::CheckFailed,
            };
            runtime.record_error(
                error_phase,
                check_error_category(&error),
                &error,
                "The current Raven installation remains unchanged. Check the connection and try again.",
                true,
            )?;
            runtime.mutate(|state| {
                state.endpoint_status = "unreachable".to_string();
                state.next_automatic_check_at_ms = Some(next);
                Ok(())
            })?;
            report_outcome(
                runtime,
                "check",
                "failure",
                check_error_category(&error),
                None,
            )
            .await;
            return Ok(runtime.snapshot());
        }
    };

    let Some(update) = update else {
        if policy_requires_manifest {
            let current_access = runtime.snapshot().access;
            let phase = match current_access.mode {
                AccessMode::Blocked => UpdatePhase::BlockedVersion,
                AccessMode::Required | AccessMode::Unsupported => UpdatePhase::UnsupportedVersion,
                AccessMode::Allowed => UpdatePhase::CheckFailed,
            };
            return runtime.record_error(
                phase,
                "manifest_missing",
                "The policy service selected a release, but the signed Tauri manifest endpoint returned no update.",
                "The current safety restriction remains active. Try again after the release manifest is repaired.",
                true,
            );
        }
        let snapshot = runtime.mutate(|state| {
            state.phase = match state.update_access.mode {
                AccessMode::Blocked => UpdatePhase::BlockedVersion,
                AccessMode::Required | AccessMode::Unsupported => UpdatePhase::UnsupportedVersion,
                AccessMode::Allowed => UpdatePhase::Idle,
            };
            state.phase_changed_at_ms = now_ms();
            state.available = None;
            state.endpoint_status = "reachable".to_string();
            state.rollout_eligibility = "no_update".to_string();
            state.last_successful_check_at_ms = Some(now_ms());
            state.next_automatic_check_at_ms = Some(next);
            state.retry_attempt = 0;
            push_log(
                state,
                "info",
                "check_complete",
                "Raven is up to date for this channel and cohort.",
            );
            Ok(())
        })?;
        report_outcome(runtime, "check", "success", "", None).await;
        return Ok(snapshot);
    };

    let metadata = match metadata_from_update(runtime, &update) {
        Ok(metadata) => metadata,
        Err(error) => {
            runtime.record_error(
                UpdatePhase::VerificationFailed,
                "manifest_invalid",
                &error,
                "Raven rejected the update metadata. The current installation remains safe; try again after the release is corrected.",
                false,
            )?;
            runtime.mutate(|state| {
                state.endpoint_status = "invalid_response".to_string();
                state.verification_status = "manifest_invalid".to_string();
                state.next_automatic_check_at_ms = Some(next);
                Ok(())
            })?;
            report_outcome(runtime, "check", "failure", "manifest_invalid", None).await;
            return Ok(runtime.snapshot());
        }
    };
    let phase = phase_for_metadata(&metadata);
    let release_id = metadata.release_id.clone();
    let snapshot = runtime.mutate(|state| {
        state.phase = phase;
        state.phase_changed_at_ms = now_ms();
        state.endpoint_status = "reachable".to_string();
        state.rollout_eligibility = if metadata.eligible {
            "eligible".to_string()
        } else {
            "not_eligible".to_string()
        };
        state.last_successful_check_at_ms = Some(now_ms());
        state.next_automatic_check_at_ms = Some(next);
        state.retry_attempt = 0;
        state.update_access = access_for_classification(
            metadata.classification,
            &metadata.reason_code,
            &metadata.message,
        );
        state.available = Some(metadata);
        state.last_error = None;
        push_log(
            state,
            "info",
            "update_available",
            "The update service returned a signed update.",
        );
        Ok(())
    })?;
    report_outcome(runtime, "check", "success", "", Some(&release_id)).await;
    Ok(snapshot)
}

pub async fn download(
    runtime: UpdaterRuntime,
    user_approved_metered: bool,
) -> Result<UpdaterSnapshot, String> {
    let Ok(_operation) = runtime.0.operation.try_lock() else {
        return Err("Another update operation is already in progress.".to_string());
    };
    download_locked(&runtime, user_approved_metered).await
}

async fn download_locked(
    runtime: &UpdaterRuntime,
    user_approved_metered: bool,
) -> Result<UpdaterSnapshot, String> {
    let snapshot = runtime.snapshot();
    let available = snapshot
        .available
        .clone()
        .ok_or_else(|| "No update is available to download.".to_string())?;
    if matches!(
        snapshot.phase,
        UpdatePhase::Paused | UpdatePhase::BlockedVersion | UpdatePhase::UnsupportedVersion
    ) && available.classification != UpdateClassification::Blocked
    {
        return Err("This release is not currently available for download.".to_string());
    }
    if snapshot.metered_connection == MeteredConnection::Metered
        && snapshot.settings.metered_behavior != MeteredBehavior::Allow
        && !user_approved_metered
    {
        return Err(format!(
            "This connection is metered. Confirm the {} byte download before continuing.",
            available.size
        ));
    }
    if snapshot.metered_connection == MeteredConnection::Metered
        && snapshot.settings.metered_behavior == MeteredBehavior::Never
        && !user_approved_metered
    {
        return Err("Automatic update downloads are disabled on metered connections.".to_string());
    }
    let free_space =
        fs2::available_space(&runtime.0.staging_dir).map_err(|error| redact(&error.to_string()))?;
    let required_space = available.size.saturating_add(MIN_FREE_SPACE_HEADROOM);
    if free_space < required_space {
        return runtime.record_error(
            UpdatePhase::DownloadFailed,
            "insufficient_disk_space",
            "There is not enough free space to stage this update safely.",
            "Free disk space, then download again. No installer was changed.",
            true,
        );
    }
    runtime.mutate(|state| {
        state.phase = UpdatePhase::Downloading;
        state.phase_changed_at_ms = now_ms();
        state.progress = Some(DownloadProgress {
            downloaded: 0,
            total: Some(available.size),
            percent: Some(0),
        });
        state.verification_status = "pending".to_string();
        state.last_error = None;
        state.retry_attempt = 0;
        push_log(
            state,
            "info",
            "download_started",
            "Raven started downloading the signed update bundle.",
        );
        Ok(())
    })?;

    let mut last_error = String::new();
    let mut verified: Option<(Update, Vec<u8>)> = None;
    for attempt in 0..DOWNLOAD_ATTEMPTS {
        runtime.mutate(|state| {
            state.retry_attempt = attempt;
            Ok(())
        })?;
        let update = match fetch_matching_update(runtime, &available).await {
            Ok(update) => update,
            Err(error) => {
                last_error = error;
                if attempt + 1 < DOWNLOAD_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis(retry_delay_ms(
                        attempt,
                        runtime.snapshot().rollout_bucket,
                    )))
                    .await;
                }
                continue;
            }
        };
        let progress_runtime = runtime.clone();
        let mut downloaded = 0_u64;
        let mut last_emitted_percent = 0_u8;
        let result = update
            .download(
                move |chunk, total| {
                    downloaded = downloaded.saturating_add(chunk as u64);
                    let total = total.or(Some(available.size));
                    let percent = total
                        .filter(|value| *value > 0)
                        .map(|value| ((downloaded.saturating_mul(100) / value).min(100)) as u8);
                    let should_emit = percent
                        .map(|value| value >= last_emitted_percent.saturating_add(1))
                        .unwrap_or(true);
                    {
                        let mut state = progress_runtime
                            .0
                            .state
                            .lock()
                            .expect("updater state poisoned");
                        state.progress = Some(DownloadProgress {
                            downloaded,
                            total,
                            percent,
                        });
                    }
                    if should_emit {
                        last_emitted_percent = percent.unwrap_or(last_emitted_percent);
                        let _ = progress_runtime
                            .0
                            .app
                            .emit("raven-updater-state", progress_runtime.snapshot());
                    }
                },
                || {},
            )
            .await;
        match result {
            Ok(bytes) => {
                verified = Some((update, bytes));
                break;
            }
            Err(error) => {
                let verification = is_signature_error(&error);
                last_error = redact(&error.to_string());
                if verification {
                    break;
                }
                if attempt + 1 < DOWNLOAD_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis(retry_delay_ms(
                        attempt,
                        runtime.snapshot().rollout_bucket,
                    )))
                    .await;
                }
            }
        }
    }
    let Some((_update, bytes)) = verified else {
        let verification = last_error.to_ascii_lowercase().contains("signature")
            || last_error.to_ascii_lowercase().contains("minisign")
            || last_error.to_ascii_lowercase().contains("base64");
        let phase = if verification {
            UpdatePhase::VerificationFailed
        } else {
            UpdatePhase::DownloadFailed
        };
        let category = if verification {
            "signature_invalid"
        } else {
            "download_failed"
        };
        let snapshot = runtime.record_error(
            phase,
            category,
            &last_error,
            if verification {
                "Raven rejected the bundle and did not install it. Wait for a corrected signed release."
            } else {
                "The current installation remains unchanged. Check the connection and try the download again."
            },
            !verification,
        )?;
        report_outcome(
            runtime,
            "download",
            "failure",
            category,
            Some(&available.release_id),
        )
        .await;
        return Ok(snapshot);
    };
    let actual_size = bytes.len() as u64;
    let actual_hash = format!("{:x}", Sha256::digest(&bytes));
    if actual_size != available.size || !actual_hash.eq_ignore_ascii_case(&available.sha256) {
        let snapshot = runtime.record_error(
            UpdatePhase::VerificationFailed,
            if actual_size != available.size { "size_mismatch" } else { "hash_mismatch" },
            "The downloaded update does not match the release size and SHA-256 metadata.",
            "Raven removed the invalid bundle. Wait for a corrected signed release, then download again.",
            false,
        )?;
        report_outcome(
            runtime,
            "verification",
            "failure",
            if actual_size != available.size {
                "size_mismatch"
            } else {
                "hash_mismatch"
            },
            Some(&available.release_id),
        )
        .await;
        return Ok(snapshot);
    }
    let file_name = staging_file_name(&available.release_id, &available.version);
    let path = runtime.staging_path(&file_name)?;
    let temp_path = path.with_extension("partial");
    {
        let mut file = File::create(&temp_path).map_err(|error| redact(&error.to_string()))?;
        file.write_all(&bytes)
            .map_err(|error| redact(&error.to_string()))?;
        file.sync_all()
            .map_err(|error| redact(&error.to_string()))?;
    }
    if path.exists() {
        fs::remove_file(&path).map_err(|error| redact(&error.to_string()))?;
    }
    fs::rename(&temp_path, &path).map_err(|error| redact(&error.to_string()))?;
    remove_other_staged_files(runtime, &file_name);
    let downloaded = DownloadedArtifact {
        release_id: available.release_id.clone(),
        version: available.version.clone(),
        staging_file: file_name,
        size: actual_size,
        sha256: actual_hash,
        verified_at_ms: now_ms(),
    };
    runtime.set_verified_release(Some(available.release_id.clone()));
    runtime.mutate(|state| {
        state.phase = UpdatePhase::Downloaded;
        state.phase_changed_at_ms = now_ms();
        state.downloaded = Some(downloaded);
        state.progress = None;
        state.verification_status = "verified_signature_size_hash".to_string();
        state.retry_attempt = 0;
        push_log(
            state,
            "info",
            "verification_succeeded",
            "The update signature, size, and SHA-256 hash were verified.",
        );
        Ok(())
    })?;
    let snapshot = runtime.transition(UpdatePhase::AwaitingRestart)?;
    report_outcome(
        runtime,
        "download",
        "success",
        "",
        Some(&available.release_id),
    )
    .await;
    report_outcome(
        runtime,
        "verification",
        "success",
        "",
        Some(&available.release_id),
    )
    .await;
    Ok(snapshot)
}

pub fn schedule_install_on_close(
    runtime: &UpdaterRuntime,
    enabled: bool,
) -> Result<UpdaterSnapshot, String> {
    runtime.mutate(|state| {
        if enabled && state.downloaded.is_none() {
            return Err(
                "Download and verify the update before scheduling installation.".to_string(),
            );
        }
        state.install_on_close = enabled;
        if enabled && state.phase == UpdatePhase::AwaitingRestart {
            state.phase = UpdatePhase::Deferred;
            state.phase_changed_at_ms = now_ms();
        } else if !enabled && state.phase == UpdatePhase::Deferred && state.downloaded.is_some() {
            state.phase = UpdatePhase::AwaitingRestart;
            state.phase_changed_at_ms = now_ms();
        }
        push_log(
            state,
            "info",
            "install_on_close_changed",
            if enabled {
                "The verified update will install after a normal Raven close."
            } else {
                "Installation on close was cancelled."
            },
        );
        Ok(())
    })
}

pub async fn install_now(runtime: UpdaterRuntime) -> Result<UpdaterSnapshot, String> {
    if runtime.0.active_session.load(Ordering::SeqCst) {
        return runtime.mutate(|state| {
            state.phase = UpdatePhase::Deferred;
            state.phase_changed_at_ms = now_ms();
            push_log(
                state,
                "info",
                "restart_deferred",
                "Restart was deferred because Raven is in an active communication or device operation.",
            );
            Ok(())
        });
    }
    install(runtime, false).await
}

pub async fn install_on_exit(runtime: UpdaterRuntime) -> Result<UpdaterSnapshot, String> {
    install(runtime, true).await
}

pub async fn attempt_rollback(runtime: UpdaterRuntime) -> Result<UpdaterSnapshot, String> {
    let Ok(_operation) = runtime.0.operation.try_lock() else {
        return Err("Another update operation is already in progress.".to_string());
    };
    if runtime.0.active_session.load(Ordering::SeqCst) {
        return Err("Raven will not roll back during an active communication session.".to_string());
    }
    let snapshot = runtime.snapshot();
    if !matches!(
        snapshot.installation_status.as_str(),
        "startup_failed" | "rollback_refused"
    ) {
        return Err(
            "Automatic rollback is available only after a failed early startup health check."
                .to_string(),
        );
    }
    let pending = runtime
        .0
        .state
        .lock()
        .expect("updater state poisoned")
        .pending_installation
        .clone()
        .ok_or_else(|| "The failed installation record is missing.".to_string())?;
    if pending.rollback_attempted
        || !pending.rollback_safe
        || !pending.local_migration_reversible
        || pending.approved_rollback_release_id.is_none()
    {
        return rollback_refused(
            &runtime,
            "Local migration state or release policy does not permit an automatic rollback.",
        );
    }
    let decision = match request_rollback_decision(&runtime, &pending).await {
        Ok(decision) => decision,
        Err(error) => return rollback_refused(&runtime, &error),
    };
    let target = match rollback_target_from_decision(&runtime, &pending, &decision) {
        Ok(target) => target,
        Err(error) => return rollback_refused(&runtime, &error),
    };
    runtime.mutate(|state| {
        state.phase = UpdatePhase::Downloading;
        state.phase_changed_at_ms = now_ms();
        state.progress = Some(DownloadProgress {
            downloaded: 0,
            total: Some(target.size),
            percent: Some(0),
        });
        state.verification_status = "rollback_signature_pending".to_string();
        state.installation_status = "rollback_downloading".to_string();
        push_log(
            state,
            "warning",
            "rollback_started",
            "Raven is restoring the exact backend-approved signed rollback target after a failed startup health check.",
        );
        Ok(())
    })?;
    let mut verified = None;
    let mut last_error = String::new();
    for attempt in 0..DOWNLOAD_ATTEMPTS {
        let update = match fetch_rollback_update(&runtime, &pending.release_id, &target).await {
            Ok(update) => update,
            Err(error) => {
                last_error = error;
                if attempt + 1 < DOWNLOAD_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis(retry_delay_ms(
                        attempt,
                        snapshot.rollout_bucket,
                    )))
                    .await;
                }
                continue;
            }
        };
        let progress_runtime = runtime.clone();
        let expected_size = target.size;
        let mut downloaded = 0_u64;
        match update
            .download(
                move |chunk, total| {
                    downloaded = downloaded.saturating_add(chunk as u64);
                    let total = total.or(Some(expected_size));
                    let percent = total
                        .filter(|value| *value > 0)
                        .map(|value| ((downloaded.saturating_mul(100) / value).min(100)) as u8);
                    {
                        let mut state = progress_runtime
                            .0
                            .state
                            .lock()
                            .expect("updater state poisoned");
                        state.progress = Some(DownloadProgress {
                            downloaded,
                            total,
                            percent,
                        });
                    }
                    let _ = progress_runtime
                        .0
                        .app
                        .emit("raven-updater-state", progress_runtime.snapshot());
                },
                || {},
            )
            .await
        {
            Ok(bytes) => {
                verified = Some(bytes);
                break;
            }
            Err(error) => {
                last_error = redact(&error.to_string());
                if is_signature_error(&error) {
                    break;
                }
                if attempt + 1 < DOWNLOAD_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis(retry_delay_ms(
                        attempt,
                        snapshot.rollout_bucket,
                    )))
                    .await;
                }
            }
        }
    }
    let Some(bytes) = verified else {
        return rollback_refused(
            &runtime,
            &format!("The approved rollback bundle could not be verified: {last_error}"),
        );
    };
    let actual_hash = format!("{:x}", Sha256::digest(&bytes));
    if bytes.len() as u64 != target.size || !actual_hash.eq_ignore_ascii_case(&target.sha256) {
        return rollback_refused(
            &runtime,
            "The signed rollback bundle did not match its backend-approved size and SHA-256 hash.",
        );
    }
    let second_decision = match request_rollback_decision(&runtime, &pending).await {
        Ok(decision) => decision,
        Err(error) => return rollback_refused(&runtime, &error),
    };
    let second_target = match rollback_target_from_decision(&runtime, &pending, &second_decision) {
        Ok(target) => target,
        Err(error) => return rollback_refused(&runtime, &error),
    };
    if second_target.release_id != target.release_id
        || second_target.version != target.version
        || second_target.size != target.size
        || !second_target.sha256.eq_ignore_ascii_case(&target.sha256)
    {
        return rollback_refused(
            &runtime,
            "The approved rollback decision changed before installation.",
        );
    }
    let update = match fetch_rollback_update(&runtime, &pending.release_id, &target).await {
        Ok(update) => update,
        Err(error) => return rollback_refused(&runtime, &error),
    };
    let file_name = staging_file_name(&target.release_id, &target.version);
    let path = runtime.staging_path(&file_name)?;
    let mut file = File::create(&path).map_err(|error| redact(&error.to_string()))?;
    file.write_all(&bytes)
        .map_err(|error| redact(&error.to_string()))?;
    file.sync_all()
        .map_err(|error| redact(&error.to_string()))?;
    runtime.set_verified_release(Some(target.release_id.clone()));
    runtime.mutate(|state| {
        state.phase = UpdatePhase::Installing;
        state.phase_changed_at_ms = now_ms();
        state.progress = None;
        state.verification_status = "rollback_signature_size_hash_verified".to_string();
        state.installation_status = "rolling_back".to_string();
        state.downloaded = Some(DownloadedArtifact {
            release_id: target.release_id.clone(),
            version: target.version.clone(),
            staging_file: file_name,
            size: target.size,
            sha256: actual_hash,
            verified_at_ms: now_ms(),
        });
        state.available = Some(target.clone());
        state.pending_installation = Some(PendingInstallation {
            release_id: target.release_id.clone(),
            from_version: runtime.0.current_version.clone(),
            to_version: target.version.clone(),
            attempted_at_ms: now_ms(),
            local_data_schema_version: target.local_data_schema_version,
            local_migration_reversible: false,
            rollback_safe: false,
            approved_rollback_release_id: None,
            startup_health_attempts: 0,
            rollback_attempted: true,
        });
        push_log(
            state,
            "warning",
            "rollback_installing",
            "The approved rollback bundle passed signature, size, hash, block, protocol, and migration checks.",
        );
        Ok(())
    })?;
    crate::stop_api_sidecar(&runtime.0.app);
    match update.install(bytes) {
        Ok(()) => {
            runtime
                .0
                .allow_exit_after_install
                .store(true, Ordering::SeqCst);
            if cfg!(target_os = "linux") {
                runtime.0.app.restart();
            }
            Ok(runtime.snapshot())
        }
        Err(error) => {
            if crate::should_start_api_sidecar() {
                let _ = crate::start_api_sidecar(&runtime.0.app);
            }
            let snapshot = runtime.record_error(
                UpdatePhase::InstallationFailed,
                "rollback_installer_failed",
                &error.to_string(),
                "The failed Raven version remains installed. Use the signed manual recovery installer.",
                false,
            )?;
            report_outcome(
                &runtime,
                "rollback",
                "failure",
                "rollback_installer_failed",
                Some(&target.release_id),
            )
            .await;
            Ok(snapshot)
        }
    }
}

fn rollback_refused(runtime: &UpdaterRuntime, message: &str) -> Result<UpdaterSnapshot, String> {
    runtime.mutate(|state| {
        state.phase = UpdatePhase::InstallationFailed;
        state.phase_changed_at_ms = now_ms();
        state.installation_status = "rollback_refused".to_string();
        state.last_error = Some(super::model::CoarseError {
            category: "rollback_refused".to_string(),
            message: redact(message),
            action: "Use the exact signed manual recovery installer or wait for a forward repair. Raven will not install an unapproved or incompatible predecessor.".to_string(),
            current_installation_safe: false,
            communication_or_privacy_affected: false,
            retryable: true,
            at_ms: now_ms(),
        });
        push_log(state, "error", "rollback_refused", message);
        Ok(())
    })
}

async fn request_rollback_decision(
    runtime: &UpdaterRuntime,
    pending: &PendingInstallation,
) -> Result<Value, String> {
    if !safe_identifier(&pending.release_id) {
        return Err("The failed release identifier is invalid.".to_string());
    }
    let state = runtime
        .0
        .state
        .lock()
        .expect("updater state poisoned")
        .clone();
    let response = reqwest::Client::new()
        .post(format!(
            "{}/{}/rollback",
            ROLLBACK_ENDPOINT, pending.release_id
        ))
        .timeout(Duration::from_secs(20))
        .json(&client_context(runtime, &state))
        .send()
        .await
        .map_err(|error| redact(&error.to_string()))?;
    if !response.status().is_success() {
        return Err(format!(
            "The rollback policy service returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    response
        .json()
        .await
        .map_err(|error| redact(&error.to_string()))
}

fn rollback_target_from_decision(
    runtime: &UpdaterRuntime,
    pending: &PendingInstallation,
    decision: &Value,
) -> Result<AvailableUpdate, String> {
    if string_at(decision, &["decision"]).as_deref() != Some("rollback_available")
        || bool_at(decision, &["eligible"]) != Some(true)
    {
        return Err(string_at(decision, &["message"])
            .unwrap_or_else(|| "The backend refused automatic rollback.".to_string()));
    }
    let release_id = string_at(decision, &["release.id"])
        .ok_or_else(|| "The rollback decision is missing its target release.".to_string())?;
    if Some(release_id.as_str()) != pending.approved_rollback_release_id.as_deref() {
        return Err(
            "The backend response does not match the locally persisted approved rollback target."
                .to_string(),
        );
    }
    let version = string_at(decision, &["release.version"])
        .ok_or_else(|| "The rollback target version is missing.".to_string())?;
    let current = semver::Version::parse(&runtime.0.current_version)
        .map_err(|_| "The current Raven version is not valid semantic version data.".to_string())?;
    let target_version = semver::Version::parse(&version)
        .map_err(|_| "The rollback target is not a valid semantic version.".to_string())?;
    if target_version >= current {
        return Err("The approved rollback target is not an older Raven version.".to_string());
    }
    let compatibility: CompatibilitySummary = value_at(decision, "compatibility")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    if !matches!(compatibility.status.as_str(), "compatible" | "grace_period") {
        return Err("The approved rollback target is no longer protocol-compatible.".to_string());
    }
    let local_schema = u64_at(decision, &["release.localDataSchemaVersion"])
        .unwrap_or_default()
        .min(i32::MAX as u64) as i32;
    if local_schema > pending.local_data_schema_version {
        return Err("The approved rollback target requires a newer local data schema than the failed release.".to_string());
    }
    let size = u64_at(decision, &["artifact.size"])
        .ok_or_else(|| "The rollback artifact size is missing.".to_string())?;
    let sha256 = string_at(decision, &["artifact.sha256"])
        .ok_or_else(|| "The rollback artifact SHA-256 hash is missing.".to_string())?;
    if size == 0
        || sha256.len() != 64
        || !sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("The rollback artifact integrity metadata is invalid.".to_string());
    }
    Ok(AvailableUpdate {
        release_id,
        version,
        notes: string_at(decision, &["release.notes"]).unwrap_or_default(),
        published_at: string_at(decision, &["release.publishedAt", "release.createdAt"]),
        classification: UpdateClassification::Recommended,
        size,
        sha256,
        signature_present: string_at(decision, &["artifact.signature"])
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false),
        eligible: true,
        rollout_bucket: u64_at(decision, &["rolloutBucket"])
            .unwrap_or(runtime.snapshot().rollout_bucket.into())
            .min(9_999) as u16,
        decision: "rollback_available".to_string(),
        reason_code: string_at(decision, &["reasonCode"]).unwrap_or_default(),
        message: string_at(decision, &["message"]).unwrap_or_default(),
        compatibility,
        local_data_schema_version: local_schema,
        local_migration_reversible: bool_at(decision, &["release.localMigrationReversible"])
            .unwrap_or(false),
        rollback_safe: bool_at(decision, &["release.rollbackSafe"]).unwrap_or(false),
        approved_rollback_release_id: string_at(decision, &["release.approvedRollbackReleaseId"]),
    })
}

async fn fetch_rollback_update(
    runtime: &UpdaterRuntime,
    source_release_id: &str,
    expected: &AvailableUpdate,
) -> Result<Update, String> {
    if !safe_identifier(source_release_id) {
        return Err("The failed release identifier is invalid.".to_string());
    }
    let endpoint = format!(
        "{}/{}/rollback-check/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}",
        ROLLBACK_ENDPOINT, source_release_id
    );
    let update = build_updater_at(runtime, &endpoint, true)?
        .check()
        .await
        .map_err(|error| redact(&error.to_string()))?
        .ok_or_else(|| "The backend no longer approves this rollback target.".to_string())?;
    let metadata = metadata_from_update(runtime, &update)?;
    if metadata.release_id != expected.release_id
        || metadata.version != expected.version
        || metadata.size != expected.size
        || !metadata.sha256.eq_ignore_ascii_case(&expected.sha256)
        || metadata.decision != "rollback_available"
    {
        return Err(
            "The signed rollback manifest does not match the approved rollback decision."
                .to_string(),
        );
    }
    Ok(update)
}

async fn install(runtime: UpdaterRuntime, closing: bool) -> Result<UpdaterSnapshot, String> {
    let Ok(_operation) = runtime.0.operation.try_lock() else {
        return Err("Another update operation is already in progress.".to_string());
    };
    let mut snapshot = runtime.snapshot();
    let downloaded = snapshot
        .downloaded
        .clone()
        .ok_or_else(|| "No verified update is staged for installation.".to_string())?;
    let available = snapshot
        .available
        .clone()
        .ok_or_else(|| "The staged update no longer has release metadata.".to_string())?;
    if downloaded.release_id != available.release_id || downloaded.version != available.version {
        return Err("The staged update does not match the current release decision.".to_string());
    }
    match revalidate_release(&runtime, &available).await {
        Ok(()) => {}
        Err(error) => {
            let snapshot = runtime.record_error(
                UpdatePhase::InstallationFailed,
                "revalidation_failed",
                &error,
                "Raven did not install the staged bundle. Check for updates again before retrying.",
                true,
            )?;
            report_outcome(
                &runtime,
                "installation",
                "failure",
                "revalidation_failed",
                Some(&available.release_id),
            )
            .await;
            return Ok(snapshot);
        }
    }
    if !snapshot.verified_in_current_process {
        snapshot = download_locked(&runtime, true).await?;
        if !snapshot.verified_in_current_process {
            return Err("Raven could not re-verify the staged update in this process.".to_string());
        }
    }
    let available = snapshot
        .available
        .clone()
        .ok_or_else(|| "The release metadata disappeared during re-verification.".to_string())?;
    let downloaded = snapshot
        .downloaded
        .clone()
        .ok_or_else(|| "The re-verified update was not staged.".to_string())?;
    let update = fetch_matching_update(&runtime, &available)
        .await
        .map_err(|error| {
            format!(
                "The release changed before installation: {}",
                redact(&error)
            )
        })?;
    let bytes = read_and_validate_staged(&runtime, &downloaded)?;
    runtime.mutate(|state| {
        state.phase = UpdatePhase::Installing;
        state.phase_changed_at_ms = now_ms();
        state.installation_status = "installing".to_string();
        state.install_on_close = false;
        state.pending_installation = Some(PendingInstallation {
            release_id: available.release_id.clone(),
            from_version: runtime.0.current_version.clone(),
            to_version: available.version.clone(),
            attempted_at_ms: now_ms(),
            local_data_schema_version: available.local_data_schema_version,
            local_migration_reversible: available.local_migration_reversible,
            rollback_safe: available.rollback_safe,
            approved_rollback_release_id: available.approved_rollback_release_id.clone(),
            startup_health_attempts: 0,
            rollback_attempted: false,
        });
        push_log(
            state,
            "info",
            "installation_started",
            "Raven started the verified updater installer.",
        );
        Ok(())
    })?;
    crate::stop_api_sidecar(&runtime.0.app);
    match update.install(bytes) {
        Ok(()) => {
            runtime
                .0
                .allow_exit_after_install
                .store(true, Ordering::SeqCst);
            if cfg!(target_os = "linux") {
                runtime.0.app.restart();
            }
            Ok(runtime.snapshot())
        }
        Err(error) => {
            if !closing && crate::should_start_api_sidecar() {
                let _ = crate::start_api_sidecar(&runtime.0.app);
            }
            let snapshot = runtime.record_error(
                UpdatePhase::InstallationFailed,
                "installer_failed",
                &error.to_string(),
                "The current Raven installation remains in place. Retry or use the signed manual recovery installer.",
                true,
            )?;
            report_outcome(
                &runtime,
                "installation",
                "failure",
                "installer_failed",
                Some(&available.release_id),
            )
            .await;
            if closing {
                runtime
                    .0
                    .close_install_in_progress
                    .store(false, Ordering::SeqCst);
            }
            Ok(snapshot)
        }
    }
}

pub async fn update_settings(
    runtime: UpdaterRuntime,
    patch: UpdateSettingsPatch,
) -> Result<UpdaterSnapshot, String> {
    let withdrawing_delivery_consent = {
        let state = runtime.0.state.lock().expect("updater state poisoned");
        patch.delivery_accepted == Some(false) && state.settings.consent.delivery_accepted
    };
    let withdrawal_completed = if withdrawing_delivery_consent {
        let mut proposed = runtime
            .0
            .state
            .lock()
            .expect("updater state poisoned")
            .clone();
        proposed.settings.consent.delivery_accepted = false;
        proposed.settings.consent.delivery_consent_version.clear();
        fetch_policy_decision_for_state(&runtime, &proposed)
            .await
            .is_ok()
    } else {
        false
    };
    let channel_or_cohort_changed = {
        let state = runtime.0.state.lock().expect("updater state poisoned");
        patch
            .channel
            .map(|value| value != state.settings.channel)
            .unwrap_or(false)
            || patch
                .cohort
                .map(|value| value != state.settings.cohort)
                .unwrap_or(false)
    };
    if channel_or_cohort_changed {
        let mut proposed = runtime
            .0
            .state
            .lock()
            .expect("updater state poisoned")
            .clone();
        if let Some(channel) = patch.channel {
            proposed.settings.channel = channel;
        }
        if let Some(cohort) = patch.cohort {
            proposed.settings.cohort = cohort;
        }
        if proposed.settings.consent.delivery_accepted {
            let decision = fetch_policy_decision_for_state(&runtime, &proposed).await?;
            validate_channel_transition(&decision)?;
        }
    }
    let mut stale_file = None;
    let snapshot = runtime.mutate(|state| {
        if let Some(channel) = patch.channel {
            state.settings.channel = channel;
            state.available = None;
            state.update_access = Default::default();
            state.phase = UpdatePhase::Idle;
            state.phase_changed_at_ms = now_ms();
            state.next_automatic_check_at_ms = Some(now_ms());
        }
        if let Some(cohort) = patch.cohort {
            state.settings.cohort = cohort;
            state.available = None;
            state.update_access = Default::default();
            state.phase = UpdatePhase::Idle;
            state.phase_changed_at_ms = now_ms();
            state.next_automatic_check_at_ms = Some(now_ms());
        }
        if let Some(value) = patch.automatic_download {
            state.settings.automatic_download = value;
        }
        if let Some(value) = patch.metered_behavior {
            state.settings.metered_behavior = value;
        }
        if let Some(value) = patch.aggregate_outcomes {
            state.settings.consent.aggregate_outcomes = value;
        }
        if let Some(value) = patch.detailed_diagnostics {
            state.settings.consent.detailed_diagnostics = value;
        }
        if let Some(accepted) = patch.delivery_accepted {
            state.settings.consent.delivery_accepted = accepted;
            if accepted {
                state.settings.consent.delivery_consent_version = ALPHA_CONSENT_VERSION.to_string();
                state.settings.consent.delivery_accepted_at_ms = Some(now_ms());
            } else {
                state.settings.consent.delivery_consent_version.clear();
                state.settings.consent.delivery_accepted_at_ms = None;
                state.settings.consent.aggregate_outcomes = false;
                state.settings.consent.detailed_diagnostics = false;
                state.next_automatic_check_at_ms = None;
                state.install_on_close = false;
                stale_file = state
                    .downloaded
                    .as_ref()
                    .map(|value| value.staging_file.clone());
                state.downloaded = None;
                state.available = None;
                state.progress = None;
                state.phase = if state.update_access.mode > Default::default() {
                    state.phase
                } else {
                    UpdatePhase::Idle
                };
                state.phase_changed_at_ms = now_ms();
                state.verification_status = "not_checked".to_string();
                if withdrawing_delivery_consent {
                    state.endpoint_status = if withdrawal_completed {
                        "consent_withdrawn".to_string()
                    } else {
                        "consent_withdrawal_pending".to_string()
                    };
                    state.next_automatic_check_at_ms = if withdrawal_completed {
                        None
                    } else {
                        Some(now_ms().saturating_add(CHECK_INTERVAL_MS))
                    };
                }
            }
        }
        push_log(
            state,
            "info",
            "settings_changed",
            "Local updater settings changed.",
        );
        Ok(())
    })?;
    if let Some(file_name) = stale_file {
        if let Ok(path) = runtime.staging_path(&file_name) {
            let _ = fs::remove_file(path);
        }
        runtime.set_verified_release(None);
    }
    Ok(snapshot)
}

pub fn set_server_context(
    runtime: &UpdaterRuntime,
    context: ServerContext,
) -> Result<UpdaterSnapshot, String> {
    runtime.mutate(|state| {
        state.server_context = context;
        push_log(
            state,
            "info",
            "compatibility_updated",
            "The selected Raven server compatibility response was applied.",
        );
        Ok(())
    })
}

pub fn mark_startup_healthy(runtime: &UpdaterRuntime) -> Result<UpdaterSnapshot, String> {
    let pending = {
        let state = runtime.0.state.lock().expect("updater state poisoned");
        if state.installation_status == "awaiting_startup_health" {
            state.pending_installation.clone()
        } else {
            None
        }
    };
    let snapshot = runtime.mutate(|state| {
        if state.installation_status == "awaiting_startup_health" {
            state.installation_status = "healthy".to_string();
            state.pending_installation = None;
            state.downloaded = None;
            state.available = None;
            state.verification_status = "not_checked".to_string();
            state.phase = UpdatePhase::Idle;
            state.phase_changed_at_ms = now_ms();
            push_log(
                state,
                "info",
                "startup_healthy",
                "The updated Raven process passed its startup health window.",
            );
        }
        Ok(())
    })?;
    if let Some(pending) = pending {
        let runtime = runtime.clone();
        tauri::async_runtime::spawn(async move {
            let stage = if pending.rollback_attempted {
                "rollback"
            } else {
                "installation"
            };
            report_outcome(&runtime, stage, "success", "", Some(&pending.release_id)).await;
        });
    }
    Ok(snapshot)
}

pub fn redacted_report(runtime: &UpdaterRuntime) -> Result<String, String> {
    let snapshot = runtime.snapshot();
    let report = json!({
        "schemaVersion": snapshot.schema_version,
        "currentVersion": snapshot.current_version,
        "channel": snapshot.settings.channel,
        "cohort": snapshot.settings.cohort,
        "rolloutBucket": snapshot.rollout_bucket,
        "platform": snapshot.platform,
        "architecture": snapshot.architecture,
        "phase": snapshot.phase,
        "lastSuccessfulCheckAtMs": snapshot.last_successful_check_at_ms,
        "endpointStatus": snapshot.endpoint_status,
        "rolloutEligibility": snapshot.rollout_eligibility,
        "availableVersion": snapshot.available.as_ref().map(|value| value.version.clone()),
        "downloadedVersion": snapshot.downloaded.as_ref().map(|value| value.version.clone()),
        "artifactSize": snapshot.available.as_ref().map(|value| value.size),
        "artifactSha256": snapshot.available.as_ref().map(|value| value.sha256.clone()),
        "signaturePresent": snapshot.available.as_ref().map(|value| value.signature_present),
        "verificationStatus": snapshot.verification_status,
        "installationStatus": snapshot.installation_status,
        "compatibility": snapshot.compatibility,
        "access": snapshot.access,
        "lastError": snapshot.last_error,
        "logs": snapshot.logs,
        "detailConsent": snapshot.settings.consent.detailed_diagnostics,
    });
    serde_json::to_string_pretty(&report).map_err(|error| redact(&error.to_string()))
}

pub async fn share_diagnostics(runtime: UpdaterRuntime) -> Result<UpdaterSnapshot, String> {
    let Ok(_operation) = runtime.0.operation.try_lock() else {
        return Err("Another update operation is already in progress.".to_string());
    };
    let snapshot = runtime.snapshot();
    if !snapshot.settings.consent.detailed_diagnostics {
        return Err(
            "Enable detailed update diagnostics sharing before sending a report.".to_string(),
        );
    }
    let payload: Value = serde_json::from_str(&redacted_report(&runtime)?)
        .map_err(|error| redact(&error.to_string()))?;
    let release_id = snapshot
        .available
        .as_ref()
        .map(|release| release.release_id.clone())
        .unwrap_or_default();
    let response = reqwest::Client::new()
        .post(DIAGNOSTICS_ENDPOINT)
        .timeout(Duration::from_secs(20))
        .json(&json!({
            "consent": true,
            "releaseId": release_id,
            "payload": payload,
        }))
        .send()
        .await
        .map_err(|error| redact(&error.to_string()))?;
    if !response.status().is_success() {
        return Err(format!(
            "The diagnostics service returned HTTP {}. Nothing else was shared.",
            response.status().as_u16()
        ));
    }
    runtime.record_log(
        "info",
        "diagnostics_shared",
        "A redacted update diagnostics report was shared with explicit consent.",
    )?;
    Ok(runtime.snapshot())
}

pub fn start_background_tasks(runtime: UpdaterRuntime) {
    let rollback = runtime.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        if rollback.snapshot().installation_status == "startup_failed" {
            report_outcome(
                &rollback,
                "startup",
                "failure",
                "early_startup_failed",
                None,
            )
            .await;
            let _ = attempt_rollback(rollback).await;
        }
    });
    let startup = runtime.clone();
    tauri::async_runtime::spawn(async move {
        let startup_snapshot = startup.snapshot();
        if startup_snapshot.endpoint_status == "consent_withdrawal_pending"
            && startup_snapshot
                .next_automatic_check_at_ms
                .map(|next| now_ms() >= next)
                .unwrap_or(true)
        {
            let _ = retry_consent_withdrawal(&startup).await;
        }
        tokio::time::sleep(Duration::from_secs(8)).await;
        run_automatic_cycle(startup).await;
    });
    let periodic = runtime.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15 * 60)).await;
            let snapshot = periodic.snapshot();
            if snapshot.endpoint_status == "consent_withdrawal_pending"
                && snapshot
                    .next_automatic_check_at_ms
                    .map(|next| now_ms() >= next)
                    .unwrap_or(true)
            {
                let _ = retry_consent_withdrawal(&periodic).await;
                continue;
            }
            if snapshot.settings.consent.delivery_accepted
                && snapshot
                    .next_automatic_check_at_ms
                    .map(|next| now_ms() >= next)
                    .unwrap_or(true)
            {
                run_automatic_cycle(periodic.clone()).await;
            }
        }
    });
}

async fn retry_consent_withdrawal(runtime: &UpdaterRuntime) -> Result<(), String> {
    let mut state = runtime
        .0
        .state
        .lock()
        .expect("updater state poisoned")
        .clone();
    state.settings.consent.delivery_accepted = false;
    state.settings.consent.delivery_consent_version.clear();
    if let Err(error) = fetch_policy_decision_for_state(runtime, &state).await {
        runtime.mutate(|state| {
            state.next_automatic_check_at_ms =
                Some(now_ms().saturating_add(CHECK_INTERVAL_MS));
            push_log(
                state,
                "warning",
                "consent_withdrawal_retry_deferred",
                "The update service is not reachable. Enrollment removal will retry after a quiet backoff.",
            );
            Ok(())
        })?;
        return Err(error);
    }
    runtime.mutate(|state| {
        state.endpoint_status = "consent_withdrawn".to_string();
        state.next_automatic_check_at_ms = None;
        push_log(
            state,
            "info",
            "consent_withdrawn",
            "The update service confirmed removal of this installation's managed-update enrollment and outstanding download grants.",
        );
        Ok(())
    })?;
    Ok(())
}

async fn run_automatic_cycle(runtime: UpdaterRuntime) {
    let snapshot = runtime.snapshot();
    if !snapshot.settings.consent.delivery_accepted {
        return;
    }
    let Ok(snapshot) = check(runtime.clone(), true).await else {
        return;
    };
    if snapshot.phase != UpdatePhase::Available || !snapshot.settings.automatic_download {
        return;
    }
    let should_download = match snapshot.metered_connection {
        MeteredConnection::Metered => snapshot.settings.metered_behavior == MeteredBehavior::Allow,
        MeteredConnection::Unknown | MeteredConnection::Unmetered => true,
    };
    if should_download {
        let _ = download(runtime, false).await;
    }
}

async fn fetch_update_with_retry(
    runtime: &UpdaterRuntime,
    attempts: u8,
) -> Result<Option<Update>, String> {
    let mut last_error = String::new();
    for attempt in 0..attempts {
        runtime.mutate(|state| {
            state.retry_attempt = attempt;
            Ok(())
        })?;
        match build_updater(runtime).and_then(|updater| Ok(updater)) {
            Ok(updater) => match updater.check().await {
                Ok(update) => return Ok(update),
                Err(error) => last_error = redact(&error.to_string()),
            },
            Err(error) => last_error = error,
        }
        if attempt + 1 < attempts {
            tokio::time::sleep(Duration::from_millis(retry_delay_ms(
                attempt,
                runtime.snapshot().rollout_bucket,
            )))
            .await;
        }
    }
    Err(last_error)
}

struct PolicyDisposition {
    terminal: bool,
    release_id: Option<String>,
}

async fn fetch_policy_decision_with_retry(
    runtime: &UpdaterRuntime,
    attempts: u8,
) -> Result<Value, String> {
    let mut last_error = String::new();
    for attempt in 0..attempts {
        let state = runtime
            .0
            .state
            .lock()
            .expect("updater state poisoned")
            .clone();
        match fetch_policy_decision_for_state(runtime, &state).await {
            Ok(value) => return Ok(value),
            Err(error) => last_error = error,
        }
        if attempt + 1 < attempts {
            tokio::time::sleep(Duration::from_millis(retry_delay_ms(
                attempt,
                runtime.snapshot().rollout_bucket,
            )))
            .await;
        }
    }
    Err(last_error)
}

async fn fetch_policy_decision_for_state(
    runtime: &UpdaterRuntime,
    state: &PersistedUpdaterState,
) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .post(DECISION_ENDPOINT)
        .timeout(Duration::from_secs(20))
        .json(&client_context(runtime, state))
        .send()
        .await
        .map_err(|error| redact(&error.to_string()))?;
    if !response.status().is_success() {
        return Err(format!(
            "The policy service returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    response
        .json()
        .await
        .map_err(|error| redact(&error.to_string()))
}

fn validate_channel_transition(decision: &Value) -> Result<(), String> {
    let decision_name = string_at(decision, &["decision"]).unwrap_or_default();
    let compatibility_status = string_at(decision, &["compatibility.status"]).unwrap_or_default();
    if matches!(
        decision_name.as_str(),
        "channel_disabled" | "consent_required" | "incompatible"
    ) || matches!(
        compatibility_status.as_str(),
        "upgrade_required" | "unsupported" | "incompatible" | "server_too_old" | "server_too_new"
    ) {
        return Err(string_at(decision, &["message", "compatibility.message"]).unwrap_or_else(
            || "The selected channel is not compatible with this Raven installation and server.".to_string(),
        ));
    }
    Ok(())
}

fn apply_policy_decision(
    runtime: &UpdaterRuntime,
    decision: &Value,
    next_check: u64,
) -> Result<PolicyDisposition, String> {
    let decision_name = string_at(decision, &["decision"])
        .ok_or_else(|| "The update policy response is missing its decision.".to_string())?;
    let reason_code = string_at(decision, &["reasonCode"]).unwrap_or_default();
    let message = string_at(decision, &["message"])
        .unwrap_or_else(|| "The update policy did not include an explanation.".to_string());
    let classification = classification_at(decision, &["classification"]);
    let compatibility: CompatibilitySummary = value_at(decision, "compatibility")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    let release_id = string_at(decision, &["release.id"]);
    let eligible = bool_at(decision, &["eligible"]).unwrap_or(false);
    let has_artifact = value_at(decision, "artifact").is_some();
    let server_bucket = u64_at(decision, &["rolloutBucket"])
        .map(|value| value.min(9_999) as u16)
        .unwrap_or_else(|| runtime.snapshot().rollout_bucket);
    if server_bucket != runtime.snapshot().rollout_bucket {
        return Err("The update service returned a rollout bucket that does not match this installation's stable local bucket.".to_string());
    }
    let mut access = access_for_classification(classification, &reason_code, &message);
    if decision_name == "blocked" {
        access.mode = AccessMode::Blocked;
    } else {
        let compatibility_access = compatibility.access();
        if compatibility_access.mode > access.mode {
            access = compatibility_access;
        }
    }
    let manifest_expected = matches!(decision_name.as_str(), "update_available" | "blocked")
        && eligible
        && release_id.is_some()
        && has_artifact;
    let phase = if manifest_expected {
        UpdatePhase::Checking
    } else {
        match decision_name.as_str() {
            "blocked" => UpdatePhase::BlockedVersion,
            "incompatible" => UpdatePhase::UnsupportedVersion,
            "channel_disabled" | "consent_required" => UpdatePhase::Paused,
            "release_unavailable" if access.mode != AccessMode::Allowed => {
                UpdatePhase::UnsupportedVersion
            }
            "release_unavailable" => UpdatePhase::Paused,
            "no_update" | "ineligible" => UpdatePhase::Idle,
            _ if access.mode == AccessMode::Blocked => UpdatePhase::BlockedVersion,
            _ if access.mode != AccessMode::Allowed => UpdatePhase::UnsupportedVersion,
            _ => UpdatePhase::Idle,
        }
    };
    runtime.mutate(|state| {
        state.phase = phase;
        state.phase_changed_at_ms = now_ms();
        state.endpoint_status = "policy_reachable".to_string();
        state.rollout_eligibility = if eligible {
            "eligible".to_string()
        } else {
            decision_name.clone()
        };
        state.last_successful_check_at_ms = Some(now_ms());
        state.next_automatic_check_at_ms = Some(next_check);
        state.update_access = access;
        if !manifest_expected {
            state.available = None;
        }
        push_log(
            state,
            "info",
            "policy_decision",
            &format!("Update policy decision: {decision_name}. {message}"),
        );
        Ok(())
    })?;
    Ok(PolicyDisposition {
        terminal: !manifest_expected,
        release_id,
    })
}

fn classification_at(value: &Value, paths: &[&str]) -> UpdateClassification {
    match string_at(value, paths)
        .unwrap_or_else(|| "optional".to_string())
        .to_ascii_lowercase()
        .as_str()
    {
        "recommended" => UpdateClassification::Recommended,
        "required" => UpdateClassification::Required,
        "blocked" => UpdateClassification::Blocked,
        _ => UpdateClassification::Optional,
    }
}

fn build_updater(runtime: &UpdaterRuntime) -> Result<tauri_plugin_updater::Updater, String> {
    build_updater_at(runtime, UPDATE_ENDPOINT, false)
}

fn build_updater_at(
    runtime: &UpdaterRuntime,
    endpoint_value: &str,
    allow_downgrade: bool,
) -> Result<tauri_plugin_updater::Updater, String> {
    let state = runtime
        .0
        .state
        .lock()
        .expect("updater state poisoned")
        .clone();
    let endpoint = endpoint_value
        .parse::<tauri::Url>()
        .map_err(|error| redact(&error.to_string()))?;
    let mut builder = runtime
        .0
        .app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| redact(&error.to_string()))?
        .timeout(Duration::from_secs(25));
    if allow_downgrade {
        builder = builder.version_comparator(|_, _| true);
    }
    for (name, value) in [
        (
            "X-Raven-Update-Channel",
            state.settings.channel.as_str().to_string(),
        ),
        (
            "X-Raven-Update-Cohort",
            state.settings.cohort.as_str().to_string(),
        ),
        ("X-Raven-Installation-ID", state.installation_id.clone()),
        (
            "X-Raven-Consent-Version",
            state.settings.consent.delivery_consent_version.clone(),
        ),
        ("X-Raven-Client-Version", runtime.0.current_version.clone()),
        (
            "X-Raven-Protocol-Version",
            state
                .server_context
                .protocol_version
                .max(CLIENT_PROTOCOL_VERSION)
                .to_string(),
        ),
        (
            "X-Raven-Capabilities",
            client_capabilities(&state).join(","),
        ),
    ] {
        builder = builder
            .header(name, value)
            .map_err(|error| redact(&error.to_string()))?;
    }
    builder.build().map_err(|error| redact(&error.to_string()))
}

async fn fetch_matching_update(
    runtime: &UpdaterRuntime,
    expected: &AvailableUpdate,
) -> Result<Update, String> {
    let update = build_updater(runtime)?
        .check()
        .await
        .map_err(|error| redact(&error.to_string()))?
        .ok_or_else(|| "The release is no longer discoverable.".to_string())?;
    let metadata = metadata_from_update(runtime, &update)?;
    if metadata.release_id != expected.release_id
        || metadata.version != expected.version
        || metadata.size != expected.size
        || !metadata.sha256.eq_ignore_ascii_case(&expected.sha256)
    {
        return Err("The release metadata changed after the original update check.".to_string());
    }
    Ok(update)
}

fn metadata_from_update(
    runtime: &UpdaterRuntime,
    update: &Update,
) -> Result<AvailableUpdate, String> {
    let raw = &update.raw_json;
    let release_id = string_at(raw, &["releaseId", "release_id"])
        .ok_or_else(|| "The update response is missing releaseId.".to_string())?;
    if !safe_identifier(&release_id) {
        return Err("The update response contains an invalid releaseId.".to_string());
    }
    let size = u64_at(raw, &["size", "artifactSize", "artifact.size"])
        .ok_or_else(|| "The update response is missing the artifact size.".to_string())?;
    if size == 0 {
        return Err("The update response contains an empty artifact.".to_string());
    }
    let sha256 = string_at(raw, &["sha256", "artifactSha256", "artifact.sha256"])
        .ok_or_else(|| "The update response is missing the artifact SHA-256 hash.".to_string())?
        .to_ascii_lowercase();
    if sha256.len() != 64
        || !sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("The update response contains an invalid SHA-256 hash.".to_string());
    }
    if update.signature.trim().is_empty() {
        return Err("The update response is missing the Tauri signature.".to_string());
    }
    let classification = match string_at(raw, &["classification"])
        .unwrap_or_else(|| "optional".to_string())
        .to_ascii_lowercase()
        .as_str()
    {
        "recommended" => UpdateClassification::Recommended,
        "required" => UpdateClassification::Required,
        "blocked" => UpdateClassification::Blocked,
        _ => UpdateClassification::Optional,
    };
    let compatibility = value_at(raw, "compatibility")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    let decision = string_at(raw, &["decision"]).unwrap_or_else(|| "update".to_string());
    let reason_code =
        string_at(raw, &["reasonCode"]).unwrap_or_else(|| "update_available".to_string());
    let message = string_at(raw, &["message"]).unwrap_or_else(|| {
        match classification {
            UpdateClassification::Optional => {
                "A signed Raven update is available when you are ready."
            }
            UpdateClassification::Recommended => "A recommended signed Raven update is available.",
            UpdateClassification::Required => {
                "This Raven version must be updated before normal service use."
            }
            UpdateClassification::Blocked => {
                "This Raven version is blocked and must be replaced before service use."
            }
        }
        .to_string()
    });
    Ok(AvailableUpdate {
        release_id,
        version: update.version.clone(),
        notes: update.body.clone().unwrap_or_default(),
        published_at: update.date.map(|date| date.to_string()),
        classification,
        size,
        sha256,
        signature_present: true,
        eligible: bool_at(raw, &["eligible"]).unwrap_or(true),
        rollout_bucket: u64_at(raw, &["rolloutBucket"])
            .map(|value| value.min(9_999) as u16)
            .unwrap_or_else(|| runtime.snapshot().rollout_bucket),
        decision,
        reason_code,
        message,
        compatibility,
        local_data_schema_version: u64_at(raw, &["localDataSchemaVersion"])
            .unwrap_or_default()
            .min(i32::MAX as u64) as i32,
        local_migration_reversible: bool_at(raw, &["localMigrationReversible"]).unwrap_or(false),
        rollback_safe: bool_at(raw, &["rollbackSafe"]).unwrap_or(false),
        approved_rollback_release_id: string_at(raw, &["approvedRollbackReleaseId"]),
    })
}

fn phase_for_metadata(metadata: &AvailableUpdate) -> UpdatePhase {
    if metadata.classification == UpdateClassification::Blocked {
        UpdatePhase::BlockedVersion
    } else if matches!(
        metadata.compatibility.status.as_str(),
        "unsupported" | "server_too_old" | "server_too_new" | "incompatible"
    ) {
        UpdatePhase::UnsupportedVersion
    } else if matches!(
        metadata.decision.as_str(),
        "paused" | "channel_disabled" | "withdrawn"
    ) {
        UpdatePhase::Paused
    } else {
        UpdatePhase::Available
    }
}

async fn revalidate_release(
    runtime: &UpdaterRuntime,
    available: &AvailableUpdate,
) -> Result<(), String> {
    let state = runtime
        .0
        .state
        .lock()
        .expect("updater state poisoned")
        .clone();
    let url = format!("{}/{}", REVALIDATE_ENDPOINT, available.release_id);
    let response = reqwest::Client::new()
        .post(url)
        .timeout(Duration::from_secs(20))
        .json(&client_context(runtime, &state))
        .send()
        .await
        .map_err(|error| redact(&error.to_string()))?;
    if !response.status().is_success() {
        return Err(format!(
            "The update service could not revalidate this release (HTTP {}).",
            response.status().as_u16()
        ));
    }
    let decision: Value = response
        .json()
        .await
        .map_err(|error| redact(&error.to_string()))?;
    let release_id = string_at(&decision, &["release.id", "releaseId"]).ok_or_else(|| {
        "The revalidation response no longer identifies an installable release.".to_string()
    })?;
    let release_state = string_at(&decision, &["release.state"]).unwrap_or_default();
    let artifact_hash = string_at(&decision, &["artifact.sha256", "sha256"]).unwrap_or_default();
    let artifact_size = u64_at(&decision, &["artifact.size", "size"]).unwrap_or_default();
    let rejected = matches!(
        release_state.as_str(),
        "paused" | "withdrawn" | "superseded" | "draft" | "validated"
    ) || matches!(
        string_at(&decision, &["decision"])
            .unwrap_or_default()
            .as_str(),
        "none" | "paused" | "withdrawn" | "channel_disabled" | "unsupported"
    );
    if rejected
        || release_id != available.release_id
        || !artifact_hash.eq_ignore_ascii_case(&available.sha256)
        || artifact_size != available.size
    {
        return Err("The release was withdrawn, paused, superseded, blocked as a target, or changed after download.".to_string());
    }
    Ok(())
}

fn client_context(runtime: &UpdaterRuntime, state: &PersistedUpdaterState) -> Value {
    json!({
        "currentVersion": runtime.0.current_version,
        "target": platform(),
        "arch": architecture(),
        "channel": state.settings.channel,
        "cohort": state.settings.cohort,
        "installationId": state.installation_id,
        "consentAccepted": state.settings.consent.delivery_accepted,
        "consentVersion": state.settings.consent.delivery_consent_version,
        "serverVersion": state.server_context.server_version,
        "protocolVersion": state.server_context.protocol_version.max(CLIENT_PROTOCOL_VERSION),
        "capabilities": client_capabilities(state),
    })
}

fn client_capabilities(state: &PersistedUpdaterState) -> Vec<String> {
    let mut values = vec![
        "desktop-updater-v1".to_string(),
        "tauri-signed-updates".to_string(),
        "nest-session-deferral".to_string(),
    ];
    values.extend(state.server_context.capabilities.clone());
    values.sort();
    values.dedup();
    values
}

async fn report_outcome(
    runtime: &UpdaterRuntime,
    stage: &str,
    outcome: &str,
    error_category: &str,
    release_id: Option<&str>,
) {
    let snapshot = runtime.snapshot();
    if !snapshot.settings.consent.aggregate_outcomes {
        return;
    }
    let to_version = snapshot
        .available
        .as_ref()
        .map(|value| value.version.clone())
        .unwrap_or_default();
    let payload = json!({
        "consent": true,
        "eventId": uuid::Uuid::new_v4().to_string(),
        "releaseId": release_id.unwrap_or_default(),
        "fromVersion": snapshot.current_version,
        "toVersion": to_version,
        "platform": snapshot.platform,
        "architecture": snapshot.architecture,
        "stage": stage,
        "outcome": outcome,
        "errorCategory": error_category,
    });
    let _ = reqwest::Client::new()
        .post(OUTCOMES_ENDPOINT)
        .timeout(Duration::from_secs(10))
        .json(&payload)
        .send()
        .await;
}

fn read_and_validate_staged(
    runtime: &UpdaterRuntime,
    downloaded: &DownloadedArtifact,
) -> Result<Vec<u8>, String> {
    let path = runtime.staging_path(&downloaded.staging_file)?;
    let mut file = File::open(path).map_err(|error| redact(&error.to_string()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| redact(&error.to_string()))?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    if bytes.len() as u64 != downloaded.size || !hash.eq_ignore_ascii_case(&downloaded.sha256) {
        return Err("The staged update changed after verification and was rejected.".to_string());
    }
    Ok(bytes)
}

fn remove_other_staged_files(runtime: &UpdaterRuntime, keep: &str) {
    if let Ok(entries) = fs::read_dir(&runtime.0.staging_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.file_name().and_then(|value| value.to_str()) != Some(keep) {
                let _ = fs::remove_file(path);
            }
        }
    }
}

fn staging_file_name(release_id: &str, version: &str) -> String {
    let clean = |value: &str| {
        value
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                    character
                } else {
                    '_'
                }
            })
            .take(72)
            .collect::<String>()
    };
    format!("{}-{}.bundle", clean(release_id), clean(version))
}

fn safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

fn value_at<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .try_fold(value, |current, key| current.get(key))
}

fn string_at(value: &Value, paths: &[&str]) -> Option<String> {
    paths
        .iter()
        .find_map(|path| value_at(value, path).and_then(Value::as_str))
        .map(str::to_string)
}

fn u64_at(value: &Value, paths: &[&str]) -> Option<u64> {
    paths.iter().find_map(|path| {
        value_at(value, path).and_then(|item| {
            item.as_u64()
                .or_else(|| item.as_i64().and_then(|number| u64::try_from(number).ok()))
        })
    })
}

fn bool_at(value: &Value, paths: &[&str]) -> Option<bool> {
    paths
        .iter()
        .find_map(|path| value_at(value, path).and_then(Value::as_bool))
}

fn retry_delay_ms(attempt: u8, seed: u16) -> u64 {
    let base = 1_500_u64.saturating_mul(1_u64 << attempt.min(8));
    let jitter = ((u64::from(seed) * 1_103 + u64::from(attempt) * 997) % 1_000) + 250;
    base.saturating_add(jitter).min(30_000)
}

fn next_check_at(runtime: &UpdaterRuntime, interval: u64) -> u64 {
    let snapshot = runtime.snapshot();
    let mixed = u64::from(snapshot.rollout_bucket)
        .saturating_mul(1_664_525)
        .saturating_add(now_ms());
    let span = CHECK_JITTER_WINDOW_MS.saturating_mul(2).saturating_add(1);
    let jitter = (mixed % span) as i64 - CHECK_JITTER_WINDOW_MS as i64;
    now_ms().saturating_add_signed(interval as i64 + jitter)
}

fn is_signature_error(error: &tauri_plugin_updater::Error) -> bool {
    matches!(
        error,
        tauri_plugin_updater::Error::Minisign(_)
            | tauri_plugin_updater::Error::Base64(_)
            | tauri_plugin_updater::Error::SignatureUtf8(_)
    )
}

fn check_error_category(error: &str) -> &str {
    let lower = error.to_ascii_lowercase();
    if lower.contains("timed out") || lower.contains("timeout") {
        "timeout"
    } else if lower.contains("dns") || lower.contains("connect") || lower.contains("network") {
        "offline_or_unreachable"
    } else if lower.contains("json") || lower.contains("deserialize") || lower.contains("release") {
        "invalid_response"
    } else {
        "check_failed"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_delay_is_bounded_and_increases() {
        let first = retry_delay_ms(0, 12);
        let second = retry_delay_ms(1, 12);
        let third = retry_delay_ms(2, 12);
        assert!(first < second);
        assert!(second < third);
        assert!(third <= 30_000);
    }

    #[test]
    fn staging_names_cannot_escape_the_managed_directory() {
        let value = staging_file_name("../../release", "1.2.3/../../bad");
        assert!(!value.contains('/'));
        assert!(!value.contains('\\'));
    }

    #[test]
    fn nested_metadata_lookup_reads_artifact_fields() {
        let value = json!({"artifact": {"size": 12, "sha256": "abc"}});
        assert_eq!(u64_at(&value, &["artifact.size"]), Some(12));
        assert_eq!(
            string_at(&value, &["artifact.sha256"]),
            Some("abc".to_string())
        );
    }

    #[test]
    fn channel_transition_rejects_disabled_or_incompatible_policy() {
        assert!(validate_channel_transition(&json!({
            "decision": "channel_disabled",
            "message": "Alpha is paused.",
            "compatibility": {"status": "compatible"}
        }))
        .is_err());
        assert!(validate_channel_transition(&json!({
            "decision": "no_update",
            "compatibility": {"status": "server_too_old"}
        }))
        .is_err());
        assert!(validate_channel_transition(&json!({
            "decision": "no_update",
            "compatibility": {"status": "compatible"}
        }))
        .is_ok());
    }
}
