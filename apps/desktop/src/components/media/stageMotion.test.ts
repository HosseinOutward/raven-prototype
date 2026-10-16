import { describe, expect, test } from "bun:test";
import { computeStageMotion, emptyStageMotionMemory, LEAVE_MS, type StageMotionMemory } from "./stageMotion";

type Lists = { voice: readonly string[]; visual: readonly string[] };

function step(memory: StageMotionMemory<string, keyof Lists>, lists: Lists, now: number, armed = true) {
  return computeStageMotion({ memory, lists, keyOf: (key) => key, armed, now, moveIn: ["visual"] });
}

function phases(entries: Record<string, { key: string; phase: string }[]>) {
  return Object.fromEntries(Object.entries(entries).map(([container, list]) => [container, list.map((entry) => `${entry.key}:${entry.phase}`)]));
}

describe("computeStageMotion", () => {
  test("nothing moves on the first render", () => {
    const first = step(emptyStageMotionMemory(), { voice: ["ava", "sam"], visual: [] }, 0);
    expect(phases(first.entries)).toEqual({ voice: ["ava:idle", "sam:idle"], visual: [] });
  });

  test("nothing moves while disarmed, and nobody is kept back", () => {
    const first = step(emptyStageMotionMemory(), { voice: ["ava"], visual: [] }, 0, false);
    const second = step(first.memory, { voice: ["sam"], visual: [] }, 10, false);
    expect(phases(second.entries)).toEqual({ voice: ["sam:idle"], visual: [] });
  });

  test("someone who joins enters; someone who leaves stays in place while leaving", () => {
    const first = step(emptyStageMotionMemory(), { voice: ["ava", "sam", "kai"], visual: [] }, 0);
    const second = step(first.memory, { voice: ["ava", "kai", "mina"], visual: [] }, 10);
    expect(phases(second.entries).voice).toEqual(["ava:idle", "sam:leave", "kai:idle", "mina:enter"]);

    const gone = step(second.memory, { voice: ["ava", "kai", "mina"], visual: [] }, 10 + LEAVE_MS + 1);
    expect(phases(gone.entries).voice).toEqual(["ava:idle", "kai:idle", "mina:enter"]);
  });

  test("moving between voice and video is not a leave", () => {
    const first = step(emptyStageMotionMemory(), { voice: ["ava", "sam"], visual: [] }, 0);
    const camera = step(first.memory, { voice: ["sam"], visual: ["ava"] }, 10);
    expect(phases(camera.entries)).toEqual({ voice: ["sam:idle"], visual: ["ava:enter"] });

    const off = step(camera.memory, { voice: ["sam", "ava"], visual: [] }, 20);
    expect(phases(off.entries)).toEqual({ voice: ["sam:idle", "ava:idle"], visual: [] });
  });

  test("coming back during the exit cancels it without replaying an entrance", () => {
    const first = step(emptyStageMotionMemory(), { voice: ["ava", "sam"], visual: [] }, 0);
    const left = step(first.memory, { voice: ["ava"], visual: [] }, 10);
    const back = step(left.memory, { voice: ["ava", "sam"], visual: [] }, 50);
    expect(phases(back.entries).voice).toEqual(["ava:idle", "sam:idle"]);
  });
});
