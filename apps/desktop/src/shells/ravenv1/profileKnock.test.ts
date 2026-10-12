import { expect, test } from "bun:test";
import type { ProfileKnockState } from "@/lib/api";
import { profileKnockPresentation } from "./profileKnock";

const base = Date.parse("2026-10-12T00:00:00Z");
const state: ProfileKnockState = {
  userId: "bob", state: "pending", outcome: "pending",
  expiresAt: new Date(base + 900_000).toISOString(),
  retryAt: new Date(base + 960_000).toISOString(),
};

test("sent knocks stay disabled, expire into cooldown, then become available without a reload", () => {
  expect(profileKnockPresentation(state, base)).toMatchObject({ disabled: true, label: "Knock sent" });
  expect(profileKnockPresentation(state, base).description).toContain("Expires in 15 min");
  expect(profileKnockPresentation(state, base + 900_000)).toMatchObject({ disabled: true, label: "Knock in 60s" });
  expect(profileKnockPresentation(state, base + 959_999)).toMatchObject({ disabled: true, label: "Knock in 1s" });
  expect(profileKnockPresentation(state, base + 960_000)).toMatchObject({ disabled: false, label: "Knock" });
});

test("dismissal replaces the pending state with a shorter cooldown", () => {
  const dismissed = { ...state, state: "cooldown" as const, outcome: "dismissed" as const, retryAt: new Date(base + 60_000).toISOString() };
  expect(profileKnockPresentation(dismissed, base + 15_000)).toMatchObject({ disabled: true, label: "Knock in 45s" });
  expect(profileKnockPresentation(dismissed, base).description).toContain("dismissed");
  expect(profileKnockPresentation(dismissed, base + 60_000).disabled).toBe(false);
  expect(profileKnockPresentation(undefined, base).disabled).toBe(false);
});
