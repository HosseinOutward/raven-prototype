package database

import (
	"path/filepath"
	"testing"
)

func TestCallStateColumnsAreAddedToAnOlderDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "raven.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	// Put the database back as a server before this change left it, then start it again.
	for _, statement := range []string{
		`ALTER TABLE session_participants DROP COLUMN away`,
		`ALTER TABLE session_participants DROP COLUMN deafened`,
		`DELETE FROM schema_migrations WHERE version = '2026102701_call_state'`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	db, err = Open(path)
	if err != nil {
		t.Fatalf("an older database should migrate: %v", err)
	}
	defer db.Close()
	rows, err := db.Query(`SELECT away, deafened FROM session_participants`)
	if err != nil {
		t.Fatalf("the migration did not add the columns: %v", err)
	}
	rows.Close()

	// Existing participations start with both markers off.
	now := Now()
	for _, statement := range []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('u1', 'u1', 'x', 'user', '` + now + `', '` + now + `')`,
		`INSERT INTO nests (id, name, join_code, creator_user_id, status, created_at, updated_at) VALUES ('n1', 'n', 'c1', 'u1', 'active', '` + now + `', '` + now + `')`,
		`INSERT INTO nest_sessions (id, nest_id, started_at, status, created_at, updated_at) VALUES ('s1', 'n1', '` + now + `', 'active', '` + now + `', '` + now + `')`,
		`INSERT INTO session_participants (id, session_id, nest_id, user_id, joined_at, last_seen_at, status, created_at, updated_at) VALUES ('p1', 's1', 'n1', 'u1', '` + now + `', '` + now + `', 'active', '` + now + `', '` + now + `')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	var away, deafened bool
	if err := db.QueryRow(`SELECT away, deafened FROM session_participants WHERE id = 'p1'`).Scan(&away, &deafened); err != nil {
		t.Fatal(err)
	}
	if away || deafened {
		t.Fatalf("a new participation should start clear: away=%v deafened=%v", away, deafened)
	}
}
