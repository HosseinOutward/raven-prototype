import { describe, expect, test } from "bun:test";
import { buildRows, type ChatRow } from "./rows";
import type { ChatMessage, PendingMessage } from "./types";

const ME = "me";

/** Message number `seq`, one minute after the one before it; the day changes after number 6. */
function message(seq: number, senderId = "ava"): ChatMessage {
  const day = seq <= 6 ? "2026-03-01" : "2026-03-02";
  const minute = String(seq % 60).padStart(2, "0");
  return { id: `m${seq}`, conversationId: "c", seq, changedSeq: seq, senderId, senderName: senderId, clientMessageId: `k${seq}`, kind: "text", body: `text ${seq}`, createdAt: `${day}T10:${minute}:00Z` };
}

const senders = ["ava", "ava", "ben", "ben", "ava", "ava", "ava", ME, ME, "ben", "ben", "ava"];
const all = senders.map((sender, index) => message(index + 1, sender));
/** Messages `from` to `to` as a loaded window. */
const span = (from: number, to: number) => all.slice(from - 1, to);

const rowsOf = (messages: ChatMessage[], options: Partial<Parameters<typeof buildRows>[0]> = {}) =>
  buildRows({ messages, pending: [], me: ME, dividerAfterSeq: null, hasMoreBefore: false, hasMoreAfter: false, ...options });

/** Everything about a row that affects how tall it is drawn. */
const look = (row: ChatRow) => (row.kind === "message" ? `${row.message.seq}:${row.dayHeading ? "day" : ""}${row.newDivider ? "+new" : ""}${row.continuation ? "+cont" : ""}` : `pending:${row.pending.clientMessageId}`);
const seqs = (rows: ChatRow[]) => rows.flatMap((row) => (row.kind === "message" ? [row.message.seq] : []));

describe("the rows of a conversation", () => {
  test("a day gets one heading and a person's run is not repeated", () => {
    expect(rowsOf(all).map(look)).toEqual([
      "1:day", "2:+cont", "3:", "4:+cont", "5:", "6:+cont",
      "7:day", "8:", "9:+cont", "10:", "11:+cont", "12:",
    ]);
  });

  test("with history before it, the oldest loaded message waits for the page before it", () => {
    expect(seqs(rowsOf(span(5, 12), { hasMoreBefore: true }))).toEqual([6, 7, 8, 9, 10, 11, 12]);
    expect(seqs(rowsOf(span(5, 12), { hasMoreBefore: false }))).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    // A window of one has nothing to wait behind.
    expect(seqs(rowsOf(span(5, 5), { hasMoreBefore: true }))).toEqual([5]);
  });

  test("no row changes its look when an earlier page arrives", () => {
    // Every window that could be on screen, then the same window with every possible
    // amount of earlier history added in front of it.
    for (let from = 2; from <= all.length - 1; from += 1) {
      const before = new Map(rowsOf(span(from, all.length), { hasMoreBefore: true, dividerAfterSeq: 8 }).map((row) => [row.key, look(row)]));
      for (let earlier = 1; earlier < from; earlier += 1) {
        const after = rowsOf(span(earlier, all.length), { hasMoreBefore: earlier > 1, dividerAfterSeq: 8 });
        for (const row of after) {
          if (before.has(row.key)) expect(`${earlier}..: ${look(row)}`).toBe(`${earlier}..: ${before.get(row.key)}`);
        }
      }
    }
  });

  test("nor when rows are let go from either end", () => {
    const whole = new Map(rowsOf(all, { dividerAfterSeq: 3 }).map((row) => [row.key, look(row)]));
    for (const row of rowsOf(span(4, 12), { hasMoreBefore: true, dividerAfterSeq: 3 })) expect(look(row)).toBe(whole.get(row.key)!);
    for (const row of rowsOf(span(1, 9), { hasMoreAfter: true, dividerAfterSeq: 3 })) expect(look(row)).toBe(whole.get(row.key)!);
  });

  test("“New messages” sits once, straight after what had been read", () => {
    const marked = (rows: ChatRow[]) => rows.flatMap((row) => (row.kind === "message" && row.newDivider ? [row.message.seq] : []));
    expect(marked(rowsOf(all, { dividerAfterSeq: 4 }))).toEqual([5]);
    // Nothing was read yet: it goes above the first message there is.
    expect(marked(rowsOf(all, { dividerAfterSeq: 0 }))).toEqual([1]);
    // The place is further back than what is loaded: it is not put on some other row.
    expect(marked(rowsOf(span(8, 12), { hasMoreBefore: true, dividerAfterSeq: 4 }))).toEqual([]);
    // Nothing was unread when the conversation was opened.
    expect(marked(rowsOf(all))).toEqual([]);
    // The message under it starts afresh: it does not read as a continuation.
    expect(rowsOf(all, { dividerAfterSeq: 3 }).map(look)[3]).toBe("4:+new");
  });

  test("unsent messages come last, and only at the newest end of the conversation", () => {
    const pending: PendingMessage[] = [{ clientMessageId: "p1", conversationId: "c", body: "not yet", createdAt: "2026-03-02T11:00:00Z", state: "sending", attempts: 1 }];
    expect(rowsOf(span(10, 12), { pending }).map(look)).toEqual(["10:day", "11:+cont", "12:", "pending:p1"]);
    expect(rowsOf(span(1, 4), { pending, hasMoreAfter: true }).map(look)).toEqual(["1:day", "2:+cont", "3:", "4:+cont"]);
  });

  test("my own message keeps the row it had while it was being sent", () => {
    const mine = rowsOf(all).find((row) => row.kind === "message" && row.message.seq === 8)!;
    expect(mine.key).toBe("c:k8");
    expect(rowsOf(all)[0].key).toBe("m:m1");
  });
});
