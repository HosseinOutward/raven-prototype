package http

import (
	"strings"
	"testing"
)

func TestCreateUserWithDisplayNamePersistsPreferencesAndRemainsLoginCompatible(t *testing.T) {
	server, _ := newTestServer(t)

	bob, err := server.CreateUserWithDisplayName("bob", "  Bob   Builder  ", "secret", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if bob.DisplayName != "Bob Builder" || bob.Preferences.DisplayName != "Bob Builder" || bob.Role != "admin" {
		t.Fatalf("unexpected created user: %+v", bob)
	}
	var persistedDisplayName string
	if err := server.db.QueryRow(`SELECT display_name FROM user_preferences WHERE user_id = ?`, bob.ID).Scan(&persistedDisplayName); err != nil {
		t.Fatal(err)
	}
	if persistedDisplayName != "Bob Builder" {
		t.Fatalf("persisted display name = %q", persistedDisplayName)
	}
	loginTestUser(t, server, bob.Username)

	charlie, err := server.CreateUserWithDisplayName("charlie", "", "secret", "user")
	if err != nil {
		t.Fatal(err)
	}
	if charlie.DisplayName != "charlie" || charlie.Preferences.DisplayName != "charlie" {
		t.Fatalf("username fallback was not applied: %+v", charlie)
	}

	if _, err := server.CreateUserWithDisplayName("bob", "Another Bob", "secret", "user"); err == nil {
		t.Fatal("duplicate username creation unexpectedly succeeded")
	}
	var preferenceCount int
	if err := server.db.QueryRow(
		`SELECT COUNT(*) FROM user_preferences up JOIN users u ON u.id = up.user_id WHERE u.username = 'bob'`,
	).Scan(&preferenceCount); err != nil {
		t.Fatal(err)
	}
	if preferenceCount != 1 {
		t.Fatalf("duplicate user attempt left %d preference rows", preferenceCount)
	}

	tooLong := strings.Repeat("x", 81)
	if _, err := server.CreateUserWithDisplayName("invalid-display", tooLong, "secret", "user"); err == nil {
		t.Fatal("overlong display name unexpectedly succeeded")
	}
	if _, err := server.CreateUserWithDisplayName("invalid-role", "Invalid Role", "secret", "superuser"); err == nil {
		t.Fatal("invalid role unexpectedly succeeded")
	}
	var invalidCount int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM users WHERE username IN ('invalid-display', 'invalid-role')`).Scan(&invalidCount); err != nil {
		t.Fatal(err)
	}
	if invalidCount != 0 {
		t.Fatalf("invalid user attempts left %d user rows", invalidCount)
	}
}

func TestProvisionSpaceAndRoomsByIDOrUniqueName(t *testing.T) {
	server, _ := newTestServer(t)
	alice := currentTestUser(t, server, "alice")

	space, err := server.CreateSpace("  Engineering   Guild ", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if space.Name != "Engineering Guild" || space.CreatorUserID != alice.ID || space.Visibility != "private" || space.JoinPolicy != "request" || space.Status != "active" {
		t.Fatalf("unexpected provisioned space: %+v", space)
	}
	assertTreeMembership(t, server, space.ID, alice.ID, "owner", "joined")

	byID, err := server.CreateRoom("Planning", space.ID)
	if err != nil {
		t.Fatal(err)
	}
	assertProvisionedRoom(t, server, byID, space, alice)

	byName, err := server.CreateRoom("Review", space.Name)
	if err != nil {
		t.Fatal(err)
	}
	assertProvisionedRoom(t, server, byName, space, alice)
}

func TestProvisioningRejectsMissingAndAmbiguousReferencesWithoutWrites(t *testing.T) {
	server, _ := newTestServer(t)
	first, err := server.CreateSpace("Duplicate", "alice")
	if err != nil {
		t.Fatal(err)
	}
	second, err := server.CreateSpace("Duplicate", "alice")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := server.CreateRoom("Ambiguous Room", "Duplicate"); err == nil || !strings.Contains(err.Error(), first.ID) || !strings.Contains(err.Error(), second.ID) {
		t.Fatalf("ambiguous lookup did not list both IDs: %v", err)
	}
	var roomCount int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM nests WHERE name = 'Ambiguous Room'`).Scan(&roomCount); err != nil {
		t.Fatal(err)
	}
	if roomCount != 0 {
		t.Fatalf("ambiguous room creation left %d rows", roomCount)
	}

	var spaceCountBefore int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM trees`).Scan(&spaceCountBefore); err != nil {
		t.Fatal(err)
	}
	if _, err := server.CreateSpace("Missing Creator", "nobody"); err == nil {
		t.Fatal("missing creator unexpectedly succeeded")
	}
	var spaceCountAfter int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM trees`).Scan(&spaceCountAfter); err != nil {
		t.Fatal(err)
	}
	if spaceCountAfter != spaceCountBefore {
		t.Fatalf("failed Space creation changed row count from %d to %d", spaceCountBefore, spaceCountAfter)
	}

	if _, err := server.CreateRoom("Missing Space Room", "does-not-exist"); err == nil {
		t.Fatal("missing Space unexpectedly succeeded")
	}
	if _, err := server.AddUserToSpace(first.ID, "nobody", nil); err == nil {
		t.Fatal("missing user unexpectedly succeeded")
	}
}

