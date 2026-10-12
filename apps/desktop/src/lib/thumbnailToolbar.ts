import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const THUMBNAIL_TOOLBAR_ACTION_EVENT = "thumbnail-toolbar-action";

export type ThumbnailToolbarAction = "mic" | "deafen" | "leave";

/** Shared by dock buttons, hotkeys, and Windows clicks to suppress duplicate work. */
export function claimThumbnailAction(
  pending: Set<ThumbnailToolbarAction>,
  action: ThumbnailToolbarAction,
): boolean {
  if (pending.has(action)) return false;
  pending.add(action);
  return true;
}

export function releaseThumbnailAction(
  pending: Set<ThumbnailToolbarAction>,
  action: ThumbnailToolbarAction,
): void {
  pending.delete(action);
}

/** Runs an action once and keeps every control disabled until it settles. */
export function runGuardedThumbnailAction(
  pending: Set<ThumbnailToolbarAction>,
  action: ThumbnailToolbarAction,
  run: () => Promise<void>,
  onPendingChange: (pending: ReadonlySet<ThumbnailToolbarAction>) => void,
): Promise<void> | null {
  if (!claimThumbnailAction(pending, action)) return null;

  const finish = () => {
    releaseThumbnailAction(pending, action);
    onPendingChange(new Set(pending));
  };
  onPendingChange(new Set(pending));

  try {
    return run().catch(() => undefined).finally(finish);
  } catch {
    finish();
    return Promise.resolve();
  }
}

export interface ThumbnailToolbarSnapshot {
  signedIn: boolean;
  micEnabled: boolean;
  micSupported: boolean;
  deafened: boolean;
  deafenSupported: boolean;
  hasMediaSession: boolean;
  busy: boolean;
  micPending: boolean;
  deafenPending: boolean;
  leavePending: boolean;
}

let revision = 0;
const generation = typeof crypto !== "undefined" && crypto.randomUUID
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random()}`;

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Disposes listeners even when an async subscription finishes after unmount. */
export function manageEventSubscription(
  subscribe: () => Promise<() => void>,
  onSubscribed: () => void,
): () => void {
  let active = true;
  let unlisten: (() => void) | undefined;
  void subscribe().then((stop) => {
    if (!active) {
      stop();
      return;
    }
    unlisten = stop;
    onSubscribed();
  }).catch(() => undefined);

  return () => {
    active = false;
    unlisten?.();
    unlisten = undefined;
  };
}

/**
 * Keeps the native Windows thumbnail controls in step with the media dock.
 * Calls from the browser preview are intentionally a no-op.
 */
export const thumbnailToolbarCommands = {
  update: (snapshot: ThumbnailToolbarSnapshot) => {
    if (!isTauriRuntime()) return Promise.resolve();
    revision += 1;
    return invoke<void>("thumbnail_toolbar_update", {
      snapshot: { ...snapshot, generation, revision },
    });
  },
};

export async function subscribeThumbnailToolbarActions(
  onAction: (action: ThumbnailToolbarAction) => void,
) {
  if (!isTauriRuntime()) return () => undefined;
  return getCurrentWindow().listen<ThumbnailToolbarAction>(
    THUMBNAIL_TOOLBAR_ACTION_EVENT,
    (event) => onAction(event.payload),
  );
}
