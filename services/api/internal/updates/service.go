package updates

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"
)

type Service struct {
	store          *Store
	artifacts      ArtifactStore
	now            func() time.Time
	serverPolicy   ServerPolicy
	presignExpiry  time.Duration
	consentVersion string
}

func NewService(db *database.DB, options Options) *Service {
	if options.Artifacts == nil {
		options.Artifacts = UnavailableArtifactStore{err: errors.New("artifact storage is not configured")}
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.PresignExpiry <= 0 || options.PresignExpiry > 24*time.Hour {
		options.PresignExpiry = 10 * time.Minute
	}
	if strings.TrimSpace(options.ConsentVersion) == "" {
		options.ConsentVersion = "closed-alpha-2026-07-12"
	}
	service := &Service{
		store:          NewStore(db),
		artifacts:      options.Artifacts,
		now:            options.Now,
		serverPolicy:   options.ServerPolicy,
		presignExpiry:  options.PresignExpiry,
		consentVersion: options.ConsentVersion,
	}
	_ = service.store.CleanupRetention(service.now())
	return service
}

func (s *Service) Store() *Store {
	return s.store
}

func (s *Service) ServerCompatibility(clientVersion string, protocolVersion int, capabilities []string) Compatibility {
	return EvaluateServerCompatibility(s.serverPolicy, clientVersion, protocolVersion, capabilities)
}

func (s *Service) EffectiveServerCompatibility(clientVersion string, protocolVersion int, capabilities []string, channel, cohort string) (Compatibility, error) {
	compatibility := EvaluateServerCompatibility(s.serverPolicy, clientVersion, protocolVersion, capabilities)
	channel, err := NormalizeChannel(channel)
	if err != nil {
		return Compatibility{}, err
	}
	cohort = strings.ToLower(strings.TrimSpace(cohort))
	if cohort == "" {
		cohort = "friends"
	}
	releases, err := s.store.ListReleases()
	if err != nil {
		return Compatibility{}, err
	}
	effectiveMinimum := compatibility.MinimumClientVersion
	effectiveRecommended := compatibility.RecommendedClientVersion
	var activeGrace *string
	for _, release := range releases {
		if release.Channel != channel || !releaseDiscoverable(release, cohort) || !releaseFullyVerified(release) || !s.releaseCompatibleWithServer(release) {
			continue
		}
		if release.Classification == ClassificationRecommended || release.Classification == ClassificationRequired {
			if effectiveRecommended == "" || VersionGreater(release.Version, effectiveRecommended) {
				effectiveRecommended = release.Version
			}
		}
		if release.Classification != ClassificationRequired {
			continue
		}
		if release.GraceEndsAt != nil {
			graceEnd, parseErr := time.Parse(time.RFC3339Nano, *release.GraceEndsAt)
			if parseErr == nil && s.now().Before(graceEnd) {
				if VersionGreater(release.Version, clientVersion) {
					value := *release.GraceEndsAt
					activeGrace = &value
				}
				continue
			}
		}
		if effectiveMinimum == "" || VersionGreater(release.Version, effectiveMinimum) {
			effectiveMinimum = release.Version
		}
	}
	compatibility.MinimumClientVersion = effectiveMinimum
	compatibility.RecommendedClientVersion = effectiveRecommended
	if compatibility.Status == "compatible" && effectiveMinimum != "" && VersionGreater(effectiveMinimum, clientVersion) {
		compatibility.Status = "upgrade_required"
		compatibility.ReasonCode = "required_release"
		compatibility.Message = "This Raven version must be updated before it can safely use communication services."
	}
	if compatibility.Status == "compatible" && activeGrace != nil {
		compatibility.ReasonCode = "required_release_grace_period"
		compatibility.Message = "A required Raven update is in its configured grace period."
		compatibility.GraceEndsAt = activeGrace
	}
	blocks, err := s.store.ListVersionBlocks(true)
	if err != nil {
		return Compatibility{}, err
	}
	for _, block := range blocks {
		if block.Channel != nil && *block.Channel != channel {
			continue
		}
		if VersionMatches(clientVersion, block.VersionRange) {
			compatibility.Status = "blocked"
			compatibility.ReasonCode = "installed_version_blocked"
			compatibility.Message = block.Reason
			return compatibility, nil
		}
	}
	return compatibility, nil
}

func (s *Service) ServerVersion() string {
	return s.serverPolicy.ServerVersion
}

func (s *Service) ConsentVersion() string {
	return s.consentVersion
}

func (s *Service) ServiceAccessCompatibility(clientVersion string, protocolVersion int, capabilities []string, channel, cohort string) (Compatibility, error) {
	return s.EffectiveServerCompatibility(clientVersion, protocolVersion, capabilities, channel, cohort)
}

func (s *Service) CreateRelease(input CreateReleaseInput, actor Actor) (Release, error) {
	normalized, err := validateCreateRelease(input)
	if err != nil {
		return Release{}, err
	}
	return s.store.CreateRelease(normalized, actor, s.now())
}

func (s *Service) ValidateRelease(ctx context.Context, id string, actor Actor) (Release, error) {
	release, err := s.store.GetRelease(id)
	if err != nil {
		return Release{}, err
	}
	if release.State != StateDraft || len(release.Artifacts) != 2 {
		return Release{}, fmt.Errorf("%w: validation requires one Windows and one Linux artifact", ErrConflict)
	}
	requiredTargets := map[string]bool{"windows/x86_64": false, "linux/x86_64": false}
	for _, artifact := range release.Artifacts {
		key := artifact.Platform + "/" + artifact.Architecture
		if _, ok := requiredTargets[key]; !ok || requiredTargets[key] {
			return Release{}, fmt.Errorf("%w: duplicate or unsupported artifact target", ErrConflict)
		}
		requiredTargets[key] = true
		prefix := fmt.Sprintf("desktop/%s/%s/%s/%s/", release.Channel, release.Version, artifact.Platform, artifact.Architecture)
		for _, objectKey := range []string{artifact.ObjectKey, artifact.ChecksumObjectKey, artifact.SBOMObjectKey, artifact.ProvenanceObjectKey} {
			if !strings.HasPrefix(objectKey, prefix) {
				return Release{}, fmt.Errorf("%w: artifact object path is outside its immutable release prefix", ErrConflict)
			}
		}
		object, err := s.artifacts.Head(ctx, artifact.ObjectKey)
		if err != nil {
			return Release{}, fmt.Errorf("artifact %s: %w", key, err)
		}
		if object.Size != artifact.Size || !strings.EqualFold(object.SHA256, artifact.SHA256) {
			return Release{}, fmt.Errorf("%w: artifact metadata does not match the registered size or hash", ErrConflict)
		}
		for _, evidence := range []struct {
			key  string
			hash string
		}{{artifact.ChecksumObjectKey, artifact.ChecksumSHA256}, {artifact.SBOMObjectKey, artifact.SBOMSHA256}, {artifact.ProvenanceObjectKey, artifact.ProvenanceSHA256}} {
			info, err := s.artifacts.Head(ctx, evidence.key)
			if err != nil {
				return Release{}, fmt.Errorf("release metadata object: %w", err)
			}
			if info.Size <= 0 || !strings.EqualFold(info.SHA256, evidence.hash) {
				return Release{}, fmt.Errorf("%w: release metadata hash does not match", ErrConflict)
			}
		}
	}
	return s.store.MarkValidated(id, actor, s.now())
}

func (s *Service) CreateVersionBlock(block VersionBlock, actor Actor) (VersionBlock, error) {
	block.VersionRange = strings.TrimSpace(block.VersionRange)
	block.Reason = strings.TrimSpace(block.Reason)
	if err := ValidateVersionRange(block.VersionRange); err != nil {
		return VersionBlock{}, err
	}
	if block.Reason == "" {
		return VersionBlock{}, errors.New("a version block reason is required")
	}
	if block.Channel != nil {
		channel, err := NormalizeChannel(*block.Channel)
		if err != nil {
			return VersionBlock{}, err
		}
		block.Channel = &channel
	}
	if block.TargetReleaseID != nil {
		target, err := s.store.GetRelease(*block.TargetReleaseID)
		if err != nil {
			return VersionBlock{}, err
		}
		if VersionMatches(target.Version, block.VersionRange) || block.Channel != nil && target.Channel != *block.Channel || target.State != StateRollingOut && target.State != StateFullyReleased {
			return VersionBlock{}, fmt.Errorf("%w: block target must be published, in the same channel, and outside the blocked range", ErrConflict)
		}
		if len(target.Artifacts) != 2 {
			return VersionBlock{}, fmt.Errorf("%w: block target does not have complete artifacts", ErrConflict)
		}
		for _, artifact := range target.Artifacts {
			if artifact.VerifiedAt == nil {
				return VersionBlock{}, fmt.Errorf("%w: block target is not verified", ErrConflict)
			}
		}
		blocked, err := s.store.VersionBlocked(target.Version, target.Channel)
		if err != nil {
			return VersionBlock{}, err
		}
		if blocked {
			return VersionBlock{}, fmt.Errorf("%w: block target is not safe", ErrConflict)
		}
	}
	return s.store.CreateVersionBlock(block, actor, s.now())
}

func (s *Service) releaseCompatibleWithServer(release Release) bool {
	if s.serverPolicy.ProtocolVersion > 0 && release.ClientProtocolVersion != s.serverPolicy.ProtocolVersion {
		return false
	}
	if release.MinimumServerVersion != nil && VersionGreater(*release.MinimumServerVersion, s.serverPolicy.ServerVersion) {
		return false
	}
	if release.MaximumServerVersion != nil && VersionGreater(s.serverPolicy.ServerVersion, *release.MaximumServerVersion) {
		return false
	}
	return true
}

func (s *Service) Decision(client ClientContext) (Decision, error) {
	client, bucket, digest, decision, err := s.prepareClient(client)
	if err != nil || decision != nil {
		if decision != nil {
			return *decision, err
		}
		return Decision{}, err
	}
	if err := s.store.Enroll(digest, bucket, client, s.now()); err != nil {
		return Decision{}, err
	}
	return s.selectDecision(client, bucket, "")
}

func (s *Service) Revalidate(releaseID string, client ClientContext) (Decision, error) {
	client, bucket, digest, decision, err := s.prepareClient(client)
	if err != nil || decision != nil {
		if decision != nil {
			return *decision, err
		}
		return Decision{}, err
	}
	if err := s.store.Enroll(digest, bucket, client, s.now()); err != nil {
		return Decision{}, err
	}
	return s.selectDecision(client, bucket, releaseID)
}

func (s *Service) RollbackDecision(sourceReleaseID string, client ClientContext) (Decision, error) {
	client, bucket, digest, early, err := s.prepareClient(client)
	if err != nil || early != nil {
		if early != nil {
			return *early, err
		}
		return Decision{}, err
	}
	if err := s.store.Enroll(digest, bucket, client, s.now()); err != nil {
		return Decision{}, err
	}
	source, err := s.store.GetRelease(sourceReleaseID)
	if err != nil {
		return Decision{}, err
	}
	base := Decision{Decision: "rollback_refused", Classification: ClassificationBlocked, ReasonCode: "rollback_not_safe", Message: "Raven cannot safely return to the previous version.", RolloutBucket: bucket, Eligible: false, Compatibility: EvaluateServerCompatibility(s.serverPolicy, client.CurrentVersion, client.ProtocolVersion, client.Capabilities), ConsentVersion: s.consentVersion}
	if source.Version != client.CurrentVersion || !source.RollbackSafe || !source.LocalMigrationReversible || source.ApprovedRollbackReleaseID == nil {
		return base, nil
	}
	target, err := s.store.GetRelease(*source.ApprovedRollbackReleaseID)
	if err != nil {
		return base, nil
	}
	blocked, err := s.store.VersionBlocked(target.Version, target.Channel)
	if err != nil {
		return Decision{}, err
	}
	artifact := artifactFor(target, client.Target, client.Architecture)
	if blocked || artifact == nil || artifact.VerifiedAt == nil || target.ClientProtocolVersion != client.ProtocolVersion || target.LocalDataSchemaVersion > source.LocalDataSchemaVersion {
		base.ReasonCode = "rollback_target_unavailable"
		return base, nil
	}
	compatibility := EvaluateReleaseCompatibility(target, client, s.now())
	if !compatibleForInstall(compatibility) {
		base.Compatibility = compatibility
		base.ReasonCode = "rollback_target_incompatible"
		return base, nil
	}
	base.Decision = "rollback_available"
	base.Classification = ClassificationRecommended
	base.ReasonCode = "approved_rollback"
	base.Message = "The approved previous Raven version can be restored because this release declared its local migration reversible."
	base.Eligible = true
	base.Compatibility = compatibility
	base.Release = &target
	base.Artifact = artifact
	return base, nil
}

func (s *Service) IssueDownloadGrant(artifact Artifact, release Release, installationID string) (string, error) {
	digest, _, err := InstallationDigestAndBucket(installationID)
	if err != nil {
		return "", err
	}
	token, tokenHash, err := secureToken()
	if err != nil {
		return "", err
	}
	now := s.now()
	if err := s.store.SaveDownloadGrant(tokenHash, artifact.ID, digest, release.Revision, now, now.Add(10*time.Minute)); err != nil {
		return "", err
	}
	return token, nil
}

func (s *Service) PresignArtifact(ctx context.Context, artifactID, eligibilityToken string) (string, error) {
	revision, err := s.store.ValidateDownloadGrant(tokenDigest(eligibilityToken), artifactID, s.now())
	if err != nil {
		return "", err
	}
	artifact, release, err := s.store.GetArtifact(artifactID)
	if err != nil {
		return "", err
	}
	if release.Revision != revision || artifact.VerifiedAt == nil || release.State == StateDraft || release.State == StateValidated || release.State == StatePaused || release.State == StateWithdrawn {
		return "", ErrNotFound
	}
	channel, err := s.store.GetChannel(release.Channel)
	if err != nil || !channel.Enabled {
		return "", ErrNotFound
	}
	blocked, err := s.store.VersionBlocked(release.Version, release.Channel)
	if err != nil {
		return "", err
	}
	if blocked {
		return "", ErrNotFound
	}
	if release.State == StateSuperseded {
		approvedSafeRollback := false
		releases, listErr := s.store.ListReleases()
		if listErr != nil {
			return "", listErr
		}
		for _, source := range releases {
			if source.ApprovedRollbackReleaseID != nil && *source.ApprovedRollbackReleaseID == release.ID && source.RollbackSafe && source.LocalMigrationReversible && source.ClientProtocolVersion == release.ClientProtocolVersion {
				approvedSafeRollback = true
				break
			}
		}
		if !approvedSafeRollback {
			return "", ErrNotFound
		}
	}
	return s.artifacts.PresignGet(ctx, artifact.ObjectKey, s.presignExpiry)
}

func (s *Service) RecordOutcome(input OutcomeInput) (bool, error) {
	if !input.Consent {
		return false, nil
	}
	input.EventID = strings.TrimSpace(input.EventID)
	input.ReleaseID = strings.TrimSpace(input.ReleaseID)
	input.FromVersion = strings.TrimSpace(input.FromVersion)
	input.ToVersion = strings.TrimSpace(input.ToVersion)
	input.Stage = strings.ToLower(strings.TrimSpace(input.Stage))
	input.Outcome = strings.ToLower(strings.TrimSpace(input.Outcome))
	input.ErrorCategory = strings.ToLower(strings.TrimSpace(input.ErrorCategory))
	if input.EventID == "" || len(input.EventID) > 200 || input.FromVersion == "" {
		return false, errors.New("eventId and fromVersion are required")
	}
	if _, err := NormalizeVersion(input.FromVersion); err != nil {
		return false, err
	}
	if input.ToVersion != "" {
		if _, err := NormalizeVersion(input.ToVersion); err != nil {
			return false, err
		}
	}
	platform, architecture, err := NormalizeTarget(input.Platform, input.Architecture)
	if err != nil {
		return false, err
	}
	input.Platform, input.Architecture = platform, architecture
	if !oneOf(input.Stage, "check", "download", "verification", "installation", "startup", "rollback") || !oneOf(input.Outcome, "success", "failure", "deferred", "cancelled") || !coarseValue(input.ErrorCategory) {
		return false, errors.New("outcome stage, result, or error category is invalid")
	}
	return s.store.RecordOutcome(input, s.now())
}

func (s *Service) RecordDiagnostic(input DiagnosticInput) (DiagnosticReport, error) {
	if !input.Consent {
		return DiagnosticReport{}, nil
	}
	if input.Payload == nil {
		return DiagnosticReport{}, errors.New("diagnostic payload is required")
	}
	input.ReleaseID = strings.TrimSpace(input.ReleaseID)
	input.Payload = RedactDiagnostic(input.Payload)
	encoded, err := json.Marshal(input.Payload)
	if err != nil {
		return DiagnosticReport{}, err
	}
	if len(encoded) > 256*1024 {
		return DiagnosticReport{}, errors.New("diagnostic payload exceeds 256 KiB")
	}
	return s.store.RecordDiagnostic(input, s.now())
}

func (s *Service) CreateOpsSession(userID, authSessionID, password string) (OpsSession, error) {
	admin, err := s.store.IsReleaseAdministrator(userID)
	if err != nil || !admin {
		return OpsSession{}, ErrNotFound
	}
	hash, err := s.store.PasswordHash(userID)
	if err != nil || !auth.VerifyPassword(hash, password) {
		return OpsSession{}, ErrNotFound
	}
	token, tokenHash, err := secureToken()
	if err != nil {
		return OpsSession{}, err
	}
	now := s.now()
	expires := now.Add(15 * time.Minute)
	if err := s.store.SaveOpsSession(tokenHash, userID, authSessionID, now, expires); err != nil {
		return OpsSession{}, err
	}
	return OpsSession{Token: token, ExpiresAt: timestamp(expires)}, nil
}

func (s *Service) ValidateOpsSession(token, userID, authSessionID string) error {
	if strings.TrimSpace(token) == "" {
		return ErrNotFound
	}
	return s.store.ValidateOpsSession(tokenDigest(token), userID, authSessionID, s.now())
}

func (s *Service) AuthorizeAction(opsToken, userID, authSessionID, password, action, subject string) (ActionAuthorization, error) {
	if err := s.ValidateOpsSession(opsToken, userID, authSessionID); err != nil {
		return ActionAuthorization{}, err
	}
	hash, err := s.store.PasswordHash(userID)
	if err != nil || !auth.VerifyPassword(hash, password) {
		return ActionAuthorization{}, ErrNotFound
	}
	action = strings.ToLower(strings.TrimSpace(action))
	subject = strings.TrimSpace(subject)
	expected, err := s.expectedConfirmation(action, subject)
	if err != nil {
		return ActionAuthorization{}, err
	}
	token, tokenHash, err := secureToken()
	if err != nil {
		return ActionAuthorization{}, err
	}
	now := s.now()
	expires := now.Add(5 * time.Minute)
	if err := s.store.SaveActionAuthorization(tokenHash, tokenDigest(opsToken), userID, action, subject, expected, now, expires); err != nil {
		return ActionAuthorization{}, err
	}
	return ActionAuthorization{Token: token, ExpectedConfirmation: expected, ExpiresAt: timestamp(expires)}, nil
}

func (s *Service) ConsumeAction(opsToken, actionToken, userID, action, subject, confirmation, reason string) error {
	if strings.TrimSpace(reason) == "" {
		return errors.New("a reason is required")
	}
	return s.store.ConsumeActionAuthorization(tokenDigest(actionToken), tokenDigest(opsToken), userID, action, subject, confirmation, s.now())
}

func (s *Service) expectedConfirmation(action, subject string) (string, error) {
	switch action {
	case "publish_required":
		release, err := s.store.GetRelease(subject)
		if err != nil {
			return "", err
		}
		return "PUBLISH " + release.Version + " AS REQUIRED", nil
	case "withdraw_release":
		release, err := s.store.GetRelease(subject)
		if err != nil {
			return "", err
		}
		return "WITHDRAW " + release.Version, nil
	case "block_version":
		if err := ValidateVersionRange(subject); err != nil {
			return "", err
		}
		return "BLOCK " + subject, nil
	case "unblock_version":
		if err := ValidateVersionRange(subject); err != nil {
			return "", err
		}
		return "UNBLOCK " + subject, nil
	case "disable_channel":
		channel, err := NormalizeChannel(subject)
		if err != nil {
			return "", err
		}
		return "DISABLE " + channel, nil
	default:
		return "", errors.New("unsupported high-risk action")
	}
}

func (s *Service) prepareClient(client ClientContext) (ClientContext, int, string, *Decision, error) {
	client.CurrentVersion = strings.TrimSpace(client.CurrentVersion)
	version, err := NormalizeVersion(client.CurrentVersion)
	if err != nil {
		return client, 0, "", nil, err
	}
	client.CurrentVersion = version
	client.Channel, err = NormalizeChannel(client.Channel)
	if err != nil {
		return client, 0, "", nil, err
	}
	client.Target, client.Architecture, err = NormalizeTarget(client.Target, client.Architecture)
	if err != nil {
		return client, 0, "", nil, err
	}
	client.Cohort = strings.ToLower(strings.TrimSpace(client.Cohort))
	if client.Cohort == "" {
		client.Cohort = "friends"
	}
	digest, bucket, err := InstallationDigestAndBucket(client.InstallationID)
	if err != nil {
		return client, 0, "", nil, err
	}
	serverCompatibility := EvaluateServerCompatibility(s.serverPolicy, client.CurrentVersion, client.ProtocolVersion, client.Capabilities)
	base := Decision{RolloutBucket: bucket, Compatibility: serverCompatibility, ConsentVersion: s.consentVersion}
	if !client.ConsentAccepted || strings.TrimSpace(client.ConsentVersion) != s.consentVersion {
		if err := s.store.RevokeEnrollment(digest); err != nil {
			return client, bucket, digest, nil, err
		}
		base.Decision = "consent_required"
		base.ReasonCode = "managed_updates_consent_required"
		base.Message = "Accept the disclosed minimum update-delivery data before enrolling this Raven installation."
		return client, bucket, digest, &base, nil
	}
	channel, err := s.store.GetChannel(client.Channel)
	if err != nil {
		return client, bucket, digest, nil, err
	}
	if !channel.Enabled {
		base.Decision = "channel_disabled"
		base.ReasonCode = "channel_disabled"
		base.Message = "This Raven update channel is currently disabled. " + channel.DisabledReason
		return client, bucket, digest, &base, nil
	}
	if client.Cohort != "friends" {
		assigned, assignmentErr := s.store.AssignedCohort(digest)
		if assignmentErr != nil && !errors.Is(assignmentErr, ErrNotFound) {
			return client, bucket, digest, nil, assignmentErr
		}
		if assignmentErr != nil || assigned != client.Cohort {
			base.Decision = "ineligible"
			base.ReasonCode = "cohort_assignment_required"
			base.Message = "This installation has not been assigned to the requested Raven update cohort."
			return client, bucket, digest, &base, nil
		}
	}
	active, err := s.store.CohortActive(client.Cohort)
	if err != nil {
		return client, bucket, digest, nil, err
	}
	if !active {
		base.Decision = "ineligible"
		base.ReasonCode = "cohort_inactive"
		base.Message = "This update cohort is not currently active."
		return client, bucket, digest, &base, nil
	}
	return client, bucket, digest, nil, nil
}

func (s *Service) selectDecision(client ClientContext, bucket int, onlyReleaseID string) (Decision, error) {
	serverCompatibility := EvaluateServerCompatibility(s.serverPolicy, client.CurrentVersion, client.ProtocolVersion, client.Capabilities)
	base := Decision{Decision: "no_update", ReasonCode: "current", Message: "Raven is up to date for this channel and cohort.", RolloutBucket: bucket, Compatibility: serverCompatibility, ConsentVersion: s.consentVersion}
	blocks, err := s.store.ListVersionBlocks(true)
	if err != nil {
		return Decision{}, err
	}
	var installedBlock *VersionBlock
	for index := range blocks {
		block := &blocks[index]
		if block.Channel != nil && *block.Channel != client.Channel {
			continue
		}
		if VersionMatches(client.CurrentVersion, block.VersionRange) {
			installedBlock = block
			break
		}
	}
	releases, err := s.store.ListReleases()
	if err != nil {
		return Decision{}, err
	}
	sort.SliceStable(releases, func(i, j int) bool { return VersionGreater(releases[i].Version, releases[j].Version) })
	if onlyReleaseID != "" {
		filtered := releases[:0]
		for _, release := range releases {
			if release.ID == onlyReleaseID {
				filtered = append(filtered, release)
			}
		}
		releases = filtered
		if len(releases) == 0 {
			return Decision{}, ErrNotFound
		}
	}
	if installedBlock != nil && installedBlock.TargetReleaseID != nil {
		for index := range releases {
			if releases[index].ID == *installedBlock.TargetReleaseID {
				return s.decisionForRelease(base, client, bucket, releases[index], true, installedBlock), nil
			}
		}
	}
	if installedBlock != nil && onlyReleaseID != "" {
		return s.decisionForRelease(base, client, bucket, releases[0], true, installedBlock), nil
	}
	for _, release := range releases {
		if release.Channel != client.Channel || !VersionGreater(release.Version, client.CurrentVersion) {
			continue
		}
		if installedBlock != nil || release.Classification == ClassificationRequired {
			decision := s.decisionForRelease(base, client, bucket, release, true, installedBlock)
			if decision.Release != nil || installedBlock != nil {
				return decision, nil
			}
			continue
		}
		decision := s.decisionForRelease(base, client, bucket, release, false, nil)
		if decision.Decision != "no_update" {
			return decision, nil
		}
	}
	if installedBlock != nil {
		base.Decision = "blocked"
		base.Classification = ClassificationBlocked
		base.ReasonCode = "installed_version_blocked"
		base.Message = installedBlock.Reason
		base.Block = installedBlock
		base.Compatibility.Status = "blocked"
		base.Compatibility.ReasonCode = "installed_version_blocked"
		base.Compatibility.Message = installedBlock.Reason
	}
	if onlyReleaseID != "" && base.Decision == "no_update" {
		base.Decision = "release_unavailable"
		base.ReasonCode = "release_no_longer_discoverable"
		base.Message = "The downloaded Raven release is no longer approved for installation."
	}
	return base, nil
}

func (s *Service) decisionForRelease(base Decision, client ClientContext, bucket int, release Release, bypassPercentage bool, block *VersionBlock) Decision {
	if !releaseDiscoverable(release, client.Cohort) {
		if block != nil {
			base.Decision = "blocked"
			base.Classification = ClassificationBlocked
			base.ReasonCode = "blocked_without_safe_target"
			base.Message = block.Reason
			base.Block = block
		}
		return base
	}
	artifact := artifactFor(release, client.Target, client.Architecture)
	if artifact == nil || artifact.VerifiedAt == nil {
		if block != nil {
			base.Decision = "blocked"
			base.Classification = ClassificationBlocked
			base.ReasonCode = "blocked_without_verified_artifact"
			base.Message = block.Reason
			base.Block = block
		}
		return base
	}
	compatibility := EvaluateReleaseCompatibility(release, client, s.now())
	if !compatibleForInstall(compatibility) {
		base.Decision = "incompatible"
		base.Classification = release.Classification
		base.ReasonCode = compatibility.ReasonCode
		base.Message = compatibility.Message
		base.Compatibility = compatibility
		base.Release = &release
		if block != nil {
			base.Decision = "blocked"
			base.Classification = ClassificationBlocked
			base.Block = block
		}
		return base
	}
	eligible := bypassPercentage
	if !eligible {
		for _, rollout := range release.Rollouts {
			if rollout.Cohort == client.Cohort {
				eligible = EligibleForPercentage(bucket, rollout.PercentageBasisPoints)
				break
			}
		}
	}
	if !eligible {
		base.Decision = "ineligible"
		base.ReasonCode = "outside_rollout_percentage"
		base.Message = "This Raven installation is not in the current rollout percentage."
		base.Compatibility = compatibility
		return base
	}
	base.Decision = "update_available"
	base.Classification = release.Classification
	base.ReasonCode = release.Classification + "_update_available"
	base.Message = "A Raven update is available."
	base.RolloutBucket = bucket
	base.Eligible = true
	base.Compatibility = compatibility
	base.Release = &release
	base.Artifact = artifact
	if block != nil {
		base.Decision = "blocked"
		base.Classification = ClassificationBlocked
		base.ReasonCode = "installed_version_blocked"
		base.Message = block.Reason
		base.Block = block
		base.Compatibility.Status = "blocked"
		base.Compatibility.ReasonCode = "installed_version_blocked"
		base.Compatibility.Message = block.Reason
	}
	return base
}

func validateCreateRelease(input CreateReleaseInput) (CreateReleaseInput, error) {
	version, err := NormalizeVersion(input.Version)
	if err != nil {
		return input, err
	}
	input.Version = version
	input.Channel, err = NormalizeChannel(input.Channel)
	if err != nil {
		return input, err
	}
	input.Classification, err = NormalizeClassification(input.Classification)
	if err != nil {
		return input, err
	}
	input.Notes = strings.TrimSpace(input.Notes)
	input.GitCommit = strings.ToLower(strings.TrimSpace(input.GitCommit))
	if input.Notes == "" || !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(input.GitCommit) || input.ClientProtocolVersion < 1 {
		return input, errors.New("release notes, a 40-character Git commit, and a positive protocol version are required")
	}
	if input.LocalDataSchemaVersion < 1 {
		return input, errors.New("localDataSchemaVersion must be positive")
	}
	if input.RollbackSafe && !input.LocalMigrationReversible {
		return input, errors.New("rollbackSafe requires localMigrationReversible")
	}
	input.RequiredCapabilities = NormalizeCapabilities(input.RequiredCapabilities)
	for _, value := range []*string{input.MinimumServerVersion, input.MaximumServerVersion} {
		if value != nil && strings.TrimSpace(*value) != "" {
			normalized, err := NormalizeVersion(*value)
			if err != nil {
				return input, err
			}
			*value = normalized
		}
	}
	if input.MinimumServerVersion != nil && input.MaximumServerVersion != nil && VersionGreater(*input.MinimumServerVersion, *input.MaximumServerVersion) {
		return input, errors.New("minimumServerVersion must not exceed maximumServerVersion")
	}
	if input.GraceEndsAt != nil {
		if _, err := time.Parse(time.RFC3339Nano, *input.GraceEndsAt); err != nil {
			return input, errors.New("graceEndsAt must be an RFC3339 timestamp")
		}
	}
	if len(input.Artifacts) == 0 || len(input.Artifacts) > 2 {
		return input, errors.New("one or two release artifacts are required")
	}
	seen := map[string]bool{}
	hashPattern := regexp.MustCompile(`^[0-9a-f]{64}$`)
	for index := range input.Artifacts {
		artifact := &input.Artifacts[index]
		artifact.Platform, artifact.Architecture, err = NormalizeTarget(artifact.Platform, artifact.Architecture)
		if err != nil {
			return input, err
		}
		key := artifact.Platform + "/" + artifact.Architecture
		if seen[key] {
			return input, errors.New("artifact targets must be unique")
		}
		seen[key] = true
		artifact.Format = strings.ToLower(strings.TrimSpace(artifact.Format))
		artifact.ObjectKey = cleanObjectKey(artifact.ObjectKey)
		artifact.ChecksumObjectKey = cleanObjectKey(artifact.ChecksumObjectKey)
		artifact.ChecksumSHA256 = strings.ToLower(strings.TrimSpace(artifact.ChecksumSHA256))
		artifact.SBOMObjectKey = cleanObjectKey(artifact.SBOMObjectKey)
		artifact.ProvenanceObjectKey = cleanObjectKey(artifact.ProvenanceObjectKey)
		artifact.Signature = strings.TrimSpace(artifact.Signature)
		artifact.SHA256 = strings.ToLower(strings.TrimSpace(artifact.SHA256))
		artifact.SBOMSHA256 = strings.ToLower(strings.TrimSpace(artifact.SBOMSHA256))
		artifact.ProvenanceSHA256 = strings.ToLower(strings.TrimSpace(artifact.ProvenanceSHA256))
		prefix := fmt.Sprintf("desktop/%s/%s/%s/%s/", input.Channel, input.Version, artifact.Platform, artifact.Architecture)
		if artifact.Size <= 0 || artifact.Signature == "" || !hashPattern.MatchString(artifact.SHA256) || !hashPattern.MatchString(artifact.ChecksumSHA256) || !hashPattern.MatchString(artifact.SBOMSHA256) || !hashPattern.MatchString(artifact.ProvenanceSHA256) || !strings.HasPrefix(artifact.ObjectKey, prefix) || !strings.HasPrefix(artifact.ChecksumObjectKey, prefix) || !strings.HasPrefix(artifact.SBOMObjectKey, prefix) || !strings.HasPrefix(artifact.ProvenanceObjectKey, prefix) {
			return input, errors.New("artifact metadata or immutable object path is invalid")
		}
	}
	return input, nil
}

func releaseDiscoverable(release Release, cohort string) bool {
	if release.State == StatePaused || release.State == StateDraft || release.State == StateValidated || release.State == StateWithdrawn || release.State == StateSuperseded {
		return false
	}
	if release.State == StateInternal && cohort != "internal" && cohort != "staging" {
		return false
	}
	return release.State == StateInternal || release.State == StateRollingOut || release.State == StateFullyReleased
}

func releaseFullyVerified(release Release) bool {
	if len(release.Artifacts) != 2 {
		return false
	}
	for _, artifact := range release.Artifacts {
		if artifact.VerifiedAt == nil {
			return false
		}
	}
	return true
}

func artifactFor(release Release, target, architecture string) *Artifact {
	for index := range release.Artifacts {
		if release.Artifacts[index].Platform == target && release.Artifacts[index].Architecture == architecture {
			artifact := release.Artifacts[index]
			return &artifact
		}
	}
	return nil
}

func compatibleForInstall(value Compatibility) bool {
	return value.Status == "compatible" || value.Status == "grace_period"
}

func secureToken() (string, string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", "", err
	}
	token := base64.RawURLEncoding.EncodeToString(bytes)
	return token, tokenDigest(token), nil
}

