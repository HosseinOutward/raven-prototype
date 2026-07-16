import { describe, expect, test } from "bun:test";
import { canRestartForUpdate, formatUpdateBytes, updatePhaseLabel, type UpdaterSnapshot } from "./updater";

describe("updater presentation helpers", () => {
  test("formats release sizes without fake precision", () => {
    expect(formatUpdateBytes(512)).toBe("512 B");
    expect(formatUpdateBytes(1_048_576)).toBe("1.0 MB");
    expect(formatUpdateBytes(undefined)).toBe("Unknown");
  });

  test("restart stays unavailable during active communication", () => {
    const state = {
      phase: "awaiting_restart",
      activeSession: true,
      verifiedInCurrentProcess: true,
      downloaded: { releaseId: "release", version: "1.2.3" },
    } as UpdaterSnapshot;
    expect(canRestartForUpdate(state)).toBe(false);
    expect(canRestartForUpdate({ ...state, activeSession: false })).toBe(true);
  });

  test("failure labels remain specific", () => {
    expect(updatePhaseLabel("verification_failed")).toBe("Verification failed");
    expect(updatePhaseLabel("blocked_version")).toBe("Installed version blocked");
  });
});
