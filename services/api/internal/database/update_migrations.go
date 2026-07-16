package database

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

type updateMigration struct {
	version    string
	statements []string
}

func migrateUpdateControl(db *sql.DB, driver string) error {
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version TEXT PRIMARY KEY,
		checksum TEXT NOT NULL,
		applied_at TEXT NOT NULL
	)`); err != nil {
		return err
	}

	migrations := []updateMigration{{
		version:    "2026071201_update_control",
		statements: updateControlStatements(driver),
	}}
	for _, migration := range migrations {
		if err := applyUpdateMigration(db, driver, migration); err != nil {
			return err
		}
	}
	return nil
}

func applyUpdateMigration(db *sql.DB, driver string, migration updateMigration) error {
	hash := sha256.Sum256([]byte(strings.Join(migration.statements, "\n")))
	checksum := hex.EncodeToString(hash[:])
	var appliedChecksum string
	err := db.QueryRow(rebind(driver, `SELECT checksum FROM schema_migrations WHERE version = ?`), migration.version).Scan(&appliedChecksum)
	if err == nil {
		if appliedChecksum != checksum {
			return fmt.Errorf("migration %s checksum mismatch", migration.version)
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, statement := range migration.statements {
		if _, err := tx.Exec(statement); err != nil {
			return fmt.Errorf("migration %s: %w", migration.version, err)
		}
	}
	if _, err := tx.Exec(
		rebind(driver, `INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)`),
		migration.version,
		checksum,
		Now(),
	); err != nil {
		return err
	}
	return tx.Commit()
}

func updateControlStatements(driver string) []string {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS update_channels (
			name TEXT PRIMARY KEY CHECK (name IN ('stable', 'alpha')),
			enabled BOOLEAN NOT NULL DEFAULT TRUE,
			disabled_reason TEXT NOT NULL DEFAULT '',
			revision INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			updated_by_user_id TEXT REFERENCES users(id)
		)`,
		`CREATE TABLE IF NOT EXISTS update_cohorts (
			name TEXT PRIMARY KEY,
			description TEXT NOT NULL DEFAULT '',
			active BOOLEAN NOT NULL DEFAULT TRUE,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS update_releases (
			id TEXT PRIMARY KEY,
			version TEXT NOT NULL,
			channel TEXT NOT NULL REFERENCES update_channels(name),
			classification TEXT NOT NULL CHECK (classification IN ('optional', 'recommended', 'required')),
			state TEXT NOT NULL CHECK (state IN ('draft', 'validated', 'internal', 'rolling_out', 'paused', 'fully_released', 'withdrawn', 'superseded')),
			paused_from_state TEXT,
			notes TEXT NOT NULL DEFAULT '',
			git_commit TEXT NOT NULL,
			client_protocol_version INTEGER NOT NULL DEFAULT 1,
			minimum_server_version TEXT,
			maximum_server_version TEXT,
			required_capabilities_json TEXT NOT NULL DEFAULT '[]',
			grace_ends_at TEXT,
			local_data_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (local_data_schema_version >= 1),
			local_migration_reversible BOOLEAN NOT NULL DEFAULT FALSE,
			rollback_safe BOOLEAN NOT NULL DEFAULT FALSE,
			superseded_by_release_id TEXT REFERENCES update_releases(id),
			approved_rollback_release_id TEXT REFERENCES update_releases(id),
			revision INTEGER NOT NULL DEFAULT 1,
			created_by_user_id TEXT REFERENCES users(id),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			validated_at TEXT,
			published_at TEXT,
			withdrawn_at TEXT,
			UNIQUE(channel, version)
		)`,
		`CREATE TABLE IF NOT EXISTS update_release_artifacts (
			id TEXT PRIMARY KEY,
			release_id TEXT NOT NULL REFERENCES update_releases(id) ON DELETE CASCADE,
			platform TEXT NOT NULL CHECK (platform IN ('windows', 'linux')),
			architecture TEXT NOT NULL CHECK (architecture = 'x86_64'),
			format TEXT NOT NULL,
			object_key TEXT NOT NULL UNIQUE,
			signature TEXT NOT NULL,
			sha256 TEXT NOT NULL,
			size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
			checksum_object_key TEXT NOT NULL,
			checksum_sha256 TEXT NOT NULL,
			sbom_object_key TEXT NOT NULL,
			sbom_sha256 TEXT NOT NULL,
			provenance_object_key TEXT NOT NULL,
			provenance_sha256 TEXT NOT NULL,
			verified_at TEXT,
			created_at TEXT NOT NULL,
			UNIQUE(release_id, platform, architecture)
		)`,
		`CREATE TABLE IF NOT EXISTS update_rollouts (
			release_id TEXT NOT NULL REFERENCES update_releases(id) ON DELETE CASCADE,
			cohort_name TEXT NOT NULL REFERENCES update_cohorts(name),
			percentage_basis_points INTEGER NOT NULL CHECK (percentage_basis_points >= 0 AND percentage_basis_points <= 10000),
			revision INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			updated_by_user_id TEXT REFERENCES users(id),
			PRIMARY KEY(release_id, cohort_name)
		)`,
		`CREATE TABLE IF NOT EXISTS update_version_blocks (
			id TEXT PRIMARY KEY,
			version_range TEXT NOT NULL,
			channel TEXT REFERENCES update_channels(name),
			reason TEXT NOT NULL,
			target_release_id TEXT REFERENCES update_releases(id),
			active BOOLEAN NOT NULL DEFAULT TRUE,
			created_by_user_id TEXT REFERENCES users(id),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS update_enrollments (
			installation_digest TEXT PRIMARY KEY,
			rollout_bucket INTEGER NOT NULL CHECK (rollout_bucket >= 0 AND rollout_bucket < 10000),
			channel TEXT NOT NULL REFERENCES update_channels(name),
			cohort_name TEXT NOT NULL REFERENCES update_cohorts(name),
			consent_version TEXT NOT NULL,
			enrolled_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			revoked_at TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS update_download_grants (
			token_hash TEXT PRIMARY KEY,
			artifact_id TEXT NOT NULL REFERENCES update_release_artifacts(id) ON DELETE CASCADE,
			installation_digest TEXT NOT NULL,
			release_revision INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS update_cohort_assignments (
			installation_digest TEXT PRIMARY KEY,
			cohort_name TEXT NOT NULL REFERENCES update_cohorts(name),
			assigned_by_user_id TEXT REFERENCES users(id),
			reason TEXT NOT NULL,
			assigned_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_update_download_grants_expiry ON update_download_grants(expires_at)`,
		`CREATE TABLE IF NOT EXISTS release_administrators (
			user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
			granted_by_user_id TEXT REFERENCES users(id),
			granted_at TEXT NOT NULL,
			revoked_at TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS release_ops_sessions (
			token_hash TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			auth_session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			revoked_at TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS release_action_authorizations (
			token_hash TEXT PRIMARY KEY,
			ops_session_hash TEXT NOT NULL REFERENCES release_ops_sessions(token_hash) ON DELETE CASCADE,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			action TEXT NOT NULL,
			subject TEXT NOT NULL,
			expected_confirmation TEXT NOT NULL,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			consumed_at TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS release_audit_events (
			id TEXT PRIMARY KEY,
			actor_user_id TEXT REFERENCES users(id),
			actor_label TEXT NOT NULL,
			action TEXT NOT NULL,
			entity_type TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			previous_state_json TEXT,
			new_state_json TEXT,
			reason TEXT NOT NULL,
			correlation_id TEXT NOT NULL,
			idempotency_key TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_release_audit_idempotency ON release_audit_events(actor_label, action, idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key <> ''`,
		`CREATE INDEX IF NOT EXISTS idx_release_audit_created ON release_audit_events(created_at, id)`,
		`CREATE INDEX IF NOT EXISTS idx_release_ops_sessions_expiry ON release_ops_sessions(user_id, expires_at, revoked_at)`,
		`CREATE INDEX IF NOT EXISTS idx_release_action_authorizations_expiry ON release_action_authorizations(user_id, expires_at, consumed_at)`,
		`CREATE INDEX IF NOT EXISTS idx_update_releases_discovery ON update_releases(channel, state, classification, version)`,
		`CREATE INDEX IF NOT EXISTS idx_update_blocks_active ON update_version_blocks(channel, active)`,
		`CREATE TABLE IF NOT EXISTS update_outcome_daily (
			day TEXT NOT NULL,
			release_id TEXT NOT NULL DEFAULT '',
			from_version TEXT NOT NULL,
			to_version TEXT NOT NULL DEFAULT '',
			platform TEXT NOT NULL,
			architecture TEXT NOT NULL,
			stage TEXT NOT NULL,
			outcome TEXT NOT NULL,
			error_category TEXT NOT NULL DEFAULT '',
			count INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL,
			PRIMARY KEY(day, release_id, from_version, to_version, platform, architecture, stage, outcome, error_category)
		)`,
		`CREATE TABLE IF NOT EXISTS update_outcome_dedup (
			event_hash TEXT PRIMARY KEY,
			expires_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_update_outcome_dedup_expiry ON update_outcome_dedup(expires_at)`,
		`CREATE TABLE IF NOT EXISTS update_diagnostic_reports (
			id TEXT PRIMARY KEY,
			release_id TEXT,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_update_diagnostics_expiry ON update_diagnostic_reports(expires_at)`,
		`INSERT INTO update_channels (name, enabled, disabled_reason, revision, created_at, updated_at)
		 VALUES ('stable', TRUE, '', 1, '2026-07-12T00:00:00Z', '2026-07-12T00:00:00Z') ON CONFLICT(name) DO NOTHING`,
		`INSERT INTO update_channels (name, enabled, disabled_reason, revision, created_at, updated_at)
		 VALUES ('alpha', TRUE, '', 1, '2026-07-12T00:00:00Z', '2026-07-12T00:00:00Z') ON CONFLICT(name) DO NOTHING`,
		`INSERT INTO update_cohorts (name, description, active, created_at, updated_at)
		 VALUES ('internal', 'Raven maintainers and release operators', TRUE, '2026-07-12T00:00:00Z', '2026-07-12T00:00:00Z') ON CONFLICT(name) DO NOTHING`,
		`INSERT INTO update_cohorts (name, description, active, created_at, updated_at)
		 VALUES ('friends', 'Closed alpha participants', TRUE, '2026-07-12T00:00:00Z', '2026-07-12T00:00:00Z') ON CONFLICT(name) DO NOTHING`,
		`INSERT INTO update_cohorts (name, description, active, created_at, updated_at)
		 VALUES ('staging', 'Disposable release validation cohort', TRUE, '2026-07-12T00:00:00Z', '2026-07-12T00:00:00Z') ON CONFLICT(name) DO NOTHING`,
	}
	if driver == "pgx" {
		statements = append(statements,
			`CREATE OR REPLACE FUNCTION prevent_release_audit_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'release audit events are immutable'; END; $$ LANGUAGE plpgsql`,
			`DROP TRIGGER IF EXISTS release_audit_events_immutable ON release_audit_events`,
			`CREATE TRIGGER release_audit_events_immutable BEFORE UPDATE OR DELETE ON release_audit_events FOR EACH ROW EXECUTE FUNCTION prevent_release_audit_mutation()`,
		)
	} else {
		statements = append(statements,
			`CREATE TRIGGER IF NOT EXISTS release_audit_events_no_update BEFORE UPDATE ON release_audit_events BEGIN SELECT RAISE(ABORT, 'release audit events are immutable'); END`,
			`CREATE TRIGGER IF NOT EXISTS release_audit_events_no_delete BEFORE DELETE ON release_audit_events BEGIN SELECT RAISE(ABORT, 'release audit events are immutable'); END`,
		)
	}
	return statements
}
