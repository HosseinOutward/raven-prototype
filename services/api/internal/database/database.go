package database

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

type DB struct {
	*sql.DB
	driver string
}

type Tx struct {
	*sql.Tx
	driver string
}

func Open(path string) (*DB, error) {
	if path == "" {
		path = filepath.Join("data", "raven.db")
	}
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
	}

	return open("sqlite", path)
}

func OpenFromEnv() (*DB, error) {
	if url := firstEnv("DATABASE_URL", "RAVEN_DATABASE_URL"); url != "" {
		return OpenPostgres(url)
	}

	driver := strings.ToLower(firstEnv("RAVEN_DATABASE_DRIVER", "DATABASE_DRIVER", "DB_DRIVER"))
	if driver == "postgres" || driver == "postgresql" || firstEnv("POSTGRES_HOST", "RAVEN_POSTGRES_HOST") != "" {
		return OpenPostgres(postgresURLFromEnv())
	}

	return Open(os.Getenv("RAVEN_DATABASE_PATH"))
}

func OpenPostgres(connString string) (*DB, error) {
	if strings.TrimSpace(connString) == "" {
		return nil, fmt.Errorf("postgres connection string is empty")
	}
	return open("pgx", connString)
}

func open(driver, source string) (*DB, error) {
	db, err := sql.Open(driver, source)
	if err != nil {
		return nil, err
	}
	if driver == "sqlite" {
		if _, err := db.Exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`); err != nil {
			_ = db.Close()
			return nil, err
		}
	}
	if err := migrate(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := migrateUpdateControl(db, driver); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &DB{DB: db, driver: driver}, nil
}

func (db *DB) Driver() string {
	return db.driver
}

func (db *DB) Exec(query string, args ...any) (sql.Result, error) {
	return db.DB.Exec(db.rebind(query), args...)
}

func (db *DB) Query(query string, args ...any) (*sql.Rows, error) {
	return db.DB.Query(db.rebind(query), args...)
}

func (db *DB) QueryRow(query string, args ...any) *sql.Row {
	return db.DB.QueryRow(db.rebind(query), args...)
}

func (db *DB) Begin() (*Tx, error) {
	tx, err := db.DB.Begin()
	if err != nil {
		return nil, err
	}
	return &Tx{Tx: tx, driver: db.driver}, nil
}

func (tx *Tx) Exec(query string, args ...any) (sql.Result, error) {
	return tx.Tx.Exec(rebind(tx.driver, query), args...)
}

func (tx *Tx) Query(query string, args ...any) (*sql.Rows, error) {
	return tx.Tx.Query(rebind(tx.driver, query), args...)
}

func (tx *Tx) QueryRow(query string, args ...any) *sql.Row {
	return tx.Tx.QueryRow(rebind(tx.driver, query), args...)
}

func (db *DB) rebind(query string) string {
	return rebind(db.driver, query)
}

func rebind(driver, query string) string {
	if driver != "pgx" {
		return query
	}
	var out strings.Builder
	out.Grow(len(query) + 8)
	arg := 1
	inSingle := false
	for i := 0; i < len(query); i++ {
		ch := query[i]
		if ch == '\'' {
			out.WriteByte(ch)
			if inSingle && i+1 < len(query) && query[i+1] == '\'' {
				i++
				out.WriteByte(query[i])
				continue
			}
			inSingle = !inSingle
			continue
		}
		if ch == '?' && !inSingle {
			out.WriteByte('$')
			out.WriteString(strconv.Itoa(arg))
			arg++
			continue
		}
		out.WriteByte(ch)
	}
	return out.String()
}

func migrate(db *sql.DB) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			username TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS user_preferences (
			user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
			display_name TEXT,
			ui_labels TEXT NOT NULL DEFAULT 'tree_nest' CHECK (ui_labels IN ('tree_nest', 'space_room')),
			color_palette TEXT NOT NULL DEFAULT 'raven_dark',
			always_join_muted BOOLEAN NOT NULL DEFAULT FALSE,
			join_with_camera_off BOOLEAN NOT NULL DEFAULT FALSE,
			join_without_screen_sharing BOOLEAN NOT NULL DEFAULT FALSE,
			follow_screen_shares BOOLEAN NOT NULL DEFAULT TRUE,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS fiber_sessions (
			id TEXT PRIMARY KEY,
			data TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS auth_sessions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			latest_ip TEXT NOT NULL DEFAULT '',
			user_agent TEXT NOT NULL DEFAULT '',
			os TEXT NOT NULL DEFAULT 'Unknown',
			device_name TEXT NOT NULL DEFAULT 'Raven Desktop',
			created_at TEXT NOT NULL,
			last_accessed_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			revoked_at TEXT
		);`,
		`CREATE TABLE IF NOT EXISTS trees (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			join_policy TEXT NOT NULL DEFAULT 'request' CHECK (join_policy IN ('free', 'request')),
			visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
			creator_user_id TEXT NOT NULL REFERENCES users(id),
			status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS nests (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			join_code TEXT NOT NULL UNIQUE,
			creator_user_id TEXT NOT NULL REFERENCES users(id),
			status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS nest_members (
			nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			role TEXT NOT NULL CHECK (role IN ('creator', 'moderator', 'participant')),
			state TEXT NOT NULL CHECK (state IN ('invited', 'joined', 'left', 'removed')),
			joined_at TEXT,
			left_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (nest_id, user_id)
		);`,
		`CREATE TABLE IF NOT EXISTS nest_invitations (
			id TEXT PRIMARY KEY,
			nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
			invited_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			invited_by_user_id TEXT NOT NULL REFERENCES users(id),
			created_at TEXT NOT NULL,
			UNIQUE (nest_id, invited_user_id)
		);`,
		`CREATE TABLE IF NOT EXISTS nest_join_requests (
			id TEXT PRIMARY KEY,
			nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
			created_at TEXT NOT NULL,
			resolved_at TEXT,
			resolved_by_user_id TEXT REFERENCES users(id),
			UNIQUE (nest_id, user_id, status)
		);`,
		`CREATE INDEX IF NOT EXISTS idx_nest_members_user ON nest_members(user_id);`,
		`CREATE INDEX IF NOT EXISTS idx_nest_join_requests_nest ON nest_join_requests(nest_id, status);`,
		`CREATE INDEX IF NOT EXISTS idx_fiber_sessions_expiry ON fiber_sessions(expires_at);`,
		`CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, revoked_at, last_accessed_at);`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			return err
		}
	}
	alterStatements := []string{
		`ALTER TABLE trees ADD COLUMN description TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE trees ADD COLUMN join_policy TEXT NOT NULL DEFAULT 'request'`,
		`ALTER TABLE trees ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`,
		`ALTER TABLE nests ADD COLUMN type TEXT NOT NULL DEFAULT 'persistent'`,
		`ALTER TABLE nests ADD COLUMN tree_id TEXT REFERENCES trees(id)`,
		`ALTER TABLE nests ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'created'`,
		`ALTER TABLE nests ADD COLUMN empty_since TEXT`,
		`ALTER TABLE nests ADD COLUMN expires_at TEXT`,
		`ALTER TABLE nests ADD COLUMN archived_at TEXT`,
		`ALTER TABLE nests ADD COLUMN ended_at TEXT`,
		`ALTER TABLE nests ADD COLUMN last_activity_at TEXT`,
		`ALTER TABLE user_preferences ADD COLUMN join_with_camera_off BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE user_preferences ADD COLUMN join_without_screen_sharing BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE user_preferences ADD COLUMN follow_screen_shares BOOLEAN NOT NULL DEFAULT TRUE`,
	}
	for _, statement := range alterStatements {
		if _, err := db.Exec(statement); err != nil && !isDuplicateColumn(err) {
			return err
		}
	}
	moreStatements := []string{
		`UPDATE trees SET description = '' WHERE description IS NULL`,
		`UPDATE trees SET join_policy = 'request' WHERE join_policy IS NULL OR join_policy = ''`,
		`UPDATE trees SET visibility = 'private' WHERE visibility IS NULL OR visibility = ''`,
		`UPDATE nests SET type = 'persistent' WHERE type IS NULL OR type = ''`,
		`UPDATE nests SET lifecycle_state = CASE WHEN status = 'ended' THEN 'closed' ELSE 'created' END WHERE lifecycle_state IS NULL OR lifecycle_state = ''`,
		`UPDATE nests SET last_activity_at = updated_at WHERE last_activity_at IS NULL`,
		`CREATE TABLE IF NOT EXISTS tree_members (
			tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			role TEXT NOT NULL CHECK (role IN ('owner', 'moderator', 'member')),
			state TEXT NOT NULL CHECK (state IN ('joined', 'left', 'removed')),
			joined_at TEXT,
			left_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (tree_id, user_id)
		);`,
		`CREATE TABLE IF NOT EXISTS user_presence (
			user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
			state TEXT NOT NULL CHECK (state IN ('offline', 'available', 'dnd', 'in_nest', 'invisible')),
			reachability TEXT NOT NULL CHECK (reachability IN ('open', 'around', 'focused', 'unavailable')),
			active_nest_id TEXT REFERENCES nests(id) ON DELETE SET NULL,
			updated_at TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS knocks (
			id TEXT PRIMARY KEY,
			from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			to_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
			nest_id TEXT REFERENCES nests(id) ON DELETE CASCADE,
			status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'dismissed', 'expired')),
			message TEXT,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			resolved_at TEXT,
			resolved_by_user_id TEXT REFERENCES users(id),
			CHECK (to_user_id IS NOT NULL OR nest_id IS NOT NULL)
		);`,
		`CREATE TABLE IF NOT EXISTS friend_requests (
			id TEXT PRIMARY KEY,
			from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
			created_at TEXT NOT NULL,
			resolved_at TEXT,
			resolved_by_user_id TEXT REFERENCES users(id),
			CHECK (from_user_id <> to_user_id)
		);`,
		`CREATE TABLE IF NOT EXISTS friendships (
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			friend_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at TEXT NOT NULL,
			CHECK (user_id <> friend_user_id),
			PRIMARY KEY (user_id, friend_user_id)
		);`,
		`CREATE INDEX IF NOT EXISTS idx_trees_creator ON trees(creator_user_id);`,
		`CREATE INDEX IF NOT EXISTS idx_tree_members_user ON tree_members(user_id, state);`,
		`CREATE TABLE IF NOT EXISTS tree_join_requests (
			id TEXT PRIMARY KEY,
			tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
			created_at TEXT NOT NULL,
			resolved_at TEXT,
			resolved_by_user_id TEXT REFERENCES users(id),
			UNIQUE (tree_id, user_id, status)
		);`,
		`CREATE INDEX IF NOT EXISTS idx_trees_search ON trees(visibility, status, name);`,
		`CREATE INDEX IF NOT EXISTS idx_tree_join_requests_tree ON tree_join_requests(tree_id, status);`,
		`CREATE INDEX IF NOT EXISTS idx_nests_tree ON nests(tree_id, status, lifecycle_state);`,
		`CREATE INDEX IF NOT EXISTS idx_knocks_targets ON knocks(to_user_id, nest_id, status, expires_at);`,
		`CREATE INDEX IF NOT EXISTS idx_friend_requests_incoming ON friend_requests(to_user_id, status, created_at);`,
		`CREATE INDEX IF NOT EXISTS idx_friend_requests_outgoing ON friend_requests(from_user_id, status, created_at);`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_requests_one_pending ON friend_requests(from_user_id, to_user_id) WHERE status = 'pending';`,
		`CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_user_id);`,
		`CREATE TABLE IF NOT EXISTS nest_sessions (
			id TEXT PRIMARY KEY,
			nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
			started_at TEXT NOT NULL,
			ended_at TEXT,
			duration_seconds INTEGER,
			status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS nest_presence (
			id TEXT PRIMARY KEY,
			nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			joined_at TEXT NOT NULL,
			left_at TEXT,
			last_seen_at TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('active', 'left', 'disconnected')),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS session_participants (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES nest_sessions(id) ON DELETE CASCADE,
			nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			joined_at TEXT NOT NULL,
			left_at TEXT,
			last_seen_at TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('active', 'left', 'disconnected')),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS nest_event_log (
			id TEXT PRIMARY KEY,
			nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
			session_id TEXT REFERENCES nest_sessions(id) ON DELETE SET NULL,
			user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			event_type TEXT NOT NULL,
			metadata_json TEXT,
			created_at TEXT NOT NULL
		);`,
		`CREATE INDEX IF NOT EXISTS idx_nest_sessions_nest ON nest_sessions(nest_id, status, started_at);`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_nest_sessions_one_active ON nest_sessions(nest_id) WHERE ended_at IS NULL;`,
		`CREATE INDEX IF NOT EXISTS idx_nest_presence_nest ON nest_presence(nest_id, left_at);`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_nest_presence_one_active ON nest_presence(nest_id, user_id) WHERE left_at IS NULL;`,
		`CREATE INDEX IF NOT EXISTS idx_session_participants_session ON session_participants(session_id, left_at);`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_session_participants_one_active ON session_participants(session_id, user_id) WHERE left_at IS NULL;`,
		`CREATE INDEX IF NOT EXISTS idx_nest_event_log_nest ON nest_event_log(nest_id, created_at);`,
	}
	for _, statement := range moreStatements {
		if _, err := db.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}

