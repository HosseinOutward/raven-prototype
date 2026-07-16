package updates

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"
)

var (
	ErrNotFound = errors.New("update resource not found")
	ErrConflict = errors.New("update resource conflict")
)

type Store struct {
	db *database.DB
}

func NewStore(db *database.DB) *Store {
	return &Store{db: db}
}

func (s *Store) CreateRelease(input CreateReleaseInput, actor Actor, now time.Time) (Release, error) {
	release := Release{
		ID:                       auth.NewID(),
		Version:                  input.Version,
		Channel:                  input.Channel,
		Classification:           input.Classification,
		State:                    StateDraft,
		Notes:                    input.Notes,
		GitCommit:                input.GitCommit,
		ClientProtocolVersion:    input.ClientProtocolVersion,
		MinimumServerVersion:     input.MinimumServerVersion,
		MaximumServerVersion:     input.MaximumServerVersion,
		RequiredCapabilities:     input.RequiredCapabilities,
		GraceEndsAt:              input.GraceEndsAt,
		LocalDataSchemaVersion:   input.LocalDataSchemaVersion,
		LocalMigrationReversible: input.LocalMigrationReversible,
		RollbackSafe:             input.RollbackSafe,
		Revision:                 1,
		CreatedByUserID:          actor.UserID,
		CreatedAt:                timestamp(now),
		UpdatedAt:                timestamp(now),
		Artifacts:                []Artifact{},
		Rollouts:                 []Rollout{},
	}
	capabilities, _ := json.Marshal(release.RequiredCapabilities)
	tx, err := s.db.Begin()
	if err != nil {
		return Release{}, err
	}
	defer tx.Rollback()
	_, err = tx.Exec(
		`INSERT INTO update_releases (id, version, channel, classification, state, notes, git_commit, client_protocol_version, minimum_server_version, maximum_server_version, required_capabilities_json, grace_ends_at, local_data_schema_version, local_migration_reversible, rollback_safe, revision, created_by_user_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		release.ID, release.Version, release.Channel, release.Classification, release.State, release.Notes, release.GitCommit,
		release.ClientProtocolVersion, release.MinimumServerVersion, release.MaximumServerVersion, string(capabilities), release.GraceEndsAt, release.LocalDataSchemaVersion, release.LocalMigrationReversible, release.RollbackSafe,
		release.Revision, release.CreatedByUserID, release.CreatedAt, release.UpdatedAt,
	)
	if err != nil {
		if database.IsUniqueViolation(err) {
			return Release{}, ErrConflict
		}
		return Release{}, err
	}
	for _, inputArtifact := range input.Artifacts {
		artifact := Artifact{
			ID:                  auth.NewID(),
			ReleaseID:           release.ID,
			Platform:            inputArtifact.Platform,
			Architecture:        inputArtifact.Architecture,
			Format:              inputArtifact.Format,
			ObjectKey:           inputArtifact.ObjectKey,
			Signature:           inputArtifact.Signature,
			SHA256:              inputArtifact.SHA256,
			Size:                inputArtifact.Size,
			ChecksumObjectKey:   inputArtifact.ChecksumObjectKey,
			ChecksumSHA256:      inputArtifact.ChecksumSHA256,
			SBOMObjectKey:       inputArtifact.SBOMObjectKey,
			SBOMSHA256:          inputArtifact.SBOMSHA256,
			ProvenanceObjectKey: inputArtifact.ProvenanceObjectKey,
			ProvenanceSHA256:    inputArtifact.ProvenanceSHA256,
			CreatedAt:           timestamp(now),
		}
		_, err = tx.Exec(
			`INSERT INTO update_release_artifacts (id, release_id, platform, architecture, format, object_key, signature, sha256, size_bytes, checksum_object_key, checksum_sha256, sbom_object_key, sbom_sha256, provenance_object_key, provenance_sha256, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			artifact.ID, artifact.ReleaseID, artifact.Platform, artifact.Architecture, artifact.Format, artifact.ObjectKey,
			artifact.Signature, artifact.SHA256, artifact.Size, artifact.ChecksumObjectKey, artifact.ChecksumSHA256, artifact.SBOMObjectKey,
			artifact.SBOMSHA256, artifact.ProvenanceObjectKey, artifact.ProvenanceSHA256, artifact.CreatedAt,
		)
		if err != nil {
			if database.IsUniqueViolation(err) {
				return Release{}, ErrConflict
			}
			return Release{}, err
		}
		release.Artifacts = append(release.Artifacts, artifact)
	}
	if err := insertAudit(tx, actor, "create_release", "release", release.ID, nil, release, "Release draft registered.", now); err != nil {
		return Release{}, err
	}
	if err := tx.Commit(); err != nil {
		return Release{}, err
	}
	return release, nil
}

