/**
 * Minimal hash-based routing for the desktop app.
 *
 * The main window loads at `/` (route `{ kind: "app" }`). Secondary OS windows
 * (e.g. the audio Studio) are opened at `/#/studio/<nestId>` so they can render a
 * dedicated standalone view instead of the full launcher. Auth is shared across
 * same-origin Tauri webviews via `localStorage`, so these windows boot signed in.
 */

export type Route =
  | { kind: "app" }
  | { kind: "studio"; nestId: string }
  | { kind: "overlay" };

export function parseRoute(hash: string = window.location.hash): Route {
  // Accept "#/studio/<id>" or "#studio/<id>"; tolerate a trailing slash.
  const normalized = hash.replace(/^#\/?/, "").replace(/\/$/, "");
  const studioMatch = normalized.match(/^studio\/(.+)$/);
  if (studioMatch) {
    return { kind: "studio", nestId: decodeURIComponent(studioMatch[1]) };
  }
  if (normalized === "overlay") {
    return { kind: "overlay" };
  }
  return { kind: "app" };
}

export function studioRoutePath(nestId: string): string {
  return `/#/studio/${encodeURIComponent(nestId)}`;
}

export function overlayRoutePath(): string {
  return "/#/overlay";
}
