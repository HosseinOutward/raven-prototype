import { describe, expect, test } from "bun:test";
import {
  classifyReading,
  readingFromTotals,
  sendQualityExplanation,
  SendQualityTracker,
  type SendQualityReading,
} from "./sendQuality";

const clear: SendQualityReading = { loss: 0, roundTripMs: 40, jitterMs: 5 };
const choppy: SendQualityReading = { loss: 0.12, roundTripMs: 80, jitterMs: 10 };

describe("how you sound to others", () => {
  test("loss over the interval comes from the counters", () => {
    const reading = readingFromTotals(
      { sentBytes: 0, receivedBytes: 0, sentPackets: 1000, sentPacketsLost: 10 },
      { sentBytes: 0, receivedBytes: 0, sentPackets: 1100, sentPacketsLost: 20, sentRoundTripMs: 90, sentJitterMs: 12 },
    );
    expect(reading).toEqual({ loss: 0.1, roundTripMs: 90, jitterMs: 12 });
  });

  test("nothing sent is nothing to judge", () => {
    expect(readingFromTotals(
      { sentBytes: 0, receivedBytes: 0, sentPackets: 50 },
      { sentBytes: 0, receivedBytes: 0, sentPackets: 50 },
    )).toBeNull();
  });

  test("thresholds", () => {
    expect(classifyReading(clear)).toBe("clear");
    expect(classifyReading({ ...clear, loss: 0.04 })).toBe("unsteady");
    expect(classifyReading({ ...clear, jitterMs: 90 })).toBe("choppy");
    expect(classifyReading(choppy)).toBe("choppy");
  });

  test("one bad reading does not flash a warning, and it clears slowly", () => {
    const tracker = new SendQualityTracker();
    expect(tracker.push(choppy)).toBe("clear");
    expect(tracker.push(clear)).toBe("clear");
    expect(tracker.push(choppy)).toBe("clear");
    expect(tracker.push(choppy)).toBe("choppy");
    expect(tracker.push(clear)).toBe("choppy");
    expect(tracker.push(clear)).toBe("choppy");
    expect(tracker.push(clear)).toBe("clear");
  });

  test("explains loss in plain words", () => {
    expect(sendQualityExplanation("choppy", choppy)).toStartWith("About 12% of your sound isn’t reaching the server");
    expect(sendQualityExplanation("unsteady", { loss: 0, roundTripMs: 400, jitterMs: 0 })).toStartWith("Your sound arrives late");
  });
});
