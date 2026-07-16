package updates

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"raven/services/api/internal/auth"
)

type ReleaseAdministrator struct {
	UserID      string  `json:"userId"`
	Username    string  `json:"username"`
	GrantedByID *string `json:"grantedByUserId,omitempty"`
	GrantedAt   string  `json:"grantedAt"`
	RevokedAt   *string `json:"revokedAt,omitempty"`
}

func (s *Store) IsReleaseAdministrator(userID string) (bool, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM release_administrators WHERE user_id = ? AND revoked_at IS NULL`, userID).Scan(&count)
	return count == 1, err
}

func (s *Store) GrantReleaseAdministrator(username string, grantedByID *string, now time.Time) (ReleaseAdministrator, error) {
	var userID, canonicalUsername string
	err := s.db.QueryRow(`SELECT id, username FROM users WHERE username = ?`, strings.TrimSpace(username)).Scan(&userID, &canonicalUsername)
	if errors.Is(err, sql.ErrNoRows) {
		return ReleaseAdministrator{}, ErrNotFound
	}
	if err != nil {
		return ReleaseAdministrator{}, err
	}
	_, err = s.db.Exec(
		`INSERT INTO release_administrators (user_id, granted_by_user_id, granted_at, revoked_at) VALUES (?, ?, ?, NULL)
		 ON CONFLICT(user_id) DO UPDATE SET granted_by_user_id = excluded.granted_by_user_id, granted_at = excluded.granted_at, revoked_at = NULL`,
		userID, grantedByID, timestamp(now),
	)
	if err != nil {
		return ReleaseAdministrator{}, err
	}
	return ReleaseAdministrator{UserID: userID, Username: canonicalUsername, GrantedByID: grantedByID, GrantedAt: timestamp(now)}, nil
}

func (s *Store) RevokeReleaseAdministrator(username string, now time.Time) error {
	result, err := s.db.Exec(`UPDATE release_administrators SET revoked_at = ? WHERE user_id = (SELECT id FROM users WHERE username = ?) AND revoked_at IS NULL`, timestamp(now), strings.TrimSpace(username))
	if err != nil {
		return err
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ListReleaseAdministrators() ([]ReleaseAdministrator, error) {
	rows, err := s.db.Query(`SELECT ra.user_id, u.username, ra.granted_by_user_id, ra.granted_at, ra.revoked_at FROM release_administrators ra JOIN users u ON u.id = ra.user_id ORDER BY u.username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	admins := []ReleaseAdministrator{}
	for rows.Next() {
		var admin ReleaseAdministrator
		var grantedBy, revoked sql.NullString
		if err := rows.Scan(&admin.UserID, &admin.Username, &grantedBy, &admin.GrantedAt, &revoked); err != nil {
			return nil, err
		}
		admin.GrantedByID = nullable(grantedBy)
		admin.RevokedAt = nullable(revoked)
		admins = append(admins, admin)
	}
	return admins, rows.Err()
}

func (s *Store) PasswordHash(userID string) (string, error) {
	var hash string
	err := s.db.QueryRow(`SELECT password_hash FROM users WHERE id = ?`, userID).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return hash, err
}

func (s *Store) SaveOpsSession(tokenHash, userID, authSessionID string, now, expiresAt time.Time) error {
	_, err := s.db.Exec(`INSERT INTO release_ops_sessions (token_hash, user_id, auth_session_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`, tokenHash, userID, authSessionID, timestamp(now), timestamp(expiresAt))
	return err
}

