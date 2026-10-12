package http

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientsBelowTheMinimumVersionAreAskedToUpdate(t *testing.T) {
	t.Setenv("RAVEN_MINIMUM_CLIENT_VERSION", "0.2.0")
	server, token := newTestServer(t)

	for _, tc := range []struct {
		name          string
		clientVersion string
		status        int
		reasonCode    string
	}{
		{"older client", "0.1.9", http.StatusUpgradeRequired, "client_below_minimum"},
		{"no version sent", "", http.StatusUpgradeRequired, "client_version_missing"},
		{"unreadable version", "banana", http.StatusUpgradeRequired, "invalid_client_version"},
		{"minimum itself", "0.2.0", http.StatusOK, ""},
		{"newer client", "0.3.1", http.StatusOK, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/v1/nests", nil)
			req.Header.Set("X-Session-ID", token)
			if tc.clientVersion != "" {
				req.Header.Set("X-Raven-Client-Version", tc.clientVersion)
			}
			response, err := server.app.Test(req)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != tc.status {
				t.Fatalf("status = %d, want %d", response.StatusCode, tc.status)
			}
			if tc.reasonCode == "" {
				return
			}
			var body struct {
				Compatibility Compatibility `json:"compatibility"`
			}
			if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.Compatibility.ReasonCode != tc.reasonCode || body.Compatibility.MinimumClientVersion != "0.2.0" {
				t.Fatalf("compatibility = %+v", body.Compatibility)
			}
		})
	}
}

func TestAnOutdatedClientCanStillReachItsAccountAndTheCompatibilityCheck(t *testing.T) {
	t.Setenv("RAVEN_MINIMUM_CLIENT_VERSION", "0.2.0")
	server, token := newTestServer(t)

	me := httptest.NewRequest(http.MethodGet, "/v1/auth/me", nil)
	me.Header.Set("X-Session-ID", token)
	me.Header.Set("X-Raven-Client-Version", "0.1.0")
	response, err := server.app.Test(me)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("/auth/me status = %d", response.StatusCode)
	}

	check := httptest.NewRequest(http.MethodGet, "/v1/server/compatibility?clientVersion=0.1.0", nil)
	response, err = server.app.Test(check)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body struct {
		Compatibility Compatibility `json:"compatibility"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || body.Compatibility.Status != "upgrade_required" {
		t.Fatalf("status = %d, compatibility = %+v", response.StatusCode, body.Compatibility)
	}
}
