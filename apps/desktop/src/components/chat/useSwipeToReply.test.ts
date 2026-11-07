import { describe, expect, test } from "bun:test";
import { attachSwipeToReply, FINGERS_LEFT_DELTA_X, scrollsSideways, slideFor, SWIPE_MAX_SLIDE, SWIPE_THRESHOLD, WHEEL_IDLE_MS } from "./useSwipeToReply";

type Handler = (event: never) => void;
const fakeRow = () => {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    addEventListener: (type: string, fn: Handler) => void handlers.set(type, fn),
    removeEventListener: (type: string) => void handlers.delete(type),
    setPointerCapture: () => undefined,
  };
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(enabled = true) {
  const row = fakeRow();
  const log = { replies: 0, ends: 0, last: { slide: 0, armed: false } };
  attachSwipeToReply(row, {
    enabled: () => enabled,
    onReply: () => void (log.replies += 1),
    onProgress: (slide, armed) => void (log.last = { slide, armed }),
    onEnd: () => void (log.ends += 1),
  });
  let prevented = 0;
  const wheel = (deltaX: number, deltaY = 0, extra: object = {}) => {
    (row.handlers.get("wheel") as (e: unknown) => void)({ deltaX, deltaY, ctrlKey: false, target: {}, preventDefault: () => void (prevented += 1), ...extra });
  };
  return { row, log, wheel, prevented: () => prevented };
}
const left = (px: number) => px * FINGERS_LEFT_DELTA_X;

describe("swipe to reply, touchpad", () => {
  test("a horizontal swipe past the threshold replies once, on release", async () => {
    const { log, wheel, prevented } = setup();
    for (let i = 0; i < 8; i++) wheel(left(10), 1);
    expect(log.last.armed).toBe(true);
    expect(prevented()).toBe(8);
    expect(log.replies).toBe(0);
    await wait(WHEEL_IDLE_MS + 60);
    expect(log.replies).toBe(1);
    expect(log.ends).toBe(1);
  });
  test("a short swipe does not reply", async () => {
    const { log, wheel } = setup();
    wheel(left(20));
    await wait(WHEEL_IDLE_MS + 60);
    expect(log.replies).toBe(0);
    expect(log.ends).toBe(1);
  });
  test("a mostly vertical gesture is left alone", async () => {
    const { log, wheel, prevented } = setup();
    for (let i = 0; i < 8; i++) wheel(left(30), 25);
    await wait(WHEEL_IDLE_MS + 60);
    expect(prevented()).toBe(0);
    expect(log.replies).toBe(0);
  });
  test("ctrl-wheel and disabled rows are left alone", async () => {
    const a = setup();
    for (let i = 0; i < 8; i++) a.wheel(left(20), 0, { ctrlKey: true });
    const b = setup(false);
    for (let i = 0; i < 8; i++) b.wheel(left(20));
    await wait(WHEEL_IDLE_MS + 60);
    expect(a.prevented() + b.prevented()).toBe(0);
    expect(a.log.replies + b.log.replies).toBe(0);
  });
  test("swiping the other way does not arm", async () => {
    const { log, wheel } = setup();
    for (let i = 0; i < 8; i++) wheel(left(-20));
    await wait(WHEEL_IDLE_MS + 60);
    expect(log.replies).toBe(0);
  });
  test("a code block that can still scroll sideways keeps the event", async () => {
    globalThis.getComputedStyle = (() => ({ overflowX: "auto" })) as unknown as typeof getComputedStyle;
    const root = {};
    const pre = { scrollWidth: 500, clientWidth: 200, scrollLeft: 0, parentElement: root };
    const { log, wheel, prevented } = setup();
    for (let i = 0; i < 8; i++) wheel(left(20), 0, { target: pre });
    await wait(WHEEL_IDLE_MS + 60);
    expect(prevented()).toBe(0);
    expect(log.replies).toBe(0);
    // At its right edge it no longer needs the gesture.
    expect(scrollsSideways({ ...pre, scrollLeft: 300 }, root, 1)).toBe(false);
    expect(scrollsSideways(pre, root, 1)).toBe(true);
  });
});

describe("swipe to reply, touch", () => {
  const touch = (row: ReturnType<typeof fakeRow>, xs: number[]) => {
    const fire = (type: string, x: number, y = 0) => (row.handlers.get(type) as (e: unknown) => void)({ pointerType: "touch", pointerId: 1, button: 0, clientX: x, clientY: y, target: {} });
    fire("pointerdown", 200);
    for (const x of xs) fire("pointermove", x);
    fire("pointerup", xs[xs.length - 1]);
  };
  test("a leftward drag past the threshold replies", () => {
    const { row, log } = setup();
    touch(row, [190, 160, 120]);
    expect(log.replies).toBe(1);
  });
  test("a short drag or a rightward drag does not", () => {
    const a = setup();
    touch(a.row, [190, 170]);
    const b = setup();
    touch(b.row, [210, 260]);
    expect(a.log.replies + b.log.replies).toBe(0);
  });
});

describe("slide curve", () => {
  test("1:1 to the threshold, then resisted and capped", () => {
    expect(slideFor(30)).toBe(30);
    expect(slideFor(SWIPE_THRESHOLD)).toBe(SWIPE_THRESHOLD);
    expect(slideFor(SWIPE_THRESHOLD + 20)).toBeLessThan(SWIPE_THRESHOLD + 20);
    expect(slideFor(1000)).toBe(SWIPE_MAX_SLIDE);
  });
});
