import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  ArchiveX,
  Ban,
  CheckCircle2,
  ChevronRight,
  CirclePause,
  CirclePlay,
  ClipboardCheck,
  FileClock,
  Fingerprint,
  Gauge,
  KeyRound,
  LogOut,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Send,
  ShieldAlert,
  TerminalSquare,
} from "lucide-react";
import { operationsApi, OperationsError } from "./api";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Select,
  Textarea,
} from "./components/ui";
import {
  formatBytes,
  normalizePercentage,
  type HighRiskAction,
} from "./lib/actions";
import type {
  AuditEvent,
  AuthorizationReview,
  DesktopRelease,
  DiagnosticReport,
  OutcomeAggregate,
  SessionIdentity,
  UpdateChannel,
  UpdateCohort,
  VersionBlock,
} from "./types";

type View = "releases" | "policy" | "outcomes" | "diagnostics" | "audit";

const viewItems: { id: View; label: string; icon: typeof PackageCheck }[] = [
  { id: "releases", label: "Releases", icon: PackageCheck },
  { id: "policy", label: "Channels & safety", icon: ShieldAlert },
  { id: "outcomes", label: "Update outcomes", icon: Activity },
  { id: "diagnostics", label: "Shared diagnostics", icon: TerminalSquare },
  { id: "audit", label: "Audit history", icon: FileClock },
];

function errorMessage(error: unknown) {
  if (error instanceof OperationsError) return error.message;
  if (error instanceof Error) return error.message;
  return "The operation could not be completed.";
}

