const DEFAULT_API_BASE_URL = normalizeApiServerUrl(import.meta.env.VITE_RAVEN_API_URL ?? "http://127.0.0.1:6977");
const API_SERVER_URL_KEY = "raven.apiServerUrl";
const API_SERVER_HISTORY_KEY = "raven.apiServerHistory";
const SESSION_ID_KEY = "raven.sessionId";
const UPDATE_CHANNEL_KEY = "raven.updateChannel";
const UPDATE_COHORT_KEY = "raven.updateCohort";
export const RAVEN_CLIENT_VERSION = typeof __RAVEN_CLIENT_VERSION__ === "string" ? __RAVEN_CLIENT_VERSION__ : "0.1.0";
export const RAVEN_PROTOCOL_VERSION = 1;
export const RAVEN_CLIENT_CAPABILITIES = [
  "desktop-updater-v1",
  "tauri-signed-updates",
  "nest-session-deferral",
];

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reasonCode = "",
    readonly compatibility?: ServerCompatibility,
    readonly serviceAccess = "",
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const compatibilityFailureListeners = new Set<(compatibility: ServerCompatibility) => void>();

export function subscribeApiCompatibilityFailures(listener: (compatibility: ServerCompatibility) => void) {
  compatibilityFailureListeners.add(listener);
  return () => {
    compatibilityFailureListeners.delete(listener);
  };
}

export function isUnauthorizedError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 401;
}

export type UserRole = "admin" | "user";
export type NestType = "persistent" | "temporary";
export type NestRole = "creator" | "moderator" | "participant";
export type MembershipState = "invited" | "joined" | "left" | "removed";
export type TreeRole = "owner" | "moderator" | "member";
export type TreeMembershipState = "joined" | "left" | "removed";
export type TreeJoinPolicy = "free" | "request";
export type TreeVisibility = "public" | "private";
export type UserPresenceState = "offline" | "available" | "dnd" | "in_nest" | "invisible";
export type UserReachability = "open" | "around" | "focused" | "unavailable";
export type KnockStatus = "pending" | "accepted" | "declined" | "dismissed" | "expired";
export type UserRelationship = "self" | "none" | "friends" | "incoming_pending" | "outgoing_pending";
export type UILabelPreference = "tree_nest" | "space_room";

export interface NestLiveUpdate {
  type: string;
  nestId?: string;
  sessionId?: string;
  at?: string;
}

export interface UserPreferences {
  displayName: string;
  uiLabels: UILabelPreference;
  colorPalette: "raven_dark";
  colorPaletteEnabled: boolean;
  alwaysJoinMuted: boolean;
  joinWithCameraOff: boolean;
  joinWithoutScreenSharing: boolean;
  followScreenShares: boolean;
  updatedAt: string;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  preferences: UserPreferences;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  relationship: UserRelationship;
  friendRequestId?: string;
}

export interface Nest {
  id: string;
  name: string;
  joinCode: string;
  creatorUserId: string;
  treeId?: string | null;
  type: NestType;
  status: "active" | "ended";
  lifecycleState: "created" | "waiting" | "ready" | "active" | "empty" | "expired" | "closed";
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  endedAt?: string | null;
  emptySince?: string | null;
  expiresAt?: string | null;
  lastActivityAt: string;
  shareableLink: string;
  httpLink: string;
}

export interface ParticipantSummary {
  userId: string;
  username: string;
  displayName: string;
  joinedAt: string;
}

export interface SessionSummary {
  id: string;
  nestId: string;
  startedAt: string;
  endedAt?: string | null;
  durationSeconds?: number | null;
  status: "active" | "ended";
  participants: ParticipantSummary[];
}

export interface LauncherNest extends Nest {
  active: boolean;
  activeParticipantCount: number;
  currentParticipants: ParticipantSummary[];
  currentSessionStartedAt?: string | null;
  currentSessionId?: string | null;
}

export interface NestEvent {
  id: string;
  nestId: string;
  sessionId?: string | null;
  userId?: string | null;
  username?: string | null;
  displayName?: string | null;
  eventType: string;
  metadata?: unknown;
  createdAt: string;
}

export interface NestHistory {
  sessions: SessionSummary[];
  events: NestEvent[];
}

export interface Invitation {
  id: string;
  nestId: string;
  userId: string;
  username: string;
  displayName: string;
  createdAt: string;
}

