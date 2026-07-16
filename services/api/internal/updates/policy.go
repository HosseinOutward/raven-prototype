package updates

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/Masterminds/semver/v3"
)

func NormalizeVersion(value string) (string, error) {
	parsed, err := semver.NewVersion(strings.TrimSpace(value))
	if err != nil {
		return "", fmt.Errorf("invalid semantic version %q", value)
	}
	return parsed.String(), nil
}

func ValidateVersionRange(value string) error {
	if strings.TrimSpace(value) == "" {
		return errors.New("version range is required")
	}
	_, err := semver.NewConstraint(value)
	if err != nil {
		return fmt.Errorf("invalid semantic version range %q", value)
	}
	return nil
}

func VersionMatches(version, constraint string) bool {
	parsed, err := semver.NewVersion(version)
	if err != nil {
		return false
	}
	rule, err := semver.NewConstraint(constraint)
	return err == nil && rule.Check(parsed)
}

func VersionGreater(left, right string) bool {
	l, err := semver.NewVersion(left)
	if err != nil {
		return false
	}
	r, err := semver.NewVersion(right)
	return err == nil && l.GreaterThan(r)
}

func InstallationDigestAndBucket(installationID string) (string, int, error) {
	installationID = strings.TrimSpace(installationID)
	if installationID == "" {
		return "", 0, errors.New("installation id is required")
	}
	hash := sha256.Sum256([]byte("raven-rollout-v1\x00" + installationID))
	bucket := int(binary.BigEndian.Uint64(hash[:8]) % 10000)
	return hex.EncodeToString(hash[:]), bucket, nil
}

func EligibleForPercentage(bucket, basisPoints int) bool {
	if bucket < 0 || bucket >= 10000 || basisPoints <= 0 {
		return false
	}
	if basisPoints >= 10000 {
		return true
	}
	return bucket < basisPoints
}

func NormalizeChannel(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return ChannelAlpha, nil
	}
	if value != ChannelAlpha && value != ChannelStable {
		return "", errors.New("channel must be alpha or stable")
	}
	return value, nil
}

func NormalizeClassification(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return ClassificationOptional, nil
	}
	switch value {
	case ClassificationOptional, ClassificationRecommended, ClassificationRequired:
		return value, nil
	default:
		return "", errors.New("classification must be optional, recommended, or required")
	}
}

func NormalizeTarget(target, architecture string) (string, string, error) {
	target = strings.ToLower(strings.TrimSpace(target))
	architecture = strings.ToLower(strings.TrimSpace(architecture))
	switch {
	case strings.Contains(target, "windows"):
		target = "windows"
	case strings.Contains(target, "linux"):
		target = "linux"
	default:
		return "", "", errors.New("target must identify Windows or Linux")
	}
	switch architecture {
	case "x86_64", "amd64", "x64":
		architecture = "x86_64"
	default:
		if strings.Contains(architecture, "x86_64") || strings.Contains(target, "x86_64") {
			architecture = "x86_64"
		} else {
			return "", "", errors.New("architecture must be x86_64")
		}
	}
	return target, architecture, nil
}

