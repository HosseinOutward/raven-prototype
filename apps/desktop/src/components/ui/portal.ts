import { useEffect, useState } from "react";

/**
 * Floating UI (menus, popovers, dialogs, tooltips) is portalled to <body>, which
 * the browser hides while an element is fullscreen. Portal into the fullscreen
 * element instead so controls keep working over a fullscreen stage or tile.
 */
export function useFullscreenContainer() {
  const [container, setContainer] = useState<HTMLElement | undefined>(() => currentFullscreenElement());

  useEffect(() => {
    const sync = () => setContainer(currentFullscreenElement());
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  return container;
}

function currentFullscreenElement() {
  if (typeof document === "undefined") return undefined;
  return document.fullscreenElement instanceof HTMLElement ? document.fullscreenElement : undefined;
}