function dateTime(value?: string | null) {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function stateTone(
  state: string,
): "neutral" | "signal" | "warning" | "danger" | "success" {
  if (state === "fully_released" || state === "validated") return "success";
  if (state === "rolling_out" || state === "internal") return "signal";
  if (state === "paused") return "warning";
  if (state === "withdrawn" || state === "superseded") return "danger";
  return "neutral";
}

function classificationTone(
  value: string,
): "neutral" | "signal" | "warning" | "danger" {
  if (value === "required") return "danger";
  if (value === "recommended") return "warning";
  if (value === "optional") return "signal";
  return "neutral";
}

function Login({ onLogin }: { onLogin: (identity: SessionIdentity) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onLogin(await operationsApi.login(username.trim(), password));
      setPassword("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center p-8">
      <section className="w-full max-w-md rounded-2xl bg-card p-8 shadow-2xl shadow-black/30">
        <div className="mb-8 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <KeyRound size={22} />
        </div>
        <p className="rv-kicker">Private release operations</p>
        <h1 className="mt-2 text-2xl font-semibold">
          Enter Raven’s release workshop
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          This surface requires both a Raven administrator account and the
          separate release-administrator permission. The operations session
          expires quickly.
        </p>
        <form className="mt-8 grid gap-4" onSubmit={submit}>
          <Field label="Username">
            <Input
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </Field>
          {error ? (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={busy}>
            {busy ? (
              <RefreshCw className="animate-spin" size={16} />
            ) : (
              <Fingerprint size={16} />
            )}
            {busy ? "Opening a short session" : "Continue"}
          </Button>
        </form>
      </section>
    </main>
  );
}

interface RiskRequest {
  action: HighRiskAction;
  subject: string;
  title: string;
  explanation: string;
  releaseEndpoint?: "required" | "withdraw" | "publish";
}

function RiskReview({
  request,
  reason,
  onCancel,
  onCommit,
}: {
  request: RiskRequest;
  reason: string;
  onCancel: () => void;
  onCommit: (
    review: AuthorizationReview,
    confirmation: string,
  ) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [review, setReview] = useState<AuthorizationReview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function authorize() {
    setBusy(true);
    setError("");
    try {
      setReview(
        await operationsApi.authorize(
          request.action,
          request.subject,
          password,
        ),
      );
      setPassword("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!review || confirmation !== review.confirmation) return;
    setBusy(true);
    setError("");
    try {
      await onCommit(review, confirmation);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <section className="mt-5 rounded-xl bg-destructive/10 p-5">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 shrink-0 text-red-300" size={19} />
        <div>
          <h3 className="font-semibold">{request.title}</h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {request.explanation}
          </p>
        </div>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        Reason recorded in the immutable audit:{" "}
        {reason || "A reason is required before continuing."}
      </p>
      {!review ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="Re-enter your password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button
            variant="destructive"
            disabled={busy || !password || !reason.trim()}
            onClick={authorize}
          >
            {busy ? "Checking" : "Create review"}
          </Button>
        </div>
      ) : (
        <div className="mt-4 grid gap-3">
          <p className="text-sm">Type this phrase exactly:</p>
          <code className="select-all rounded-lg bg-black/25 px-3 py-2 text-sm text-red-200">
            {review.confirmation}
          </code>
          <Input
            autoComplete="off"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder="Typed confirmation"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || confirmation !== review.confirmation}
              onClick={commit}
            >
              {busy ? "Applying" : "Apply reviewed action"}
            </Button>
          </div>
        </div>
      )}
      {error ? <p className="mt-3 text-sm text-red-300">{error}</p> : null}
      {!review ? (
        <div className="mt-3 flex justify-end">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function ReleaseList({
  releases,
  selectedId,
  onSelect,
}: {
  releases: DesktopRelease[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (!releases.length)
    return (
      <EmptyState
        title="No release drafts yet"
        body="Use the local Raven release command to upload verified artifacts and register an inactive draft."
      />
    );
  return (
    <div className="grid gap-2">
      {releases.map((release) => (
        <button
          key={release.id}
          onClick={() => onSelect(release.id)}
          className={`group rounded-xl p-4 text-left transition ${selectedId === release.id ? "bg-accent" : "bg-card hover:bg-accent/60"}`}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="font-semibold">{release.version}</span>
              <Badge tone={release.channel === "alpha" ? "signal" : "neutral"}>
                {release.channel}
              </Badge>
            </div>
            <ChevronRight
              size={16}
              className="text-muted-foreground transition group-hover:translate-x-0.5"
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge tone={stateTone(release.state)}>
              {release.state.replaceAll("_", " ")}
            </Badge>
            <Badge tone={classificationTone(release.classification)}>
              {release.classification}
            </Badge>
          </div>
          <p className="mt-3 line-clamp-2 text-xs leading-5 text-muted-foreground">
            {release.notes || "No release notes have been written."}
          </p>
        </button>
      ))}
    </div>
  );
}

function ArtifactTable({ release }: { release: DesktopRelease }) {
  return (
    <section className="rv-section">
      <div className="rv-section-heading">
        <div>
          <p className="rv-kicker">Signed deliverables</p>
          <h3>Artifacts</h3>
        </div>
        <Badge tone={release.artifacts.length >= 2 ? "success" : "warning"}>
          {release.artifacts.length} targets
        </Badge>
      </div>
      {release.artifacts.length ? (
        <div className="mt-4 overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Target</th>
                <th>Package</th>
                <th>Size</th>
                <th>Integrity</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {release.artifacts.map((artifact) => (
                <tr key={artifact.id}>
                  <td>
                    {artifact.platform} · {artifact.architecture}
                  </td>
                  <td>{artifact.format}</td>
                  <td>{formatBytes(artifact.size)}</td>
                  <td>
                    <span className="rv-hash">
                      {artifact.sha256.slice(0, 14)}…
                    </span>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {artifact.verifiedAt
                        ? `Verified ${dateTime(artifact.verifiedAt)}`
                        : "Awaiting validation"}
                    </div>
                  </td>
                  <td className="text-xs text-muted-foreground">
                    SBOM + provenance
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          No artifacts are registered. This draft cannot be validated.
        </p>
      )}
    </section>
  );
}

function ReleaseDetail({
  release,
  releases,
  cohorts,
  onChanged,
  onError,
}: {
  release: DesktopRelease;
  releases: DesktopRelease[];
  cohorts: UpdateCohort[];
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [risk, setRisk] = useState<RiskRequest | null>(null);
  const [supersedeId, setSupersedeId] = useState("");
  const [rollbackId, setRollbackId] = useState(
    release.approvedRollbackReleaseId ?? "",
  );
  const [rollouts, setRollouts] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      cohorts.map((cohort) => [
        cohort.name,
        release.rollouts.find((item) => item.cohort === cohort.name)
          ?.percentage ?? (cohort.name === "internal" ? 100 : 0),
      ]),
    ),
  );

  useEffect(() => {
    setRollbackId(release.approvedRollbackReleaseId ?? "");
    setRollouts(
      Object.fromEntries(
        cohorts.map((cohort) => [
          cohort.name,
          release.rollouts.find((item) => item.cohort === cohort.name)
            ?.percentage ?? (cohort.name === "internal" ? 100 : 0),
        ]),
      ),
    );
  }, [release.id, release.revision, cohorts]);

  async function act(name: string, body: Record<string, unknown> = {}) {
    setBusy(name);
    try {
      await operationsApi.releaseAction(release.id, name, {
        reason: reason.trim(),
        ...body,
      });
      setReason("");
      await onChanged();
    } catch (caught) {
      onError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  }

  async function saveRollouts() {
    setBusy("rollouts");
    try {
      await operationsApi.releaseAction(release.id, "rollouts", {
        reason: reason.trim(),
        rollouts: publishRollouts,
      });
      setReason("");
      await onChanged();
    } catch (caught) {
      onError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  }

  async function commitRisk(review: AuthorizationReview, confirmation: string) {
    if (!risk) return;
    const endpoint =
      risk.releaseEndpoint ??
      (risk.action === "publish_required" ? "required" : "withdraw");
    await operationsApi.releaseAction(release.id, endpoint, {
      reason: reason.trim(),
      authorizationToken: review.token,
      confirmation,
      ...(endpoint === "publish" ? { rollouts: publishRollouts } : {}),
    });
    setRisk(null);
    setReason("");
    await onChanged();
  }

  const publishRollouts = cohorts.map((cohort) => ({
    cohort: cohort.name,
    percentage: normalizePercentage(rollouts[cohort.name] ?? 0),
  }));
  const canMutate = !["withdrawn", "superseded"].includes(release.state);

  return (
    <div className="grid gap-5">
      <section className="rounded-2xl bg-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-3xl font-semibold">
                Raven {release.version}
              </h2>
              <Badge tone={release.channel === "alpha" ? "signal" : "neutral"}>
                {release.channel}
              </Badge>
              <Badge tone={classificationTone(release.classification)}>
                {release.classification}
              </Badge>
            </div>
            <p className="mt-3 max-w-3xl whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
              {release.notes || "No release notes have been written."}
            </p>
          </div>
          <Badge tone={stateTone(release.state)}>
            {release.state.replaceAll("_", " ")}
          </Badge>
        </div>
        <div className="mt-6 grid gap-4 border-t border-border/70 pt-5 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <DataPoint
            label="Git commit"
            value={
              release.gitCommit
                ? `${release.gitCommit.slice(0, 12)}…`
                : "Missing"
            }
            mono
          />
          <DataPoint
            label="Protocol"
            value={String(release.clientProtocolVersion)}
          />
          <DataPoint label="Created" value={dateTime(release.createdAt)} />
          <DataPoint label="Published" value={dateTime(release.publishedAt)} />
        </div>
      </section>
      <ArtifactTable release={release} />
      <section className="rv-section">
        <div className="rv-section-heading">
          <div>
            <p className="rv-kicker">Compatibility contract</p>
            <h3>Boundaries</h3>
          </div>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <DataPoint
            label="Minimum server"
            value={release.minimumServerVersion ?? "No lower bound"}
          />
          <DataPoint
            label="Maximum server"
            value={release.maximumServerVersion ?? "No upper bound"}
          />
          <DataPoint
            label="Required capabilities"
            value={
              release.requiredCapabilities.length
                ? release.requiredCapabilities.join(", ")
                : "None"
            }
          />
          <DataPoint
            label="Grace period ends"
            value={dateTime(release.graceEndsAt)}
          />
          <DataPoint
            label="Local data schema"
            value={String(release.localDataSchemaVersion)}
          />
          <DataPoint
            label="Rollback declaration"
            value={
              release.rollbackSafe && release.localMigrationReversible
                ? "Eligible for constrained recovery"
                : "Forward repair only"
            }
          />
        </div>
      </section>
      <section className="rv-section">
        <div className="rv-section-heading">
          <div>
            <p className="rv-kicker">Staged availability</p>
            <h3>Cohort rollout</h3>
          </div>
          <Gauge size={20} className="text-primary" />
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {cohorts.map((cohort) => (
            <Field
              key={cohort.name}
              label={cohort.name}
              hint={cohort.description}
            >
              <div className="relative">
                <Input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={rollouts[cohort.name] ?? 0}
                  onChange={(event) =>
                    setRollouts((current) => ({
                      ...current,
                      [cohort.name]: normalizePercentage(
                        Number(event.target.value),
                      ),
                    }))
                  }
                />
                <span className="pointer-events-none absolute right-3 top-2 text-sm text-muted-foreground">
                  %
                </span>
              </div>
            </Field>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            size="sm"
            variant="secondary"
            disabled={
              busy !== "" ||
              !reason.trim() ||
              release.state === "draft" ||
              !canMutate
            }
            onClick={() => void saveRollouts()}
          >
            <Gauge size={14} />
            Save percentages
          </Button>
        </div>
      </section>
      <section className="rv-section">
        <div className="rv-section-heading">
          <div>
            <p className="rv-kicker">Controlled transitions</p>
            <h3>Release actions</h3>
          </div>
        </div>
        <div className="mt-4 grid gap-4">
          <Field
            label="Reason"
            hint="Every transition records this reason and a correlation identifier in the immutable audit."
          >
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is this action safe and necessary?"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={
                busy !== "" || release.state !== "draft" || !reason.trim()
              }
              onClick={() => act("validate")}
            >
              <ClipboardCheck size={16} />
              Validate draft
            </Button>
            <Button
              disabled={
                busy !== "" || release.state !== "validated" || !reason.trim()
              }
              onClick={() =>
                release.classification === "required"
                  ? setRisk({
                      action: "publish_required",
                      subject: release.id,
                      releaseEndpoint: "publish",
                      title: `Publish Raven ${release.version} as required`,
                      explanation:
                        "Publishing this required release bypasses percentage rollout for affected clients and blocks unsafe communication until the signed update is installed.",
                    })
                  : act("publish", { rollouts: publishRollouts })
              }
            >
              <Send size={16} />
              Publish rollout
            </Button>
            <Button
              variant="secondary"
              disabled={
                busy !== "" ||
                !["internal", "rolling_out", "fully_released"].includes(
                  release.state,
                ) ||
                !reason.trim()
              }
              onClick={() => act("pause")}
            >
              <CirclePause size={16} />
              Pause
            </Button>
            <Button
              variant="secondary"
              disabled={
                busy !== "" || release.state !== "paused" || !reason.trim()
              }
              onClick={() => act("resume")}
            >
              <CirclePlay size={16} />
              Resume
            </Button>
            <Button
              variant="destructive"
              disabled={busy !== "" || !canMutate || !reason.trim()}
              onClick={() =>
                setRisk({
                  action: "publish_required",
                  subject: release.id,
                  releaseEndpoint: "required",
                  title: `Require Raven ${release.version}`,
                  explanation:
                    "Required status bypasses percentage rollout for affected clients and blocks unsafe communication until the signed update is installed.",
                })
              }
            >
              <ShieldAlert size={16} />
              Mark required
            </Button>
            <Button
              variant="outline"
              disabled={busy !== "" || !canMutate || !reason.trim()}
              onClick={() =>
                setRisk({
                  action: "withdraw_release",
                  subject: release.id,
                  releaseEndpoint: "withdraw",
                  title: `Withdraw Raven ${release.version}`,
                  explanation:
                    "Withdrawal immediately removes this release from new discovery. Downloaded clients must revalidate before installation.",
                })
              }
            >
              <ArchiveX size={16} />
              Withdraw
            </Button>
          </div>
          {risk ? (
            <RiskReview
              request={risk}
              reason={reason}
              onCancel={() => setRisk(null)}
              onCommit={commitRisk}
            />
          ) : null}
          <div className="grid gap-4 border-t border-border/70 pt-5 lg:grid-cols-2">
            <Field
              label="Supersede with"
              hint="The replacement must already exist and be compatible."
            >
              <Select
                value={supersedeId}
                onChange={(event) => setSupersedeId(event.target.value)}
              >
                <option value="">Choose a newer release</option>
                {releases
                  .filter((candidate) => candidate.id !== release.id)
                  .map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.version} · {candidate.channel}
                    </option>
                  ))}
              </Select>
            </Field>
            <div className="self-end">
              <Button
                variant="secondary"
                disabled={
                  !supersedeId || !reason.trim() || busy !== "" || !canMutate
                }
                onClick={() => act("supersede", { newerReleaseId: supersedeId })}
              >
                Supersede
              </Button>
            </div>
            <Field
              label="Approved rollback target"
              hint="A rollback still requires health failure, compatibility, and an unblocked target."
            >
              <Select
                value={rollbackId}
                onChange={(event) => setRollbackId(event.target.value)}
              >
                <option value="">No approved target</option>
                {releases
                  .filter((candidate) => candidate.id !== release.id)
                  .map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.version} · {candidate.state}
                    </option>
                  ))}
              </Select>
            </Field>
            <div className="self-end">
              <Button
                variant="secondary"
                disabled={!rollbackId || !reason.trim() || busy !== ""}
                onClick={() =>
                  act("rollback-target", { targetReleaseId: rollbackId })
                }
              >
                <RotateCcw size={16} />
                Set rollback target
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function DataPoint({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </p>
      <p className={`mt-1 break-words ${mono ? "rv-mono text-xs" : ""}`}>
        {value}
      </p>
    </div>
  );
}

function PolicyView({
  channels,
  cohorts,
  blocks,
  releases,
  onChanged,
  onError,
}: {
  channels: UpdateChannel[];
  cohorts: UpdateCohort[];
  blocks: VersionBlock[];
  releases: DesktopRelease[];
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [range, setRange] = useState("");
  const [channel, setChannel] = useState("");
  const [targetReleaseId, setTargetReleaseId] = useState("");
  const [reason, setReason] = useState("");
  const [risk, setRisk] = useState<RiskRequest | null>(null);
  const [disableTarget, setDisableTarget] = useState("");

  async function enable(name: string) {
    try {
      await operationsApi.setChannel(name, true, { reason: reason.trim() });
      await onChanged();
    } catch (caught) {
      onError(errorMessage(caught));
    }
  }

  async function commit(review: AuthorizationReview, confirmation: string) {
    if (!risk) return;
    if (risk.action === "disable_channel") {
      await operationsApi.setChannel(disableTarget, false, {
        reason: reason.trim(),
        authorizationToken: review.token,
        confirmation,
      });
      setDisableTarget("");
    } else {
      await operationsApi.createVersionBlock({
        range: range.trim(),
        channel: channel || null,
        reason: reason.trim(),
        targetReleaseId: targetReleaseId || null,
        authorizationToken: review.token,
        confirmation,
      });
      setRange("");
      setTargetReleaseId("");
    }
    setRisk(null);
    setReason("");
    await onChanged();
  }

  return (
    <div className="grid gap-5">
      <section className="rv-section">
        <div className="rv-section-heading">
          <div>
            <p className="rv-kicker">Discovery switches</p>
            <h2 className="text-xl font-semibold">Channels</h2>
          </div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {channels.map((item) => (
            <div key={item.name} className="rounded-xl bg-background/60 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold">{item.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Revision {item.revision} · {dateTime(item.updatedAt)}
                  </p>
                </div>
                <Badge tone={item.enabled ? "success" : "danger"}>
                  {item.enabled ? "enabled" : "disabled"}
                </Badge>
              </div>
              {item.disabledReason ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  {item.disabledReason}
                </p>
              ) : null}
              <div className="mt-4">
                {item.enabled ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={!reason.trim()}
                    onClick={() => {
                      setDisableTarget(item.name);
                      setRisk({
                        action: "disable_channel",
                        subject: item.name,
                        title: `Disable ${item.name}`,
                        explanation:
                          "Disabling a channel stops all new update discovery on it. Existing downloads must revalidate before installation.",
                      });
                    }}
                  >
                    <Ban size={14} />
                    Disable
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={!reason.trim()}
                    onClick={() => enable(item.name)}
                  >
                    <CirclePlay size={14} />
                    Enable
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="rv-section">
        <div className="rv-section-heading">
          <div>
            <p className="rv-kicker">Stable enrollment groups</p>
            <h2 className="text-xl font-semibold">Cohorts</h2>
          </div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {cohorts.map((cohort) => (
            <div key={cohort.name} className="rounded-xl bg-background/60 p-4">
              <div className="flex items-center justify-between">
                <p className="font-semibold">{cohort.name}</p>
                <Badge tone={cohort.active ? "signal" : "neutral"}>
                  {cohort.active ? "active" : "inactive"}
                </Badge>
              </div>
              <p className="mt-2 text-sm leading-5 text-muted-foreground">
                {cohort.description}
              </p>
            </div>
          ))}
        </div>
      </section>
      <section className="rv-section">
        <div className="rv-section-heading">
          <div>
            <p className="rv-kicker">Unsafe installed versions</p>
            <h2 className="text-xl font-semibold">Version blocks</h2>
          </div>
        </div>
        <div className="mt-5 grid gap-4">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Semantic version range">
              <Input
                value={range}
                onChange={(event) => setRange(event.target.value)}
                placeholder=">=0.1.0 <0.1.3"
              />
            </Field>
            <Field label="Channel">
              <Select
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
              >
                <option value="">All channels</option>
                <option value="alpha">alpha</option>
                <option value="stable">stable</option>
              </Select>
            </Field>
            <Field label="Safe replacement">
              <Select
                value={targetReleaseId}
                onChange={(event) => setTargetReleaseId(event.target.value)}
              >
                <option value="">No replacement yet</option>
                {releases.map((release) => (
                  <option key={release.id} value={release.id}>
                    {release.version}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field
            label="Reason"
            hint="Required for channel changes and version blocks."
          >
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Specific user-facing and operational reason"
            />
          </Field>
          <div>
            <Button
              variant="destructive"
              disabled={!range.trim() || !reason.trim()}
              onClick={() =>
                setRisk({
                  action: "block_version",
                  subject: range.trim(),
                  title: `Block ${range.trim()}`,
                  explanation:
                    "Matching installations will be treated as unsafe and prevented from Raven service connectivity until a safe signed version is available.",
                })
              }
            >
              <Ban size={16} />
              Review version block
            </Button>
          </div>
          {risk ? (
            <RiskReview
              request={risk}
              reason={reason}
              onCancel={() => setRisk(null)}
              onCommit={commit}
            />
          ) : null}
          <div className="grid gap-2">
            {blocks.map((block) => (
              <div
                key={block.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-xl bg-background/60 p-4"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <code>{block.range}</code>
                    <Badge tone={block.active ? "danger" : "neutral"}>
                      {block.active ? "active" : "inactive"}
                    </Badge>
                    {block.channel ? <Badge>{block.channel}</Badge> : null}
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {block.reason}
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  {dateTime(block.createdAt)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function OutcomeView({ outcomes }: { outcomes: OutcomeAggregate[] }) {
  if (!outcomes.length)
    return (
      <EmptyState
        title="No consented outcomes yet"
        body="Raven records aggregate update outcomes only after the installation owner explicitly enables that sharing."
      />
    );
  return (
    <section className="rv-section">
      <div className="rv-section-heading">
        <div>
          <p className="rv-kicker">Anonymous aggregate reports</p>
          <h2 className="text-xl font-semibold">Update outcomes</h2>
        </div>
        <Activity className="text-primary" size={20} />
      </div>
      <div className="mt-5 overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th>Target</th>
              <th>Transition</th>
              <th>Stage</th>
              <th>Outcome</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            {outcomes.map((item, index) => (
              <tr
                key={`${item.day}-${item.releaseId}-${item.stage}-${item.outcome}-${index}`}
              >
                <td>{item.day}</td>
                <td>
                  {item.platform} · {item.architecture}
                </td>
                <td>
                  {item.fromVersion} → {item.toVersion || "—"}
                </td>
                <td>{item.stage}</td>
                <td>
                  <Badge
                    tone={
                      item.outcome === "succeeded" || item.outcome === "success"
                        ? "success"
                        : "warning"
                    }
                  >
                    {item.outcome}
                  </Badge>
                  {item.errorCategory ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      {item.errorCategory}
                    </div>
                  ) : null}
                </td>
                <td>{item.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DiagnosticsView({ reports }: { reports: DiagnosticReport[] }) {
  if (!reports.length)
    return (
      <EmptyState
        title="No detailed reports have been shared"
        body="Detailed updater diagnostics are local by default and arrive here only after separate, explicit consent."
      />
    );
  return (
    <div className="grid gap-3">
      {reports.map((report) => (
        <details key={report.id} className="rounded-xl bg-card p-5">
          <summary className="cursor-pointer list-none">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold">
                  Diagnostic report {report.id.slice(0, 8)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Shared {dateTime(report.createdAt)} · expires{" "}
                  {dateTime(report.expiresAt)}
                </p>
              </div>
              <Badge tone="warning">consented detail</Badge>
            </div>
          </summary>
          <pre className="mt-4 max-h-96 overflow-auto rounded-lg bg-background p-4 text-xs leading-5 text-muted-foreground">
            {JSON.stringify(report.payload, null, 2)}
          </pre>
        </details>
      ))}
    </div>
  );
}

function AuditView({ events }: { events: AuditEvent[] }) {
  if (!events.length)
    return (
      <EmptyState
        title="The release audit is empty"
        body="Every release-control mutation will appear here with its actor, reason, state change, and correlation identifier."
      />
    );
  return (
    <div className="relative grid gap-3 before:absolute before:bottom-5 before:left-[21px] before:top-5 before:w-px before:bg-border">
      {events.map((event) => (
        <details
          key={event.id}
          className="relative ml-11 rounded-xl bg-card p-5 before:absolute before:-left-[34px] before:top-5 before:h-3 before:w-3 before:rounded-full before:bg-primary"
        >
          <summary className="cursor-pointer list-none">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-semibold">
                  {event.action.replaceAll("_", " ")}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {event.actorLabel} · {event.entityType} {event.entityId}
                </p>
              </div>
              <time className="text-xs text-muted-foreground">
                {dateTime(event.createdAt)}
              </time>
            </div>
            <p className="mt-3 text-sm leading-6">{event.reason}</p>
          </summary>
          <div className="mt-4 grid gap-3 border-t border-border/70 pt-4 text-xs text-muted-foreground">
            <p>
              Correlation: <code>{event.correlationId}</code>
            </p>
            {event.previousStateJson ? (
              <details>
                <summary className="cursor-pointer">Previous state</summary>
                <pre className="mt-2 overflow-auto rounded bg-background p-3">
                  {event.previousStateJson}
                </pre>
              </details>
            ) : null}
            {event.newStateJson ? (
              <details>
                <summary className="cursor-pointer">New state</summary>
                <pre className="mt-2 overflow-auto rounded bg-background p-3">
                  {event.newStateJson}
                </pre>
              </details>
            ) : null}
          </div>
        </details>
      ))}
    </div>
  );
}

export function App() {
  const [identity, setIdentity] = useState<SessionIdentity | null>(
    operationsApi.session,
  );
  const [view, setView] = useState<View>("releases");
  const [releases, setReleases] = useState<DesktopRelease[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [channels, setChannels] = useState<UpdateChannel[]>([]);
  const [cohorts, setCohorts] = useState<UpdateCohort[]>([]);
  const [blocks, setBlocks] = useState<VersionBlock[]>([]);
  const [outcomes, setOutcomes] = useState<OutcomeAggregate[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticReport[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!operationsApi.session) return;
    setLoading(true);
    setError("");
    try {
      const [nextReleases, nextChannels, nextCohorts] = await Promise.all([
        operationsApi.releases(),
        operationsApi.channels(),
        operationsApi.cohorts(),
      ]);
      setReleases(nextReleases);
      setChannels(nextChannels);
      setCohorts(nextCohorts);
      setSelectedId((current) =>
        nextReleases.some((release) => release.id === current)
          ? current
          : (nextReleases[0]?.id ?? ""),
      );
      const [nextBlocks, nextOutcomes, nextDiagnostics, nextAudit] =
        await Promise.all([
          operationsApi.versionBlocks().catch(() => []),
          operationsApi.outcomes(),
          operationsApi.diagnostics(),
          operationsApi.audit(),
        ]);
      setBlocks(nextBlocks);
      setOutcomes(nextOutcomes);
      setDiagnostics(nextDiagnostics);
      setAudit(nextAudit);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      if (
        caught instanceof OperationsError &&
        (caught.status === 401 || caught.status === 403)
      ) {
        operationsApi.clearSession();
        setIdentity(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [identity, refresh]);
  const selected = useMemo(
    () => releases.find((release) => release.id === selectedId) ?? null,
    [releases, selectedId],
  );

  async function logout() {
    await operationsApi.logout().catch(() => undefined);
    setIdentity(null);
  }

  if (!identity) return <Login onLogin={setIdentity} />;

  let content: ReactNode;
  if (view === "releases")
    content = (
      <div className="grid min-h-0 gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto">
          <ReleaseList
            releases={releases}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </aside>
        <div className="min-w-0">
          {selected ? (
            <ReleaseDetail
              release={selected}
              releases={releases}
              cohorts={cohorts}
              onChanged={refresh}
              onError={setError}
            />
          ) : (
            <EmptyState
              title="Choose a release"
              body="Select a release to inspect its signed artifacts, compatibility contract, rollout, and audit-backed actions."
            />
          )}
        </div>
      </div>
    );
  else if (view === "policy")
    content = (
      <PolicyView
        channels={channels}
        cohorts={cohorts}
        blocks={blocks}
        releases={releases}
        onChanged={refresh}
        onError={setError}
      />
    );
  else if (view === "outcomes") content = <OutcomeView outcomes={outcomes} />;
  else if (view === "diagnostics")
    content = <DiagnosticsView reports={diagnostics} />;
  else content = <AuditView events={audit} />;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1680px] items-center justify-between gap-6 px-6 py-4">
          <div>
            <p className="rv-kicker">Raven</p>
            <h1 className="text-lg font-semibold">Release workshop</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={() => void refresh()}
            >
              <RefreshCw className={loading ? "animate-spin" : ""} size={15} />
              Refresh
            </Button>
            <span className="hidden text-xs text-muted-foreground sm:block">
              {identity.username} · session ends {dateTime(identity.expiresAt)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Sign out"
              onClick={() => void logout()}
            >
              <LogOut size={16} />
            </Button>
          </div>
        </div>
      </header>
      <div className="mx-auto grid max-w-[1680px] gap-6 px-6 py-6 lg:grid-cols-[210px_minmax(0,1fr)]">
        <nav className="flex gap-1 overflow-x-auto lg:sticky lg:top-24 lg:h-fit lg:flex-col">
          {viewItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => setView(item.id)}
                className={`flex shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition ${view === item.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`}
              >
                <Icon size={16} />
                {item.label}
              </button>
            );
          })}
        </nav>
        <main className="min-w-0">
          {error ? (
            <div className="mb-5 flex items-start justify-between gap-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-red-300">
              <span>{error}</span>
              <button onClick={() => setError("")} aria-label="Dismiss error">
                ×
              </button>
            </div>
          ) : null}
          {content}
        </main>
      </div>
    </div>
  );
}
