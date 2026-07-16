package updates

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"raven/services/api/internal/database"
)

type fakeArtifactStore struct {
	objects    map[string]ObjectInfo
	headErrors map[string]error
	presignErr error
}

func (f *fakeArtifactStore) PresignGet(_ context.Context, key string, _ time.Duration) (string, error) {
	if f.presignErr != nil {
		return "", f.presignErr
	}
	return "https://storage.example/" + key, nil
}

func (f *fakeArtifactStore) Head(_ context.Context, key string) (ObjectInfo, error) {
	if err := f.headErrors[key]; err != nil {
		return ObjectInfo{}, err
	}
	info, ok := f.objects[key]
	if !ok {
		return ObjectInfo{}, errors.New("missing object")
	}
	return info, nil
}

type serviceHarness struct {
	service   *Service
	db        *database.DB
	artifacts *fakeArtifactStore
	now       time.Time
}

func newServiceHarness(t *testing.T) *serviceHarness {
	t.Helper()
	db, err := database.Open(filepath.Join(t.TempDir(), "updates.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	now := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
	artifacts := &fakeArtifactStore{objects: map[string]ObjectInfo{}, headErrors: map[string]error{}}
	service := NewService(db, Options{
		Artifacts: artifacts,
		Now:       func() time.Time { return now },
		ServerPolicy: ServerPolicy{
			ServerVersion:            "1.0.0",
			ProtocolVersion:          1,
			MinimumClientVersion:     "0.1.0",
			RecommendedClientVersion: "1.0.0",
		},
		ConsentVersion: "closed-alpha-2026-07-12",
	})
	return &serviceHarness{service: service, db: db, artifacts: artifacts, now: now}
}

func TestReleaseValidationRequiresCompleteVerifiedImmutableEvidence(t *testing.T) {
	t.Run("partial multi-platform release", func(t *testing.T) {
		harness := newServiceHarness(t)
		input := harness.releaseInput("1.1.0", ClassificationOptional, true, 1)
		input.Artifacts = input.Artifacts[:1]
		release, err := harness.service.CreateRelease(input, testActor())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := harness.service.ValidateRelease(context.Background(), release.ID, testActor()); !errors.Is(err, ErrConflict) {
			t.Fatalf("partial release validation error = %v", err)
		}
	})

	t.Run("missing object", func(t *testing.T) {
		harness := newServiceHarness(t)
		input := harness.releaseInput("1.1.0", ClassificationOptional, true, 1)
		delete(harness.artifacts.objects, input.Artifacts[0].SBOMObjectKey)
		release, err := harness.service.CreateRelease(input, testActor())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := harness.service.ValidateRelease(context.Background(), release.ID, testActor()); err == nil {
			t.Fatal("missing evidence object was accepted")
		}
	})

	t.Run("incorrect artifact hash", func(t *testing.T) {
		harness := newServiceHarness(t)
		input := harness.releaseInput("1.1.0", ClassificationOptional, true, 1)
		info := harness.artifacts.objects[input.Artifacts[0].ObjectKey]
		info.SHA256 = strings.Repeat("f", 64)
		harness.artifacts.objects[input.Artifacts[0].ObjectKey] = info
		release, err := harness.service.CreateRelease(input, testActor())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := harness.service.ValidateRelease(context.Background(), release.ID, testActor()); !errors.Is(err, ErrConflict) {
			t.Fatalf("incorrect hash validation error = %v", err)
		}
	})

	t.Run("missing metadata hash", func(t *testing.T) {
		harness := newServiceHarness(t)
		input := harness.releaseInput("1.1.0", ClassificationOptional, true, 1)
		info := harness.artifacts.objects[input.Artifacts[0].ProvenanceObjectKey]
		info.SHA256 = ""
		harness.artifacts.objects[input.Artifacts[0].ProvenanceObjectKey] = info
		release, err := harness.service.CreateRelease(input, testActor())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := harness.service.ValidateRelease(context.Background(), release.ID, testActor()); !errors.Is(err, ErrConflict) {
			t.Fatalf("empty metadata hash validation error = %v", err)
		}
	})

	t.Run("invalid signature registration", func(t *testing.T) {
		harness := newServiceHarness(t)
		input := harness.releaseInput("1.1.0", ClassificationOptional, true, 1)
		input.Artifacts[0].Signature = ""
		if _, err := harness.service.CreateRelease(input, testActor()); err == nil {
			t.Fatal("empty Tauri signature was accepted")
		}
	})
}

func TestOptionalRecommendedRequiredAndLifecycleDecisions(t *testing.T) {
	harness := newServiceHarness(t)
	release := harness.createValidatedRelease(t, "1.1.0", ClassificationOptional, true, 1)
	release, err := harness.service.Store().Publish(release.ID, StateRollingOut, []RolloutInput{{Cohort: "friends", Percentage: 100}}, "closed alpha rollout", testActor(), harness.now)
	if err != nil {
		t.Fatal(err)
	}
	decision := harness.decision(t, "installation-a")
	if decision.Decision != "update_available" || decision.Classification != ClassificationOptional {
		t.Fatalf("optional decision = %+v", decision)
	}
	if _, err := harness.service.Store().SetRollouts(release.ID, []RolloutInput{{Cohort: "friends", Percentage: 0}}, "pause percentage", testActor(), harness.now); err != nil {
		t.Fatal(err)
	}
	decision = harness.decision(t, "installation-a")
	if decision.Decision != "ineligible" {
		t.Fatalf("zero-percent decision = %+v", decision)
	}
	if _, err := harness.service.Store().SetRequired(release.ID, "protocol repair", testActor(), harness.now); err != nil {
		t.Fatal(err)
	}
	decision = harness.decision(t, "installation-a")
	if decision.Decision != "update_available" || decision.Classification != ClassificationRequired || !decision.Eligible {
		t.Fatalf("required release did not bypass percentage: %+v", decision)
	}
	paused, err := harness.service.Store().UpdateReleaseState(release.ID, StatePaused, "investigating startup reports", testActor(), harness.now)
	if err != nil {
		t.Fatal(err)
	}
	if decision = harness.decision(t, "installation-a"); decision.Decision != "no_update" {
		t.Fatalf("paused release remained discoverable: %+v", decision)
	}
	if _, err := harness.service.Store().UpdateReleaseState(release.ID, *paused.PausedFromState, "resume stable buckets", testActor(), harness.now); err != nil {
		t.Fatal(err)
	}
	if decision = harness.decision(t, "installation-a"); decision.Decision != "update_available" {
		t.Fatalf("resumed release was not discoverable: %+v", decision)
	}
	if _, err := harness.service.Store().UpdateReleaseState(release.ID, StateWithdrawn, "withdraw unsafe artifact", testActor(), harness.now); err != nil {
		t.Fatal(err)
	}
	if decision = harness.decision(t, "installation-a"); decision.Decision != "no_update" {
		t.Fatalf("withdrawn release remained discoverable: %+v", decision)
	}
}

func TestRecommendedClassificationAndDisabledChannel(t *testing.T) {
	harness := newServiceHarness(t)
	release := harness.createValidatedRelease(t, "1.2.0", ClassificationRecommended, true, 1)
	if _, err := harness.service.Store().Publish(release.ID, StateRollingOut, []RolloutInput{{Cohort: "friends", Percentage: 100}}, "recommended rollout", testActor(), harness.now); err != nil {
		t.Fatal(err)
	}
	decision := harness.decision(t, "installation-b")
	if decision.Classification != ClassificationRecommended {
		t.Fatalf("recommended classification lost: %+v", decision)
	}
	if _, err := harness.service.Store().SetChannel(ChannelAlpha, false, "operator pause", testActor(), harness.now); err != nil {
		t.Fatal(err)
	}
	decision = harness.decision(t, "installation-b")
	if decision.Decision != "channel_disabled" || decision.Eligible {
		t.Fatalf("disabled channel decision = %+v", decision)
	}
}

func TestBlockedVersionGetsVerifiedTargetAndBypassesPercentage(t *testing.T) {
	harness := newServiceHarness(t)
	target := harness.createValidatedRelease(t, "1.3.0", ClassificationRecommended, true, 1)
	if _, err := harness.service.Store().Publish(target.ID, StateRollingOut, []RolloutInput{{Cohort: "friends", Percentage: 0}}, "emergency target", testActor(), harness.now); err != nil {
		t.Fatal(err)
	}
	channel := ChannelAlpha
	block, err := harness.service.CreateVersionBlock(VersionBlock{VersionRange: "< 1.1.0", Channel: &channel, Reason: "This build cannot safely connect.", TargetReleaseID: &target.ID}, testActor())
	if err != nil {
		t.Fatal(err)
	}
	decision := harness.decision(t, "installation-c")
	if decision.Decision != "blocked" || decision.Classification != ClassificationBlocked || !decision.Eligible || decision.Release == nil || decision.Release.ID != target.ID {
		t.Fatalf("blocked decision = %+v", decision)
	}
	compatibility, err := harness.service.ServiceAccessCompatibility("1.0.0", 1, nil, ChannelAlpha, "friends")
	if err != nil {
		t.Fatal(err)
	}
	if compatibility.Status != "blocked" || compatibility.ReasonCode != "installed_version_blocked" {
		t.Fatalf("blocked service compatibility = %+v", compatibility)
	}
	if _, err := harness.service.Store().DeactivateVersionBlock(block.ID, "repair completed", testActor(), harness.now); err != nil {
		t.Fatal(err)
	}
	compatibility, err = harness.service.ServiceAccessCompatibility("1.0.0", 1, nil, ChannelAlpha, "friends")
	if err != nil || compatibility.Status != "compatible" {
		t.Fatalf("deactivated block still gated service: %+v, %v", compatibility, err)
	}
}

func TestNamedInternalCohortRequiresOperatorAssignment(t *testing.T) {
	harness := newServiceHarness(t)
	release := harness.createValidatedRelease(t, "1.1.0", ClassificationOptional, true, 1)
	if _, err := harness.service.Store().Publish(release.ID, StateInternal, []RolloutInput{{Cohort: "internal", Percentage: 100}}, "internal validation", testActor(), harness.now); err != nil {
		t.Fatal(err)
	}
	client := testClient("installation-internal", "1.0.0")
	client.Cohort = "internal"
	decision, err := harness.service.Decision(client)
	if err != nil || decision.Decision != "ineligible" || decision.ReasonCode != "cohort_assignment_required" {
		t.Fatalf("unassigned internal cohort = %+v, %v", decision, err)
	}
	if _, err := harness.service.Store().AssignInstallationCohort(client.InstallationID, "internal", "explicit maintainer enrollment", testActor(), harness.now); err != nil {
		t.Fatal(err)
	}
	decision, err = harness.service.Decision(client)
	if err != nil || decision.Decision != "update_available" || decision.Release == nil || decision.Release.ID != release.ID {
		t.Fatalf("assigned internal cohort = %+v, %v", decision, err)
	}
}

func TestInternalRequiredReleaseDoesNotGateFriendsCohort(t *testing.T) {
	harness := newServiceHarness(t)
	release := harness.createValidatedRelease(t, "1.1.0", ClassificationRequired, true, 1)
	if _, err := harness.service.Store().Publish(release.ID, StateInternal, []RolloutInput{{Cohort: "internal", Percentage: 100}}, "internal required validation", testActor(), harness.now); err != nil {
		t.Fatal(err)
	}
	friends, err := harness.service.EffectiveServerCompatibility("1.0.0", 1, nil, ChannelAlpha, "friends")
	if err != nil {
		t.Fatal(err)
	}
	if friends.Status != "compatible" || friends.MinimumClientVersion != "0.1.0" {
		t.Fatalf("internal release overblocked friends: %+v", friends)
	}
	internal, err := harness.service.EffectiveServerCompatibility("1.0.0", 1, nil, ChannelAlpha, "internal")
	if err != nil {
		t.Fatal(err)
	}
	if internal.Status != "upgrade_required" || internal.MinimumClientVersion != "1.1.0" {
		t.Fatalf("internal release did not gate internal cohort: %+v", internal)
	}
}

func TestRevalidationAndDownloadGrantFailClosedAfterPause(t *testing.T) {
	harness := newServiceHarness(t)
	release := harness.createValidatedRelease(t, "1.1.0", ClassificationOptional, true, 1)
	release, err := harness.service.Store().Publish(release.ID, StateRollingOut, []RolloutInput{{Cohort: "friends", Percentage: 100}}, "roll out", testActor(), harness.now)
	if err != nil {
		t.Fatal(err)
	}
	client := testClient("installation-d", "1.0.0")
	decision, err := harness.service.Revalidate(release.ID, client)
	if err != nil || decision.Artifact == nil {
		t.Fatalf("initial revalidation = %+v, %v", decision, err)
	}
	grant, err := harness.service.IssueDownloadGrant(*decision.Artifact, *decision.Release, client.InstallationID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := harness.service.PresignArtifact(context.Background(), decision.Artifact.ID, grant); err != nil {
		t.Fatalf("valid grant failed: %v", err)
	}
	if _, err := harness.service.Store().UpdateReleaseState(release.ID, StatePaused, "pause", testActor(), harness.now); err != nil {
		t.Fatal(err)
	}
	if _, err := harness.service.PresignArtifact(context.Background(), decision.Artifact.ID, grant); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stale grant was accepted after pause: %v", err)
	}
	decision, err = harness.service.Revalidate(release.ID, client)
	if err != nil || decision.Decision != "release_unavailable" {
		t.Fatalf("paused revalidation = %+v, %v", decision, err)
	}
}

func TestRollbackRequiresExplicitReversibilityApprovalCompatibilityAndUnblockedTarget(t *testing.T) {
	harness := newServiceHarness(t)
	target := harness.createValidatedRelease(t, "1.5.0", ClassificationOptional, true, 1)
	if _, err := harness.service.Store().Publish(target.ID, StateFullyReleased, []RolloutInput{{Cohort: "friends", Percentage: 100}}, "previous release", testActor(), harness.now); err != nil {
		t.Fatal(err)
	}
	source := harness.createValidatedRelease(t, "2.0.0", ClassificationOptional, true, 2)
	if _, err := harness.service.Store().Publish(source.ID, StateFullyReleased, []RolloutInput{{Cohort: "friends", Percentage: 100}}, "new release", testActor(), harness.now); err != nil {
		t.Fatal(err)
	}
	if _, err := harness.service.Store().SetRollbackTarget(source.ID, &target.ID, "startup recovery", testActor(), harness.now); err != nil {
		t.Fatal(err)
	}
	client := testClient("installation-e", source.Version)
	decision, err := harness.service.RollbackDecision(source.ID, client)
	if err != nil || decision.Decision != "rollback_available" || decision.Release == nil || decision.Release.ID != target.ID {
		t.Fatalf("approved rollback = %+v, %v", decision, err)
	}
	channel := ChannelAlpha
	if _, err := harness.service.CreateVersionBlock(VersionBlock{VersionRange: "= 1.5.0", Channel: &channel, Reason: "Rollback target is blocked."}, testActor()); err != nil {
		t.Fatal(err)
	}
	decision, err = harness.service.RollbackDecision(source.ID, client)
	if err != nil || decision.Decision != "rollback_refused" || decision.ReasonCode != "rollback_target_unavailable" {
		t.Fatalf("blocked rollback target = %+v, %v", decision, err)
	}

	unsafeHarness := newServiceHarness(t)
	unsafeTarget := unsafeHarness.createValidatedRelease(t, "1.5.0", ClassificationOptional, false, 1)
	if _, err := unsafeHarness.service.Store().Publish(unsafeTarget.ID, StateFullyReleased, []RolloutInput{{Cohort: "friends", Percentage: 100}}, "previous", testActor(), unsafeHarness.now); err != nil {
		t.Fatal(err)
	}
	unsafeSource := unsafeHarness.createValidatedRelease(t, "2.0.0", ClassificationOptional, false, 2)
	if _, err := unsafeHarness.service.Store().Publish(unsafeSource.ID, StateFullyReleased, []RolloutInput{{Cohort: "friends", Percentage: 100}}, "source", testActor(), unsafeHarness.now); err != nil {
		t.Fatal(err)
	}
	if _, err := unsafeHarness.service.Store().SetRollbackTarget(unsafeSource.ID, &unsafeTarget.ID, "unsafe", testActor(), unsafeHarness.now); !errors.Is(err, ErrConflict) {
		t.Fatalf("irreversible migration accepted rollback target: %v", err)
	}
}

func TestConsentWithdrawalNoOpsAndRetentionCleanup(t *testing.T) {
	harness := newServiceHarness(t)
	client := testClient("installation-f", "1.0.0")
	if _, err := harness.service.Decision(client); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := harness.db.QueryRow(`SELECT COUNT(*) FROM update_enrollments`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("enrollment count = %d, err=%v", count, err)
	}
	client.ConsentAccepted = false
	decision, err := harness.service.Decision(client)
	if err != nil || decision.Decision != "consent_required" || decision.ConsentVersion != "closed-alpha-2026-07-12" {
		t.Fatalf("consent withdrawal decision = %+v, %v", decision, err)
	}
	if err := harness.db.QueryRow(`SELECT COUNT(*) FROM update_enrollments`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("withdrawn enrollment count = %d, err=%v", count, err)
	}
	if recorded, err := harness.service.RecordOutcome(OutcomeInput{Consent: false}); err != nil || recorded {
		t.Fatalf("disabled outcome = %v, %v", recorded, err)
	}
	if _, err := harness.service.RecordDiagnostic(DiagnosticInput{Consent: false, Payload: map[string]any{"token": "secret"}}); err != nil {
		t.Fatalf("disabled diagnostics returned error: %v", err)
	}
	if err := harness.db.QueryRow(`SELECT COUNT(*) FROM update_outcome_daily`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("disabled outcome wrote data: %d, %v", count, err)
	}
	if err := harness.db.QueryRow(`SELECT COUNT(*) FROM update_diagnostic_reports`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("disabled diagnostic wrote data: %d, %v", count, err)
	}
	if _, err := harness.db.Exec(`INSERT INTO update_outcome_dedup (event_hash, expires_at) VALUES ('expired', '2020-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := harness.db.Exec(`INSERT INTO update_diagnostic_reports (id, payload_json, created_at, expires_at) VALUES ('expired', '{}', '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if err := harness.service.Store().CleanupRetention(harness.now); err != nil {
		t.Fatal(err)
	}
	if err := harness.db.QueryRow(`SELECT COUNT(*) FROM update_outcome_dedup`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("expired outcome dedup retained: %d, %v", count, err)
	}
	if err := harness.db.QueryRow(`SELECT COUNT(*) FROM update_diagnostic_reports`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("expired diagnostic retained: %d, %v", count, err)
	}
}

func TestConsentedAggregateOutcomeDedupAndDetailedDiagnosticRedaction(t *testing.T) {
	harness := newServiceHarness(t)
	input := OutcomeInput{Consent: true, EventID: "event-1", FromVersion: "1.0.0", ToVersion: "1.1.0", Platform: "windows", Architecture: "x86_64", Stage: "installation", Outcome: "failure", ErrorCategory: "installer_exit"}
	recorded, err := harness.service.RecordOutcome(input)
	if err != nil || !recorded {
		t.Fatalf("first outcome = %v, %v", recorded, err)
	}
	recorded, err = harness.service.RecordOutcome(input)
	if err != nil || recorded {
		t.Fatalf("duplicate outcome = %v, %v", recorded, err)
	}
	metrics, err := harness.service.Store().ListOutcomes(10)
	if err != nil || len(metrics) != 1 || metrics[0].Count != 1 {
		t.Fatalf("outcome metrics = %+v, %v", metrics, err)
	}
	report, err := harness.service.RecordDiagnostic(DiagnosticInput{Consent: true, Payload: map[string]any{"token": "secret", "status": "verification_failed", "log": "/home/alice/.config 10.0.0.4"}})
	if err != nil {
		t.Fatal(err)
	}
	if report.Payload["token"] != "[redacted]" || report.Payload["status"] != "verification_failed" || strings.Contains(report.Payload["log"].(string), "alice") || strings.Contains(report.Payload["log"].(string), "10.0.0.4") {
		t.Fatalf("diagnostic was not safely redacted: %+v", report.Payload)
	}
}

func TestConsentWithdrawalRevokesDownloadGrantAndCohortAssignment(t *testing.T) {
	harness := newServiceHarness(t)
	release := harness.createValidatedRelease(t, "1.1.0", ClassificationOptional, true, 1)
	if _, err := harness.service.Store().Publish(release.ID, StateRollingOut, []RolloutInput{{Cohort: "friends", Percentage: 100}}, "friends rollout", testActor(), harness.now); err != nil {
		t.Fatal(err)
	}
	client := testClient("installation-withdrawal", "1.0.0")
	if _, err := harness.service.Store().AssignInstallationCohort(client.InstallationID, "internal", "consented assignment", testActor(), harness.now); err != nil {
		t.Fatal(err)
	}
	decision, err := harness.service.Decision(client)
	if err != nil || decision.Artifact == nil || decision.Release == nil {
		t.Fatalf("initial decision = %+v, %v", decision, err)
	}
	grant, err := harness.service.IssueDownloadGrant(*decision.Artifact, *decision.Release, client.InstallationID)
	if err != nil {
		t.Fatal(err)
	}
	client.ConsentAccepted = false
	if _, err := harness.service.Decision(client); err != nil {
		t.Fatal(err)
	}
	if _, err := harness.service.PresignArtifact(context.Background(), decision.Artifact.ID, grant); !errors.Is(err, ErrNotFound) {
		t.Fatalf("download grant survived consent withdrawal: %v", err)
	}
	digest, _, err := InstallationDigestAndBucket(client.InstallationID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := harness.service.Store().AssignedCohort(digest); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cohort assignment survived consent withdrawal: %v", err)
	}
}

func (h *serviceHarness) releaseInput(version, classification string, rollbackSafe bool, schemaVersion int) CreateReleaseInput {
	input := CreateReleaseInput{
		Version:                  version,
		Channel:                  ChannelAlpha,
		Classification:           classification,
		Notes:                    "Calm, specific release notes.",
		GitCommit:                strings.Repeat("a", 40),
		ClientProtocolVersion:    1,
		LocalDataSchemaVersion:   schemaVersion,
		LocalMigrationReversible: rollbackSafe,
		RollbackSafe:             rollbackSafe,
	}
	for _, platform := range []string{"windows", "linux"} {
		prefix := "desktop/alpha/" + version + "/" + platform + "/x86_64/"
		artifact := ArtifactInput{
			Platform:            platform,
			Architecture:        "x86_64",
			Format:              map[string]string{"windows": "nsis", "linux": "appimage"}[platform],
			ObjectKey:           prefix + "Raven-update",
			Signature:           "tauri-minisign-signature",
			SHA256:              strings.Repeat("a", 64),
			Size:                1024,
			ChecksumObjectKey:   prefix + "Raven-update.sha256",
			ChecksumSHA256:      strings.Repeat("b", 64),
			SBOMObjectKey:       prefix + "Raven-update.sbom.json",
			SBOMSHA256:          strings.Repeat("c", 64),
			ProvenanceObjectKey: prefix + "Raven-update.provenance.json",
			ProvenanceSHA256:    strings.Repeat("d", 64),
		}
		h.artifacts.objects[artifact.ObjectKey] = ObjectInfo{Size: artifact.Size, SHA256: artifact.SHA256}
		h.artifacts.objects[artifact.ChecksumObjectKey] = ObjectInfo{Size: 80, SHA256: artifact.ChecksumSHA256}
		h.artifacts.objects[artifact.SBOMObjectKey] = ObjectInfo{Size: 80, SHA256: artifact.SBOMSHA256}
		h.artifacts.objects[artifact.ProvenanceObjectKey] = ObjectInfo{Size: 80, SHA256: artifact.ProvenanceSHA256}
		input.Artifacts = append(input.Artifacts, artifact)
	}
	return input
}

func (h *serviceHarness) createValidatedRelease(t *testing.T, version, classification string, rollbackSafe bool, schemaVersion int) Release {
	t.Helper()
	release, err := h.service.CreateRelease(h.releaseInput(version, classification, rollbackSafe, schemaVersion), testActor())
	if err != nil {
		t.Fatal(err)
	}
	release, err = h.service.ValidateRelease(context.Background(), release.ID, testActor())
	if err != nil {
		t.Fatal(err)
	}
	return release
}

func (h *serviceHarness) decision(t *testing.T, installationID string) Decision {
	t.Helper()
	decision, err := h.service.Decision(testClient(installationID, "1.0.0"))
	if err != nil {
		t.Fatal(err)
	}
	return decision
}

func testClient(installationID, currentVersion string) ClientContext {
	return ClientContext{
		CurrentVersion:  currentVersion,
		Target:          "windows",
		Architecture:    "x86_64",
		Channel:         ChannelAlpha,
		Cohort:          "friends",
		InstallationID:  installationID,
		ConsentAccepted: true,
		ConsentVersion:  "closed-alpha-2026-07-12",
		ServerVersion:   "1.0.0",
		ProtocolVersion: 1,
	}
}

func testActor() Actor {
	return Actor{Label: "test-operator", CorrelationID: "test-correlation"}
}
