import { describe, expect, test } from "bun:test";
import { downloadPercent, formatUpdateBytes, releasesSince, updateStatusLine, type UpdaterSnapshot } from "./updater";

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

describe("releasesSince", () => {
  const release = (version: string) => ({ version, notes: `notes ${version}` });
  const available = { version: "0.1.7", notes: "notes 0.1.7", downloadUrl: "https://example.test/raven" };

  test("lists everything newer than what is installed, newest first", () => {
    const history = [release("0.1.3"), release("0.1.6"), release("0.1.10"), release("0.1.5"), release("0.1.4")];
    expect(releasesSince({ ...available, history }, "0.1.4").map((entry) => entry.version)).toEqual(["0.1.7", "0.1.6", "0.1.5"]);
  });

  test("compares versions as numbers, not text", () => {
    const history = [release("0.1.9")];
    expect(releasesSince({ ...available, version: "0.1.10", history }, "0.1.8").map((entry) => entry.version)).toEqual(["0.1.10", "0.1.9"]);
  });

  test("a manifest without history still shows the offered version", () => {
    expect(releasesSince(available, "0.1.4")).toEqual([release("0.1.7")]);
  });

  test("skips versions without notes", () => {
    expect(releasesSince({ ...available, notes: "", history: [{ version: "0.1.6", notes: "" }] }, "0.1.4")).toEqual([]);
  });
});
