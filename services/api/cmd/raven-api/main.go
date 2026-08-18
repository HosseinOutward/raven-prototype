package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"raven/services/api/internal/database"
	apihttp "raven/services/api/internal/http"
	"raven/services/api/internal/updates"
)

func main() {
	if err := database.LoadDotEnv(".env", "../../.env"); err != nil {
		log.Fatalf("load env: %v", err)
	}

	db, err := database.OpenFromEnv()
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer db.Close()

	if len(os.Args) >= 2 && os.Args[1] == "release-admin" {
		if len(os.Args) < 3 {
			log.Fatal("usage: raven-api release-admin <grant|revoke|list|assign-cohort> [flags]")
		}
		manageReleaseAdministrator(updates.NewStore(db), os.Args[2], os.Args[3:])
		return
	}
	server := apihttp.New(db)
	if handled, err := runProvisioningCLI(server, os.Args[1:], os.Stdout, os.Stderr); handled {
		if err != nil {
			log.Fatal(err)
		}
		return
	}
	if len(os.Args) > 1 {
		log.Fatalf("unknown command %q", os.Args[1])
	}

	addr := os.Getenv("RAVEN_API_ADDR")
	if addr == "" {
		addr = "127.0.0.1:6977"
	}
	log.Printf("Raven API listening on http://%s", addr)
	if err := server.Listen(addr); err != nil {
		log.Fatal(err)
	}
}

func manageReleaseAdministrator(store *updates.Store, action string, args []string) {
	fs := flag.NewFlagSet("release-admin "+action, flag.ExitOnError)
	username := fs.String("username", "", "existing Raven username")
	installationID := fs.String("installation-id", "", "installation identifier shared with explicit consent")
	cohort := fs.String("cohort", "", "update cohort")
	reason := fs.String("reason", "", "assignment reason")
	_ = fs.Parse(args)
	switch action {
	case "grant":
		admin, err := store.GrantReleaseAdministrator(*username, nil, time.Now())
		if err != nil {
			log.Fatalf("grant release administrator: %v", err)
		}
		fmt.Printf("granted release-administrator permission to %q (%s)\n", admin.Username, admin.UserID)
	case "revoke":
		if err := store.RevokeReleaseAdministrator(*username, time.Now()); err != nil {
			log.Fatalf("revoke release administrator: %v", err)
		}
		fmt.Printf("revoked release-administrator permission from %q\n", *username)
	case "list":
		admins, err := store.ListReleaseAdministrators()
		if err != nil {
			log.Fatalf("list release administrators: %v", err)
		}
		for _, admin := range admins {
			status := "active"
			if admin.RevokedAt != nil {
				status = "revoked"
			}
			fmt.Printf("%s\t%s\t%s\n", admin.Username, admin.UserID, status)
		}
	case "assign-cohort":
		assignment, err := store.AssignInstallationCohort(*installationID, *cohort, *reason, updates.Actor{Label: "local-release-admin-cli"}, time.Now())
		if err != nil {
			log.Fatalf("assign update cohort: %v", err)
		}
		fmt.Printf("assigned the consented installation to cohort %q at %s\n", assignment.Cohort, assignment.AssignedAt)
	default:
		log.Fatal("release-admin action must be grant, revoke, list, or assign-cohort")
	}
}