func (s *Store) GetRelease(id string) (Release, error) {
	var release Release
	var paused, minimumServer, maximumServer, grace, superseded, rollback, creator, validated, published, withdrawn sql.NullString
	var capabilities string
	err := s.db.QueryRow(releaseSelect+` WHERE id = ?`, id).Scan(
		&release.ID, &release.Version, &release.Channel, &release.Classification, &release.State, &paused, &release.Notes,
		&release.GitCommit, &release.ClientProtocolVersion, &minimumServer, &maximumServer, &capabilities, &grace, &release.LocalDataSchemaVersion, &release.LocalMigrationReversible, &release.RollbackSafe,
		&superseded, &rollback, &release.Revision, &creator, &release.CreatedAt, &release.UpdatedAt, &validated, &published, &withdrawn,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Release{}, ErrNotFound
	}
	if err != nil {
		return Release{}, err
	}
	release.PausedFromState = nullable(paused)
	release.MinimumServerVersion = nullable(minimumServer)
	release.MaximumServerVersion = nullable(maximumServer)
	release.GraceEndsAt = nullable(grace)
	release.SupersededByReleaseID = nullable(superseded)
	release.ApprovedRollbackReleaseID = nullable(rollback)
	release.CreatedByUserID = nullable(creator)
	release.ValidatedAt = nullable(validated)
	release.PublishedAt = nullable(published)
	release.WithdrawnAt = nullable(withdrawn)
	_ = json.Unmarshal([]byte(capabilities), &release.RequiredCapabilities)
	if release.RequiredCapabilities == nil {
		release.RequiredCapabilities = []string{}
	}
	release.Artifacts, err = s.releaseArtifacts(release.ID)
	if err != nil {
		return Release{}, err
	}
	release.Rollouts, err = s.releaseRollouts(release.ID)
	return release, err
}

