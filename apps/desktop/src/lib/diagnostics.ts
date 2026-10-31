import { invoke } from "@tauri-apps/api/core";

/**
 * Write a UI error to `ui-errors.log` in the app's log directory. Best effort: logging
 * must never throw into code that is already handling an error.
 */
export function logUiError(kind: string, error: unknown, componentStack?: string | null) {
  const { message, stack } = describeError(error);
  try {
    void invoke("diagnostics_log_ui_error", {
      kind,
      message,
      stack: stack ?? null,
      componentStack: componentStack ?? null,
    }).catch(() => undefined);
  } catch {
    // Outside Tauri (a plain browser tab) there is nowhere to write.
  }
}

/** Errors that escape React entirely: event handlers, timers, rejected promises. */
export function installGlobalErrorLogging() {
  window.addEventListener("error", (event) => {
    // A browser notice, not a thrown error: the chat list measures rows in the frame they
    // change (`skipAnimationFrameInResizeObserver` in MessageList.tsx), which react-virtuoso
    // documents as producing it. Nothing breaks, so keep it out of the log.
    if (!event.error && typeof event.message === "string" && event.message.startsWith("ResizeObserver loop")) return;
    logUiError("window error", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => logUiError("unhandled rejection", event.reason));
}

function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: `${error.name}: ${error.message}`, stack: error.stack };
  if (typeof error === "string") return { message: error };
  try {
    return { message: JSON.stringify(error) ?? String(error) };
  } catch {
    return { message: String(error) };
  }
}
