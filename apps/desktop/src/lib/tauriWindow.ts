import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { studioRoutePath } from "@/lib/route";

/**
 * Opens a joined nest in a dedicated OS window.
 *
 * TODO: Full implementation requires URL-based routing so the new window can
 * receive the nest ID and auto-join. Current setup loads the main app from
 * scratch (the user would need to sign in and navigate to the nest manually).
 *
 * To complete this feature:
 *   1. Add hash or query-param routing (e.g. `/#/nest/<nestId>`)
 *   2. Read the route on startup and call `api.getNest()` + auto-select
 *   3. Pass the target URL here instead of "/"
 */
export async function openNestInWindow(nestId: string, nestName: string): Promise<void> {
  const label = `nest-window-${nestId.replace(/[^a-z0-9-]/gi, "-")}`;
  try {
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      await existing.setFocus();
      return;
    }
    const webview = new WebviewWindow(label, {
      url: "/",
      title: `${nestName} — Raven`,
      width: 1280,
      height: 820,
      minWidth: 980,
      minHeight: 700,
      resizable: true,
      center: true,
    });
    webview.once("tauri://error", (e) => {
      console.error("[Raven] Could not open nest window:", e);
    });
  } catch (err) {
    console.error("[Raven] openNestInWindow failed:", err);
  }
}

/**
 * Opens the audio Studio (Sources & Mixer console) for a nest in its own OS window.
 *
 * Loads `/#/studio/<nestId>`, which `main.tsx` resolves to a standalone Studio view.
 * The mixer drives global Rust audio state, so the console controls the same audio
 * engine as the main window; the main window must stay open + RTC-connected for any
 * "publish" action to actually reach LiveKit.
 */
export async function openStudioInWindow(nestId: string, nestName: string): Promise<void> {
  const label = `studio-window-${nestId.replace(/[^a-z0-9-]/gi, "-")}`;
  try {
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      await existing.setFocus();
      return;
    }
    const webview = new WebviewWindow(label, {
      url: studioRoutePath(nestId),
      title: `${nestName} — Studio`,
      width: 1180,
      height: 760,
      minWidth: 880,
      minHeight: 560,
      resizable: true,
      center: true,
    });
    webview.once("tauri://error", (e) => {
      console.error("[Raven] Could not open studio window:", e);
    });
  } catch (err) {
    console.error("[Raven] openStudioInWindow failed:", err);
  }
}
