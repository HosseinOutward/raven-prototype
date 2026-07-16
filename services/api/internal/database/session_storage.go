package database

import (
	"database/sql"
	"encoding/base64"
	"errors"
	"time"
)

// SessionStorage implements fiber.Storage on top of Raven's configured database.
// Values are base64 encoded so the same schema works with SQLite and PostgreSQL.
type SessionStorage struct {
	db *DB
}

func NewSessionStorage(db *DB) *SessionStorage {
	return &SessionStorage{db: db}
}

func (s *SessionStorage) Get(key string) ([]byte, error) {
	var encoded, expiresAt string
	err := s.db.QueryRow(`SELECT data, expires_at FROM fiber_sessions WHERE id = ?`, key).Scan(&encoded, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	expires, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil || !expires.After(time.Now().UTC()) {
		_ = s.Delete(key)
		return nil, nil
	}
	return base64.StdEncoding.DecodeString(encoded)
}

func (s *SessionStorage) Set(key string, value []byte, expiration time.Duration) error {
	if key == "" || len(value) == 0 {
		return nil
	}
	if expiration <= 0 {
		expiration = 30 * 24 * time.Hour
	}
	now := Now()
	expiresAt := time.Now().UTC().Add(expiration).Format(time.RFC3339Nano)
	_, err := s.db.Exec(
		`INSERT INTO fiber_sessions (id, data, expires_at, updated_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
		key, base64.StdEncoding.EncodeToString(value), expiresAt, now,
	)
	return err
}

func (s *SessionStorage) Delete(key string) error {
	_, err := s.db.Exec(`DELETE FROM fiber_sessions WHERE id = ?`, key)
	return err
}

func (s *SessionStorage) Reset() error {
	_, err := s.db.Exec(`DELETE FROM fiber_sessions`)
	return err
}

func (s *SessionStorage) Close() error { return nil }
