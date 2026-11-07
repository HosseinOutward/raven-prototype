import { useEffect, useRef, useState } from "react";

/**
 * Sign of `WheelEvent.deltaX` when two fingers move LEFT on a touchpad.
 * Chromium/WebView2 on Windows precision touchpads report a rightward scroll (positive
 * deltaX) when the fingers move left under the default natural-scrolling setting, so this
 * is +1. It is not measured: confirm on Soroush's laptop (log `deltaX` during a swipe left)
 * and flip it to -1 if the row slides the wrong way.
 */
export const FINGERS_LEFT_DELTA_X = 1;

/** Pull (px of finger travel) at which letting go replies. */
export const SWIPE_THRESHOLD = 56;
/** The row never slides further than this. */
export const SWIPE_MAX_SLIDE = 72;
/** Quiet time that ends a touchpad gesture. */
export const WHEEL_IDLE_MS = 120;
/** Travel before a touch or pen drag is taken over from the browser. */
const TOUCH_SLOP = 10;
/** A gesture is horizontal when |dx| beats |dy| by this factor. */
const HORIZONTAL_RATIO = 1.5;
const RESISTANCE = 0.25;

/** How far the row slides for a given pull: 1:1 up to the threshold, then with resistance. */
export function slideFor(pull: number): number {
  if (pull <= SWIPE_THRESHOLD) return Math.max(0, pull);
  return Math.min(SWIPE_MAX_SLIDE, SWIPE_THRESHOLD + (pull - SWIPE_THRESHOLD) * RESISTANCE);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (event: any) => void;
/** The part of an element the controller needs; a real HTMLElement satisfies it. */
export interface SwipeTarget {
  addEventListener(type: string, listener: Listener, options?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, listener: Listener, options?: AddEventListenerOptions | boolean): void;
  setPointerCapture?(pointerId: number): void;
}

export interface SwipeOptions {
  /** Read at the start of each gesture, so a row can turn the gesture off (selection mode, no Reply). */
  enabled: () => boolean;
  onReply: () => void;
  /** Called with the slide in px and whether letting go now would reply. Not React state. */
  onProgress: (slide: number, armed: boolean) => void;
  /** Called when the gesture ends, after any reply. */
  onEnd: () => void;
}

/**
 * True when `node` or an ancestor below `root` can still scroll sideways in the direction
 * of the gesture (a long code line), so the gesture belongs to it.
 * `dir` is +1 for content moving right to left (scrollLeft grows).
 */
export function scrollsSideways(node: unknown, root: unknown, dir: number): boolean {
  let current = node as (Element & { parentElement: Element | null }) | null;
  while (current && current !== root) {
    if (typeof current.scrollWidth === "number" && current.scrollWidth > current.clientWidth + 1) {
      const overflow = typeof getComputedStyle === "function" ? getComputedStyle(current).overflowX : "";
      if (overflow === "auto" || overflow === "scroll") {
        const atEnd = current.scrollLeft + current.clientWidth >= current.scrollWidth - 1;
        const atStart = current.scrollLeft <= 0;
        if (dir > 0 ? !atEnd : !atStart) return true;
      }
    }
    current = current.parentElement;
  }
  return false;
}

/** Wires the gesture onto `el`. Returns the detach function. */
export function attachSwipeToReply(el: SwipeTarget, options: SwipeOptions): () => void {
  let pull = 0;
  let armed = false;
  // Wheel gestures: undefined until the first event decides, then swipe or ignore until quiet.
  let wheelMode: "swipe" | "ignore" | undefined;
  let wheelTimer: ReturnType<typeof setTimeout> | undefined;
  // Pointer gestures.
  let pointer: { id: number; x: number; y: number; captured: boolean; ignored: boolean } | undefined;

  const show = () => {
    armed = pull >= SWIPE_THRESHOLD;
    options.onProgress(slideFor(pull), armed);
  };
  const finish = () => {
    const replies = armed;
    pull = 0;
    armed = false;
    wheelMode = undefined;
    pointer = undefined;
    if (replies) options.onReply();
    options.onEnd();
  };

  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey) return;
    if (wheelMode === undefined) {
      const horizontal = Math.abs(event.deltaX) > HORIZONTAL_RATIO * Math.abs(event.deltaY);
      wheelMode = horizontal && options.enabled() && !scrollsSideways(event.target, el, Math.sign(event.deltaX)) ? "swipe" : "ignore";
    }
    if (wheelMode === "ignore") {
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => { wheelMode = undefined; }, WHEEL_IDLE_MS);
      return;
    }
    if (Math.abs(event.deltaX) > HORIZONTAL_RATIO * Math.abs(event.deltaY)) {
      event.preventDefault();
      pull = Math.max(0, pull + event.deltaX * FINGERS_LEFT_DELTA_X);
      show();
    }
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(finish, WHEEL_IDLE_MS);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" || event.button > 0) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, captured: false, ignored: !options.enabled() };
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!pointer || pointer.id !== event.pointerId || pointer.ignored) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (!pointer.captured) {
      if (Math.abs(dx) < TOUCH_SLOP && Math.abs(dy) < TOUCH_SLOP) return;
      // The first clear movement decides: leftwards and mostly horizontal, or not ours.
      if (dx >= 0 || Math.abs(dx) <= HORIZONTAL_RATIO * Math.abs(dy) || scrollsSideways(event.target, el, 1)) {
        pointer.ignored = true;
        return;
      }
      pointer.captured = true;
      el.setPointerCapture?.(event.pointerId);
    }
    pull = Math.max(0, -dx);
    show();
  };
  const onPointerEnd = (event: PointerEvent) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const captured = pointer.captured;
    pointer = undefined;
    if (captured) finish();
  };

  el.addEventListener("wheel", onWheel as Listener, { passive: false });
  el.addEventListener("pointerdown", onPointerDown as Listener);
  el.addEventListener("pointermove", onPointerMove as Listener);
  el.addEventListener("pointerup", onPointerEnd as Listener);
  el.addEventListener("pointercancel", onPointerEnd as Listener);
  return () => {
    clearTimeout(wheelTimer);
    el.removeEventListener("wheel", onWheel as Listener, { passive: false });
    el.removeEventListener("pointerdown", onPointerDown as Listener);
    el.removeEventListener("pointermove", onPointerMove as Listener);
    el.removeEventListener("pointerup", onPointerEnd as Listener);
    el.removeEventListener("pointercancel", onPointerEnd as Listener);
  };
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/**
 * Swipe a message row left to reply. Attach `rowRef` to the element that slides and
 * `arrowRef` to the reply arrow at its end edge; `armed` is true once letting go replies.
 * Transforms are written straight to the elements; state changes only at the threshold.
 */
