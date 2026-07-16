import { describe, expect, test } from "bun:test";
import {
  formatBytes,
  isHighRiskAction,
  normalizePercentage,
  parsePayload,
} from "./actions";

describe("release operation helpers", () => {
  test("recognizes only actions that require typed reauthorization", () => {
    expect(isHighRiskAction("withdraw_release")).toBe(true);
    expect(isHighRiskAction("publish_required")).toBe(true);
    expect(isHighRiskAction("pause_release")).toBe(false);
  });

  test("bounds rollout percentages", () => {
    expect(normalizePercentage(-2)).toBe(0);
    expect(normalizePercentage(12.345)).toBe(12.35);
    expect(normalizePercentage(140)).toBe(100);
  });

  test("formats artifact sizes", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  test("accepts already-redacted structured diagnostics", () => {
    expect(parsePayload('{"stage":"download"}')).toEqual({ stage: "download" });
    expect(parsePayload("offline")).toEqual({ message: "offline" });
  });
});
