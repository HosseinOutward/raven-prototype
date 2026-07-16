export type ReleaseChannel = "stable" | "alpha";
export type ReleaseClassification = "optional" | "recommended" | "required";
export type ReleaseState =
  | "draft"
  | "validated"
  | "internal"
  | "rolling_out"
  | "paused"
  | "fully_released"
  | "withdrawn"
  | "superseded";

export interface ReleaseArtifact {
  id: string;
  releaseId: string;
  platform: "windows" | "linux";
  architecture: "x86_64";
  format: string;
  objectKey: string;
  checksumObjectKey: string;
  checksumSha256: string;
  signature: string;
  sha256: string;
  size: number;
  sbomObjectKey: string;
  sbomSha256: string;
  provenanceObjectKey: string;
  provenanceSha256: string;
  verifiedAt?: string | null;
  createdAt: string;
}

export interface ReleaseRollout {
  releaseId: string;
  cohort: string;
  percentageBasisPoints: number;
  percentage: number;
  revision: number;
  updatedAt: string;
}

export interface DesktopRelease {
  id: string;
  version: string;
  channel: ReleaseChannel;
  classification: ReleaseClassification;
  state: ReleaseState;
  notes: string;
  gitCommit: string;
  clientProtocolVersion: number;
  minimumServerVersion?: string | null;
  maximumServerVersion?: string | null;
  requiredCapabilities: string[];
  graceEndsAt?: string | null;
  localDataSchemaVersion: number;
  localMigrationReversible: boolean;
  rollbackSafe: boolean;
  supersededByReleaseId?: string | null;
  approvedRollbackReleaseId?: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  validatedAt?: string | null;
  publishedAt?: string | null;
  withdrawnAt?: string | null;
  artifacts: ReleaseArtifact[];
  rollouts: ReleaseRollout[];
}

export interface UpdateChannel {
  name: ReleaseChannel;
  enabled: boolean;
  disabledReason: string;
  revision: number;
  updatedAt: string;
}

export interface UpdateCohort {
  name: string;
  description: string;
  active: boolean;
  updatedAt: string;
}

export interface VersionBlock {
  id: string;
  range: string;
  channel?: ReleaseChannel | null;
  reason: string;
  targetReleaseId?: string | null;
  active: boolean;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  actorUserId?: string | null;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId: string;
  previousStateJson?: string | null;
  newStateJson?: string | null;
  reason: string;
  correlationId: string;
  createdAt: string;
}

export interface OutcomeAggregate {
  day: string;
  releaseId?: string;
  fromVersion: string;
  toVersion?: string;
  platform: string;
  architecture: string;
  stage: string;
  outcome: string;
  errorCategory?: string;
  count: number;
}

export interface DiagnosticReport {
  id: string;
  releaseId?: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

export interface AuthorizationReview {
  token: string;
  confirmation: string;
  expiresAt: string;
}

export interface SessionIdentity {
  sessionId: string;
  opsToken: string;
  expiresAt: string;
  username: string;
}