export function useSwipeToReply({ disabled, onReply }: { disabled: boolean; onReply: () => void }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLSpanElement>(null);
  const [armed, setArmed] = useState(false);
  const latest = useRef({ disabled, onReply });
  latest.current = { disabled, onReply };

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const arrow = arrowRef.current;
    return attachSwipeToReply(row, {
      enabled: () => !latest.current.disabled,
      onReply: () => latest.current.onReply(),
      onProgress: (slide, isArmed) => {
        const move = prefersReducedMotion() ? 0 : slide;
        row.style.transition = "none";
        row.style.transform = move ? `translateX(${-move}px)` : "";
        if (arrow) {
          const progress = Math.min(1, slide / SWIPE_THRESHOLD);
          arrow.style.transition = "none";
          arrow.style.opacity = String(progress);
          arrow.style.transform = `scale(${0.6 + 0.4 * progress})`;
        }
        setArmed((was) => (was === isArmed ? was : isArmed));
      },
      onEnd: () => {
        row.style.transition = prefersReducedMotion() ? "" : "transform 150ms ease-out";
        row.style.transform = "";
        if (arrow) {
          arrow.style.transition = prefersReducedMotion() ? "" : "opacity 150ms ease-out, transform 150ms ease-out";
          arrow.style.opacity = "0";
          arrow.style.transform = "scale(0.6)";
        }
        setArmed(false);
      },
    });
  }, []);

  return { rowRef, arrowRef, armed };
}