export interface JoinRequest {
  id: string;
  nestId: string;
  nestName: string;
  userId: string;
  username: string;
  displayName: string;
  status: "pending" | "accepted" | "rejected" | "cancelled";
  createdAt: string;
  resolvedAt?: string | null;
}

export interface Member {
  nestId: string;
  userId: string;
  username: string;
  displayName: string;
  role: NestRole;
  state: MembershipState;
  joinedAt?: string | null;
  leftAt?: string | null;
}

export interface Dashboard {
  created: Nest[];
  invited: Nest[];
  joined: Nest[];
  pendingAdmission: JoinRequest[];
}

export interface NestDetails {
  nest: Nest;
  members: Member[];
  invitations: Invitation[];
  joinRequests: JoinRequest[];
}

export interface Tree {
  id: string;
  name: string;
  description: string;
  joinPolicy: TreeJoinPolicy;
  visibility: TreeVisibility;
  creatorUserId: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface TreeMember {
  treeId: string;
  userId: string;
  username: string;
  displayName: string;
  role: TreeRole;
  state: TreeMembershipState;
  joinedAt?: string | null;
  leftAt?: string | null;
  presenceState: UserPresenceState;
  reachability: UserReachability;
  activeNestId?: string | null;
}

export interface TreeJoinRequest {
  id: string;
  treeId: string;
  treeName: string;
  userId: string;
  username: string;
  displayName: string;
  status: "pending" | "accepted" | "rejected" | "cancelled";
  createdAt: string;
  resolvedAt?: string | null;
}

export interface TreeSearchResult {
  tree: Tree;
  memberRole?: TreeRole;
  requestId?: string;
  accessState: "none" | "joined" | "pending";
}

export interface UserPresence {
  userId: string;
  username: string;
  displayName: string;
  state: UserPresenceState;
  reachability: UserReachability;
  activeNestId?: string | null;
  updatedAt: string;
}

export interface Knock {
  id: string;
  fromUserId: string;
  fromUsername: string;
  fromDisplayName: string;
  toUserId?: string | null;
  toUsername?: string | null;
  toDisplayName?: string | null;
  nestId?: string | null;
  nestName?: string | null;
  status: KnockStatus;
  message?: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string | null;
  resolvedByUserId?: string | null;
}

export interface Friend {
  userId: string;
  username: string;
  displayName: string;
  createdAt: string;
}

export interface FriendRequest {
  id: string;
  fromUserId: string;
  fromUsername: string;
  fromDisplayName: string;
  toUserId: string;
  toUsername: string;
  toDisplayName: string;
  status: "pending" | "accepted" | "declined" | "cancelled";
  createdAt: string;
  resolvedAt?: string | null;
}

export interface TreeDetails {
  tree: Tree;
  members: TreeMember[];
  activeNests: Nest[];
  inactiveNests: Nest[];
  joinRequests: TreeJoinRequest[];
}

export interface HomeState {
  user: User;
  presence: UserPresence;
  trees: Tree[];
  activeNests: LauncherNest[];
  temporaryNests: LauncherNest[];
  pendingKnocks: Knock[];
  pendingInvites: Invitation[];
  pendingRequests: JoinRequest[];
  friends: Friend[];
  incomingFriendRequests: FriendRequest[];
  outgoingFriendRequests: FriendRequest[];
}

export interface LoginResponse {
  user: User;
}

export interface AuthSession {
  id: string;
  latestIp: string;
  userAgent: string;
  os: string;
  deviceName: string;
  createdAt: string;
  lastAccessedAt: string;
  expiresAt: string;
  revokedAt?: string;
  current: boolean;
}

export interface ServerProperties {
  name: string;
  description: string;
  avatar: string;
  rtcServerUrl: string;
  properties: Record<string, unknown>;
}

export interface ServerCompatibility {
  status: string;
  reasonCode: string;
  message: string;
  clientVersion?: string;
  serverVersion?: string;
  protocolVersion: number;
  minimumClientVersion?: string;
  recommendedClientVersion?: string;
  minimumServerVersion?: string;
  maximumServerVersion?: string;
  requiredCapabilities: string[];
  missingCapabilities: string[];
  graceEndsAt?: string | null;
}

export interface JoinResponse {
  status: "joined" | "waiting";
  nest: Nest;
  joinRequest?: JoinRequest;
}

export interface LiveKitTokenResponse {
  url: string;
  token: string;
  sessionName: string;
  identity: string;
  displayName: string;
}

export function parseNestLiveUpdateEvent(event: string): NestLiveUpdate | null {
  const lines = event.split(/\r?\n/);
  if (!lines.some((line) => line.trim() === "event: nest-update")) return null;
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (typeof parsed.type !== "string" || !parsed.type) return null;
    return {
      type: parsed.type,
      nestId: typeof parsed.nestId === "string" && parsed.nestId ? parsed.nestId : undefined,
      sessionId: typeof parsed.sessionId === "string" && parsed.sessionId ? parsed.sessionId : undefined,
      at: typeof parsed.at === "string" && parsed.at ? parsed.at : undefined,
    };
  } catch {
    return null;
  }
}

