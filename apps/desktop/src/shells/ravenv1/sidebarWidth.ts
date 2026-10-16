import { useEffect, useState } from "react";

export const SIDEBAR_DEFAULT_WIDTH = 256;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 400;
export const SIDEBAR_RAIL_WIDTH = 60;
// Released narrower than this, the sidebar becomes the rail.
export const SIDEBAR_SNAP_WIDTH = 160;
export const SIDEBAR_KEY_STEP = 16;
// The main panel stays at least this wide, beside the shell's 8px right gutter.
const MAIN_PANEL_MIN_WIDTH = 600;
const SHELL_GUTTER = 8;

const STORAGE_KEY = "raven.sidebarWidth";

export function sidebarMaxWidth(windowWidth: number) {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.floor(windowWidth - MAIN_PANEL_MIN_WIDTH - SHELL_GUTTER)));
}

export function clampSidebarWidth(width: number, maxWidth: number) {
  return Math.round(Math.min(maxWidth, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

// Where a drag to `width` lands: the rail below the snap point, otherwise a clamped width.
export function resolveSidebarDrag(width: number, maxWidth: number, canCollapse: boolean) {
  if (canCollapse && width < SIDEBAR_SNAP_WIDTH) return { collapsed: true, width: SIDEBAR_RAIL_WIDTH };
  return { collapsed: false, width: clampSidebarWidth(width, maxWidth) };
}

export function readSidebarWidth() {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(stored) && stored >= SIDEBAR_MIN_WIDTH && stored <= SIDEBAR_MAX_WIDTH) return Math.round(stored);
  } catch {
    // Storage can be unavailable; the default width still works.
  }
  return SIDEBAR_DEFAULT_WIDTH;
}

export function writeSidebarWidth(width: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Not remembered this time; nothing else depends on it.
  }
}

// The widest the sidebar may be at the current window size. Only changes (and re-renders)
// when the window is narrow enough for the cap to matter.
export function useSidebarMaxWidth() {
  const [maxWidth, setMaxWidth] = useState(() => sidebarMaxWidth(window.innerWidth));
  useEffect(() => {
    const update = () => setMaxWidth(sidebarMaxWidth(window.innerWidth));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return maxWidth;
}
