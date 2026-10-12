package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"raven/services/api/internal/database"
	apihttp "raven/services/api/internal/http"
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
	// On a stop signal, finish what is in flight instead of cutting it off: a send that
	// was acknowledged is already committed, and one that was not gets a clean error the
	// client retries.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		log.Printf("Raven API shutting down")
		if err := server.Shutdown(10 * time.Second); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}()

	log.Printf("Raven API listening on http://%s", addr)
	if err := server.Listen(addr); err != nil {
		log.Fatal(err)
	}
}
