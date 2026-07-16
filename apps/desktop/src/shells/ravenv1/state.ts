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
} from "@/lib/api";

export type Presence = "open" | "around" | "focused" | "dnd" | "invisible";

export const PRESENCE: Record<Presence, { label: string; h: string }> = {
  open: { label: "Open to talk", h: "150 46% 52%" },
  around: { label: "Around", h: "234 40% 66%" },
  focused: { label: "Focused", h: "38 82% 58%" },
  dnd: { label: "Do not disturb", h: "356 62% 60%" },
  invisible: { label: "Invisible", h: "34 8% 48%" },
};

export type RavenView =
  | { kind: "home" }
  | { kind: "tree"; id: string }
  | { kind: "tree-preview"; result: TreeSearchResult }
  | { kind: "tree-settings"; id: string }
  | { kind: "user"; id: string; person?: ShellPerson }
  | { kind: "waiting"; id: string }
  | { kind: "nest"; id: string }
  | { kind: "settings" };

export interface ShellPerson {
  id: string;
  name: string;
  presence: Presence;
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
  loading: boolean;
  busy: boolean;
  error: string;
  serverUnreachable: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
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
  acceptTreeJoinRequest: (treeId: string, requestId: string) => Promise<void>;
  rejectTreeJoinRequest: (treeId: string, requestId: string) => Promise<void>;
  sendFriendRequest: (userId: string) => Promise<void>;
  acceptFriendRequest: (requestId: string) => Promise<void>;
  declineFriendRequest: (requestId: string) => Promise<void>;
  cancelFriendRequest: (requestId: string) => Promise<void>;
  removeFriend: (userId: string) => Promise<void>;
  setPresence: (presence: Presence) => Promise<void>;
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

export function presenceFromApi(presence?: UserPresence | null): Presence {
  if (!presence) return "invisible";
  if (presence.state === "dnd") return "dnd";
  if (presence.state === "invisible" || presence.state === "offline") return "invisible";
  if (presence.reachability === "open") return "open";
  if (presence.reachability === "focused") return "focused";
  return "around";
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
