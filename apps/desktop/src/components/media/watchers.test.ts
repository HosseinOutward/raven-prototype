import { describe, expect, test } from "bun:test";
import type { VideoParticipantState } from "@/lib/video";
import { sharesWatchedBy, splitWatcherStack, watchersOfShare, watchersTooltip, watchingTooltip } from "./watchers";

const person = (participantId: string, displayName: string, extra: Partial<VideoParticipantState> = {}): VideoParticipantState => ({
  participantId,
  displayName,
  isLocal: false,
  audioMuted: false,
  speaking: false,
  connectionQuality: "good",
  watching: [],
  ...extra,
});

const room = [
  person("me", "You", { isLocal: true }),
  person("sara", "Sara", { watching: ["me", "omid"] }),
  person("omid", "Omid", { watching: ["me"] }),
  person("lena", "Lena", { watching: ["omid", "gone"] }),
];

describe("who is watching a share", () => {
  test("lists other people by name, never the sharer", () => {
    expect(watchersOfShare(room, "me").map((watcher) => watcher.displayName)).toEqual(["Omid", "Sara"]);
    expect(watchersOfShare(room, "omid").map((watcher) => watcher.displayName)).toEqual(["Lena", "Sara"]);
    expect(watchersOfShare(room, "lena")).toEqual([]);
    expect(watchersOfShare([person("a", "A", { watching: ["a"] })], "a")).toEqual([]);
  });

  test("lists the shares a person watches, yours first, skipping people who left", () => {
    expect(sharesWatchedBy(room, "sara").map((target) => [target.displayName, target.isLocal])).toEqual([
      ["You", true],
      ["Omid", false],
    ]);
    expect(sharesWatchedBy(room, "lena").map((target) => target.participantId)).toEqual(["omid"]);
    expect(sharesWatchedBy(room, "me")).toEqual([]);
    expect(sharesWatchedBy(room, "nobody")).toEqual([]);
  });
});

describe("watching wording", () => {
  test("the eye names whose screen", () => {
    const [yours] = sharesWatchedBy(room, "omid");
    expect(watchingTooltip([yours])).toBe("Watching your screen");
    expect(watchingTooltip(sharesWatchedBy(room, "sara"))).toBe("Watching your and Omid’s screens");
    expect(watchingTooltip([])).toBe("");
  });

  test("the stack names who, and shortens long lists", () => {
    const names = (...list: string[]) => list.map((displayName) => ({ participantId: displayName, displayName }));
    expect(watchersTooltip(names("Sara"))).toBe("Sara is watching");
    expect(watchersTooltip(names("Sara", "Omid"))).toBe("Sara and Omid are watching");
    expect(watchersTooltip(names("Sara", "Omid", "Lena"))).toBe("Sara, Omid and Lena are watching");
    expect(watchersTooltip(names("A", "B", "C", "D", "E"))).toBe("A, B, C and 2 others are watching");
  });

  test("the stack never hides a single face behind +1", () => {
    expect(splitWatcherStack([1, 2, 3, 4])).toEqual({ shown: [1, 2, 3, 4], extra: 0 });
    expect(splitWatcherStack([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2, 3], extra: 2 });
  });
});