export class ApiClient {
  private sessionId = localStorage.getItem(SESSION_ID_KEY) ?? "";
  private baseUrl = readStoredApiServerUrl();
  private updateChannel: "alpha" | "stable" = localStorage.getItem(UPDATE_CHANNEL_KEY) === "stable" ? "stable" : "alpha";
  private updateCohort: "internal" | "friends" = localStorage.getItem(UPDATE_COHORT_KEY) === "internal" ? "internal" : "friends";
  private serviceAccess: { mode: string; reasonCode: string; message: string } = { mode: "allowed", reasonCode: "", message: "" };

  getBaseUrl() {
    return this.baseUrl;
  }

  url(path: string) {
    return `${this.baseUrl}${path}`;
  }

  assetUrl(value: string) {
    if (!value || /^(?:https?:|data:|blob:)/i.test(value)) return value;
    return this.url(value.startsWith("/") ? value : `/${value}`);
  }

  userAvatarUrl(userId: string, version = "") {
    return this.url(`/v1/media/users/${encodeURIComponent(userId)}/avatar${version ? `?v=${encodeURIComponent(version)}` : ""}`);
  }

  treeAvatarUrl(treeId: string, version = "") {
    return this.url(`/v1/media/trees/${encodeURIComponent(treeId)}/avatar${version ? `?v=${encodeURIComponent(version)}` : ""}`);
  }

  getServerHistory() {
    return readApiServerHistory();
  }

  setBaseUrl(value: string, remember = true) {
    const next = normalizeApiServerUrl(value);
    this.baseUrl = next;
    localStorage.setItem(API_SERVER_URL_KEY, next);
    if (remember) rememberApiServerUrl(next);
    return next;
  }

  setSessionId(sessionId: string) {
    this.sessionId = sessionId;
    localStorage.setItem(SESSION_ID_KEY, sessionId);
  }

  clearSession() {
    this.sessionId = "";
    localStorage.removeItem(SESSION_ID_KEY);
    localStorage.removeItem("raven.token");
  }

  getSessionId() {
    return this.sessionId;
  }

  setUpdateChannel(channel: "alpha" | "stable") {
    this.updateChannel = channel;
    localStorage.setItem(UPDATE_CHANNEL_KEY, channel);
  }

  setUpdateCohort(cohort: "internal" | "friends") {
    this.updateCohort = cohort;
    localStorage.setItem(UPDATE_COHORT_KEY, cohort);
  }

  setServiceAccess(access: { mode: string; reasonCode: string; message: string }) {
    this.serviceAccess = access;
  }

