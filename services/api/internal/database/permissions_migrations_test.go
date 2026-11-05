package database

import (
	"path/filepath"
	"testing"
)

// Trees from before the one-owner rule may have several owners, or none. The migration
// settles each on exactly one before the database starts refusing a second.
func TestSingleOwnerStatementsSettleEveryTreeOnOneOwner(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "raven.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, id := range []string{"a", "b", "c", "d"} {
		if _, err := db.Exec(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, 'x', 'user', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, id, id); err != nil {
			t.Fatal(err)
		}
	}
	member := func(tree, user, role, state, joinedAt string) string {
		return `INSERT INTO tree_members (tree_id, user_id, role, state, joined_at, created_at, updated_at) VALUES ('` +
			tree + `', '` + user + `', '` + role + `', '` + state + `', '` + joinedAt + `', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
	}
	tree := func(id, creator string) string {
		return `INSERT INTO trees (id, name, creator_user_id, status, created_at, updated_at) VALUES ('` + id + `', '` + id + `', '` + creator + `', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
	}
	setup := []string{
		`DROP INDEX idx_tree_members_one_owner`,
		// Two owners, one of whom created it: the creator stays.
		tree("created", "b"),
		member("created", "a", "owner", "joined", "2026-01-01T00:00:00Z"),
		member("created", "b", "owner", "joined", "2026-02-01T00:00:00Z"),
		// Two owners, the creator long gone: whoever has been there longest stays.
		tree("inherited", "d"),
		member("inherited", "a", "owner", "joined", "2026-03-01T00:00:00Z"),
		member("inherited", "b", "owner", "joined", "2026-02-01T00:00:00Z"),
		member("inherited", "d", "owner", "removed", "2026-01-01T00:00:00Z"),
		// No owner: a moderator is preferred over an older member.
		tree("orphan", "d"),
		member("orphan", "a", "member", "joined", "2026-01-01T00:00:00Z"),
		member("orphan", "b", "moderator", "joined", "2026-02-01T00:00:00Z"),
		// Already right: left alone.
		tree("fine", "a"),
		member("fine", "a", "owner", "joined", "2026-01-01T00:00:00Z"),
		member("fine", "b", "moderator", "joined", "2026-02-01T00:00:00Z"),
		// Nobody in it: nothing to promote.
		tree("empty", "a"),
	}
	for _, statement := range append(setup, singleOwnerStatements()...) {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}

	want := map[string]string{
		"created/a": "moderator", "created/b": "owner",
		"inherited/a": "moderator", "inherited/b": "owner", "inherited/d": "member",
		"orphan/a": "member", "orphan/b": "owner",
		"fine/a": "owner", "fine/b": "moderator",
	}
	rows, err := db.Query(`SELECT tree_id, user_id, role FROM tree_members`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	seen := 0
	for rows.Next() {
		var treeID, userID, role string
		if err := rows.Scan(&treeID, &userID, &role); err != nil {
			t.Fatal(err)
		}
		seen++
		if want[treeID+"/"+userID] != role {
			t.Errorf("%s/%s is %s, want %s", treeID, userID, role, want[treeID+"/"+userID])
		}
	}
	if seen != len(want) {
		t.Fatalf("saw %d memberships, want %d", seen, len(want))
	}
	if _, err := db.Exec(`UPDATE tree_members SET role = 'owner' WHERE tree_id = 'fine' AND user_id = 'b'`); !IsUniqueViolation(err) {
		t.Fatalf("a second owner was allowed: %v", err)
	}
}

func TestCapabilityDefaultsStartOpen(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "raven.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var total, allowed int
	if err := db.QueryRow(`SELECT COUNT(*), SUM(CASE WHEN allowed AND limit_value IS NULL THEN 1 ELSE 0 END) FROM server_capability_defaults`).Scan(&total, &allowed); err != nil {
		t.Fatal(err)
	}
	// Inviting people starts off; everything else starts on, including the two Workshop ones.
	wantAllowed := len(permissionsCapabilities) + 2
	if total != len(Capabilities) || allowed != wantAllowed {
		t.Fatalf("%d of %d capabilities start allowed without a limit, want %d", allowed, total, wantAllowed)
	}
	// A CHECK failure is not a duplicate.
	_, err = db.Exec(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('x', 'x', 'x', 'superuser', 'now', 'now')`)
	if err == nil || IsUniqueViolation(err) {
		t.Fatalf("a bad role should fail as something other than a duplicate: %v", err)
	}
}