func (s *Store) ValidateOpsSession(tokenHash, userID, authSessionID string, now time.Time) error {
	var expiresAt string
	err := s.db.QueryRow(`SELECT expires_at FROM release_ops_sessions WHERE token_hash = ? AND user_id = ? AND auth_session_id = ? AND revoked_at IS NULL`, tokenHash, userID, authSessionID).Scan(&expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	expires, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil || !now.Before(expires) {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SaveActionAuthorization(tokenHash, opsHash, userID, action, subject, expected string, now, expiresAt time.Time) error {
	_, err := s.db.Exec(`INSERT INTO release_action_authorizations (token_hash, ops_session_hash, user_id, action, subject, expected_confirmation, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, tokenHash, opsHash, userID, action, subject, expected, timestamp(now), timestamp(expiresAt))
	return err
}

func (s *Store) SaveDownloadGrant(tokenHash, artifactID, installationDigest string, releaseRevision int64, now, expiresAt time.Time) error {
	_, err := s.db.Exec(`INSERT INTO update_download_grants (token_hash, artifact_id, installation_digest, release_revision, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`, tokenHash, artifactID, installationDigest, releaseRevision, timestamp(now), timestamp(expiresAt))
	return err
}

func (s *Store) ValidateDownloadGrant(tokenHash, artifactID string, now time.Time) (int64, error) {
	var releaseRevision int64
	var expiresAt string
	err := s.db.QueryRow(`SELECT release_revision, expires_at FROM update_download_grants WHERE token_hash = ? AND artifact_id = ?`, tokenHash, artifactID).Scan(&releaseRevision, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	expires, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil || !now.Before(expires) {
		return 0, ErrNotFound
	}
	return releaseRevision, nil
}

func (s *Store) ConsumeActionAuthorization(tokenHash, opsHash, userID, action, subject, confirmation string, now time.Time) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var expected, expiresAt string
	err = tx.QueryRow(`SELECT expected_confirmation, expires_at FROM release_action_authorizations WHERE token_hash = ? AND ops_session_hash = ? AND user_id = ? AND action = ? AND subject = ? AND consumed_at IS NULL`, tokenHash, opsHash, userID, action, subject).Scan(&expected, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	expires, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil || !now.Before(expires) || confirmation != expected {
		return ErrNotFound
	}
	result, err := tx.Exec(`UPDATE release_action_authorizations SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL`, timestamp(now), tokenHash)
	if err != nil {
		return err
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return ErrConflict
	}
	return tx.Commit()
}

func (s *Store) RecordOutcome(input OutcomeInput, now time.Time) (bool, error) {
	eventHashBytes := sha256.Sum256([]byte("raven-update-outcome-v1\x00" + strings.TrimSpace(input.EventID)))
	eventHash := hex.EncodeToString(eventHashBytes[:])
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	result, err := tx.Exec(`INSERT INTO update_outcome_dedup (event_hash, expires_at) VALUES (?, ?) ON CONFLICT(event_hash) DO NOTHING`, eventHash, timestamp(now.Add(30*24*time.Hour)))
	if err != nil {
		return false, err
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return false, nil
	}
	_, err = tx.Exec(
		`INSERT INTO update_outcome_daily (day, release_id, from_version, to_version, platform, architecture, stage, outcome, error_category, count, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
		 ON CONFLICT(day, release_id, from_version, to_version, platform, architecture, stage, outcome, error_category)
		 DO UPDATE SET count = update_outcome_daily.count + 1, updated_at = excluded.updated_at`,
		now.UTC().Format("2006-01-02"), input.ReleaseID, input.FromVersion, input.ToVersion, input.Platform, input.Architecture,
		input.Stage, input.Outcome, input.ErrorCategory, timestamp(now),
	)
	if err != nil {
		return false, err
	}
	_, _ = tx.Exec(`DELETE FROM update_outcome_dedup WHERE expires_at < ?`, timestamp(now))
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) ListOutcomes(limit int) ([]OutcomeMetric, error) {
	if limit <= 0 || limit > 5000 {
		limit = 1000
	}
	rows, err := s.db.Query(`SELECT day, release_id, from_version, to_version, platform, architecture, stage, outcome, error_category, count, updated_at FROM update_outcome_daily ORDER BY day DESC, updated_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	metrics := []OutcomeMetric{}
	for rows.Next() {
		var metric OutcomeMetric
		if err := rows.Scan(&metric.Day, &metric.ReleaseID, &metric.FromVersion, &metric.ToVersion, &metric.Platform, &metric.Architecture, &metric.Stage, &metric.Outcome, &metric.ErrorCategory, &metric.Count, &metric.UpdatedAt); err != nil {
			return nil, err
		}
		metrics = append(metrics, metric)
	}
	return metrics, rows.Err()
}

func (s *Store) RecordDiagnostic(input DiagnosticInput, now time.Time) (DiagnosticReport, error) {
	report := DiagnosticReport{
		ID:        auth.NewID(),
		ReleaseID: input.ReleaseID,
		Payload:   input.Payload,
		CreatedAt: timestamp(now),
		ExpiresAt: timestamp(now.Add(14 * 24 * time.Hour)),
	}
	payload, err := json.Marshal(report.Payload)
	if err != nil {
		return DiagnosticReport{}, err
	}
	_, err = s.db.Exec(`INSERT INTO update_diagnostic_reports (id, release_id, payload_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`, report.ID, nullableString(report.ReleaseID), string(payload), report.CreatedAt, report.ExpiresAt)
	return report, err
}

func (s *Store) ListDiagnostics(limit int, now time.Time) ([]DiagnosticReport, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	_, _ = s.db.Exec(`DELETE FROM update_diagnostic_reports WHERE expires_at < ?`, timestamp(now))
	rows, err := s.db.Query(`SELECT id, release_id, payload_json, created_at, expires_at FROM update_diagnostic_reports WHERE expires_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?`, timestamp(now), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	reports := []DiagnosticReport{}
	for rows.Next() {
		var report DiagnosticReport
		var releaseID sql.NullString
		var payload string
		if err := rows.Scan(&report.ID, &releaseID, &payload, &report.CreatedAt, &report.ExpiresAt); err != nil {
			return nil, err
		}
		if releaseID.Valid {
			report.ReleaseID = releaseID.String
		}
		if err := json.Unmarshal([]byte(payload), &report.Payload); err != nil {
			return nil, err
		}
		reports = append(reports, report)
	}
	return reports, rows.Err()
}

func (s *Store) CleanupRetention(now time.Time) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM update_outcome_dedup WHERE expires_at < ?`, timestamp(now)); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM update_diagnostic_reports WHERE expires_at < ?`, timestamp(now)); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM release_action_authorizations WHERE expires_at < ?`, timestamp(now)); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM release_ops_sessions WHERE expires_at < ?`, timestamp(now)); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM update_download_grants WHERE expires_at < ?`, timestamp(now)); err != nil {
		return err
	}
	return tx.Commit()
}

func nullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.TrimSpace(value)
}
