import type {
  HomeState,
  JoinRequest,
  Knock,
  LauncherNest,
  Member,
  Nest,
  NestDetails,
  SessionSummary,
  Tree,
  TreeDetails,
  TreeJoinPolicy,
  TreeSearchResult,
  TreeVisibility,
  TreeMember,
  TreeRole,
  User,
  UserPresence,
  Friend,
  FriendRequest,
  PublicUser,
  ServerProperties,
  UILabelPreference,
  UserPreferences,
  UserPresenceState,
  UserReachability,
} from "@/lib/api";

export type Presence = "open" | "around" | "focused" | "dnd" | "invisible" | "offline";
export type SelectablePresence = Exclude<Presence, "offline">;

// Presence hues. Shape carries the state too (see PresenceDot), so these never
// have to be told apart by colour alone.
export const PRESENCE: Record<Presence, { label: string; h: string }> = {
  open: { label: "Open to talk", h: "146 40% 58%" },
  around: { label: "Around", h: "36 7% 68%" },
  focused: { label: "Focused", h: "38 80% 62%" },
  dnd: { label: "Do not disturb", h: "4 66% 64%" },
  invisible: { label: "Invisible", h: "34 6% 52%" },
  offline: { label: "Offline", h: "34 6% 52%" },
};

export const SELECTABLE_PRESENCES: SelectablePresence[] = ["open", "around", "focused", "dnd", "invisible"];

export type RavenView =
  | { kind: "home" }
  | { kind: "tree"; id: string }
  | { kind: "tree-preview"; result: TreeSearchResult }
  | { kind: "tree-settings"; id: string; section?: string }
  | { kind: "user"; id: string; person?: ShellPerson }
  | { kind: "waiting"; id: string }
  | { kind: "nest"; id: string }
  /** One conversation: a direct message, a group, or a text nest. */
  | { kind: "chat"; id: string }
  /** Every direct message and group, including archived ones. */
  | { kind: "messages" }
  | { kind: "mixer" }
  | { kind: "settings"; section?: string };

export interface ShellPerson {
  id: string;
  name: string;
  presence: Presence;
  /**
   * Nothing tells this client where the person is (a search result, or someone known
   * only through a friend request). `presence` is then a placeholder and must not be shown.
   */
  presenceUnknown?: boolean;
  treeIds: string[];
  activeNestIds: string[];
  relationship: "friend" | "context";
}

export interface UILabelCopy {
  treeSingular: string;
  treePlural: string;
  nestSingular: string;
  nestPlural: string;
  activeTrees: string;
  liveNests: string;
  temporaryNest: string;
  noTree: string;
}

export type PendingItem =
  | { id: string; kind: "knock"; from: string; fromId: string; context: string; knock: Knock }
  | { id: string; kind: "invite"; from: string; nestId: string; context: string }
  | { id: string; kind: "request"; from: string; fromId: string; nestId: string; context: string; request: JoinRequest }
  | { id: string; kind: "friend"; from: string; fromId: string; context: string; request: FriendRequest };

/** Someone announced they are about to enter a Nest this client is inside. */
export interface NestEntryNotice {
  nestId: string;
  actorId: string;
  actorName: string;
  receivedAt: number;
}

