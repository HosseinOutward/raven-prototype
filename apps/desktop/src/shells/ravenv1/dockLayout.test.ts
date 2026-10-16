import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DOCK_ORDER,
  isDefaultDockOrder,
  moveDockControl,
  normalizeDockOrder,
  parseDockOrder,
  reorderDockControls,
} from "./dockLayout";

describe("dock order", () => {
  test("defaults to microphone, camera, screen, hearing", () => {
    expect(parseDockOrder(null)).toEqual(["mic", "camera", "screen", "hear"]);
    expect(isDefaultDockOrder(parseDockOrder(null))).toBe(true);
  });

  test("keeps a valid stored order", () => {
    expect(parseDockOrder(JSON.stringify(["hear", "screen", "camera", "mic"]))).toEqual(["hear", "screen", "camera", "mic"]);
  });

  test("falls back to the default for anything unreadable", () => {
    expect(parseDockOrder("not json")).toEqual([...DEFAULT_DOCK_ORDER]);
    expect(parseDockOrder("{\"mic\":1}")).toEqual([...DEFAULT_DOCK_ORDER]);
    expect(parseDockOrder("42")).toEqual([...DEFAULT_DOCK_ORDER]);
  });

  test("drops unknown ids and repeats", () => {
    expect(normalizeDockOrder(["screen", "chat", "screen", 3, null, "mic", "camera", "hear"])).toEqual(["screen", "mic", "camera", "hear"]);
  });

  test("appends controls a saved order does not know about, in default order", () => {
    // An order saved before "camera" and "hear" existed keeps its own arrangement.
    expect(normalizeDockOrder(["screen", "mic"])).toEqual(["screen", "mic", "camera", "hear"]);
    expect(normalizeDockOrder([])).toEqual([...DEFAULT_DOCK_ORDER]);
  });

  test("moves one control left or right, and not past the ends", () => {
    expect(moveDockControl(DEFAULT_DOCK_ORDER, "camera", -1)).toEqual(["camera", "mic", "screen", "hear"]);
    expect(moveDockControl(DEFAULT_DOCK_ORDER, "camera", 1)).toEqual(["mic", "screen", "camera", "hear"]);
    expect(moveDockControl(DEFAULT_DOCK_ORDER, "mic", -1)).toEqual([...DEFAULT_DOCK_ORDER]);
    expect(moveDockControl(DEFAULT_DOCK_ORDER, "hear", 1)).toEqual([...DEFAULT_DOCK_ORDER]);
  });

  test("drops a dragged control where the other one was", () => {
    expect(reorderDockControls(DEFAULT_DOCK_ORDER, "mic", "hear")).toEqual(["camera", "screen", "hear", "mic"]);
    expect(reorderDockControls(DEFAULT_DOCK_ORDER, "hear", "camera")).toEqual(["mic", "hear", "camera", "screen"]);
  });
});
