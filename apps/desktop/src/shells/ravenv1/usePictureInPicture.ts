import { useCallback, useEffect, useRef, useState } from "react";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { closeAllPipWindows, openPipWindow, pipKey, type PipTarget } from "@/lib/pictureInPicture";

const NONE: ReadonlySet<string> = new Set();

/**
 * The main window's list of open picture-in-picture windows. Each window reads the
 * engine by itself; the list is what the stage needs to hold those videos' places, and
 * this is what ends them with the call.
 */
export function usePictureInPicture(activeNestId: string | null, onOpenFailed: (message: string) => void) {
  const [keys, setKeys] = useState<ReadonlySet<string>>(NONE);
  const windowsRef = useRef(new Map<string, WebviewWindow>());
  const opening = useRef(new Set<string>());

  const forget = useCallback((key: string) => {
    windowsRef.current.delete(key);
    setKeys((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);

  const open = useCallback((target: PipTarget) => {
    const key = pipKey(target);
    if (windowsRef.current.has(key) || opening.current.has(key)) return;
    opening.current.add(key);
    setKeys((current) => new Set(current).add(key));
    void openPipWindow(target, windowsRef.current.size)
      .then((window) => {
        windowsRef.current.set(key, window);
        void window.once("tauri://destroyed", () => forget(key));
      })
      .catch(() => {
        forget(key);
        onOpenFailed("Could not open picture in picture. The video stays on the stage.");
      })
      .finally(() => opening.current.delete(key));
  }, [forget, onOpenFailed]);

  const close = useCallback((target: PipTarget) => {
    void windowsRef.current.get(pipKey(target))?.close().catch(() => undefined);
  }, []);

  // Leave ends the call. A rejoin keeps `activeNestId`, so the windows ride it out and say
  // "Reconnecting…". A reloaded main page has ended its call and lost its list, so anything
  // still open from before it goes too.
  useEffect(() => {
    if (activeNestId) return;
    void closeAllPipWindows();
    windowsRef.current.clear();
    setKeys(NONE);
  }, [activeNestId]);

  return { keys, open, close };
}