export interface RavenShellData {
  user: User | null;
  preferences: UserPreferences;
  labels: UILabelCopy;
  serverProperties: ServerProperties;
  apiServerUrl: string;
  apiServerHistory: string[];
  home: HomeState | null;
  presence: UserPresence | null;
  trees: Tree[];
  treeDetails: Record<string, TreeDetails>;
  nestDetails: Record<string, NestDetails>;
  activeSessions: Record<string, SessionSummary | null>;
  activeNests: LauncherNest[];
  temporaryNests: LauncherNest[];
  friends: Friend[];
  incomingFriendRequests: FriendRequest[];
  outgoingFriendRequests: FriendRequest[];
  people: ShellPerson[];
  pending: PendingItem[];
  entryNotices: NestEntryNotice[];
  loading: boolean;
  busy: boolean;
  error: string;
  serverUnreachable: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  /** The server no longer accepts this session: return to sign-in and say why. */
  sessionExpired: () => void;
  selectApiServer: (url: string) => Promise<void>;
  refresh: () => Promise<void>;
  retryConnection: () => Promise<void>;
  updatePreferences: (patch: Partial<Pick<UserPreferences, "displayName" | "uiLabels" | "colorPalette" | "alwaysJoinMuted" | "joinWithCameraOff" | "joinWithoutScreenSharing" | "followScreenShares">>) => Promise<void>;
  getTree: (id: string) => Tree | undefined;
  getNest: (id: string) => Nest | LauncherNest | undefined;
  getPerson: (id: string) => ShellPerson | undefined;
  getTreeDetails: (id: string) => TreeDetails | undefined;
  getNestDetails: (id: string) => NestDetails | undefined;
  getActiveSession: (id: string) => SessionSummary | null | undefined;
  searchUsers: (query: string) => Promise<PublicUser[]>;
  searchTrees: (query: string) => Promise<TreeSearchResult[]>;
  createTree: (name: string) => Promise<Tree>;
  updateTreeSettings: (treeId: string, settings: { name: string; description: string; joinPolicy: TreeJoinPolicy; visibility: TreeVisibility }) => Promise<Tree>;
  deleteTree: (treeId: string, confirmation: string) => Promise<void>;
  joinTree: (treeId: string) => Promise<"joined" | "waiting">;
  createTreeNest: (treeId: string, name: string) => Promise<Nest>;
  addTreeMember: (treeId: string, username: string, role?: TreeRole) => Promise<TreeMember>;
  updateTreeMemberRole: (treeId: string, userId: string, role: TreeRole) => Promise<TreeMember>;
  removeTreeMember: (treeId: string, userId: string) => Promise<void>;
  leaveTree: (treeId: string) => Promise<void>;
  transferTreeOwnership: (treeId: string, userId: string) => Promise<TreeMember>;
  /** The account holds a temporary password and can do nothing until it is replaced. */
  passwordChangeRequired: boolean;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  acceptTreeJoinRequest: (treeId: string, requestId: string) => Promise<void>;
  rejectTreeJoinRequest: (treeId: string, requestId: string) => Promise<void>;
  sendFriendRequest: (userId: string) => Promise<void>;
  acceptFriendRequest: (requestId: string) => Promise<void>;
  declineFriendRequest: (requestId: string) => Promise<void>;
  cancelFriendRequest: (requestId: string) => Promise<void>;
  removeFriend: (userId: string) => Promise<void>;
  setPresence: (presence: SelectablePresence) => Promise<void>;
  joinNest: (nestId: string) => Promise<"joined" | "waiting">;
  knockUser: (userId: string) => Promise<void>;
  dismissKnock: (knockId: string) => Promise<void>;
}

export function defaultPreferences(username = "You"): UserPreferences {
  return {
    displayName: username,
    uiLabels: "tree_nest",
    colorPalette: "raven_dark",
    colorPaletteEnabled: false,
    alwaysJoinMuted: false,
    joinWithCameraOff: false,
    joinWithoutScreenSharing: false,
    followScreenShares: true,
    updatedAt: "",
  };
}

export function labelsForPreference(mode: UILabelPreference = "tree_nest"): UILabelCopy {
  if (mode === "space_room") {
    return {
      treeSingular: "Space",
      treePlural: "Spaces",
      nestSingular: "Room",
      nestPlural: "Rooms",
      activeTrees: "Active spaces",
      liveNests: "Live rooms",
      temporaryNest: "Temporary room",
      noTree: "Temporary room",
    };
  }
  return {
    treeSingular: "Tree",
    treePlural: "Trees",
    nestSingular: "Nest",
    nestPlural: "Nests",
    activeTrees: "Active trees",
    liveNests: "Live nests",
    temporaryNest: "Temporary Nest",
    noTree: "Temporary Nest",
  };
}

export function displayNameFor(person: { displayName?: string | null; username?: string | null }) {
  return person.displayName?.trim() || person.username?.trim() || "Unknown";
}

export function presenceFromApi(presence?: Pick<UserPresence, "state" | "reachability"> | null): Presence {
  if (!presence || !presence.state || presence.state === "offline") return "offline";
  if (presence.state === "dnd") return "dnd";
  if (presence.state === "invisible") return "invisible";
  if (presence.reachability === "open") return "open";
  if (presence.reachability === "focused") return "focused";
  return "around";
}

export function presenceForActiveNest(presence?: Partial<Pick<UserPresence, "state" | "reachability">> | null): {
  state: UserPresenceState;
  reachability: UserReachability;
} {
  if (presence?.state === "dnd") return { state: "dnd", reachability: "unavailable" };
  if (presence?.state === "invisible") return { state: "invisible", reachability: "unavailable" };
  const reachability = presence?.reachability;
  return {
    state: "in_nest",
    reachability: reachability === "open" || reachability === "focused" || reachability === "around" ? reachability : "around",
  };
}

export function lifecycleLabel(nest: Pick<Nest, "lifecycleState" | "type">) {
  if (nest.lifecycleState === "active") return "Live";
  if (nest.lifecycleState === "empty") return nest.type === "temporary" ? "Empty, expiring" : "Empty";
  if (nest.lifecycleState === "waiting") return "Waiting";
  if (nest.lifecycleState === "ready") return "Ready";
  if (nest.lifecycleState === "expired") return "Expired";
  if (nest.lifecycleState === "closed") return "Closed";
  return "Created";
}

export function formatRelativeTime(value?: string | null) {
  if (!value) return "";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const diffMs = timestamp - Date.now();
  const abs = Math.abs(diffMs);
  const minutes = Math.max(1, Math.round(abs / 60000));
  if (minutes < 60) return diffMs >= 0 ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return diffMs >= 0 ? `in ${hours}h` : `${hours}h ago`;
}
