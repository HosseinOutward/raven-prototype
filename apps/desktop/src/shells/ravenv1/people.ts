import type { UserRelationship } from "@/lib/api";
import { PRESENCE, type RavenShellData, type ShellPerson } from "./state";

export const OFFLINE_RANK = 5;

/** Lower is more reachable. Being in a nest comes first because it is joinable. */
export function reachRank(person: ShellPerson) {
  if (person.presence === "offline" || person.presence === "invisible") return OFFLINE_RANK;
  if (person.activeNestIds.length > 0) return 0;
  if (person.presence === "open") return 1;
  if (person.presence === "around") return 2;
  if (person.presence === "focused") return 3;
  return 4;
}

/** The one thing worth saying about someone. "Around" needs no words. */
export function personStatus(person: ShellPerson, data: RavenShellData) {
  if (person.presence === "offline" || person.presence === "invisible") return null;
  const nest = person.activeNestIds[0] ? data.getNest(person.activeNestIds[0]) : undefined;
  if (nest) return `In ${nest.name}`;
  if (person.presence === "around") return null;
  return PRESENCE[person.presence].label;
}

/**
 * How the signed-in person stands with someone right now. It reads live data, so it stays
 * true after a request is sent or answered; a search result only knows how things stood
 * when the search ran.
 */
export function friendStanding(
  userId: string,
  data: Pick<RavenShellData, "user" | "friends" | "incomingFriendRequests" | "outgoingFriendRequests">,
): { relationship: UserRelationship; requestId?: string } {
  if (userId === data.user?.id) return { relationship: "self" };
  if (data.friends.some((friend) => friend.userId === userId)) return { relationship: "friends" };
  const incoming = data.incomingFriendRequests.find((request) => request.fromUserId === userId);
  if (incoming) return { relationship: "incoming_pending", requestId: incoming.id };
  const outgoing = data.outgoingFriendRequests.find((request) => request.toUserId === userId);
  if (outgoing) return { relationship: "outgoing_pending", requestId: outgoing.id };
  return { relationship: "none" };
}

/** Someone Raven can name but knows nothing else about: no shared tree, no friendship. */
export function strangerNamed(id: string, name: string): ShellPerson {
  return { id, name, presence: "offline", presenceUnknown: true, treeIds: [], activeNestIds: [], relationship: "context" };
}