  async login(username: string, password: string) {
    const response = await this.request<LoginResponse>("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      auth: false,
    });
    rememberApiServerUrl(this.baseUrl);
    return response;
  }

  logout() {
    return this.request<void>("/v1/auth/logout", { method: "POST" });
  }

  authSessions() {
    return this.request<{ sessions: AuthSession[] }>("/v1/auth/sessions");
  }

  revokeAuthSession(id: string) {
    return this.request<{ revoked: boolean; current: boolean }>(`/v1/auth/sessions/${id}`, { method: "DELETE" });
  }

  subscribeNestEvents(
    onUpdate: (update: NestLiveUpdate) => void,
    options: { initialReconnectDelayMs?: number; maxReconnectDelayMs?: number } = {},
  ) {
    if (this.serviceAccess.mode !== "allowed") return () => undefined;
    const controller = new AbortController();
    const initialReconnectDelayMs = Math.max(options.initialReconnectDelayMs ?? 1000, 0);
    const maxReconnectDelayMs = Math.max(options.maxReconnectDelayMs ?? 30_000, initialReconnectDelayMs);
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let hasConnected = false;

    const waitForReconnect = (delayMs: number) => new Promise<void>((resolve) => {
      if (controller.signal.aborted || delayMs === 0) {
        resolve();
        return;
      }
      const finish = () => {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timeout = setTimeout(finish, delayMs);
      controller.signal.addEventListener("abort", finish, { once: true });
    });

    const consumeStream = async () => {
      const headers = new Headers({ Accept: "text/event-stream" });
      if (this.sessionId) headers.set("X-Session-ID", this.sessionId);
      headers.set("X-Raven-OS", desktopOS());
      headers.set("X-Raven-Device", "Raven Desktop");
      addClientCompatibilityHeaders(headers, this.updateChannel, this.updateCohort);
      const response = await fetch(this.url("/v1/nest-events"), { headers, signal: controller.signal });
      if (!response.ok || !response.body) return;
        if (hasConnected) onUpdate({ type: "stream.reconnected", at: new Date().toISOString() });
      hasConnected = true;
      const nextSessionId = response.headers.get("X-Session-ID");
      if (nextSessionId) this.setSessionId(nextSessionId);
      const reader = response.body.getReader();
      activeReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 262_144) buffer = "";
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() ?? "";
          for (const event of events) {
            const update = parseNestLiveUpdateEvent(event);
            if (update) onUpdate(update);
          }
        }
      } finally {
        if (activeReader === reader) activeReader = null;
        reader.releaseLock();
      }
    };

    const run = async () => {
      let reconnectDelayMs = initialReconnectDelayMs;
      while (!controller.signal.aborted) {
        try {
          await consumeStream();
        } catch {
          // A dropped stream is expected during server/network changes. Reconnect below.
        }
        if (controller.signal.aborted) break;
        await waitForReconnect(reconnectDelayMs);
        reconnectDelayMs = Math.min(Math.max(reconnectDelayMs * 2, 1), maxReconnectDelayMs);
      }
    };

    void run();
    return () => {
      controller.abort();
      void activeReader?.cancel().catch(() => undefined);
      activeReader = null;
    };
  }

  serverProperties() {
    return this.request<ServerProperties>("/v1/server/properties", { auth: false });
  }

  serverCompatibility() {
    const query = new URLSearchParams({
      clientVersion: RAVEN_CLIENT_VERSION,
      protocolVersion: String(RAVEN_PROTOCOL_VERSION),
      capabilities: RAVEN_CLIENT_CAPABILITIES.join(","),
    });
    return this.request<{ compatibility: ServerCompatibility }>(`/v1/server/compatibility?${query}`, { auth: false });
  }

  fallbackServerProperties(): ServerProperties {
    return {
      name: "Raven",
      description: "Desktop RTC for private Nests",
      avatar: "",
      rtcServerUrl: "ws://127.0.0.1:7880",
      properties: {},
    };
  }

  me() {
    return this.request<{ user: User }>("/v1/auth/me");
  }

  preferences() {
    return this.request<{ preferences: UserPreferences }>("/v1/preferences");
  }

  updatePreferences(patch: Partial<Pick<UserPreferences, "displayName" | "uiLabels" | "colorPalette" | "alwaysJoinMuted" | "joinWithCameraOff" | "joinWithoutScreenSharing" | "followScreenShares">>) {
    return this.request<{ preferences: UserPreferences; user: User }>("/v1/preferences", {
      method: "POST",
      body: JSON.stringify(patch),
    });
  }

  uploadProfileAvatar(file: File) {
    return this.uploadAvatar("/v1/profile/avatar", file);
  }

  uploadServerAvatar(file: File) {
    return this.uploadAvatar("/v1/admin/server/avatar", file);
  }

  dashboard() {
    return this.request<Dashboard>("/v1/nests");
  }

  home() {
    return this.request<HomeState>("/v1/home");
  }

  trees() {
    return this.request<{ trees: Tree[] }>("/v1/trees");
  }

  searchTrees(query: string) {
    return this.request<{ trees: TreeSearchResult[] }>(`/v1/trees/search?q=${encodeURIComponent(query)}`);
  }

  searchUsers(query: string) {
    return this.request<{ users: PublicUser[] }>(`/v1/users/search?q=${encodeURIComponent(query)}`);
  }

  friends() {
    return this.request<{ friends: Friend[]; incomingFriendRequests: FriendRequest[]; outgoingFriendRequests: FriendRequest[] }>("/v1/friends");
  }

  createFriendRequest(payload: { toUserId?: string; username?: string }) {
    return this.request<{ friendRequest: FriendRequest }>("/v1/friend-requests", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  acceptFriendRequest(id: string) {
    return this.request<{ friendRequest: FriendRequest }>(`/v1/friend-requests/${id}/accept`, { method: "POST" });
  }

  declineFriendRequest(id: string) {
    return this.request<{ friendRequest: FriendRequest }>(`/v1/friend-requests/${id}/decline`, { method: "POST" });
  }

  cancelFriendRequest(id: string) {
    return this.request<{ friendRequest: FriendRequest }>(`/v1/friend-requests/${id}/cancel`, { method: "POST" });
  }

  removeFriend(userId: string) {
    return this.request<void>(`/v1/friends/${userId}`, { method: "DELETE" });
  }

  createTree(payload: { name: string; description?: string; joinPolicy?: TreeJoinPolicy; visibility?: TreeVisibility }) {
    return this.request<{ tree: Tree }>("/v1/trees", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  getTree(id: string) {
    return this.request<TreeDetails>(`/v1/trees/${id}`);
  }

  updateTreeSettings(treeId: string, payload: { name: string; description: string; joinPolicy: TreeJoinPolicy; visibility: TreeVisibility }) {
    return this.request<{ tree: Tree }>(`/v1/trees/${treeId}/settings`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  uploadTreeAvatar(treeId: string, file: File) {
    return this.uploadAvatar(`/v1/trees/${treeId}/avatar`, file);
  }

  deleteTree(treeId: string, confirmation: string) {
    return this.request<void>(`/v1/trees/${treeId}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmation }),
    });
  }

  joinTree(treeId: string) {
    return this.request<{ status: "joined" | "waiting"; tree: Tree; member?: TreeMember; joinRequest?: TreeJoinRequest }>(`/v1/trees/${treeId}/join`, {
      method: "POST",
    });
  }

  addTreeMember(treeId: string, username: string, role: TreeRole = "member") {
    return this.request<{ member: TreeMember }>(`/v1/trees/${treeId}/members`, {
      method: "POST",
      body: JSON.stringify({ username, role }),
    });
  }

  updateTreeMemberRole(treeId: string, userId: string, role: TreeRole) {
    return this.request<{ member: TreeMember }>(`/v1/trees/${treeId}/members/${userId}/role`, {
      method: "POST",
      body: JSON.stringify({ role }),
    });
  }

  removeTreeMember(treeId: string, userId: string) {
    return this.request<void>(`/v1/trees/${treeId}/members/${userId}`, { method: "DELETE" });
  }

  acceptTreeJoinRequest(treeId: string, requestId: string) {
    return this.request<{ joinRequest: TreeJoinRequest; status: "accepted" }>(`/v1/trees/${treeId}/join-requests/${requestId}/accept`, { method: "POST" });
  }

  rejectTreeJoinRequest(treeId: string, requestId: string) {
    return this.request<{ joinRequest: TreeJoinRequest; status: "rejected" }>(`/v1/trees/${treeId}/join-requests/${requestId}/reject`, { method: "POST" });
  }

  createNest(name: string, type: NestType = "persistent") {
    return this.request<{ nest: Nest }>("/v1/nests", {
      method: "POST",
      body: JSON.stringify({ name, type }),
    });
  }

  createPersistentNest(name: string) {
    return this.request<{ nest: Nest }>("/v1/nests/persistent", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  createTemporaryNest(name: string) {
    return this.request<{ nest: Nest }>("/v1/nests/temporary", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  createTreeNest(treeId: string, name: string) {
    return this.request<{ nest: Nest }>(`/v1/trees/${treeId}/nests`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  launcherNests() {
    return this.request<{ nests: LauncherNest[] }>("/v1/nests/launcher");
  }

  getNest(id: string) {
    return this.request<NestDetails>(`/v1/nests/${id}`);
  }

  inviteUser(nestId: string, username: string) {
    return this.request<{ invitation: Invitation }>(`/v1/nests/${nestId}/invitations`, {
      method: "POST",
      body: JSON.stringify({ username }),
    });
  }

  joinNest(nestId: string) {
    return this.request<JoinResponse>(`/v1/nests/${nestId}/join`, { method: "POST" });
  }

  joinByCode(value: string) {
    return this.request<JoinResponse>("/v1/nests/join-by-code", {
      method: "POST",
      body: JSON.stringify({ code: value, link: value }),
    });
  }

  leaveNest(nestId: string) {
    return this.request<void>(`/v1/nests/${nestId}/leave`, { method: "POST" });
  }

  archiveNest(nestId: string) {
    return this.request<void>(`/v1/nests/${nestId}/archive`, { method: "POST" });
  }

  joinNestPresence(nestId: string) {
    return this.request<void>(`/v1/nests/${nestId}/presence/join`, { method: "POST" });
  }

  leaveNestPresence(nestId: string) {
    return this.request<void>(`/v1/nests/${nestId}/presence/leave`, { method: "POST" });
  }

  joinSession(nestId: string) {
    return this.request<{ session: SessionSummary }>(`/v1/nests/${nestId}/session/join`, { method: "POST" });
  }

  leaveSession(nestId: string) {
    return this.request<{ session: SessionSummary | null }>(`/v1/nests/${nestId}/session/leave`, { method: "POST" });
  }

  disconnectFromNest(nestId: string) {
    return this.request<{ session: SessionSummary | null }>(`/v1/nests/${nestId}/session/disconnect`, { method: "POST" });
  }

  activeSession(nestId: string) {
    return this.request<{ session: SessionSummary | null }>(`/v1/nests/${nestId}/session`);
  }

  nestHistory(nestId: string) {
    return this.request<NestHistory>(`/v1/nests/${nestId}/history`);
  }

  liveKitToken(nestId: string, identity?: "audio" | "video") {
    const query = identity ? `?identity=${identity}` : "";
    return this.request<LiveKitTokenResponse>(`/v1/nests/${nestId}/livekit-token${query}`, {
      method: "POST",
    });
  }

  acceptJoinRequest(nestId: string, requestId: string) {
    return this.request(`/v1/nests/${nestId}/join-requests/${requestId}/accept`, { method: "POST" });
  }

  rejectJoinRequest(nestId: string, requestId: string) {
    return this.request(`/v1/nests/${nestId}/join-requests/${requestId}/reject`, { method: "POST" });
  }

  updatePresence(state: UserPresenceState, reachability?: UserReachability, activeNestId?: string | null) {
    return this.request<{ presence: UserPresence }>("/v1/presence", {
      method: "POST",
      body: JSON.stringify({ state, reachability, activeNestId }),
    });
  }

  presenceHeartbeat(signal?: AbortSignal) {
    return this.request<void>("/v1/presence/heartbeat", { method: "POST", response: "none", signal });
  }

  createKnock(payload: { toUserId?: string; username?: string; nestId?: string; message?: string }) {
    return this.request<{ knock: Knock }>("/v1/knocks", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  listKnocks() {
    return this.request<{ knocks: Knock[] }>("/v1/knocks");
  }

  acceptKnock(id: string) {
    return this.request<{ knock: Knock }>(`/v1/knocks/${id}/accept`, { method: "POST" });
  }

  declineKnock(id: string) {
    return this.request<{ knock: Knock }>(`/v1/knocks/${id}/decline`, { method: "POST" });
  }

  dismissKnock(id: string) {
    return this.request<{ knock: Knock }>(`/v1/knocks/${id}/dismiss`, { method: "POST" });
  }

  createUser(username: string, password: string, role: UserRole) {
    return this.request<{ user: User }>("/v1/admin/users", {
      method: "POST",
      body: JSON.stringify({ username, password, role }),
    });
  }

  listUsers() {
    return this.request<{ users: User[] }>("/v1/admin/users");
  }

  private uploadAvatar(path: string, file: File) {
    if (file.size > 512 * 1024) {
      return Promise.reject(new Error("Profile images must be 512 KB or smaller"));
    }
    return this.request<{ avatar: string }>(path, {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    });
  }

  private async request<T>(
    path: string,
    init: RequestInit & { auth?: boolean; response?: "json" | "none" } = {},
  ): Promise<T> {
    if (this.serviceAccess.mode !== "allowed" && isCompatibilityGatedPath(path)) {
      throw new ApiError(
        this.serviceAccess.message || "Raven service access is paused until compatibility is restored.",
        426,
        this.serviceAccess.reasonCode,
        undefined,
        "blocked",
      );
    }
    const { auth = true, response: responseMode = "json", ...requestInit } = init;
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type") && typeof init.body === "string") headers.set("Content-Type", "application/json");
    if (auth && this.sessionId) headers.set("X-Session-ID", this.sessionId);
    headers.set("X-Raven-OS", desktopOS());
    headers.set("X-Raven-Device", "Raven Desktop");
    addClientCompatibilityHeaders(headers, this.updateChannel, this.updateCohort);

    const response = await fetch(this.url(path), { ...requestInit, headers });
    const nextSessionId = response.headers.get("X-Session-ID");
    if (nextSessionId) this.setSessionId(nextSessionId);
    if (response.status === 204) return undefined as T;
    if (response.ok && responseMode === "none") {
      await response.body?.cancel().catch(() => undefined);
      return undefined as T;
    }
    const payload: Record<string, unknown> = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = apiErrorFromPayload(payload, response.status);
      if (response.status === 426 && error.compatibility) {
        this.serviceAccess = {
          mode: error.compatibility.status === "blocked" ? "blocked" : error.compatibility.status === "upgrade_required" ? "required" : "unsupported",
          reasonCode: error.compatibility.reasonCode,
          message: error.compatibility.message,
        };
        compatibilityFailureListeners.forEach((listener) => listener(error.compatibility!));
      }
      throw error;
    }
    return payload as T;
  }
}

export function apiErrorFromPayload(payload: Record<string, unknown>, status: number) {
  const compatibility = isServerCompatibility(payload.compatibility) ? payload.compatibility : undefined;
  const message = typeof payload.error === "string"
    ? payload.error
    : compatibility?.message || `Request failed with ${status}`;
  const reasonCode = typeof payload.reasonCode === "string"
    ? payload.reasonCode
    : compatibility?.reasonCode ?? "";
  return new ApiError(
    message,
    status,
    reasonCode,
    compatibility,
    typeof payload.serviceAccess === "string" ? payload.serviceAccess : "",
    payload,
  );
}

function isServerCompatibility(value: unknown): value is ServerCompatibility {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ServerCompatibility>;
  return typeof candidate.status === "string"
    && typeof candidate.reasonCode === "string"
    && typeof candidate.message === "string";
}

function addClientCompatibilityHeaders(headers: Headers, channel: "alpha" | "stable", cohort: "internal" | "friends") {
  headers.set("X-Raven-Client-Version", RAVEN_CLIENT_VERSION);
  headers.set("X-Raven-Protocol-Version", String(RAVEN_PROTOCOL_VERSION));
  headers.set("X-Raven-Capabilities", RAVEN_CLIENT_CAPABILITIES.join(","));
  headers.set("X-Raven-Update-Channel", channel);
  headers.set("X-Raven-Update-Cohort", cohort);
}

function isCompatibilityGatedPath(path: string) {
  return [
    "/v1/home",
    "/v1/users",
    "/v1/friends",
    "/v1/friend-requests",
    "/v1/trees",
    "/v1/nests",
    "/v1/presence",
    "/v1/knocks",
    "/v1/nest-events",
  ].some((prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`));
}

function desktopOS() {
  const platform = navigator.platform || navigator.userAgent;
  if (/win/i.test(platform)) return "Windows";
  if (/mac/i.test(platform)) return "macOS";
  if (/linux/i.test(platform)) return "Linux";
  return platform || "Unknown";
}

export const api = new ApiClient();

export function normalizeApiServerUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("API server URL is required");
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Enter a valid Raven API server URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Raven API server URL must start with http:// or https://");
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/+$/, "");
}

function readStoredApiServerUrl() {
  const stored = localStorage.getItem(API_SERVER_URL_KEY);
  try {
    return stored ? normalizeApiServerUrl(stored) : DEFAULT_API_BASE_URL;
  } catch {
    return DEFAULT_API_BASE_URL;
  }
}

function readApiServerHistory() {
  const raw = localStorage.getItem(API_SERVER_HISTORY_KEY);
  if (!raw) return [readStoredApiServerUrl()];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [readStoredApiServerUrl()];
    const urls = parsed.flatMap((value) => {
      if (typeof value !== "string") return [];
      try {
        return [normalizeApiServerUrl(value)];
      } catch {
        return [];
      }
    });
    return [...new Set([readStoredApiServerUrl(), ...urls])].slice(0, 8);
  } catch {
    return [readStoredApiServerUrl()];
  }
}

function rememberApiServerUrl(value: string) {
  const url = normalizeApiServerUrl(value);
  const next = [...new Set([url, ...readApiServerHistory()])].slice(0, 8);
  localStorage.setItem(API_SERVER_HISTORY_KEY, JSON.stringify(next));
}