func tokenDigest(token string) string {
	hash := sha256.Sum256([]byte(strings.TrimSpace(token)))
	return hex.EncodeToString(hash[:])
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func coarseValue(value string) bool {
	return value == "" || regexp.MustCompile(`^[a-z0-9_-]{1,64}$`).MatchString(value)
}

func cleanObjectKey(value string) string {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\\", "/"))
	if strings.HasPrefix(value, "/") || strings.Contains(value, "../") || strings.Contains(value, "/..") {
		return ""
	}
	return value
}

var sensitiveKey = regexp.MustCompile(`(?i)(authorization|cookie|token|password|secret|credential|access.?key|database.?url|livekit|session.?id|account.?id|user.?id|ip.?address)`)
var bearerValue = regexp.MustCompile(`(?i)bearer\s+[a-z0-9._~+/=-]+`)
var homePathValue = regexp.MustCompile(`(?i)[a-z]:\\users\\[^\\\s]+`)
var unixHomePathValue = regexp.MustCompile(`(?:/home/|/Users/)[^/\s]+`)
var ipv4Value = regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}\b`)
var credentialURLValue = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*://)[^/@\s]+@`)
var sensitiveQueryValue = regexp.MustCompile(`(?i)([?&](?:token|session_?id|signature|credential|authorization|access_?key|x-amz-signature|x-amz-credential)=)[^&#\s]+`)

func RedactDiagnostic(payload map[string]any) map[string]any {
	redacted, _ := redactValue(payload).(map[string]any)
	return redacted
}

func redactValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			if sensitiveKey.MatchString(key) {
				result[key] = "[redacted]"
			} else {
				result[key] = redactValue(item)
			}
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for index, item := range typed {
			result[index] = redactValue(item)
		}
		return result
	case string:
		result := bearerValue.ReplaceAllString(typed, "[redacted]")
		result = homePathValue.ReplaceAllString(result, "[home]")
		result = unixHomePathValue.ReplaceAllString(result, "[home]")
		result = ipv4Value.ReplaceAllString(result, "[ip]")
		result = credentialURLValue.ReplaceAllString(result, "$1[redacted]@")
		return sensitiveQueryValue.ReplaceAllString(result, "$1[redacted]")
	default:
		return typed
	}
}
