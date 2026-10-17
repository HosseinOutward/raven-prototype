import { useSyncExternalStore } from "react";

/**
 * The newest known version of each person's picture. The server sends `profile.avatar`
 * when someone changes theirs, and your own upload records it here at once. Avatar URLs
 * carry the version, so a mounted picture switches as soon as this changes, and the
 * server can let a versioned URL be cached for good.
 */
const versions = new Map<string, string>();
const listeners = new Set<() => void>();
let revision = 0;

const USER_AVATAR_PATH = /\/v1\/media\/users\/([^/?#]+)\/avatar(?:\?[^#]*)?$/;

export function avatarVersion(userId: string): string {
  return versions.get(userId) ?? "";
}

export function noteAvatarVersion(userId: string, version: string) {
  if (!userId || !version || versions.get(userId) === version) return;
  versions.set(userId, version);
  revision += 1;
  for (const listener of listeners) listener();
}

/** Records the version in a route the server answered with, such as an upload's. */
export function noteAvatarRoute(route: string) {
  const match = USER_AVATAR_PATH.exec(route);
  if (!match) return;
  const version = new URLSearchParams(route.split("?")[1] ?? "").get("v") ?? "";
  noteAvatarVersion(decodeURIComponent(match[1]), version);
}

/**
 * Gives a person's avatar URL the newest known version. A version recorded here was
 * learned after the page's data was loaded, so it wins over the one in the URL. Other
 * URLs are returned unchanged.
 */
export function freshAvatarSrc(src: string): string {
  const match = USER_AVATAR_PATH.exec(src);
  if (!match) return src;
  const version = versions.get(decodeURIComponent(match[1]));
  if (!version) return src;
  return `${src.slice(0, match.index)}/v1/media/users/${match[1]}/avatar?v=${encodeURIComponent(version)}`;
}

export function subscribeAvatarVersions(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function currentRevision() {
  return revision;
}

/** Re-renders the caller whenever any known picture changes. */
export function useAvatarVersions(): number {
  return useSyncExternalStore(subscribeAvatarVersions, currentRevision, currentRevision);
}

/** Forgets every version, for signing out. */
export function clearAvatarVersions() {
  if (versions.size === 0) return;
  versions.clear();
  revision += 1;
  for (const listener of listeners) listener();
}