func (s *Store) ListReleases() ([]Release, error) {
	rows, err := s.db.Query(`SELECT id FROM update_releases ORDER BY created_at DESC, id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	releases := make([]Release, 0, len(ids))
	for _, id := range ids {
		release, err := s.GetRelease(id)
		if err != nil {
			return nil, err
		}
		releases = append(releases, release)
	}
	return releases, nil
}

func (s *Store) UpdateReleaseState(id, target, reason string, actor Actor, now time.Time) (Release, error) {
	current, err := s.GetRelease(id)
	if err != nil {
		return Release{}, err
	}
	if !ValidLifecycleTransition(current.State, target) {
		return Release{}, ErrConflict
	}
	next := current
	next.State = target
	next.Revision++
	next.UpdatedAt = timestamp(now)
	if target == StatePaused {
		value := current.State
		next.PausedFromState = &value
	}
	if current.State == StatePaused {
		next.PausedFromState = nil
	}
	if target == StateWithdrawn {
		value := timestamp(now)
		next.WithdrawnAt = &value
	}
	if target == StateInternal || target == StateRollingOut || target == StateFullyReleased {
		if next.PublishedAt == nil {
			value := timestamp(now)
			next.PublishedAt = &value
		}
	}
	action := "transition_release_" + target
	tx, err := s.db.Begin()
	if err != nil {
		return Release{}, err
	}
	defer tx.Rollback()
	result, err := tx.Exec(
		`UPDATE update_releases SET state = ?, paused_from_state = ?, revision = ?, updated_at = ?, published_at = ?, withdrawn_at = ? WHERE id = ? AND revision = ?`,
		next.State, next.PausedFromState, next.Revision, next.UpdatedAt, next.PublishedAt, next.WithdrawnAt, next.ID, current.Revision,
	)
	if err != nil {
		return Release{}, err
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return Release{}, ErrConflict
	}
	if err := insertAudit(tx, actor, action, "release", id, current, next, reason, now); err != nil {
		return Release{}, err
	}
	if err := tx.Commit(); err != nil {
		return Release{}, err
	}
	return next, nil
}

func (s *Store) MarkValidated(id string, actor Actor, now time.Time) (Release, error) {
	current, err := s.GetRelease(id)
	if err != nil {
		return Release{}, err
	}
	if current.State != StateDraft {
		return Release{}, ErrConflict
	}
	next := current
	next.State = StateValidated
	next.Revision++
	next.UpdatedAt = timestamp(now)
	verifiedAt := timestamp(now)
	next.ValidatedAt = &verifiedAt
	for index := range next.Artifacts {
		next.Artifacts[index].VerifiedAt = &verifiedAt
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Release{}, err
	}
	defer tx.Rollback()
	result, err := tx.Exec(`UPDATE update_releases SET state = ?, revision = ?, updated_at = ?, validated_at = ? WHERE id = ? AND revision = ?`, next.State, next.Revision, next.UpdatedAt, verifiedAt, id, current.Revision)
	if err != nil {
		return Release{}, err
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return Release{}, ErrConflict
	}
	if _, err := tx.Exec(`UPDATE update_release_artifacts SET verified_at = ? WHERE release_id = ?`, verifiedAt, id); err != nil {
		return Release{}, err
	}
	if err := insertAudit(tx, actor, "validate_release", "release", id, current, next, "Artifacts and release policy validated.", now); err != nil {
		return Release{}, err
	}
	if err := tx.Commit(); err != nil {
		return Release{}, err
	}
	return next, nil
}

func (s *Store) SetRollouts(id string, inputs []RolloutInput, reason string, actor Actor, now time.Time) (Release, error) {
	current, err := s.GetRelease(id)
	if err != nil {
		return Release{}, err
	}
	if current.State == StateDraft || current.State == StateWithdrawn || current.State == StateSuperseded {
		return Release{}, ErrConflict
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Release{}, err
	}
	defer tx.Rollback()
	for _, input := range inputs {
		basisPoints := int(input.Percentage*100 + 0.5)
		_, err := tx.Exec(
			`INSERT INTO update_rollouts (release_id, cohort_name, percentage_basis_points, revision, created_at, updated_at, updated_by_user_id)
			 VALUES (?, ?, ?, 1, ?, ?, ?)
			 ON CONFLICT(release_id, cohort_name) DO UPDATE SET percentage_basis_points = excluded.percentage_basis_points, revision = update_rollouts.revision + 1, updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id`,
			id, input.Cohort, basisPoints, timestamp(now), timestamp(now), actor.UserID,
		)
		if err != nil {
			return Release{}, err
		}
	}
	result, err := tx.Exec(`UPDATE update_releases SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`, timestamp(now), id, current.Revision)
	if err != nil {
		return Release{}, err
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return Release{}, ErrConflict
	}
	next := current
	next.Revision++
	next.UpdatedAt = timestamp(now)
	if err := insertAudit(tx, actor, "configure_rollouts", "release", id, current.Rollouts, inputs, reason, now); err != nil {
		return Release{}, err
	}
	if err := tx.Commit(); err != nil {
		return Release{}, err
	}
	return s.GetRelease(id)
}

func (s *Store) Publish(id, targetState string, inputs []RolloutInput, reason string, actor Actor, now time.Time) (Release, error) {
	current, err := s.GetRelease(id)
	if err != nil {
		return Release{}, err
	}
	if !ValidLifecycleTransition(current.State, targetState) || targetState != StateInternal && targetState != StateRollingOut && targetState != StateFullyReleased {
		return Release{}, ErrConflict
	}
	next := current
	next.State = targetState
	next.PausedFromState = nil
	next.Revision++
	next.UpdatedAt = timestamp(now)
	if next.PublishedAt == nil {
		published := timestamp(now)
		next.PublishedAt = &published
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Release{}, err
	}
	defer tx.Rollback()
	for _, input := range inputs {
		basisPoints := int(input.Percentage*100 + 0.5)
		_, err := tx.Exec(
			`INSERT INTO update_rollouts (release_id, cohort_name, percentage_basis_points, revision, created_at, updated_at, updated_by_user_id)
			 VALUES (?, ?, ?, 1, ?, ?, ?)
			 ON CONFLICT(release_id, cohort_name) DO UPDATE SET percentage_basis_points = excluded.percentage_basis_points, revision = update_rollouts.revision + 1, updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id`,
			id, input.Cohort, basisPoints, timestamp(now), timestamp(now), actor.UserID,
		)
		if err != nil {
			return Release{}, err
		}
	}
	result, err := tx.Exec(`UPDATE update_releases SET state = ?, paused_from_state = NULL, revision = ?, updated_at = ?, published_at = ? WHERE id = ? AND revision = ?`, next.State, next.Revision, next.UpdatedAt, next.PublishedAt, id, current.Revision)
	if err != nil {
		return Release{}, err
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return Release{}, ErrConflict
	}
	if err := insertAudit(tx, actor, "publish_release", "release", id, current, map[string]any{"state": targetState, "rollouts": inputs}, reason, now); err != nil {
		return Release{}, err
	}
	if err := tx.Commit(); err != nil {
		return Release{}, err
	}
	return s.GetRelease(id)
}

func (s *Store) SetRequired(id, reason string, actor Actor, now time.Time) (Release, error) {
	current, err := s.GetRelease(id)
	if err != nil {
		return Release{}, err
	}
	if current.State == StateDraft || current.State == StateWithdrawn || current.State == StateSuperseded {
		return Release{}, ErrConflict
	}
	next := current
	next.Classification = ClassificationRequired
	next.Revision++
	next.UpdatedAt = timestamp(now)
	tx, err := s.db.Begin()
	if err != nil {
		return Release{}, err
	}
	defer tx.Rollback()
	result, err := tx.Exec(`UPDATE update_releases SET classification = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?`, next.Classification, next.Revision, next.UpdatedAt, id, current.Revision)
	if err != nil {
		return Release{}, err
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return Release{}, ErrConflict
	}
	if err := insertAudit(tx, actor, "mark_release_required", "release", id, current, next, reason, now); err != nil {
		return Release{}, err
	}
	if err := tx.Commit(); err != nil {
		return Release{}, err
	}
	return next, nil
}

func (s *Store) SetRollbackTarget(id string, targetID *string, reason string, actor Actor, now time.Time) (Release, error) {
	current, err := s.GetRelease(id)
	if err != nil {
		return Release{}, err
	}
	if targetID != nil {
		if !current.RollbackSafe || !current.LocalMigrationReversible {
			return Release{}, ErrConflict
		}
		target, err := s.GetRelease(*targetID)
		if err != nil {
			return Release{}, err
		}
		validTargetState := target.State == StateRollingOut || target.State == StateFullyReleased || target.State == StateSuperseded
		if target.Channel != current.Channel || !VersionGreater(current.Version, target.Version) || !validTargetState || target.ClientProtocolVersion != current.ClientProtocolVersion {
			return Release{}, ErrConflict
		}
		blocked, err := s.VersionBlocked(target.Version, target.Channel)
		if err != nil {
			return Release{}, err
		}
		if blocked {
			return Release{}, ErrConflict
		}
		for _, artifact := range target.Artifacts {
			if artifact.VerifiedAt == nil {
				return Release{}, ErrConflict
			}
		}
	}
	next := current
	next.ApprovedRollbackReleaseID = targetID
	next.Revision++
	next.UpdatedAt = timestamp(now)
	tx, err := s.db.Begin()
	if err != nil {
		return Release{}, err
	}
	defer tx.Rollback()
	result, err := tx.Exec(`UPDATE update_releases SET approved_rollback_release_id = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?`, targetID, next.Revision, next.UpdatedAt, id, current.Revision)
	if err != nil {
		return Release{}, err
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return Release{}, ErrConflict
	}
	if err := insertAudit(tx, actor, "set_rollback_target", "release", id, current.ApprovedRollbackReleaseID, targetID, reason, now); err != nil {
		return Release{}, err
	}
	if err := tx.Commit(); err != nil {
		return Release{}, err
	}
	return next, nil
}

func (s *Store) VersionBlocked(version, channel string) (bool, error) {
	blocks, err := s.ListVersionBlocks(true)
	if err != nil {
		return false, err
	}
	for _, block := range blocks {
		if block.Channel != nil && *block.Channel != channel {
			continue
		}
		if VersionMatches(version, block.VersionRange) {
			return true, nil
		}
	}
	return false, nil
}

func (s *Store) Supersede(id, newerID, reason string, actor Actor, now time.Time) (Release, error) {
	current, err := s.GetRelease(id)
	if err != nil {
		return Release{}, err
	}
	newer, err := s.GetRelease(newerID)
	if err != nil {
		return Release{}, err
	}
	if newer.Channel != current.Channel || !VersionGreater(newer.Version, current.Version) || !ValidLifecycleTransition(current.State, StateSuperseded) {
		return Release{}, ErrConflict
	}
	next := current
	next.State = StateSuperseded
	next.SupersededByReleaseID = &newerID
	next.Revision++
	next.UpdatedAt = timestamp(now)
	tx, err := s.db.Begin()
	if err != nil {
		return Release{}, err
	}
	defer tx.Rollback()
	result, err := tx.Exec(`UPDATE update_releases SET state = ?, superseded_by_release_id = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?`, next.State, newerID, next.Revision, next.UpdatedAt, id, current.Revision)
	if err != nil {
		return Release{}, err
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return Release{}, ErrConflict
	}
	if err := insertAudit(tx, actor, "supersede_release", "release", id, current, next, reason, now); err != nil {
		return Release{}, err
	}
	if err := tx.Commit(); err != nil {
		return Release{}, err
	}
	return next, nil
}

func (s *Store) ListChannels() ([]Channel, error) {
	rows, err := s.db.Query(`SELECT name, enabled, disabled_reason, revision, created_at, updated_at, updated_by_user_id FROM update_channels ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	channels := []Channel{}
	for rows.Next() {
		var channel Channel
		var updatedBy sql.NullString
		if err := rows.Scan(&channel.Name, &channel.Enabled, &channel.DisabledReason, &channel.Revision, &channel.CreatedAt, &channel.UpdatedAt, &updatedBy); err != nil {
			return nil, err
		}
		channel.UpdatedByID = nullable(updatedBy)
		channels = append(channels, channel)
	}
	return channels, rows.Err()
}

func (s *Store) GetChannel(name string) (Channel, error) {
	var channel Channel
	var updatedBy sql.NullString
	err := s.db.QueryRow(`SELECT name, enabled, disabled_reason, revision, created_at, updated_at, updated_by_user_id FROM update_channels WHERE name = ?`, name).Scan(&channel.Name, &channel.Enabled, &channel.DisabledReason, &channel.Revision, &channel.CreatedAt, &channel.UpdatedAt, &updatedBy)
	if errors.Is(err, sql.ErrNoRows) {
		return Channel{}, ErrNotFound
	}
	channel.UpdatedByID = nullable(updatedBy)
	return channel, err
}

func (s *Store) SetChannel(name string, enabled bool, reason string, actor Actor, now time.Time) (Channel, error) {
	current, err := s.GetChannel(name)
	if err != nil {
		return Channel{}, err
	}
	next := current
	next.Enabled = enabled
	next.DisabledReason = ""
	if !enabled {
		next.DisabledReason = reason
	}
	next.Revision++
	next.UpdatedAt = timestamp(now)
	next.UpdatedByID = actor.UserID
	tx, err := s.db.Begin()
	if err != nil {
		return Channel{}, err
	}
	defer tx.Rollback()
	result, err := tx.Exec(`UPDATE update_channels SET enabled = ?, disabled_reason = ?, revision = ?, updated_at = ?, updated_by_user_id = ? WHERE name = ? AND revision = ?`, next.Enabled, next.DisabledReason, next.Revision, next.UpdatedAt, next.UpdatedByID, name, current.Revision)
	if err != nil {
		return Channel{}, err
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return Channel{}, ErrConflict
	}
	action := "enable_channel"
	if !enabled {
		action = "disable_channel"
	}
	if err := insertAudit(tx, actor, action, "channel", name, current, next, reason, now); err != nil {
		return Channel{}, err
	}
	if err := tx.Commit(); err != nil {
		return Channel{}, err
	}
	return next, nil
}

func (s *Store) ListCohorts() ([]Cohort, error) {
	rows, err := s.db.Query(`SELECT name, description, active, created_at, updated_at FROM update_cohorts ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cohorts := []Cohort{}
	for rows.Next() {
		var cohort Cohort
		if err := rows.Scan(&cohort.Name, &cohort.Description, &cohort.Active, &cohort.CreatedAt, &cohort.UpdatedAt); err != nil {
			return nil, err
		}
		cohorts = append(cohorts, cohort)
	}
	return cohorts, rows.Err()
}

func (s *Store) CohortActive(name string) (bool, error) {
	var active bool
	err := s.db.QueryRow(`SELECT active FROM update_cohorts WHERE name = ?`, name).Scan(&active)
	if errors.Is(err, sql.ErrNoRows) {
		return false, ErrNotFound
	}
	return active, err
}

func (s *Store) AssignedCohort(installationDigest string) (string, error) {
	var cohort string
	err := s.db.QueryRow(`SELECT cohort_name FROM update_cohort_assignments WHERE installation_digest = ?`, installationDigest).Scan(&cohort)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return cohort, err
}

func (s *Store) AssignInstallationCohort(installationID, cohort, reason string, actor Actor, now time.Time) (CohortAssignment, error) {
	digest, _, err := InstallationDigestAndBucket(installationID)
	if err != nil {
		return CohortAssignment{}, err
	}
	cohort = strings.ToLower(strings.TrimSpace(cohort))
	active, err := s.CohortActive(cohort)
	if err != nil || !active {
		return CohortAssignment{}, ErrNotFound
	}
	if strings.TrimSpace(reason) == "" {
		return CohortAssignment{}, errors.New("a cohort assignment reason is required")
	}
	previous, previousErr := s.AssignedCohort(digest)
	if previousErr != nil && !errors.Is(previousErr, ErrNotFound) {
		return CohortAssignment{}, previousErr
	}
	assignment := CohortAssignment{Cohort: cohort, AssignedAt: timestamp(now)}
	tx, err := s.db.Begin()
	if err != nil {
		return CohortAssignment{}, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM update_download_grants WHERE installation_digest = ?`, digest); err != nil {
		return CohortAssignment{}, err
	}
	_, err = tx.Exec(
		`INSERT INTO update_cohort_assignments (installation_digest, cohort_name, assigned_by_user_id, reason, assigned_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(installation_digest) DO UPDATE SET cohort_name = excluded.cohort_name, assigned_by_user_id = excluded.assigned_by_user_id, reason = excluded.reason, updated_at = excluded.updated_at`,
		digest, cohort, actor.UserID, strings.TrimSpace(reason), assignment.AssignedAt, assignment.AssignedAt,
	)
	if err != nil {
		return CohortAssignment{}, err
	}
	var previousValue any
	if previousErr == nil {
		previousValue = map[string]string{"cohort": previous}
	}
	if err := insertAudit(tx, actor, "assign_update_cohort", "cohort_assignment", auth.NewID(), previousValue, assignment, reason, now); err != nil {
		return CohortAssignment{}, err
	}
	if err := tx.Commit(); err != nil {
		return CohortAssignment{}, err
	}
	return assignment, nil
}

func (s *Store) CreateVersionBlock(block VersionBlock, actor Actor, now time.Time) (VersionBlock, error) {
	block.ID = auth.NewID()
	block.Active = true
	block.CreatedByUserID = actor.UserID
	block.CreatedAt = timestamp(now)
	block.UpdatedAt = block.CreatedAt
	tx, err := s.db.Begin()
	if err != nil {
		return VersionBlock{}, err
	}
	defer tx.Rollback()
	_, err = tx.Exec(`INSERT INTO update_version_blocks (id, version_range, channel, reason, target_release_id, active, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, TRUE, ?, ?, ?)`, block.ID, block.VersionRange, block.Channel, block.Reason, block.TargetReleaseID, block.CreatedByUserID, block.CreatedAt, block.UpdatedAt)
	if err != nil {
		return VersionBlock{}, err
	}
	if err := insertAudit(tx, actor, "block_version", "version_block", block.ID, nil, block, block.Reason, now); err != nil {
		return VersionBlock{}, err
	}
	if err := tx.Commit(); err != nil {
		return VersionBlock{}, err
	}
	return block, nil
}

func (s *Store) GetVersionBlock(id string) (VersionBlock, error) {
	var block VersionBlock
	var channel, target, creator sql.NullString
	err := s.db.QueryRow(`SELECT id, version_range, channel, reason, target_release_id, active, created_by_user_id, created_at, updated_at FROM update_version_blocks WHERE id = ?`, id).Scan(&block.ID, &block.VersionRange, &channel, &block.Reason, &target, &block.Active, &creator, &block.CreatedAt, &block.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return VersionBlock{}, ErrNotFound
	}
	if err != nil {
		return VersionBlock{}, err
	}
	block.Channel = nullable(channel)
	block.TargetReleaseID = nullable(target)
	block.CreatedByUserID = nullable(creator)
	return block, nil
}

func (s *Store) DeactivateVersionBlock(id, reason string, actor Actor, now time.Time) (VersionBlock, error) {
	current, err := s.GetVersionBlock(id)
	if err != nil {
		return VersionBlock{}, err
	}
	if !current.Active {
		return VersionBlock{}, ErrConflict
	}
	next := current
	next.Active = false
	next.UpdatedAt = timestamp(now)
	tx, err := s.db.Begin()
	if err != nil {
		return VersionBlock{}, err
	}
	defer tx.Rollback()
	result, err := tx.Exec(`UPDATE update_version_blocks SET active = FALSE, updated_at = ? WHERE id = ? AND active = TRUE`, next.UpdatedAt, id)
	if err != nil {
		return VersionBlock{}, err
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return VersionBlock{}, ErrConflict
	}
	if err := insertAudit(tx, actor, "deactivate_version_block", "version_block", id, current, next, reason, now); err != nil {
		return VersionBlock{}, err
	}
	if err := tx.Commit(); err != nil {
		return VersionBlock{}, err
	}
	return next, nil
}

func (s *Store) ListVersionBlocks(activeOnly bool) ([]VersionBlock, error) {
	query := `SELECT id, version_range, channel, reason, target_release_id, active, created_by_user_id, created_at, updated_at FROM update_version_blocks`
	if activeOnly {
		query += ` WHERE active = TRUE`
	}
	query += ` ORDER BY created_at DESC, id DESC`
	rows, err := s.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	blocks := []VersionBlock{}
	for rows.Next() {
		var block VersionBlock
		var channel, target, creator sql.NullString
		if err := rows.Scan(&block.ID, &block.VersionRange, &channel, &block.Reason, &target, &block.Active, &creator, &block.CreatedAt, &block.UpdatedAt); err != nil {
			return nil, err
		}
		block.Channel = nullable(channel)
		block.TargetReleaseID = nullable(target)
		block.CreatedByUserID = nullable(creator)
		blocks = append(blocks, block)
	}
	return blocks, rows.Err()
}

func (s *Store) Enroll(digest string, bucket int, client ClientContext, now time.Time) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		`DELETE FROM update_download_grants WHERE installation_digest = ? AND EXISTS (
			SELECT 1 FROM update_enrollments WHERE installation_digest = ? AND (channel <> ? OR cohort_name <> ?)
		)`,
		digest, digest, client.Channel, client.Cohort,
	); err != nil {
		return err
	}
	_, err = tx.Exec(
		`INSERT INTO update_enrollments (installation_digest, rollout_bucket, channel, cohort_name, consent_version, enrolled_at, updated_at, revoked_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
		 ON CONFLICT(installation_digest) DO UPDATE SET channel = excluded.channel, cohort_name = excluded.cohort_name, consent_version = excluded.consent_version, updated_at = excluded.updated_at, revoked_at = NULL`,
		digest, bucket, client.Channel, client.Cohort, client.ConsentVersion, timestamp(now), timestamp(now),
	)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) RevokeEnrollment(digest string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM update_download_grants WHERE installation_digest = ?`, digest); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM update_enrollments WHERE installation_digest = ?`, digest); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM update_cohort_assignments WHERE installation_digest = ?`, digest); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ListAudit(limit int) ([]AuditEvent, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	rows, err := s.db.Query(`SELECT id, actor_user_id, actor_label, action, entity_type, entity_id, previous_state_json, new_state_json, reason, correlation_id, idempotency_key, created_at FROM release_audit_events ORDER BY created_at DESC, id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []AuditEvent{}
	for rows.Next() {
		var event AuditEvent
		var actorID, previous, next, idempotency sql.NullString
		if err := rows.Scan(&event.ID, &actorID, &event.ActorLabel, &event.Action, &event.EntityType, &event.EntityID, &previous, &next, &event.Reason, &event.CorrelationID, &idempotency, &event.CreatedAt); err != nil {
			return nil, err
		}
		event.ActorUserID = nullable(actorID)
		event.PreviousStateJSON = nullable(previous)
		event.NewStateJSON = nullable(next)
		event.IdempotencyKey = nullable(idempotency)
		events = append(events, event)
	}
	return events, rows.Err()
}

