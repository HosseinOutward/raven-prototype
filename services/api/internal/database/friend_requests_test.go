package database

import (
	"path/filepath"
	"testing"
)

// Databases from before one-pending-request-per-pair may hold requests the rule forbids.
// Opening the database withdraws them so the unique index can be built.
func TestMigrateWithdrawsFriendRequestsTheRuleForbids(t *testing.T) {
	path := filepath.Join(t.TempDir(), "raven.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b", "c"} {
		if _, err := db.Exec(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, 'x', 'user', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, id, id); err != nil {
			t.Fatal(err)
		}
	}
	statements := []string{
		`DROP INDEX idx_friend_requests_one_pending_pair`,
		// a and b asked each other; a asked first.
		`INSERT INTO friend_requests (id, from_user_id, to_user_id, status, created_at) VALUES ('first', 'a', 'b', 'pending', '2026-01-01T00:00:00Z')`,
		`INSERT INTO friend_requests (id, from_user_id, to_user_id, status, created_at) VALUES ('crossed', 'b', 'a', 'pending', '2026-01-02T00:00:00Z')`,
		// a and c are friends with a request still open.
		`INSERT INTO friendships (user_id, friend_user_id, created_at) VALUES ('a', 'c', '2026-01-01T00:00:00Z'), ('c', 'a', '2026-01-01T00:00:00Z')`,
		`INSERT INTO friend_requests (id, from_user_id, to_user_id, status, created_at) VALUES ('leftover', 'c', 'a', 'pending', '2026-01-01T00:00:00Z')`,
		// An ordinary request is left alone.
		`INSERT INTO friend_requests (id, from_user_id, to_user_id, status, created_at) VALUES ('ordinary', 'b', 'c', 'pending', '2026-01-01T00:00:00Z')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	db, err = Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer db.Close()
	want := map[string]string{"first": "pending", "crossed": "cancelled", "leftover": "cancelled", "ordinary": "pending"}
	for id, status := range want {
		var got string
		if err := db.QueryRow(`SELECT status FROM friend_requests WHERE id = ?`, id).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != status {
			t.Errorf("request %q is %s, want %s", id, got, status)
		}
	}
	if _, err := db.Exec(`INSERT INTO friend_requests (id, from_user_id, to_user_id, status, created_at) VALUES ('again', 'b', 'a', 'pending', '2026-01-03T00:00:00Z')`); !IsUniqueViolation(err) {
		t.Fatalf("a second pending request between a and b was allowed: %v", err)
	}
}
