package database

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"strings"
	"testing"
)

// Applied migrations are checked against their checksum on every start. Adding a
// capability must not change the text of the migration that seeded the first ones.
func TestPermissionsMigrationTextIsUnchanged(t *testing.T) {
	want := map[string]string{
		"sqlite": "941b78e94fd9840559bab60ec67e71d39170a8afb845bb64147ffafed8775d4a",
		"pgx":    "3ac98619d1ba5424cc8e096d277bf174993a01bcdc7ebb9544726809b36c6c7c",
	}
	for driver, checksum := range want {
		hash := sha256.Sum256([]byte(strings.Join(permissionsStatements(driver), "\n")))
		if got := hex.EncodeToString(hash[:]); got != checksum {
			t.Errorf("%s: permissions migration changed: %s", driver, got)
		}
	}
}

func TestSignUpInviteMigrationStartsEverythingClosed(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "raven.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var signUp, invitations bool
	if err := db.QueryRow(`SELECT sign_up_open, invitations_open FROM server_settings WHERE id = 1`).Scan(&signUp, &invitations); err != nil {
		t.Fatal(err)
	}
	if signUp || invitations {
		t.Fatalf("sign-up %v, invitations %v; want both off", signUp, invitations)
	}
	var allowed bool
	if err := db.QueryRow(`SELECT allowed FROM server_capability_defaults WHERE capability = ?`, CapabilityInvitesCreate).Scan(&allowed); err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("invites.create is allowed by default")
	}
}
