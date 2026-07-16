package http

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	updatecontrol "raven/services/api/internal/updates"
)

func TestUpdatePolicyMatchesDesktopClosedAlphaConsentLiteral(t *testing.T) {
	server, _ := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/updates/policy", nil)
	response, err := server.app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("policy status = %d", response.StatusCode)
	}
	var payload struct {
		ConsentVersion string   `json:"consentVersion"`
		RequiredData   []string `json:"requiredDeliveryData"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.ConsentVersion != "closed-alpha-2026-07-12" || len(payload.RequiredData) == 0 {
		t.Fatalf("policy = %+v", payload)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("policy cache control = %q", response.Header.Get("Cache-Control"))
	}
}

func TestLegacyClientCommunicationIsBlockedButRecoverySurfacesRemainAvailable(t *testing.T) {
	server, token := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/nests", nil)
	req.Header.Set("X-Session-ID", token)
	response, err := server.app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUpgradeRequired {
		t.Fatalf("legacy service status = %d", response.StatusCode)
	}
	var blocked struct {
		Compatibility struct {
			ReasonCode string `json:"reasonCode"`
		} `json:"compatibility"`
	}
	if err := json.NewDecoder(response.Body).Decode(&blocked); err != nil {
		t.Fatal(err)
	}
	if blocked.Compatibility.ReasonCode != "client_metadata_required" {
		t.Fatalf("legacy reason code = %q", blocked.Compatibility.ReasonCode)
	}

	preferences := httptest.NewRequest(http.MethodGet, "/v1/preferences", nil)
	preferences.Header.Set("X-Session-ID", token)
	preferenceResponse, err := server.app.Test(preferences)
	if err != nil {
		t.Fatal(err)
	}
	defer preferenceResponse.Body.Close()
	if preferenceResponse.StatusCode != http.StatusOK {
		t.Fatalf("recovery/settings status = %d", preferenceResponse.StatusCode)
	}

	compatibility := httptest.NewRequest(http.MethodGet, "/v1/server/compatibility?clientVersion=0.1.0&protocolVersion=1", nil)
	compatibilityResponse, err := server.app.Test(compatibility)
	if err != nil {
		t.Fatal(err)
	}
	defer compatibilityResponse.Body.Close()
	if compatibilityResponse.StatusCode != http.StatusOK {
		t.Fatalf("compatibility status = %d", compatibilityResponse.StatusCode)
	}
}

func TestMissingRequiredCapabilityDeclarationFailsClosed(t *testing.T) {
	t.Setenv("RAVEN_REQUIRED_CLIENT_CAPABILITIES", "updates-v1")
	server, token := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/nests", nil)
	req.Header.Set("X-Session-ID", token)
	req.Header.Set("X-Raven-Client-Version", "0.1.0")
	req.Header.Set("X-Raven-Protocol-Version", "1")
	req.Header.Set("X-Raven-Update-Channel", "alpha")
	response, err := server.app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUpgradeRequired {
		t.Fatalf("missing capability status = %d", response.StatusCode)
	}
	var payload struct {
		Compatibility updatecontrol.Compatibility `json:"compatibility"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Compatibility.ReasonCode != "capability_missing" || len(payload.Compatibility.MissingCapabilities) != 1 || payload.Compatibility.MissingCapabilities[0] != "updates-v1" {
		t.Fatalf("missing capability response = %+v", payload.Compatibility)
	}
}

func TestOpsPasswordReauthenticationIsRateLimitedByIPAndAccount(t *testing.T) {
	server, token := newTestServer(t)
	user := currentTestUser(t, server, "alice")
	if _, err := server.updates.Store().GrantReleaseAdministrator(user.Username, nil, time.Now()); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 6; attempt++ {
		status, _ := rawJSONRequest(t, server, http.MethodPost, "/v1/ops/session", token, nil, map[string]any{"password": "wrong"})
		want := http.StatusUnauthorized
		if attempt == 5 {
			want = http.StatusTooManyRequests
		}
		if status != want {
			t.Fatalf("attempt %d status = %d, want %d", attempt+1, status, want)
		}
	}
}

