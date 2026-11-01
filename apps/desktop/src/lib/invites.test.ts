import { describe, expect, test } from "bun:test";
import { accountsOffered, inviteMessage } from "./invites";

describe("accountsOffered", () => {
  test("an older server offers nothing", () => {
    expect(accountsOffered({ properties: {} })).toEqual({ signUp: false, invitations: false });
    expect(accountsOffered(null)).toEqual({ signUp: false, invitations: false });
  });

  test("reads the server's switches", () => {
    expect(accountsOffered({ properties: { accounts: { signUp: true, invitations: false } } })).toEqual({ signUp: true, invitations: false });
    expect(accountsOffered({ properties: { accounts: { signUp: "yes", invitations: true } } })).toEqual({ signUp: false, invitations: true });
  });
});

describe("inviteMessage", () => {
  test("holds the server, the code and the date", () => {
    const message = inviteMessage("https://raven.example.org", "ABCDE-12345", "2026-11-09T12:00:00Z", "en-GB");
    expect(message).toBe("Join me on Raven.\nServer: https://raven.example.org\nInvite code: ABCDE-12345\nIt works once, until 9 November 2026.");
  });
});
