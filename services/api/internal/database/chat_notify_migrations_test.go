package database

import (
	"path/filepath"
	"testing"
)

func TestChatNotifyMigratesExistingMembers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "raven.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`ALTER TABLE chat_members DROP COLUMN notify`,
		`DELETE FROM schema_migrations WHERE version = '2026103101_chat_notify'`,
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('u', 'u', 'x', 'user', '', '')`,
		`INSERT INTO chat_conversations (id, kind, creator_user_id, created_at, updated_at) VALUES ('c', 'group', 'u', '', '')`,
		`INSERT INTO chat_members (conversation_id, user_id, role, state, joined_at, created_at, updated_at) VALUES ('c', 'u', 'owner', 'joined', '', '', '')`,
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
	var mode string
	if err := db.QueryRow(`SELECT notify FROM chat_members WHERE conversation_id = 'c'`).Scan(&mode); err != nil {
		t.Fatal(err)
	}
	if mode != "" {
		t.Fatalf("existing member should use kind default: %q", mode)
	}
}
