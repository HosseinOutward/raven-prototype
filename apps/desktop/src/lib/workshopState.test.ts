import { describe, expect, test } from "bun:test";
import { applyShareEvent, endReasonSentence, formatBytes, mayUseShare, routeParts, timeLeft, type WorkshopShare } from "./workshopState";

const share = (id: string, over: Partial<WorkshopShare> = {}): WorkshopShare => ({
  id, name: "web", placeKind: "nest", placeId: "n1", publisherId: "alice", protocol: "tcp", port: 8080,
  everyone: true, audience: [], expiresAt: "2026-11-06T14:00:00Z", online: true, consumers: [], udpDropped: 0, ...over,
});

describe("applyShareEvent", () => {
  test("adds, updates and ends shares", () => {
    let shares = applyShareEvent([], "workshop.share.added", share("b"));
    shares = applyShareEvent(shares, "workshop.share.added", share("a"));
    expect(shares.map((s) => s.id)).toEqual(["a", "b"]);
    shares = applyShareEvent(shares, "workshop.share.updated", share("a", { consumers: ["bob"] }));
    expect(shares).toHaveLength(2);
    expect(shares[0].consumers).toEqual(["bob"]);
    shares = applyShareEvent(shares, "workshop.share.ended", share("a"));
    expect(shares.map((s) => s.id)).toEqual(["b"]);
    expect(applyShareEvent(shares, "workshop.other", share("z"))).toBe(shares);
  });
});

describe("mayUseShare", () => {
  test("follows the audience", () => {
    expect(mayUseShare(share("a"), "bob")).toBe(true);
    const picked = share("a", { everyone: false, audience: ["bob"] });
    expect(mayUseShare(picked, "bob")).toBe(true);
    expect(mayUseShare(picked, "carol")).toBe(false);
    expect(mayUseShare(picked, "alice")).toBe(true);
  });
});

describe("wording", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  test("time left", () => {
    expect(timeLeft("2026-11-06T12:00:30Z", now)).toBe("less than a minute left");
    expect(timeLeft("2026-11-06T12:12:00Z", now)).toBe("12 min left");
    expect(timeLeft("2026-11-06T13:05:00Z", now)).toBe("1 h 5 min left");
    expect(timeLeft("2026-11-06T14:00:00Z", now)).toBe("2 h left");
    expect(timeLeft("2026-11-06T11:00:00Z", now)).toBe("ended");
  });
  test("each end reason is a sentence", () => {
    for (const reason of ["stopped", "expired", "publisher_offline", "left_place", "relay_restarted", "connection_lost: x", undefined]) {
      expect(endReasonSentence(reason, "consumer").endsWith(".")).toBe(true);
    }
    expect(endReasonSentence("relay_restarted", "publisher")).toBe("The relay restarted. Share the port again.");
  });
  test("the route splits into transport and relay", () => {
    expect(routeParts("QUIC with TLS 1.3 to relay.example:7443")).toEqual({ transport: "QUIC with TLS 1.3", endpoint: "relay.example:7443" });
  });
  test("bytes", () => {
    expect(formatBytes(820)).toBe("820 B");
    expect(formatBytes(14_000)).toBe("14 KB");
    expect(formatBytes(3_200_000)).toBe("3.2 MB");
  });
});
