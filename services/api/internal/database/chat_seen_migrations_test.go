package database

import (
	"path/filepath"
	"testing"
)

func TestChatSeenMigrationCopiesShareReadStatus(t *testing.T) {
	path := filepath.Join(t.TempDir(), "raven.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`ALTER TABLE chat_user_settings DROP COLUMN read_dm`,
		`ALTER TABLE chat_user_settings DROP COLUMN read_group`,
		`ALTER TABLE chat_user_settings DROP COLUMN read_private_space`,
		`ALTER TABLE chat_user_settings DROP COLUMN read_public_space`,
		`ALTER TABLE chat_members DROP COLUMN shared_read_at`,
		`DELETE FROM schema_migrations WHERE version = '2026103103_chat_seen'`,
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('off', 'off', 'x', 'user', '', '')`,
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('on', 'on', 'x', 'user', '', '')`,
		`INSERT INTO chat_user_settings (user_id, share_read_status, updated_at) VALUES ('off', FALSE, '')`,
		`INSERT INTO chat_user_settings (user_id, share_read_status, updated_at) VALUES ('on', TRUE, '')`,
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
		t.Fatal(err)
	}
	defer db.Close()
	for user, want := range map[string][4]bool{
		"off": {false, true, true, false},
		"on":  {true, true, true, false},
	} {
		var got [4]bool
		if err := db.QueryRow(
			`SELECT read_dm, read_group, read_private_space, read_public_space FROM chat_user_settings WHERE user_id = ?`, user,
		).Scan(&got[0], &got[1], &got[2], &got[3]); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("%s: switches %v, want %v", user, got, want)
		}
	}
}
