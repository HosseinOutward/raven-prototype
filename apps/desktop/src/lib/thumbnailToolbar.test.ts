import { describe, expect, it } from "bun:test";
import {
  claimThumbnailAction,
  manageEventSubscription,
  releaseThumbnailAction,
  runGuardedThumbnailAction,
  type ThumbnailToolbarAction,
} from "./thumbnailToolbar";

describe("thumbnail toolbar action guards", () => {
  it("allows only one in-flight action of each kind and releases it for a retry", () => {
    const pending = new Set<ThumbnailToolbarAction>();

    expect(claimThumbnailAction(pending, "mic")).toBe(true);
    expect(claimThumbnailAction(pending, "mic")).toBe(false);
    expect(claimThumbnailAction(pending, "deafen")).toBe(true);

    releaseThumbnailAction(pending, "mic");
    expect(claimThumbnailAction(pending, "mic")).toBe(true);
  });

  it("runs one click while pending, then accepts another after settlement", async () => {
    const pending = new Set<ThumbnailToolbarAction>();
    const states: string[] = [];
    let complete!: () => void;
    let calls = 0;
    const firstOperation = new Promise<void>((resolve) => { complete = resolve; });
    const publish = (actions: ReadonlySet<ThumbnailToolbarAction>) => {
      states.push([...actions].join(","));
    };

    const first = runGuardedThumbnailAction(pending, "mic", () => {
      calls += 1;
      return firstOperation;
    }, publish);
    const duplicate = runGuardedThumbnailAction(pending, "mic", () => {
      calls += 1;
      return Promise.resolve();
    }, publish);

    expect(first).not.toBeNull();
    expect(duplicate).toBeNull();
    expect(calls).toBe(1);
    expect(states).toEqual(["mic"]);

    complete();
    await first;
    expect(states).toEqual(["mic", ""]);

    const retry = runGuardedThumbnailAction(pending, "mic", () => {
      calls += 1;
      return Promise.resolve();
    }, publish);
    expect(retry).not.toBeNull();
    await retry;
    expect(calls).toBe(2);
  });

  it("unsubscribes if setup finishes after the component has unmounted", async () => {
    let completeSubscription!: (stop: () => void) => void;
    let stopped = 0;
    let becameReady = 0;
    const subscription = new Promise<() => void>((resolve) => {
      completeSubscription = resolve;
    });

    const dispose = manageEventSubscription(() => subscription, () => { becameReady += 1; });
    dispose();
    completeSubscription(() => { stopped += 1; });
    await subscription;
    await Promise.resolve();

    expect(stopped).toBe(1);
    expect(becameReady).toBe(0);
  });

  it("unsubscribes an active native event listener exactly once", async () => {
    let stopped = 0;
    let becameReady = 0;
    const dispose = manageEventSubscription(
      async () => () => { stopped += 1; },
      () => { becameReady += 1; },
    );
    await Promise.resolve();
    expect(becameReady).toBe(1);
    dispose();
    dispose();
    expect(stopped).toBe(1);
  });
});
