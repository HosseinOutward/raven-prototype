package http

import (
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"
)

// openTestDB gives a test its own empty database.
//
// By default that is a SQLite file in the test's temp directory. With
// RAVEN_TEST_DATABASE_URL set to a PostgreSQL URL, each test instead gets its own schema
// in that database, dropped when the test ends. Production runs on PostgreSQL, and the
// row locks that order chat messages only behave like production there.
func openTestDB(t *testing.T) *database.DB {
	t.Helper()
	base := strings.TrimSpace(os.Getenv("RAVEN_TEST_DATABASE_URL"))
	if base == "" {
		db, err := database.Open(filepath.Join(t.TempDir(), "raven-test.db"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = db.Close() })
		return db
	}

	target, err := url.Parse(base)
	if err != nil {
		t.Fatalf("RAVEN_TEST_DATABASE_URL: %v", err)
	}
	schema := "t_" + auth.NewID()
	admin, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(`CREATE SCHEMA "` + schema + `"`); err != nil {
		_ = admin.Close()
		t.Fatalf("create test schema: %v", err)
	}
	query := target.Query()
	query.Set("search_path", schema)
	target.RawQuery = query.Encode()
	db, err := database.OpenPostgres(target.String())
	if err != nil {
		_, _ = admin.Exec(`DROP SCHEMA "` + schema + `" CASCADE`)
		_ = admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = db.Close()
		_, _ = admin.Exec(`DROP SCHEMA "` + schema + `" CASCADE`)
		_ = admin.Close()
	})
	return db
}

// usingPostgres reports whether this test run is against PostgreSQL.
func usingPostgres() bool {
	return strings.TrimSpace(os.Getenv("RAVEN_TEST_DATABASE_URL")) != ""
}
