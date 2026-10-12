export type UserRole = "admin" | "user";
export type NestStatus = "active" | "ended";
export type NestType = "persistent" | "temporary";
export type NestRole = "creator" | "moderator" | "participant";
export type MembershipState = "invited" | "joined" | "left" | "removed";
export type JoinRequestStatus = "pending" | "accepted" | "rejected" | "cancelled";
export type TreeJoinPolicy = "free" | "request";
export type TreeVisibility = "public" | "private";
export type UILabelPreference = "tree_nest" | "space_room";

export interface RavenUserPreferences {
  displayName: string;
  uiLabels: UILabelPreference;
  colorPalette: "raven_dark";
  colorPaletteEnabled: boolean;
  alwaysJoinMuted: boolean;
  joinWithCameraOff: boolean;
  joinWithoutScreenSharing: boolean;
  updatedAt: string;
}

export interface RavenUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  preferences: RavenUserPreferences;
  createdAt: string;
  updatedAt: string;
}

export interface RavenServerProperties {
  name: string;
  description: string;
  avatar: string;
  rtcServerUrl: string;
  properties: Record<string, unknown>;
}

export interface RavenNest {
  id: string;
  name: string;
  joinCode: string;
  creatorUserId: string;
  type: NestType;
  status: NestStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  endedAt?: string | null;
  lastActivityAt: string;
  shareableLink: string;
  httpLink: string;
}

export interface RavenParticipantSummary {
  userId: string;
  username: string;
  displayName: string;
  joinedAt: string;
}

export interface RavenSessionSummary {
  id: string;
  nestId: string;
  startedAt: string;
  endedAt?: string | null;
  durationSeconds?: number | null;
  status: NestStatus;
  participants: RavenParticipantSummary[];
}

export interface RavenLauncherNest extends RavenNest {
  active: boolean;
  activeParticipantCount: number;
  currentParticipants: RavenParticipantSummary[];
  currentSessionStartedAt?: string | null;
  currentSessionId?: string | null;
}
