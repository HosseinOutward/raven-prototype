package main

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"

	"raven/services/api/internal/database"
	apihttp "raven/services/api/internal/http"
)

func TestProvisioningCLIWorkflow(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "raven-cli-test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	server := apihttp.New(db)

	var stdout, stderr bytes.Buffer
	runCLI := func(args ...string) string {
		t.Helper()
		stdout.Reset()
		stderr.Reset()
		handled, err := runProvisioningCLI(server, args, &stdout, &stderr)
		if err != nil {
			t.Fatalf("%v: %v (stderr=%s)", args, err, stderr.String())
		}
		if !handled {
			t.Fatalf("command was not handled: %v", args)
		}
		return stdout.String()
	}

	userOutput := runCLI("user", "create", "--username", "alice", "--display-name", "Alice Admin", "--password", "top-secret", "--role", "admin")
	if !strings.Contains(userOutput, `display name "Alice Admin"`) || strings.Contains(userOutput, "top-secret") {
		t.Fatalf("unexpected user output: %q", userOutput)
	}
	runCLI("user", "create", "--username", "bob", "--password", "bob-secret")
	spaceOutput := runCLI("space", "create", "--name", "Raven Core", "--creator", "alice")
	if !strings.Contains(spaceOutput, `space "Raven Core"`) || !strings.Contains(spaceOutput, `creator "alice"`) {
		t.Fatalf("unexpected Space output: %q", spaceOutput)
	}
	roomOutput := runCLI("room", "create", "--name", "Daily Room", "--space", "Raven Core")
	if !strings.Contains(roomOutput, `room "Daily Room"`) || !strings.Contains(roomOutput, `space "Raven Core"`) || !strings.Contains(roomOutput, `creator "alice"`) {
		t.Fatalf("unexpected Room output: %q", roomOutput)
	}
	memberOutput := runCLI("space", "add-user", "--space", "Raven Core", "--username", "bob", "--role", "moderator")
	if !strings.Contains(memberOutput, `member "bob"`) || !strings.Contains(memberOutput, "as moderator") {
		t.Fatalf("unexpected membership output: %q", memberOutput)
	}

	var displayName, treeRole, nestType string
	if err := db.QueryRow(`SELECT up.display_name FROM user_preferences up JOIN users u ON u.id = up.user_id WHERE u.username = 'alice'`).Scan(&displayName); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT tm.role FROM tree_members tm JOIN trees t ON t.id = tm.tree_id JOIN users u ON u.id = tm.user_id WHERE t.name = 'Raven Core' AND u.username = 'bob'`).Scan(&treeRole); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT n.type FROM nests n JOIN trees t ON t.id = n.tree_id WHERE n.name = 'Daily Room' AND t.name = 'Raven Core'`).Scan(&nestType); err != nil {
		t.Fatal(err)
	}
	if displayName != "Alice Admin" || treeRole != "moderator" || nestType != "persistent" {
		t.Fatalf("unexpected persisted values: display=%q role=%q roomType=%q", displayName, treeRole, nestType)
	}
}

func TestProvisioningCLIValidationAndDispatch(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "raven-cli-validation.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	server := apihttp.New(db)
	var stdout, stderr bytes.Buffer

	handled, err := runProvisioningCLI(server, nil, &stdout, &stderr)
	if handled || err != nil {
		t.Fatalf("empty command should fall through: handled=%t err=%v", handled, err)
	}
	handled, err = runProvisioningCLI(server, []string{"release-admin", "list"}, &stdout, &stderr)
	if handled || err != nil {
		t.Fatalf("release-admin should fall through: handled=%t err=%v", handled, err)
	}

	for _, args := range [][]string{
		{"user", "create", "--username", "alice"},
		{"space", "create", "--name", "Missing Creator"},
		{"room", "create", "--name", "Missing Space"},
		{"space", "add-user", "--space", "Missing User"},
		{"user", "create", "--username", "alice", "--password", "secret", "extra"},
	} {
		stdout.Reset()
		stderr.Reset()
		handled, err := runProvisioningCLI(server, args, &stdout, &stderr)
		if !handled || err == nil {
			t.Fatalf("invalid command should fail: args=%v handled=%t err=%v", args, handled, err)
		}
	}

	if _, err := runProvisioningCLI(server, []string{"user", "create", "--username", "alice", "--password", "secret-enough"}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	if _, err := runProvisioningCLI(server, []string{"user", "create", "--username", "alice", "--password", "secret-enough"}, &stdout, &stderr); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("duplicate CLI user error = %v", err)
	}
}
