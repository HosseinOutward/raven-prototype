import { describe, expect, test } from "bun:test";
import {
  VOLUME_READOUT_MS,
  cardButtons,
  clampVolumePercent,
  createLatestThrottle,
  steppedVolumePercent,
  takeWheelNotches,
  volumeReadout,
} from "./voiceOverlayControls";

const ALL_ON = { mute: true, deafen: true, away: true };

describe("volume steps", () => {
  test("a notch moves 10 percent and the result stays between 0 and 200", () => {
    expect(steppedVolumePercent(100, 1)).toBe(110);
    expect(steppedVolumePercent(100, -1)).toBe(90);
    expect(steppedVolumePercent(195, 3)).toBe(200);
    expect(steppedVolumePercent(5, -3)).toBe(0);
  });

  test("clamps and rounds whatever it is given", () => {
    expect(clampVolumePercent(250)).toBe(200);
    expect(clampVolumePercent(-4)).toBe(0);
    expect(clampVolumePercent(66.6)).toBe(67);
    expect(clampVolumePercent(Number.NaN)).toBe(100);
  });
});

describe("wheel notches", () => {
  test("a mouse notch is one step, scrolling up is louder", () => {
    expect(takeWheelNotches(0, -100, 0)).toEqual({ notches: 1, carry: 0 });
    expect(takeWheelNotches(0, 100, 0)).toEqual({ notches: -1, carry: 0 });
  });

  test("small trackpad deltas add up to whole notches", () => {
    let carry = 0;
    let notches = 0;
    for (let i = 0; i < 10; i += 1) {
      const step = takeWheelNotches(carry, -30, 0);
      carry = step.carry;
      notches += step.notches;
    }
    // Ten events of 30 px is 300 px: three notches, nothing left over.
    expect(notches).toBe(3);
    expect(carry).toBe(0);
  });

  test("line and page modes are scaled to about a notch", () => {
    expect(takeWheelNotches(0, -3, 1).notches).toBe(1);
    expect(takeWheelNotches(0, -1, 2).notches).toBe(3);
  });
});

describe("which buttons the card shows", () => {
  test("nothing outside a call or while not interactive", () => {
    expect(cardButtons({ inCall: false, interactive: true, buttons: ALL_ON, awaySupported: true })).toEqual([]);
    expect(cardButtons({ inCall: true, interactive: false, buttons: ALL_ON, awaySupported: true })).toEqual([]);
  });

  test("each switch hides its button, and all off means no bar", () => {
    expect(
      cardButtons({ inCall: true, interactive: true, buttons: { mute: false, deafen: true, away: true }, awaySupported: true }),
    ).toEqual(["deafen", "away"]);
    expect(
      cardButtons({ inCall: true, interactive: true, buttons: { mute: false, deafen: false, away: false }, awaySupported: true }),
    ).toEqual([]);
  });

  test("Back in a bit stays hidden until the server supports it", () => {
    expect(cardButtons({ inCall: true, interactive: true, buttons: ALL_ON, awaySupported: false })).toEqual([
      "mute",
      "deafen",
    ]);
  });
});

describe("volume readout", () => {
  test("shows and flashes while changing, then only when interactive and not 100", () => {
    const changedAt = 1_000;
    expect(volumeReadout({ percent: 120, changedAt, now: changedAt + 100, interactive: false })).toEqual({
      show: true,
      flashing: true,
    });
    const later = changedAt + VOLUME_READOUT_MS + 1;
    expect(volumeReadout({ percent: 120, changedAt, now: later, interactive: true })).toEqual({
      show: true,
      flashing: false,
    });
    expect(volumeReadout({ percent: 120, changedAt, now: later, interactive: false })).toEqual({
      show: false,
      flashing: false,
    });
    expect(volumeReadout({ percent: 100, changedAt: null, now: later, interactive: true })).toEqual({
      show: false,
      flashing: false,
    });
  });
});

describe("latest-value throttle", () => {
  test("sends at most once per interval and always the last value", () => {
    const sent: number[] = [];
    let now = 0;
    const scheduled: Array<{ run: () => void; ms: number }> = [];
    const throttle = createLatestThrottle<number>((value) => sent.push(value), 80, {
      now: () => now,
      schedule: (run, ms) => {
        scheduled.push({ run, ms });
        return scheduled.length;
      },
    });

    throttle.push(1);
    throttle.push(2);
    throttle.push(3);
    expect(scheduled.length).toBe(1);
    expect(scheduled[0]?.ms).toBe(0);

    scheduled[0]?.run();
    expect(sent).toEqual([3]);

    now = 10;
    throttle.push(4);
    expect(scheduled.length).toBe(2);
    expect(scheduled[1]?.ms).toBe(70);

    scheduled[1]?.run();
    expect(sent).toEqual([3, 4]);
  });

  test("cancel drops the pending value", () => {
    const sent: number[] = [];
    const cancelled: unknown[] = [];
    const throttle = createLatestThrottle<number>((value) => sent.push(value), 80, {
      now: () => 0,
      schedule: () => "timer",
      cancel: (handle) => cancelled.push(handle),
    });
    throttle.push(5);
    throttle.cancel();
    expect(cancelled).toEqual(["timer"]);
    expect(sent).toEqual([]);
  });
});