func TestPublishedRequiredReleaseDynamicallyGatesServiceAndCompatibility(t *testing.T) {
	server, token := newTestServer(t)
	input := updatecontrol.CreateReleaseInput{
		Version:                  "1.1.0",
		Channel:                  updatecontrol.ChannelAlpha,
		Classification:           updatecontrol.ClassificationRecommended,
		Notes:                    "Required protocol repair.",
		GitCommit:                strings.Repeat("a", 40),
		ClientProtocolVersion:    1,
		LocalDataSchemaVersion:   1,
		LocalMigrationReversible: true,
		RollbackSafe:             true,
	}
	for _, platform := range []string{"windows", "linux"} {
		prefix := "desktop/alpha/1.1.0/" + platform + "/x86_64/"
		input.Artifacts = append(input.Artifacts, updatecontrol.ArtifactInput{Platform: platform, Architecture: "x86_64", Format: "update", ObjectKey: prefix + "Raven", Signature: "signature", SHA256: strings.Repeat("a", 64), Size: 100, ChecksumObjectKey: prefix + "Raven.sha256", ChecksumSHA256: strings.Repeat("b", 64), SBOMObjectKey: prefix + "Raven.sbom.json", SBOMSHA256: strings.Repeat("c", 64), ProvenanceObjectKey: prefix + "Raven.provenance.json", ProvenanceSHA256: strings.Repeat("d", 64)})
	}
	actor := updatecontrol.Actor{Label: "test-operator", CorrelationID: "required-policy-test"}
	release, err := server.updates.Store().CreateRelease(input, actor, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	release, err = server.updates.Store().MarkValidated(release.ID, actor, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	release, err = server.updates.Store().Publish(release.ID, updatecontrol.StateRollingOut, []updatecontrol.RolloutInput{{Cohort: "friends", Percentage: 0}}, "publish repair", actor, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.updates.Store().SetRequired(release.ID, "unsafe predecessor", actor, time.Now()); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/nests", nil)
	req.Header.Set("X-Session-ID", token)
	req.Header.Set("X-Raven-Client-Version", "0.1.0")
	req.Header.Set("X-Raven-Protocol-Version", "1")
	req.Header.Set("X-Raven-Update-Channel", "alpha")
	req.Header.Set("X-Raven-Update-Cohort", "friends")
	response, err := server.app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUpgradeRequired {
		t.Fatalf("required release gate status = %d", response.StatusCode)
	}
	var blocked struct {
		Compatibility updatecontrol.Compatibility `json:"compatibility"`
	}
	if err := json.NewDecoder(response.Body).Decode(&blocked); err != nil {
		t.Fatal(err)
	}
	if blocked.Compatibility.ReasonCode != "required_release" || blocked.Compatibility.MinimumClientVersion != "1.1.0" {
		t.Fatalf("required release compatibility = %+v", blocked.Compatibility)
	}
	compatibilityRequest := httptest.NewRequest(http.MethodGet, "/v1/server/compatibility?clientVersion=0.1.0&protocolVersion=1&channel=alpha&cohort=friends", nil)
	compatibilityResponse, err := server.app.Test(compatibilityRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer compatibilityResponse.Body.Close()
	var policy struct {
		Compatibility updatecontrol.Compatibility `json:"compatibility"`
	}
	if err := json.NewDecoder(compatibilityResponse.Body).Decode(&policy); err != nil {
		t.Fatal(err)
	}
	if policy.Compatibility.MinimumClientVersion != "1.1.0" || policy.Compatibility.RecommendedClientVersion != "1.1.0" {
		t.Fatalf("effective compatibility policy = %+v", policy.Compatibility)
	}
}

func TestOpsShortSessionTypedConfirmationAndImmutableAudit(t *testing.T) {
	server, token := newTestServer(t)
	user := currentTestUser(t, server, "alice")
	if _, err := server.updates.Store().GrantReleaseAdministrator(user.Username, nil, time.Now()); err != nil {
		t.Fatal(err)
	}
	status, raw := rawJSONRequest(t, server, http.MethodPost, "/v1/ops/session", token, nil, map[string]any{"password": "secret"})
	if status != http.StatusOK {
		t.Fatalf("ops session status = %d, body=%s", status, raw)
	}
	var session struct {
		Token string `json:"opsSessionToken"`
	}
	if err := json.Unmarshal(raw, &session); err != nil || session.Token == "" {
		t.Fatalf("ops session response = %s, %v", raw, err)
	}
	headers := map[string]string{"X-Raven-Ops-Session": session.Token}
	status, raw = rawJSONRequest(t, server, http.MethodPost, "/v1/ops/authorize-action", token, headers, map[string]any{"password": "secret", "action": "disable_channel", "subject": "alpha"})
	if status != http.StatusOK {
		t.Fatalf("authorize status = %d, body=%s", status, raw)
	}
	var authorization struct {
		Token        string `json:"actionAuthorizationToken"`
		Confirmation string `json:"expectedConfirmation"`
	}
	if err := json.Unmarshal(raw, &authorization); err != nil {
		t.Fatal(err)
	}
	if authorization.Confirmation != "DISABLE alpha" || authorization.Token == "" {
		t.Fatalf("authorization = %+v", authorization)
	}
	headers["X-Raven-Action-Authorization"] = authorization.Token
	status, raw = rawJSONRequest(t, server, http.MethodPost, "/v1/ops/channels/alpha/disable", token, headers, map[string]any{"reason": "emergency maintenance", "confirmation": authorization.Confirmation})
	if status != http.StatusOK {
		t.Fatalf("disable status = %d, body=%s", status, raw)
	}
	status, _ = rawJSONRequest(t, server, http.MethodPost, "/v1/ops/channels/alpha/disable", token, headers, map[string]any{"reason": "replay", "confirmation": authorization.Confirmation})
	if status != http.StatusForbidden {
		t.Fatalf("consumed action authorization replay status = %d", status)
	}
	var count int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM release_audit_events WHERE action = 'disable_channel'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("disable audit count = %d, err=%v", count, err)
	}
	if _, err := server.db.Exec(`UPDATE release_audit_events SET reason = 'tampered' WHERE action = 'disable_channel'`); err == nil {
		t.Fatal("immutable release audit row was updated")
	}
}

func rawJSONRequest(t *testing.T, server *Server, method, path, sessionToken string, headers map[string]string, body any) (int, []byte) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if sessionToken != "" {
		req.Header.Set("X-Session-ID", sessionToken)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	response, err := server.app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	responseBody := new(bytes.Buffer)
	if _, err := responseBody.ReadFrom(response.Body); err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, responseBody.Bytes()
}