func TestAddUserToSpaceDefaultsPreservesRestoresAndProtectsOwners(t *testing.T) {
	server, _ := newTestServer(t)
	bob, _ := createTestUser(t, server, "bob")
	space, err := server.CreateSpace("Membership", "alice")
	if err != nil {
		t.Fatal(err)
	}
	alice := currentTestUser(t, server, "alice")

	added, err := server.AddUserToSpace(space.ID, bob.Username, nil)
	if err != nil {
		t.Fatal(err)
	}
	if added.Member.Role != "member" || added.Member.State != "joined" {
		t.Fatalf("unexpected default membership: %+v", added.Member)
	}

	moderator := "moderator"
	updated, err := server.AddUserToSpace(space.Name, bob.Username, &moderator)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Member.Role != "moderator" {
		t.Fatalf("explicit role was not applied: %+v", updated.Member)
	}
	preserved, err := server.AddUserToSpace(space.ID, bob.Username, nil)
	if err != nil {
		t.Fatal(err)
	}
	if preserved.Member.Role != "moderator" {
		t.Fatalf("omitted role did not preserve joined role: %+v", preserved.Member)
	}

	if _, err := server.db.Exec(`UPDATE tree_members SET state = 'removed', left_at = updated_at WHERE tree_id = ? AND user_id = ?`, space.ID, bob.ID); err != nil {
		t.Fatal(err)
	}
	restored, err := server.AddUserToSpace(space.ID, bob.Username, nil)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Member.Role != "member" || restored.Member.State != "joined" || restored.Member.LeftAt != nil {
		t.Fatalf("removed membership was not restored as member: %+v", restored.Member)
	}

	member := "member"
	if _, err := server.AddUserToSpace(space.ID, alice.Username, &member); err == nil {
		t.Fatal("sole owner demotion unexpectedly succeeded")
	}
	assertTreeMembership(t, server, space.ID, alice.ID, "owner", "joined")

	owner := "owner"
	if _, err := server.AddUserToSpace(space.ID, bob.Username, &owner); err != nil {
		t.Fatal(err)
	}
	if _, err := server.AddUserToSpace(space.ID, alice.Username, &member); err != nil {
		t.Fatalf("owner demotion with another owner failed: %v", err)
	}
	assertTreeMembership(t, server, space.ID, alice.ID, "member", "joined")
}

func assertProvisionedRoom(t *testing.T, server *Server, result ProvisionedRoom, space Tree, creator User) {
	t.Helper()
	if result.Room.TreeID == nil || *result.Room.TreeID != space.ID || result.Room.Type != "persistent" || result.Room.Status != "active" || result.Room.LifecycleState != "created" || result.Room.CreatorUserID != creator.ID {
		t.Fatalf("unexpected provisioned room: %+v", result)
	}
	var role, state string
	if err := server.db.QueryRow(`SELECT role, state FROM nest_members WHERE nest_id = ? AND user_id = ?`, result.Room.ID, creator.ID).Scan(&role, &state); err != nil {
		t.Fatal(err)
	}
	if role != "creator" || state != "joined" {
		t.Fatalf("unexpected room creator membership: role=%s state=%s", role, state)
	}
}

func assertTreeMembership(t *testing.T, server *Server, treeID, userID, wantRole, wantState string) {
	t.Helper()
	var role, state string
	if err := server.db.QueryRow(`SELECT role, state FROM tree_members WHERE tree_id = ? AND user_id = ?`, treeID, userID).Scan(&role, &state); err != nil {
		t.Fatal(err)
	}
	if role != wantRole || state != wantState {
		t.Fatalf("membership role/state = %s/%s, want %s/%s", role, state, wantRole, wantState)
	}
}
