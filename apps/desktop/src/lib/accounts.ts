/**
 * Saved sign-ins: several server + user pairs the person can switch between.
 *
 * The list holds only live sessions. Whatever ends the active session (sign out, an expiry)
 * drops that account, so a saved entry is always one a click away from being usable.
 * `raven.apiServerUrl` and `raven.sessionId` stay the *active* pointers; this list is the rest.
 */

export type SavedAccount = {
  /** Normalized, as `normalizeApiServerUrl` returns it. */
  serverUrl: string;
  sessionId: string;
  userId: string;
  username: string;
  displayName: string;
  serverName: string;
  lastUsedAt: number;
};

/** The host of a server address, for showing it short. */
export function hostOf(url: string) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export const ACCOUNTS_KEY = "raven.accounts";

type AccountStorage = Pick<Storage, "getItem" | "setItem">;

const STRING_FIELDS = ["serverUrl", "sessionId", "userId", "username", "displayName", "serverName"] as const;

function isAccount(value: unknown): value is SavedAccount {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return STRING_FIELDS.every((field) => typeof candidate[field] === "string")
    && typeof candidate.serverUrl === "string" && candidate.serverUrl !== ""
    && typeof candidate.sessionId === "string" && candidate.sessionId !== ""
    && typeof candidate.userId === "string" && candidate.userId !== ""
    && typeof candidate.lastUsedAt === "number" && Number.isFinite(candidate.lastUsedAt);
}

/** Reads the saved list. Malformed entries are dropped; never throws. */
export function readAccounts(storage: AccountStorage): SavedAccount[] {
  try {
    const raw = storage.getItem(ACCOUNTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isAccount) : [];
  } catch {
    return [];
  }
}

export function writeAccounts(storage: AccountStorage, list: SavedAccount[]) {
  try {
    storage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable: the switcher just will not remember accounts.
  }
}

/**
 * Adds or replaces an account; identity is server + user. `replacedSessionId` is the old
 * session id when the match carried a different one, so the caller can sign it out.
 */
export function upsertAccount(list: SavedAccount[], entry: SavedAccount) {
  const index = list.findIndex((item) => item.serverUrl === entry.serverUrl && item.userId === entry.userId);
  if (index < 0) return { list: [...list, entry], replacedSessionId: undefined as string | undefined };
  const previous = list[index];
  const next = [...list];
  next[index] = entry;
  return {
    list: next,
    replacedSessionId: previous.sessionId !== entry.sessionId ? previous.sessionId : undefined,
  };
}

export function removeBySession(list: SavedAccount[], serverUrl: string, sessionId: string) {
  return list.filter((item) => !(item.serverUrl === serverUrl && item.sessionId === sessionId));
}

/** Active account first, then most recently used. */
export function sortForMenu(list: SavedAccount[], activeServerUrl: string, activeSessionId: string) {
  const isActive = (item: SavedAccount) => item.serverUrl === activeServerUrl && item.sessionId === activeSessionId;
  return [...list].sort((a, b) => {
    if (isActive(a) !== isActive(b)) return isActive(a) ? -1 : 1;
    return b.lastUsedAt - a.lastUsedAt;
  });
}