func isDuplicateColumn(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "duplicate column") ||
		strings.Contains(message, "already exists")
}

func Now() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func NormalizeRole(role string) (string, error) {
	role = strings.ToLower(strings.TrimSpace(role))
	if role == "" {
		return "user", nil
	}
	if role != "admin" && role != "user" {
		return "", fmt.Errorf("invalid role %q", role)
	}
	return role, nil
}

func IsUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "constraint") || strings.Contains(message, "duplicate key")
}

func ErrNotFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return sql.ErrNoRows
	}
	return err
}

func LoadDotEnv(paths ...string) error {
	for _, path := range paths {
		if err := loadDotEnvFile(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func loadDotEnvFile(path string) error {
	content, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(content), "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		value = strings.Trim(value, `"'`)
		if key != "" && os.Getenv(key) == "" {
			_ = os.Setenv(key, value)
		}
	}
	return nil
}

func firstEnv(names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
	}
	return ""
}

func postgresURLFromEnv() string {
	host := firstEnv("POSTGRES_HOST", "RAVEN_POSTGRES_HOST")
	port := firstEnv("POSTGRES_PORT", "RAVEN_POSTGRES_PORT")
	dbname := firstEnv("POSTGRES_DB", "RAVEN_POSTGRES_DB", "POSTGRES_DATABASE", "RAVEN_POSTGRES_DATABASE")
	user := firstEnv("POSTGRES_USER", "RAVEN_POSTGRES_USER")
	password := firstEnv("POSTGRES_PASSWORD", "RAVEN_POSTGRES_PASSWORD")
	sslmode := firstEnv("POSTGRES_SSLMODE", "RAVEN_POSTGRES_SSLMODE")
	if host == "" {
		host = "127.0.0.1"
	}
	if port == "" {
		port = "5432"
	}
	if dbname == "" {
		dbname = "raven"
	}
	if sslmode == "" {
		sslmode = "disable"
	}
	u := &url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(user, password),
		Host:   host + ":" + port,
		Path:   "/" + dbname,
	}
	q := u.Query()
	q.Set("sslmode", sslmode)
	u.RawQuery = q.Encode()
	return u.String()
}
