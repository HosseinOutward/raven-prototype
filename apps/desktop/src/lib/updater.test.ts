import { describe, expect, test } from "bun:test";
import { downloadPercent, formatUpdateBytes, updateStatusLine, type UpdaterSnapshot } from "./updater";

const base: UpdaterSnapshot = {
  currentVersion: "0.1.0",
  phase: "idle",
  busy: false,
  busyReason: "",
};

describe("updater presentation helpers", () => {
  test("formats sizes without fake precision", () => {
    expect(formatUpdateBytes(512)).toBe("512 B");
    expect(formatUpdateBytes(1_048_576)).toBe("1.0 MB");
    expect(formatUpdateBytes(undefined)).toBe("");
  });

  test("says where the update stands", () => {
    const available = { version: "0.2.0", notes: "", downloadUrl: "https://example.test/raven" };
    expect(updateStatusLine(base)).toBe("Raven is up to date.");
    expect(updateStatusLine({ ...base, phase: "available", available })).toBe("Raven 0.2.0 is available.");
    expect(updateStatusLine({ ...base, phase: "ready", available })).toBe(
      "Raven 0.2.0 is downloaded. Restart to finish updating.",
    );
  });

  test("progress is unknown until the size is", () => {
    expect(downloadPercent({ ...base, progress: { downloaded: 10 } })).toBeNull();
    expect(downloadPercent({ ...base, progress: { downloaded: 50, total: 200 } })).toBe(25);
    expect(downloadPercent({ ...base, progress: { downloaded: 300, total: 200 } })).toBe(100);
  });
});
