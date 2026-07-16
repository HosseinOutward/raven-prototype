package updates

import (
	"context"
	"time"
)

const (
	ChannelStable = "stable"
	ChannelAlpha  = "alpha"

	ClassificationOptional    = "optional"
	ClassificationRecommended = "recommended"
	ClassificationRequired    = "required"
	ClassificationBlocked     = "blocked"

	StateDraft         = "draft"
	StateValidated     = "validated"
	StateInternal      = "internal"
	StateRollingOut    = "rolling_out"
	StatePaused        = "paused"
	StateFullyReleased = "fully_released"
	StateWithdrawn     = "withdrawn"
	StateSuperseded    = "superseded"
)

type Channel struct {
	Name           string  `json:"name"`
	Enabled        bool    `json:"enabled"`
	DisabledReason string  `json:"disabledReason"`
	Revision       int64   `json:"revision"`
	CreatedAt      string  `json:"createdAt"`
	UpdatedAt      string  `json:"updatedAt"`
	UpdatedByID    *string `json:"updatedByUserId,omitempty"`
}

type Cohort struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Active      bool   `json:"active"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

type CohortAssignment struct {
	Cohort     string `json:"cohort"`
	AssignedAt string `json:"assignedAt"`
}

type Release struct {
	ID                        string     `json:"id"`
	Version                   string     `json:"version"`
	Channel                   string     `json:"channel"`
	Classification            string     `json:"classification"`
	State                     string     `json:"state"`
	PausedFromState           *string    `json:"pausedFromState,omitempty"`
	Notes                     string     `json:"notes"`
	GitCommit                 string     `json:"gitCommit"`
	ClientProtocolVersion     int        `json:"clientProtocolVersion"`
	MinimumServerVersion      *string    `json:"minimumServerVersion,omitempty"`
	MaximumServerVersion      *string    `json:"maximumServerVersion,omitempty"`
	RequiredCapabilities      []string   `json:"requiredCapabilities"`
	GraceEndsAt               *string    `json:"graceEndsAt,omitempty"`
	LocalDataSchemaVersion    int        `json:"localDataSchemaVersion"`
	LocalMigrationReversible  bool       `json:"localMigrationReversible"`
	RollbackSafe              bool       `json:"rollbackSafe"`
	SupersededByReleaseID     *string    `json:"supersededByReleaseId,omitempty"`
	ApprovedRollbackReleaseID *string    `json:"approvedRollbackReleaseId,omitempty"`
	Revision                  int64      `json:"revision"`
	CreatedByUserID           *string    `json:"createdByUserId,omitempty"`
	CreatedAt                 string     `json:"createdAt"`
	UpdatedAt                 string     `json:"updatedAt"`
	ValidatedAt               *string    `json:"validatedAt,omitempty"`
	PublishedAt               *string    `json:"publishedAt,omitempty"`
	WithdrawnAt               *string    `json:"withdrawnAt,omitempty"`
	Artifacts                 []Artifact `json:"artifacts"`
	Rollouts                  []Rollout  `json:"rollouts"`
}

type Artifact struct {
	ID                  string  `json:"id"`
	ReleaseID           string  `json:"releaseId"`
	Platform            string  `json:"platform"`
	Architecture        string  `json:"architecture"`
	Format              string  `json:"format"`
	ObjectKey           string  `json:"objectKey"`
	Signature           string  `json:"signature"`
	SHA256              string  `json:"sha256"`
	Size                int64   `json:"size"`
	ChecksumObjectKey   string  `json:"checksumObjectKey"`
	ChecksumSHA256      string  `json:"checksumSha256"`
	SBOMObjectKey       string  `json:"sbomObjectKey"`
	SBOMSHA256          string  `json:"sbomSha256"`
	ProvenanceObjectKey string  `json:"provenanceObjectKey"`
	ProvenanceSHA256    string  `json:"provenanceSha256"`
	VerifiedAt          *string `json:"verifiedAt,omitempty"`
	CreatedAt           string  `json:"createdAt"`
	DownloadURL         string  `json:"downloadUrl,omitempty"`
}

type Rollout struct {
	ReleaseID             string  `json:"releaseId"`
	Cohort                string  `json:"cohort"`
	PercentageBasisPoints int     `json:"percentageBasisPoints"`
	Percentage            float64 `json:"percentage"`
	Revision              int64   `json:"revision"`
	CreatedAt             string  `json:"createdAt"`
	UpdatedAt             string  `json:"updatedAt"`
	UpdatedByUserID       *string `json:"updatedByUserId,omitempty"`
}

type VersionBlock struct {
	ID              string  `json:"id"`
	VersionRange    string  `json:"range"`
	Channel         *string `json:"channel,omitempty"`
	Reason          string  `json:"reason"`
	TargetReleaseID *string `json:"targetReleaseId,omitempty"`
	Active          bool    `json:"active"`
	CreatedByUserID *string `json:"createdByUserId,omitempty"`
	CreatedAt       string  `json:"createdAt"`
	UpdatedAt       string  `json:"updatedAt"`
}

type AuditEvent struct {
	ID                string  `json:"id"`
	ActorUserID       *string `json:"actorUserId,omitempty"`
	ActorLabel        string  `json:"actorLabel"`
	Action            string  `json:"action"`
	EntityType        string  `json:"entityType"`
	EntityID          string  `json:"entityId"`
	PreviousStateJSON *string `json:"previousStateJson,omitempty"`
	NewStateJSON      *string `json:"newStateJson,omitempty"`
	Reason            string  `json:"reason"`
	CorrelationID     string  `json:"correlationId"`
	IdempotencyKey    *string `json:"idempotencyKey,omitempty"`
	CreatedAt         string  `json:"createdAt"`
}

type ArtifactInput struct {
	Platform            string `json:"platform"`
	Architecture        string `json:"architecture"`
	Format              string `json:"format"`
	ObjectKey           string `json:"objectKey"`
	Signature           string `json:"signature"`
	SHA256              string `json:"sha256"`
	Size                int64  `json:"size"`
	ChecksumObjectKey   string `json:"checksumObjectKey"`
	ChecksumSHA256      string `json:"checksumSha256"`
	SBOMObjectKey       string `json:"sbomObjectKey"`
	SBOMSHA256          string `json:"sbomSha256"`
	ProvenanceObjectKey string `json:"provenanceObjectKey"`
	ProvenanceSHA256    string `json:"provenanceSha256"`
}

type CreateReleaseInput struct {
	Version                  string          `json:"version"`
	Channel                  string          `json:"channel"`
	Classification           string          `json:"classification"`
	Notes                    string          `json:"notes"`
	GitCommit                string          `json:"gitCommit"`
	ClientProtocolVersion    int             `json:"clientProtocolVersion"`
	MinimumServerVersion     *string         `json:"minimumServerVersion"`
	MaximumServerVersion     *string         `json:"maximumServerVersion"`
	RequiredCapabilities     []string        `json:"requiredCapabilities"`
	GraceEndsAt              *string         `json:"graceEndsAt"`
	LocalDataSchemaVersion   int             `json:"localDataSchemaVersion"`
	LocalMigrationReversible bool            `json:"localMigrationReversible"`
	RollbackSafe             bool            `json:"rollbackSafe"`
	Artifacts                []ArtifactInput `json:"artifacts"`
}

type RolloutInput struct {
	Cohort     string  `json:"cohort"`
	Percentage float64 `json:"percentage"`
}

type ClientContext struct {
	CurrentVersion  string   `json:"currentVersion"`
	Target          string   `json:"target"`
	Architecture    string   `json:"arch"`
	Channel         string   `json:"channel"`
	Cohort          string   `json:"cohort"`
	InstallationID  string   `json:"installationId"`
	ConsentAccepted bool     `json:"consentAccepted"`
	ConsentVersion  string   `json:"consentVersion"`
	ServerVersion   string   `json:"serverVersion"`
	ProtocolVersion int      `json:"protocolVersion"`
	Capabilities    []string `json:"capabilities"`
}

type Compatibility struct {
	Status                   string   `json:"status"`
	ReasonCode               string   `json:"reasonCode"`
	Message                  string   `json:"message"`
	ClientVersion            string   `json:"clientVersion,omitempty"`
	ServerVersion            string   `json:"serverVersion,omitempty"`
	ProtocolVersion          int      `json:"protocolVersion"`
	MinimumClientVersion     string   `json:"minimumClientVersion,omitempty"`
	RecommendedClientVersion string   `json:"recommendedClientVersion,omitempty"`
	MinimumServerVersion     string   `json:"minimumServerVersion,omitempty"`
	MaximumServerVersion     string   `json:"maximumServerVersion,omitempty"`
	RequiredCapabilities     []string `json:"requiredCapabilities"`
	MissingCapabilities      []string `json:"missingCapabilities"`
	GraceEndsAt              *string  `json:"graceEndsAt,omitempty"`
}

type Decision struct {
	Decision       string        `json:"decision"`
	Classification string        `json:"classification,omitempty"`
	ReasonCode     string        `json:"reasonCode"`
	Message        string        `json:"message"`
	RolloutBucket  int           `json:"rolloutBucket"`
	Eligible       bool          `json:"eligible"`
	Compatibility  Compatibility `json:"compatibility"`
	Release        *Release      `json:"release,omitempty"`
	Artifact       *Artifact     `json:"artifact,omitempty"`
	Block          *VersionBlock `json:"block,omitempty"`
	ConsentVersion string        `json:"consentVersion"`
}

type TauriUpdate struct {
	Version                   string        `json:"version"`
	Notes                     string        `json:"notes"`
	PubDate                   string        `json:"pub_date"`
	URL                       string        `json:"url"`
	Signature                 string        `json:"signature"`
	ReleaseID                 string        `json:"releaseId"`
	Classification            string        `json:"classification"`
	Size                      int64         `json:"size"`
	SHA256                    string        `json:"sha256"`
	Decision                  string        `json:"decision"`
	ReasonCode                string        `json:"reasonCode"`
	Message                   string        `json:"message"`
	Compatibility             Compatibility `json:"compatibility"`
	LocalDataSchemaVersion    int           `json:"localDataSchemaVersion"`
	LocalMigrationReversible  bool          `json:"localMigrationReversible"`
	RollbackSafe              bool          `json:"rollbackSafe"`
	ApprovedRollbackReleaseID *string       `json:"approvedRollbackReleaseId,omitempty"`
}

type OutcomeInput struct {
	Consent       bool   `json:"consent"`
	EventID       string `json:"eventId"`
	ReleaseID     string `json:"releaseId"`
	FromVersion   string `json:"fromVersion"`
	ToVersion     string `json:"toVersion"`
	Platform      string `json:"platform"`
	Architecture  string `json:"architecture"`
	Stage         string `json:"stage"`
	Outcome       string `json:"outcome"`
	ErrorCategory string `json:"errorCategory"`
}

type DiagnosticInput struct {
	Consent   bool           `json:"consent"`
	ReleaseID string         `json:"releaseId"`
	Payload   map[string]any `json:"payload"`
}

type DiagnosticReport struct {
	ID        string         `json:"id"`
	ReleaseID string         `json:"releaseId,omitempty"`
	Payload   map[string]any `json:"payload"`
	CreatedAt string         `json:"createdAt"`
	ExpiresAt string         `json:"expiresAt"`
}

type OutcomeMetric struct {
	Day           string `json:"day"`
	ReleaseID     string `json:"releaseId,omitempty"`
	FromVersion   string `json:"fromVersion"`
	ToVersion     string `json:"toVersion,omitempty"`
	Platform      string `json:"platform"`
	Architecture  string `json:"architecture"`
	Stage         string `json:"stage"`
	Outcome       string `json:"outcome"`
	ErrorCategory string `json:"errorCategory,omitempty"`
	Count         int64  `json:"count"`
	UpdatedAt     string `json:"updatedAt"`
}

type ObjectInfo struct {
	Size   int64
	SHA256 string
}

type ArtifactStore interface {
	PresignGet(context.Context, string, time.Duration) (string, error)
	Head(context.Context, string) (ObjectInfo, error)
}

type OpsSession struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
}

type ActionAuthorization struct {
	Token                string `json:"token"`
	ExpectedConfirmation string `json:"expectedConfirmation"`
	ExpiresAt            string `json:"expiresAt"`
}

type Actor struct {
	UserID         *string
	Label          string
	CorrelationID  string
	IdempotencyKey string
}

type ServerPolicy struct {
	ServerVersion            string
	ProtocolVersion          int
	MinimumClientVersion     string
	RecommendedClientVersion string
	RequiredCapabilities     []string
}

type Options struct {
	Artifacts      ArtifactStore
	Now            func() time.Time
	ServerPolicy   ServerPolicy
	PresignExpiry  time.Duration
	ConsentVersion string
}