func (s *Store) releaseArtifacts(releaseID string) ([]Artifact, error) {
	rows, err := s.db.Query(`SELECT id, release_id, platform, architecture, format, object_key, signature, sha256, size_bytes, checksum_object_key, checksum_sha256, sbom_object_key, sbom_sha256, provenance_object_key, provenance_sha256, verified_at, created_at FROM update_release_artifacts WHERE release_id = ? ORDER BY platform, architecture`, releaseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	artifacts := []Artifact{}
	for rows.Next() {
		var artifact Artifact
		var verified sql.NullString
		if err := rows.Scan(&artifact.ID, &artifact.ReleaseID, &artifact.Platform, &artifact.Architecture, &artifact.Format, &artifact.ObjectKey, &artifact.Signature, &artifact.SHA256, &artifact.Size, &artifact.ChecksumObjectKey, &artifact.ChecksumSHA256, &artifact.SBOMObjectKey, &artifact.SBOMSHA256, &artifact.ProvenanceObjectKey, &artifact.ProvenanceSHA256, &verified, &artifact.CreatedAt); err != nil {
			return nil, err
		}
		artifact.VerifiedAt = nullable(verified)
		artifacts = append(artifacts, artifact)
	}
	return artifacts, rows.Err()
}

func (s *Store) GetArtifact(id string) (Artifact, Release, error) {
	var artifact Artifact
	var verified sql.NullString
	err := s.db.QueryRow(`SELECT id, release_id, platform, architecture, format, object_key, signature, sha256, size_bytes, checksum_object_key, checksum_sha256, sbom_object_key, sbom_sha256, provenance_object_key, provenance_sha256, verified_at, created_at FROM update_release_artifacts WHERE id = ?`, id).Scan(&artifact.ID, &artifact.ReleaseID, &artifact.Platform, &artifact.Architecture, &artifact.Format, &artifact.ObjectKey, &artifact.Signature, &artifact.SHA256, &artifact.Size, &artifact.ChecksumObjectKey, &artifact.ChecksumSHA256, &artifact.SBOMObjectKey, &artifact.SBOMSHA256, &artifact.ProvenanceObjectKey, &artifact.ProvenanceSHA256, &verified, &artifact.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Artifact{}, Release{}, ErrNotFound
	}
	if err != nil {
		return Artifact{}, Release{}, err
	}
	artifact.VerifiedAt = nullable(verified)
	release, err := s.GetRelease(artifact.ReleaseID)
	return artifact, release, err
}

func (s *Store) releaseRollouts(releaseID string) ([]Rollout, error) {
	rows, err := s.db.Query(`SELECT release_id, cohort_name, percentage_basis_points, revision, created_at, updated_at, updated_by_user_id FROM update_rollouts WHERE release_id = ? ORDER BY cohort_name`, releaseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rollouts := []Rollout{}
	for rows.Next() {
		var rollout Rollout
		var updatedBy sql.NullString
		if err := rows.Scan(&rollout.ReleaseID, &rollout.Cohort, &rollout.PercentageBasisPoints, &rollout.Revision, &rollout.CreatedAt, &rollout.UpdatedAt, &updatedBy); err != nil {
			return nil, err
		}
		rollout.Percentage = float64(rollout.PercentageBasisPoints) / 100
		rollout.UpdatedByUserID = nullable(updatedBy)
		rollouts = append(rollouts, rollout)
	}
	return rollouts, rows.Err()
}

func insertAudit(tx *database.Tx, actor Actor, action, entityType, entityID string, previous, next any, reason string, now time.Time) error {
	previousJSON, err := optionalJSON(previous)
	if err != nil {
		return err
	}
	nextJSON, err := optionalJSON(next)
	if err != nil {
		return err
	}
	label := strings.TrimSpace(actor.Label)
	if label == "" {
		label = "system"
	}
	correlationID := strings.TrimSpace(actor.CorrelationID)
	if correlationID == "" {
		correlationID = auth.NewID()
	}
	var idempotency *string
	if value := strings.TrimSpace(actor.IdempotencyKey); value != "" {
		idempotency = &value
	}
	_, err = tx.Exec(
		`INSERT INTO release_audit_events (id, actor_user_id, actor_label, action, entity_type, entity_id, previous_state_json, new_state_json, reason, correlation_id, idempotency_key, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		auth.NewID(), actor.UserID, label, action, entityType, entityID, previousJSON, nextJSON, strings.TrimSpace(reason), correlationID, idempotency, timestamp(now),
	)
	if err != nil && database.IsUniqueViolation(err) {
		return fmt.Errorf("%w: idempotency key already used", ErrConflict)
	}
	return err
}

func optionalJSON(value any) (*string, error) {
	if value == nil {
		return nil, nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	text := string(encoded)
	return &text, nil
}

func nullable(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

func timestamp(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

const releaseSelect = `SELECT id, version, channel, classification, state, paused_from_state, notes, git_commit, client_protocol_version, minimum_server_version, maximum_server_version, required_capabilities_json, grace_ends_at, local_data_schema_version, local_migration_reversible, rollback_safe, superseded_by_release_id, approved_rollback_release_id, revision, created_by_user_id, created_at, updated_at, validated_at, published_at, withdrawn_at FROM update_releases`
