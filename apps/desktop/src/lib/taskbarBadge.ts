import { Image } from "@tauri-apps/api/image";
import { getCurrentWindow } from "@tauri-apps/api/window";

// A small dot on Raven's taskbar icon while there is something unread. It is a dot and
// not a number on purpose: it says "there is something", not "you are this far behind".
//
// Windows only. Linux launchers offer a numeric badge that depends on the desktop
// environment, which is neither a dot nor reliable, so nothing is shown there.

const SIZE = 32;

/** A light dot with a dark edge, so it reads on a light or a dark taskbar. */
function dotPixels(): Uint8Array {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  const centre = (SIZE - 1) / 2;
  const outer = SIZE / 2 - 1;
  const inner = outer - 3;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const distance = Math.hypot(x - centre, y - centre);
      if (distance > outer) continue;
      const offset = (y * SIZE + x) * 4;
      const edge = distance > inner;
      pixels[offset] = edge ? 20 : 241;
      pixels[offset + 1] = edge ? 19 : 239;
      pixels[offset + 2] = edge ? 18 : 234;
      // Soften the outermost pixel so the circle is not jagged.
      pixels[offset + 3] = distance > outer - 1 ? Math.round(255 * (outer - distance)) : 255;
    }
  }
  return pixels;
}

let wanted = false;
let shown: boolean | null = null;
let applying: Promise<void> | null = null;

/**
 * Shows or clears the unread dot. Safe to call often; it only acts on a change.
 *
 * Changes are applied one at a time, always to the latest wanted state. Showing the dot
 * takes two round trips (make the image, then set it), so without this a quick
 * show-then-clear could finish in the wrong order and leave the dot up with nothing unread.
 */
export function setTaskbarUnread(unread: boolean): Promise<void> {
  wanted = unread;
  if (!applying && shown === wanted) return Promise.resolve();
  applying ??= apply();
  return applying;
}

async function apply(): Promise<void> {
  while (shown !== wanted) {
    const unread = wanted;
    try {
      const appWindow = getCurrentWindow();
      if (unread) {
        await appWindow.setOverlayIcon(await Image.new(dotPixels(), SIZE, SIZE));
      } else {
        await appWindow.setOverlayIcon(undefined);
      }
    } catch {
      // Not Windows, or not running inside the desktop app.
    }
    shown = unread;
  }
  // Cleared in the same tick as the last check, so a call made after it starts a new run.
  applying = null;
}
