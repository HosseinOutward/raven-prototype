import type { VideoParticipantState } from "@/lib/video";

export interface WatchPerson {
  participantId: string;
  displayName: string;
}

/** A share someone is watching; `isLocal` when it is yours. */
export interface WatchTarget {
  participantId: string;
  displayName: string;
  isLocal: boolean;
}

/** People other than the sharer who are watching this person's screen, by name. */
export function watchersOfShare(participants: readonly VideoParticipantState[], sharerId: string): WatchPerson[] {
  return participants
    .filter((person) => !person.isLocal && person.participantId !== sharerId && person.watching?.includes(sharerId))
    .map((person) => ({ participantId: person.participantId, displayName: person.displayName || person.participantId }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

/** The shares one person is watching, for those who are in the room. */
export function sharesWatchedBy(participants: readonly VideoParticipantState[], participantId: string): WatchTarget[] {
  const person = participants.find((candidate) => candidate.participantId === participantId);
  if (!person || person.isLocal) return [];
  const targets: WatchTarget[] = [];
  for (const sharerId of person.watching ?? []) {
    const sharer = participants.find((candidate) => candidate.participantId === sharerId);
    if (!sharer) continue;
    targets.push({ participantId: sharerId, displayName: sharer.displayName || sharerId, isLocal: sharer.isLocal });
  }
  return targets.sort((left, right) => Number(right.isLocal) - Number(left.isLocal) || left.displayName.localeCompare(right.displayName));
}

/** "Watching your screen", "Watching Sara’s screen", "Watching your and Sara’s screens". */
export function watchingTooltip(targets: readonly WatchTarget[]): string {
  if (targets.length === 0) return "";
  const names = targets.map((target) => (target.isLocal ? "your" : `${target.displayName}’s`));
  const screens = names.length === 1 ? "screen" : "screens";
  const list = names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Watching ${list} ${screens}`;
}

/** The names on a share's avatar stack: "Sara, Omid and 2 others are watching". */
export function watchersTooltip(watchers: readonly WatchPerson[]): string {
  if (watchers.length === 0) return "";
  const names = watchers.map((watcher) => watcher.displayName);
  const verb = names.length === 1 ? "is" : "are";
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  const list = rest > 0
    ? `${shown.join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}`
    : shown.length <= 2
      ? shown.join(" and ")
      : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  return `${list} ${verb} watching`;
}

/** How many faces to draw before "+N". */
export const WATCHER_STACK_LIMIT = 3;

export function splitWatcherStack<T>(watchers: readonly T[], limit = WATCHER_STACK_LIMIT): { shown: T[]; extra: number } {
  // A "+1" chip is no smaller than the face it hides.
  if (watchers.length <= limit + 1) return { shown: [...watchers], extra: 0 };
  return { shown: watchers.slice(0, limit), extra: watchers.length - limit };
}
