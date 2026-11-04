import { describe, expect, test } from "bun:test";
import { callVoteHeadline, canCastBallot, isVotedOut, mergeCallVote, parseCallVote, type CallVote } from "./callVote";

const vote: CallVote = {
  id: "v1",
  nestId: "n1",
  targetId: "alex",
  targetName: "Alex",
  starterId: "sara",
  starterName: "Sara",
  yes: 1,
  needed: 2,
  total: 3,
  remainingMs: 30000,
  outcome: "open",
};

describe("parseCallVote", () => {
  test("accepts a whole vote and refuses anything else", () => {
    expect(parseCallVote(vote)?.id).toBe("v1");
    expect(parseCallVote(undefined)).toBeUndefined();
    expect(parseCallVote({ ...vote, yes: "1" })).toBeUndefined();
    expect(parseCallVote({ ...vote, outcome: "maybe" })).toBeUndefined();
  });
});

describe("mergeCallVote", () => {
  test("sets the deadline once, on the local clock", () => {
    const first = mergeCallVote(null, vote, 1000);
    expect(first.deadline).toBe(31000);
    expect(mergeCallVote(first, { ...vote, remainingMs: 2000 }, 9000).deadline).toBe(31000);
  });

  test("an older update cannot undo a newer one", () => {
    const voted = mergeCallVote(null, { ...vote, yes: 2, voted: true, outcome: "passed" }, 0);
    const late = mergeCallVote(voted, vote, 10);
    expect(late.yes).toBe(2);
    expect(late.voted).toBe(true);
    expect(late.outcome).toBe("passed");
  });

  test("a new vote replaces the old one", () => {
    const old = mergeCallVote(null, { ...vote, voted: true }, 0);
    const next = mergeCallVote(old, { ...vote, id: "v2" }, 0);
    expect(next.id).toBe("v2");
    expect(next.voted).toBe(false);
  });
});

describe("what each person sees", () => {
  const held = mergeCallVote(null, vote, 0);

  test("voters get buttons until they vote; the target never does", () => {
    expect(canCastBallot(held, "carol")).toBe(true);
    expect(canCastBallot({ ...held, voted: true }, "carol")).toBe(false);
    expect(canCastBallot(held, "alex")).toBe(false);
    expect(canCastBallot({ ...held, outcome: "failed" }, "carol")).toBe(false);
  });

  test("the headline names who started it and speaks to the target", () => {
    expect(callVoteHeadline(vote, "carol")).toBe("Sara started a vote to remove Alex from this call");
    expect(callVoteHeadline(vote, "sara")).toBe("You started a vote to remove Alex from this call");
    expect(callVoteHeadline(vote, "alex")).toBe("People are voting on removing you from this call. Sara started it.");
    expect(callVoteHeadline({ ...vote, outcome: "failed" }, "alex")).toBe("The vote to remove you didn’t pass.");
    expect(callVoteHeadline({ ...vote, outcome: "passed" }, "carol")).toBe("Alex was voted out of this call.");
  });

  test("only the target is voted out, and only by a pass", () => {
    expect(isVotedOut({ ...vote, outcome: "passed" }, "alex")).toBe(true);
    expect(isVotedOut({ ...vote, outcome: "passed" }, "carol")).toBe(false);
    expect(isVotedOut(vote, "alex")).toBe(false);
  });
});
