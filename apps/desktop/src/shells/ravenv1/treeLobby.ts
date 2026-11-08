import type { TreeMember, TreeVisibility } from "@/lib/api";
import { displayNameFor, presenceFromApi } from "./state";

export type CreateChoice = "voice" | "text" | "category";
export type MoreChoice = "arrange" | "addPerson";

/**
 * What the lobby header offers. Creating things needs `rooms.manage`, adding a person needs
 * `members.manage`: they are separate permissions, so neither hides the other's entry.
 * Text nests, categories and arranging only exist when the server has chat.
 */
export function lobbyMenus({ canRooms, canMembers, hasChat }: { canRooms: boolean; canMembers: boolean; hasChat: boolean }): { create: CreateChoice[]; more: MoreChoice[] } {
  const create: CreateChoice[] = canRooms ? (hasChat ? ["voice", "text", "category"] : ["voice"]) : [];
  const more: MoreChoice[] = [];
  if (canRooms && hasChat) more.push("arrange");
  if (canMembers) more.push("addPerson");
  return { create, more };
}

/** The header's one line, in parts so the member count can be a button on a narrow window. */
export function treeSubtitleParts({ visibility, members, inside, nestSingular }: { visibility: TreeVisibility; members: number; inside: number; nestSingular: string }) {
  return {
    visibility: visibility === "public" ? "Public" : "Private",
    members: `${members} ${members === 1 ? "member" : "members"}`,
    inside: inside > 0 ? `${inside} in a ${nestSingular}` : null,
  };
}

export type MemberGroups = { here: TreeMember[]; online: TreeMember[]; offline: TreeMember[] };

function rank(member: TreeMember) {
  const presence = presenceFromApi({ state: member.presenceState, reachability: member.reachability });
  if (presence === "open") return 0;
  if (presence === "around") return 1;
  if (presence === "focused") return 2;
  return 3;
}

/** People in a nest, then people who are online, then everyone who is away. */
export function groupMembers(members: readonly TreeMember[]): MemberGroups {
  const sorted = [...members].sort((a, b) => rank(a) - rank(b) || displayNameFor(a).localeCompare(displayNameFor(b)));
  const groups: MemberGroups = { here: [], online: [], offline: [] };
  for (const member of sorted) {
    const presence = presenceFromApi({ state: member.presenceState, reachability: member.reachability });
    const away = presence === "offline" || presence === "invisible";
    if (away) groups.offline.push(member);
    else if (member.activeNestId) groups.here.push(member);
    else groups.online.push(member);
  }
  return groups;
}
