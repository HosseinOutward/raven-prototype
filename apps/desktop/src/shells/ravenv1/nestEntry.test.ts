import { describe, expect, test } from "bun:test";
import { runNestEntry, type NestEntryDeps, type NestEntryRun } from "./nestEntry";

/** Deterministic harness: time only advances when the entry flow sleeps. */
function harness(overrides: Partial<NestEntryDeps> = {}) {
  let clock = 1_000;
  const calls: string[] = [];
  const ticks: Array<number | null> = [];
  const run: NestEntryRun = { cancelled: false, wake: null };
  const deps: NestEntryDeps = {
    joinNest: async () => {
      calls.push("joinNest");
      return "joined";
    },
    announce: async () => {
      calls.push("announce");
      return { notified: 1, delaySeconds: 3 };
    },
    withdraw: async () => {
      calls.push("withdraw");
    },
    joinMedia: async () => {
      calls.push("joinMedia");
    },
    now: () => clock,
    sleep: async (ms, onWake) => {
      onWake(() => undefined);
      clock += ms;
    },
    ...overrides,
  };
  return {
    deps,
    run,
    calls,
    ticks,
    advance: (ms: number) => {
      clock += ms;
    },
    start: () => runNestEntry(deps, "nest-1", run, (secondsLeft) => ticks.push(secondsLeft)),
  };
}

describe("entering a Nest", () => {
  test("gives the people inside the announced notice before joining", async () => {
    const entry = harness();

    expect(await entry.start()).toBe("joined");

    expect(entry.calls).toEqual(["announce", "joinNest", "joinMedia"]);
    expect(entry.ticks[0]).toBe(3);
    expect(entry.ticks.at(-1)).toBeNull();
    expect(new Set(entry.ticks.filter((tick) => tick !== null))).toEqual(new Set([3, 2, 1]));
  });

  test("walks straight into an empty Nest", async () => {
    const entry = harness({ announce: async () => ({ notified: 0, delaySeconds: 3 }) });

    expect(await entry.start()).toBe("joined");

    expect(entry.ticks).toEqual([]);
    expect(entry.calls).toEqual(["joinNest", "joinMedia"]);
  });

  test("still enters when the notice cannot be sent", async () => {
    const entry = harness({ announce: async () => null });

    expect(await entry.start()).toBe("joined");

    expect(entry.ticks).toEqual([]);
    expect(entry.calls).toContain("joinMedia");
    expect(entry.calls).not.toContain("withdraw");
  });

  test("cancelling during the countdown withdraws the notice and never joins", async () => {
    let entry!: ReturnType<typeof harness>;
    entry = harness({
      sleep: async (ms, onWake) => {
        onWake(() => undefined);
        entry.advance(ms);
        // The user clicks Cancel one second in.
        if (entry.ticks.includes(2)) entry.run.cancelled = true;
      },
    });

    expect(await entry.start()).toBe("cancelled");

    expect(entry.calls).toContain("withdraw");
    expect(entry.calls).not.toContain("joinMedia");
    expect(entry.ticks.at(-1)).toBeNull();
  });

  test("does not join media while admission is still pending, and takes the notice back", async () => {
    const entry = harness({
      joinNest: async () => {
        entry.calls.push("joinNest");
        return "waiting";
      },
    });

    expect(await entry.start()).toBe("waiting");

    expect(entry.calls).toContain("withdraw");
    expect(entry.calls).not.toContain("joinMedia");
    expect(entry.ticks).toEqual([]);
  });

  test("a media connect that fails takes the notice back, so nobody waits on a connecting toast", async () => {
    const entry = harness({
      joinMedia: async () => {
        entry.calls.push("joinMedia");
        throw new Error("could not establish pc connection");
      },
    });

    await expect(entry.start()).rejects.toThrow("could not establish pc connection");

    expect(entry.calls).toEqual(["announce", "joinNest", "joinMedia", "withdraw"]);
  });

  test("a failed connect into an empty Nest has nothing to take back", async () => {
    const entry = harness({
      announce: async () => ({ notified: 0, delaySeconds: 3 }),
      joinMedia: async () => {
        throw new Error("offline");
      },
    });

    await expect(entry.start()).rejects.toThrow("offline");

    expect(entry.calls).not.toContain("withdraw");
  });

  test("counts the wait from when the notice went out, not from when membership finished", async () => {
    const entry = harness();
    entry.deps.joinNest = async () => {
      entry.calls.push("joinNest");
      // The notice is acknowledged first; membership then takes two more seconds.
      await Promise.resolve();
      await Promise.resolve();
      entry.advance(2_000);
      return "joined";
    };

    await entry.start();

    expect(entry.ticks[0]).toBe(1);
  });
});
