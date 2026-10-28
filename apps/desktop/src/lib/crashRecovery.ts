/**
 * Getting back into a call after the window's page was reloaded under it.
 *
 * The page owns the call: when it is lost (a render error at the root, or the WebView2
 * renderer dying, see `diagnostics.rs`) the call ends with it. Session storage outlives a
 * reload of the same window but not a restart of the app, so a Nest recorded here on load
 * means "this window was in that call a moment ago".
 */

const ACTIVE_NEST_KEY = "raven.activeNest";
const AUTO_RELOAD_KEY = "raven.autoReloadAt";
/** A second automatic reload this soon after the first would be a loop: stop and ask. */
const AUTO_RELOAD_COOLDOWN_MS = 60_000;

function read(key: string) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // Storage unavailable: recovery just will not rejoin.
  }
}

// Taken once, before the app mounts and starts recording its own (empty) state.
const nestToRejoin = read(ACTIVE_NEST_KEY);

/** The Nest this window was in before it reloaded, if any. Returns it only once. */
let taken = false;
export function takeNestToRejoin(): string | null {
  if (taken) return null;
  taken = true;
  return nestToRejoin;
}

/** Remember the call this window is in, so a reload can return to it. */
export function rememberActiveNest(nestId: string | null) {
  write(ACTIVE_NEST_KEY, nestId);
}

/** True when an automatic reload is allowed now; records it. */
export function claimAutoReload(now = Date.now()): boolean {
  const last = Number(read(AUTO_RELOAD_KEY) ?? 0);
  if (Number.isFinite(last) && now - last < AUTO_RELOAD_COOLDOWN_MS) return false;
  write(AUTO_RELOAD_KEY, String(now));
  return true;
}

/** Whether the window was in a call when the page went down. */
export function wasInCall() {
  return read(ACTIVE_NEST_KEY) !== null;
}