func NormalizeCapabilities(values []string) []string {
	seen := map[string]struct{}{}
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if value != "" {
			seen[value] = struct{}{}
		}
	}
	out := make([]string, 0, len(seen))
	for value := range seen {
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func MissingCapabilities(required, provided []string) []string {
	have := map[string]struct{}{}
	for _, value := range NormalizeCapabilities(provided) {
		have[value] = struct{}{}
	}
	missing := []string{}
	for _, value := range NormalizeCapabilities(required) {
		if _, ok := have[value]; !ok {
			missing = append(missing, value)
		}
	}
	return missing
}

func EvaluateServerCompatibility(policy ServerPolicy, clientVersion string, protocolVersion int, capabilities []string) Compatibility {
	result := Compatibility{
		Status:                   "compatible",
		ReasonCode:               "compatible",
		Message:                  "This Raven client is compatible with the selected server.",
		ClientVersion:            strings.TrimSpace(clientVersion),
		ServerVersion:            policy.ServerVersion,
		ProtocolVersion:          policy.ProtocolVersion,
		MinimumClientVersion:     policy.MinimumClientVersion,
		RecommendedClientVersion: policy.RecommendedClientVersion,
		RequiredCapabilities:     NormalizeCapabilities(policy.RequiredCapabilities),
	}
	if clientVersion == "" {
		result.Status = "unknown"
		result.ReasonCode = "client_version_missing"
		result.Message = "The client version was not provided, so compatibility could not be confirmed."
		return result
	}
	client, err := semver.NewVersion(clientVersion)
	if err != nil {
		result.Status = "unsupported"
		result.ReasonCode = "invalid_client_version"
		result.Message = "The client version is not a valid semantic version."
		return result
	}
	if minimum, err := semver.NewVersion(policy.MinimumClientVersion); err == nil && client.LessThan(minimum) {
		result.Status = "upgrade_required"
		result.ReasonCode = "client_below_minimum"
		result.Message = "This Raven version is too old for safe communication with the selected server."
		return result
	}
	if policy.ProtocolVersion > 0 && protocolVersion > 0 && protocolVersion != policy.ProtocolVersion {
		result.Status = "upgrade_required"
		result.ReasonCode = "protocol_mismatch"
		result.Message = "The Raven client and server use incompatible communication protocols."
		return result
	}
	result.MissingCapabilities = MissingCapabilities(policy.RequiredCapabilities, capabilities)
	if len(result.MissingCapabilities) > 0 {
		result.Status = "upgrade_required"
		result.ReasonCode = "capability_missing"
		result.Message = "This Raven version is missing capabilities required by the selected server."
	}
	return result
}

func EvaluateReleaseCompatibility(release Release, client ClientContext, now time.Time) Compatibility {
	result := Compatibility{
		Status:               "compatible",
		ReasonCode:           "compatible",
		Message:              "The update is compatible with this Raven installation.",
		ClientVersion:        client.CurrentVersion,
		ServerVersion:        client.ServerVersion,
		ProtocolVersion:      release.ClientProtocolVersion,
		RequiredCapabilities: NormalizeCapabilities(release.RequiredCapabilities),
		GraceEndsAt:          release.GraceEndsAt,
	}
	if release.ClientProtocolVersion > 0 && client.ProtocolVersion > 0 && release.ClientProtocolVersion != client.ProtocolVersion {
		result.Status = "unsupported"
		result.ReasonCode = "protocol_mismatch"
		result.Message = "The available update requires a different Raven protocol version."
		return result
	}
	if client.ServerVersion != "" && release.MinimumServerVersion != nil && VersionGreater(*release.MinimumServerVersion, client.ServerVersion) {
		result.Status = "server_too_old"
		result.ReasonCode = "server_below_minimum"
		result.MinimumServerVersion = *release.MinimumServerVersion
		result.Message = "The selected Raven server is too old for this update."
		return result
	}
	if client.ServerVersion != "" && release.MaximumServerVersion != nil && VersionGreater(client.ServerVersion, *release.MaximumServerVersion) {
		result.Status = "server_too_new"
		result.ReasonCode = "server_above_maximum"
		result.MaximumServerVersion = *release.MaximumServerVersion
		result.Message = "The selected Raven server is newer than this update supports."
		return result
	}
	result.MissingCapabilities = MissingCapabilities(release.RequiredCapabilities, client.Capabilities)
	if len(result.MissingCapabilities) > 0 {
		result.Status = "unsupported"
		result.ReasonCode = "capability_missing"
		result.Message = "The available update requires capabilities this installation did not report."
		return result
	}
	if release.GraceEndsAt != nil {
		if end, err := time.Parse(time.RFC3339Nano, *release.GraceEndsAt); err == nil && now.Before(end) {
			result.Status = "grace_period"
			result.ReasonCode = "grace_period_active"
			result.Message = "This update is compatible and is currently within its configured grace period."
		}
	}
	return result
}

func ValidLifecycleTransition(from, to string) bool {
	allowed := map[string]map[string]bool{
		StateDraft:         {StateValidated: true, StateWithdrawn: true},
		StateValidated:     {StateInternal: true, StateRollingOut: true, StateFullyReleased: true, StateWithdrawn: true, StateSuperseded: true},
		StateInternal:      {StateRollingOut: true, StateFullyReleased: true, StatePaused: true, StateWithdrawn: true, StateSuperseded: true},
		StateRollingOut:    {StateFullyReleased: true, StatePaused: true, StateWithdrawn: true, StateSuperseded: true},
		StatePaused:        {StateInternal: true, StateRollingOut: true, StateFullyReleased: true, StateWithdrawn: true, StateSuperseded: true},
		StateFullyReleased: {StatePaused: true, StateWithdrawn: true, StateSuperseded: true},
	}
	return allowed[from][to]
}
