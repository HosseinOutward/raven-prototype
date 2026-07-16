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
import { parsePayload, type HighRiskAction } from "./lib/actions";

const SESSION_KEY = "raven.release.session";

export class OperationsError extends Error {
  status: number;
  code: string;
  details: unknown;

  constructor(
    message: string,
    status = 0,
    code = "request_failed",
    details?: unknown,
  ) {
    super(message);
    this.name = "OperationsError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function envelopeArray<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "object" && value !== null) {
    const candidate = (value as Record<string, unknown>)[key];
    if (Array.isArray(candidate)) return candidate as T[];
  }
  return [];
}

function endpoint(path: string) {
  const base =
    (import.meta.env.VITE_RAVEN_OPERATIONS_API_URL as string | undefined)
      ?.trim()
      .replace(/\/$/, "") ?? "";
  return `${base}${path}`;
}

function loadSession(): SessionIdentity | null {
  try {
    const value = sessionStorage.getItem(SESSION_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as SessionIdentity;
    if (
      !parsed.sessionId ||
      !parsed.opsToken ||
      new Date(parsed.expiresAt).getTime() <= Date.now()
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

export class OperationsApi {
  session: SessionIdentity | null = loadSession();

  clearSession() {
    this.session = null;
    sessionStorage.removeItem(SESSION_KEY);
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    auth: "none" | "account" | "ops" = "ops",
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Cache-Control", "no-store");
    headers.set("X-Request-ID", crypto.randomUUID());
    if (init.body) headers.set("Content-Type", "application/json");
    if (auth !== "none" && this.session?.sessionId)
      headers.set("X-Session-ID", this.session.sessionId);
    if (auth === "ops" && this.session?.opsToken)
      headers.set("X-Raven-Ops-Session", this.session.opsToken);
    if (init.method && init.method !== "GET")
      headers.set("X-Idempotency-Key", crypto.randomUUID());
    const response = await fetch(endpoint(path), {
      ...init,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
    const text = await response.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text };
      }
    }
    if (!response.ok) {
      const details =
        typeof body === "object" && body !== null
          ? (body as Record<string, unknown>)
          : {};
      throw new OperationsError(
        typeof details.message === "string"
          ? details.message
          : typeof details.error === "string"
            ? details.error
            : `Request failed with status ${response.status}.`,
        response.status,
        typeof details.code === "string" ? details.code : "request_failed",
        body,
      );
    }
    return body as T;
  }

  async login(username: string, password: string): Promise<SessionIdentity> {
    const response = await fetch(endpoint("/v1/auth/login"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-ID": crypto.randomUUID(),
      },
      body: JSON.stringify({ username, password }),
      credentials: "same-origin",
    });
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok)
      throw new OperationsError(
        typeof body.message === "string"
          ? body.message
          : typeof body.error === "string"
            ? body.error
            : "Login failed.",
        response.status,
      );
    const sessionId =
      response.headers.get("X-Session-ID") ??
      (typeof body.sessionId === "string" ? body.sessionId : "");
    if (!sessionId)
      throw new OperationsError(
        "The Raven API did not return an account session.",
      );
    this.session = {
      sessionId,
      opsToken: "",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      username,
    };
    const ops = await this.request<{
      token?: string;
      opsSessionToken?: string;
      expiresAt: string;
    }>(
      "/v1/ops/session",
      { method: "POST", body: JSON.stringify({ password }) },
      "account",
    );
    const opsToken = ops.token || ops.opsSessionToken || "";
    if (!opsToken)
      throw new OperationsError(
        "The Raven API did not return a release-operations session.",
      );
    this.session = { sessionId, opsToken, expiresAt: ops.expiresAt, username };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
    return this.session;
  }

  async logout() {
    try {
      await this.request("/v1/auth/logout", { method: "POST" }, "account");
    } finally {
      this.clearSession();
    }
  }

  async authorize(action: HighRiskAction, subject: string, password: string) {
    const value = await this.request<
      AuthorizationReview & {
        actionAuthorizationToken?: string;
        expectedConfirmation?: string;
      }
    >("/v1/ops/authorize-action", {
      method: "POST",
      body: JSON.stringify({ password, action, subject }),
    });
    return {
      ...value,
      token: value.token || value.actionAuthorizationToken || "",
      confirmation: value.confirmation || value.expectedConfirmation || "",
    };
  }

  async releases() {
    return envelopeArray<DesktopRelease>(
      await this.request("/v1/ops/releases"),
      "releases",
    );
  }

  async release(id: string) {
    const value = await this.request<
      DesktopRelease | { release: DesktopRelease }
    >(`/v1/ops/releases/${encodeURIComponent(id)}`);
    return "release" in value ? value.release : value;
  }

  async releaseAction(
    id: string,
    action: string,
    body: Record<string, unknown> = {},
  ) {
    const authorizationToken =
      typeof body.authorizationToken === "string"
        ? body.authorizationToken
        : "";
    const payload = { ...body };
    delete payload.authorizationToken;
    return this.request<DesktopRelease>(
      `/v1/ops/releases/${encodeURIComponent(id)}/${action}`,
      {
        method: "POST",
        headers: authorizationToken
          ? { "X-Raven-Action-Authorization": authorizationToken }
          : undefined,
        body: JSON.stringify(payload),
      },
    );
  }

  async channels() {
    return envelopeArray<UpdateChannel>(
      await this.request("/v1/ops/channels"),
      "channels",
    );
  }

  async cohorts() {
    return envelopeArray<UpdateCohort>(
      await this.request("/v1/ops/cohorts"),
      "cohorts",
    );
  }

  async setChannel(
    name: string,
    enabled: boolean,
    body: Record<string, unknown>,
  ) {
    const authorizationToken =
      typeof body.authorizationToken === "string"
        ? body.authorizationToken
        : "";
    const payload = { ...body };
    delete payload.authorizationToken;
    return this.request<UpdateChannel>(
      `/v1/ops/channels/${encodeURIComponent(name)}/${enabled ? "enable" : "disable"}`,
      {
        method: "POST",
        headers: authorizationToken
          ? { "X-Raven-Action-Authorization": authorizationToken }
          : undefined,
        body: JSON.stringify(payload),
      },
    );
  }

  async versionBlocks() {
    return envelopeArray<VersionBlock>(
      await this.request("/v1/ops/version-blocks"),
      "versionBlocks",
    );
  }

  async createVersionBlock(body: Record<string, unknown>) {
    const authorizationToken =
      typeof body.authorizationToken === "string"
        ? body.authorizationToken
        : "";
    const payload = { ...body };
    delete payload.authorizationToken;
    return this.request<VersionBlock>("/v1/ops/version-blocks", {
      method: "POST",
      headers: authorizationToken
        ? { "X-Raven-Action-Authorization": authorizationToken }
        : undefined,
      body: JSON.stringify(payload),
    });
  }

  async audit() {
    return envelopeArray<AuditEvent>(
      await this.request("/v1/ops/audit"),
      "audit",
    );
  }

  async outcomes() {
    return envelopeArray<OutcomeAggregate>(
      await this.request("/v1/ops/outcomes"),
      "outcomes",
    );
  }

  async diagnostics() {
    const reports = envelopeArray<DiagnosticReport & { payloadJson?: string }>(
      await this.request("/v1/ops/diagnostics"),
      "diagnostics",
    );
    return reports.map((report) => ({
      ...report,
      payload: parsePayload(report.payload ?? report.payloadJson),
    }));
  }
}

export const operationsApi = new OperationsApi();
