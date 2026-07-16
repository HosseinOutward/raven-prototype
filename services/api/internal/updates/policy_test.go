package updates

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestStableRolloutBucketAndPercentageExpansion(t *testing.T) {
	digestA, bucketA, err := InstallationDigestAndBucket("installation-a")
	if err != nil {
		t.Fatal(err)
	}
	digestB, bucketB, err := InstallationDigestAndBucket("installation-a")
	if err != nil {
		t.Fatal(err)
	}
	if digestA != digestB || bucketA != bucketB || len(digestA) != 64 {
		t.Fatalf("bucket was not stable: %q/%d vs %q/%d", digestA, bucketA, digestB, bucketB)
	}
	for index := 0; index < 1000; index++ {
		_, bucket, err := InstallationDigestAndBucket("installation-" + string(rune(index+1000)))
		if err != nil {
			t.Fatal(err)
		}
		if EligibleForPercentage(bucket, 500) && !EligibleForPercentage(bucket, 2500) {
			t.Fatalf("5%% member left the rollout after expansion at bucket %d", bucket)
		}
	}
}

func TestCompatibilityRangesCapabilitiesAndGrace(t *testing.T) {
	policy := ServerPolicy{ServerVersion: "2.0.0", ProtocolVersion: 4, MinimumClientVersion: "1.5.0", RecommendedClientVersion: "1.9.0", RequiredCapabilities: []string{"updates-v1", "nests-v2"}}
	below := EvaluateServerCompatibility(policy, "1.4.9", 4, []string{"updates-v1", "nests-v2"})
	if below.Status != "upgrade_required" || below.ReasonCode != "client_below_minimum" {
		t.Fatalf("unexpected below-minimum result: %+v", below)
	}
	missing := EvaluateServerCompatibility(policy, "1.8.0", 4, []string{"updates-v1"})
	if missing.ReasonCode != "capability_missing" || len(missing.MissingCapabilities) != 1 || missing.MissingCapabilities[0] != "nests-v2" {
		t.Fatalf("unexpected capability result: %+v", missing)
	}
	protocol := EvaluateServerCompatibility(policy, "1.8.0", 3, []string{"updates-v1", "nests-v2"})
	if protocol.ReasonCode != "protocol_mismatch" {
		t.Fatalf("unexpected protocol result: %+v", protocol)
	}
	grace := time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)
	minimum := "2.0.0"
	release := Release{ClientProtocolVersion: 4, MinimumServerVersion: &minimum, RequiredCapabilities: []string{"updates-v1"}, GraceEndsAt: &grace}
	client := ClientContext{CurrentVersion: "1.8.0", ServerVersion: "2.0.0", ProtocolVersion: 4, Capabilities: []string{"updates-v1"}}
	compatible := EvaluateReleaseCompatibility(release, client, time.Now())
	if compatible.Status != "grace_period" {
		t.Fatalf("expected grace period, got %+v", compatible)
	}
}

func TestLifecyclePauseResumeWithdrawAndSupersedePolicy(t *testing.T) {
	cases := []struct {
		from string
		to   string
		want bool
	}{
		{StateDraft, StateValidated, true},
		{StateValidated, StateRollingOut, true},
		{StateRollingOut, StatePaused, true},
		{StatePaused, StateRollingOut, true},
		{StateRollingOut, StateWithdrawn, true},
		{StateFullyReleased, StateSuperseded, true},
		{StateWithdrawn, StateRollingOut, false},
		{StateSuperseded, StateRollingOut, false},
	}
	for _, test := range cases {
		if got := ValidLifecycleTransition(test.from, test.to); got != test.want {
			t.Fatalf("transition %s -> %s: got %v, want %v", test.from, test.to, got, test.want)
		}
	}
}

func TestDiagnosticRedactionFixedVectors(t *testing.T) {
	payload := map[string]any{
		"authorization": "Bearer top-secret",
		"nested": map[string]any{
			"log":      "GET https://updates.example/file?token=abc&safe=yes&X-Amz-Signature=deadbeef from C:\\Users\\Soroush\\AppData and /home/alice/.config at 192.168.1.12",
			"endpoint": "postgres://raven:password@example/db?session_id=abc",
		},
		"safe": "verification_failed",
	}
	redacted := RedactDiagnostic(payload)
	encoded := strings.ToLower(toJSON(t, redacted))
	for _, forbidden := range []string{"top-secret", "token=abc", "deadbeef", "soroush", "/home/alice", "192.168.1.12", "raven:password"} {
		if strings.Contains(encoded, strings.ToLower(forbidden)) {
			t.Fatalf("redaction leaked %q in %s", forbidden, encoded)
		}
	}
	if !strings.Contains(encoded, "verification_failed") || !strings.Contains(encoded, "safe=yes") {
		t.Fatalf("redaction removed safe diagnostic context: %s", encoded)
	}
}

func toJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}
