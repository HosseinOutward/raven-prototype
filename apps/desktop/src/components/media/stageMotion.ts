import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Matches `animate-pop-out`; the departing entry is dropped just after it ends. */
export const LEAVE_MS = 170;
/** Long enough for `animate-pop-in` / `animate-fade-in` to finish once. */
export const ENTER_MS = 400;

export type MotionPhase = "idle" | "enter" | "leave";
export type MotionEntry<T> = { key: string; item: T; phase: MotionPhase };

type Ghost<T, C extends string> = { container: C; item: T; index: number; until: number };
type Entering<C extends string> = { container: C; until: number };

export type StageMotionMemory<T, C extends string> = {
  /** What was drawn last time, real items only. Null until the first render. */
  previous: Record<C, readonly T[]> | null;
  ghosts: ReadonlyMap<string, Ghost<T, C>>;
  entering: ReadonlyMap<string, Entering<C>>;
};

export function emptyStageMotionMemory<T, C extends string>(): StageMotionMemory<T, C> {
  return { previous: null, ghosts: new Map(), entering: new Map() };
}

/**
 * Who arrived and who left since the last render, across every container of the
 * stage at once, so a person moving from the voice room to a tile is a move rather
 * than a leave and a join.
 *
 * - Nothing moves until `armed` (the stage has settled after you joined or the
 *   connection came back); while disarmed every change simply happens.
 * - Something new to the stage enters. A move into a container listed in `moveIn`
 *   enters too (a camera turning on fades in as a tile); other moves do not.
 * - Something gone from the stage stays in its old place as a "leave" entry for
 *   `LEAVE_MS`. If it returns meanwhile, the exit is cancelled and it just stays.
 */
export function computeStageMotion<T, C extends string>({
  memory,
  lists,
  keyOf,
  armed,
  now,
  moveIn = [],
}: {
  memory: StageMotionMemory<T, C>;
  lists: Record<C, readonly T[]>;
  keyOf: (item: T) => string;
  armed: boolean;
  now: number;
  moveIn?: readonly C[];
}): { entries: Record<C, MotionEntry<T>[]>; memory: StageMotionMemory<T, C> } {
  const containers = Object.keys(lists) as C[];
  const currentAll = new Set<string>();
  for (const container of containers) for (const item of lists[container]) currentAll.add(keyOf(item));

  const ghosts = new Map<string, Ghost<T, C>>();
  const entering = new Map<string, Entering<C>>();
  const previous = memory.previous;

  if (armed && previous) {
    const previousAll = new Set<string>();
    const previousIn = {} as Record<C, Set<string>>;
    for (const container of containers) {
      previousIn[container] = new Set((previous[container] ?? []).map(keyOf));
      for (const key of previousIn[container]) previousAll.add(key);
    }

    for (const [key, ghost] of memory.ghosts) {
      if (ghost.until > now && !currentAll.has(key)) ghosts.set(key, ghost);
    }
    for (const [key, enter] of memory.entering) {
      if (enter.until > now && currentAll.has(key)) entering.set(key, enter);
    }
    for (const container of containers) {
      for (const item of lists[container]) {
        const key = keyOf(item);
        if (previousIn[container].has(key) || entering.has(key)) continue;
        // Back while its exit was playing: the exit is cancelled, nothing replays.
        if (memory.ghosts.has(key) && memory.ghosts.get(key)!.until > now) continue;
        const isNew = !previousAll.has(key);
        if (isNew || moveIn.includes(container)) entering.set(key, { container, until: now + ENTER_MS });
      }
      (previous[container] ?? []).forEach((item, index) => {
        const key = keyOf(item);
        if (currentAll.has(key) || ghosts.has(key)) return;
        ghosts.set(key, { container, item, index, until: now + LEAVE_MS });
      });
    }
  }

  const entries = {} as Record<C, MotionEntry<T>[]>;
  for (const container of containers) {
    const list: MotionEntry<T>[] = lists[container].map((item) => {
      const key = keyOf(item);
      return { key, item, phase: entering.get(key)?.container === container ? "enter" : "idle" };
    });
    const leaving = [...ghosts.entries()]
      .filter(([, ghost]) => ghost.container === container)
      .sort(([, a], [, b]) => a.index - b.index);
    for (const [key, ghost] of leaving) {
      list.splice(Math.min(ghost.index, list.length), 0, { key, item: ghost.item, phase: "leave" });
    }
    entries[container] = list;
  }

  return { entries, memory: { previous: lists, ghosts, entering } };
}

/**
 * `computeStageMotion` for a component: the "leaving" list lives here, in the
 * component, never in shared state. With reduced motion nothing is kept back, so
 * a departure closes the gap at once.
 */
export function useStageMotion<T, C extends string>(
  lists: Record<C, readonly T[]>,
  keyOf: (item: T) => string,
  armed: boolean,
  moveIn?: readonly NoInfer<C>[],
) {
  const memoryRef = useRef<StageMotionMemory<T, C>>(emptyStageMotionMemory());
  const [tick, setTick] = useState(0);
  const reducedMotion = usePrefersReducedMotion();
  const { entries, memory } = computeStageMotion({
    memory: memoryRef.current,
    lists,
    keyOf,
    armed: armed && !reducedMotion,
    now: Date.now(),
    moveIn,
  });

  useLayoutEffect(() => {
    memoryRef.current = memory;
  });

  const nextExpiry = Math.min(...[...memory.ghosts.values()].map((ghost) => ghost.until));
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(() => setTick((value) => value + 1), Math.max(0, nextExpiry - Date.now()) + 16);
    return () => window.clearTimeout(timer);
  }, [nextExpiry, tick]);

  return entries;
}

/**
 * True once the stage has been connected for `settleMs`: what arrives in that window
 * was already there when you joined (or came back after a reconnect) and just appears.
 */
export function useMotionArmed(ready: boolean, settleMs: number) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!ready) {
      setArmed(false);
      return;
    }
    const timer = window.setTimeout(() => setArmed(true), settleMs);
    return () => window.clearTimeout(timer);
  }, [ready, settleMs]);
  return ready && armed;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => reducedMotionQuery()?.matches ?? false);
  useEffect(() => {
    const query = reducedMotionQuery();
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function reducedMotionQuery() {
  return typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
}

/** The animation class for an entry; `enter` names the arrival token for its place. */
export function motionClass(phase: MotionPhase, enter: "animate-pop-in" | "animate-fade-in") {
  if (phase === "enter") return enter;
  if (phase === "leave") return "pointer-events-none animate-pop-out";
  return undefined;
}
