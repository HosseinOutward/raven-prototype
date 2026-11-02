import { describe, expect, test } from "bun:test";
import { canDeleteAccount, deleteErrorText, exportErrorText, exportFileName, retryTime, savedFileName } from "./accountExit";

describe("exportFileName", () => {
  test("names the file after the account and the day", () => {
    expect(exportFileName("ava", new Date("2026-11-02T23:30:00Z"))).toBe("raven-ava-2026-11-02.zip");
  });
});

describe("savedFileName", () => {
  test("keeps only the file's own name", () => {
    expect(savedFileName("C:\\Users\\Ava\\Downloads\\raven-ava-2026-11-02.zip")).toBe("raven-ava-2026-11-02.zip");
    expect(savedFileName("/home/ava/raven.zip")).toBe("raven.zip");
  });
});

describe("canDeleteAccount", () => {
  const ready = { choice: "keep" as const, typed: "ava", username: "ava", password: "secret" };
  test("needs a choice, the exact username and a password", () => {
    expect(canDeleteAccount(ready)).toBe(true);
    expect(canDeleteAccount({ ...ready, choice: null })).toBe(false);
    expect(canDeleteAccount({ ...ready, typed: "Ava" })).toBe(false);
    expect(canDeleteAccount({ ...ready, typed: "ava " })).toBe(false);
    expect(canDeleteAccount({ ...ready, password: "" })).toBe(false);
  });
});

describe("retryTime", () => {
  test("adds the wait to the reader's clock", () => {
    const now = new Date(2026, 10, 2, 9, 5, 0);
    expect(retryTime(125, now)).toBe("09:07");
    expect(retryTime(undefined, now)).toBe("09:05");
  });
});

describe("error copy", () => {
  const now = new Date(2026, 10, 2, 9, 5, 0);
  test("a download that was refused for being too often names the time", () => {
    expect(exportErrorText({ status: 429, message: "x", retryAfterSeconds: 3600 }, now)).toBe("You’ve downloaded 3 copies this hour. Try again at 10:05.");
  });
  test("any other download failure says nothing was saved and shows the server's words", () => {
    expect(exportErrorText({ status: 500, message: "Boom." }, now)).toBe("Couldn’t prepare your copy. Nothing was saved. Boom. Try again in a minute.");
  });
  test("a wrong password is told apart from other failures", () => {
    expect(deleteErrorText({ status: 403, message: "x" })).toBe("That isn’t your password. Your account wasn’t deleted.");
    expect(deleteErrorText({ status: 409, message: "Leave the call first." })).toBe("Couldn’t delete your account. Nothing was changed. Leave the call first.");
  });
});
