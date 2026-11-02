import { expect, test } from "bun:test";
import type { ProfileKnockState } from "@/lib/api";
import { clockTime } from "@/lib/chat/time";
import {
  answerHint,
  answerToast,
  dismissHint,
  formatWhen,
  knockAnswers,
  knockerView,
  laterChoices,
  messageSummary,
  newKnockAnswers,
  notTodayUntil,
  overlayAnswers,
  pickedTime,
} from "./knockReplies";

// Local times, so the tests hold in any time zone.
const at = (day: number, hours: number, minutes = 0) => new Date(2026, 10, day, hours, minutes);
const clock = (date: Date) => clockTime(date.toISOString());

test("times are always a real clock time, with the day when it is not today", () => {
  const now = at(2, 23, 0);
  expect(formatWhen(at(2, 23, 30), now)).toBe(clock(at(2, 23, 30)));
  expect(formatWhen(at(3, 0, 0), now)).toBe(`${clock(at(3, 0, 0))} tomorrow`);
  const later = at(4, 10, 0);
  expect(formatWhen(later, now)).toBe(`${clock(later)} ${new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(later)}`);
});

test("Ask me later choices name their exact time, across midnight too", () => {
  const choices = laterChoices(at(2, 23, 0));
  expect(choices.map((choice) => choice.label)).toEqual([
    `In 30 min · ${clock(at(2, 23, 30))}`,
    `In 1 hour · ${clock(at(3, 0, 0))} tomorrow`,
    `In 2 hours · ${clock(at(3, 1, 0))} tomorrow`,
    `In 4 hours · ${clock(at(3, 3, 0))} tomorrow`,
  ]);
});

test("a picked time is its next occurrence, at least 15 minutes away", () => {
  const now = at(2, 14, 0);
  expect(pickedTime("18:30", now)).toEqual(at(2, 18, 30));
  expect(pickedTime("09:00", now)).toEqual(at(3, 9, 0));
  expect(pickedTime("14:10", now)).toBeNull();
  expect(pickedTime("14:15", now)).toEqual(at(2, 14, 15));
  expect(pickedTime("13:59", now)).toEqual(at(3, 13, 59));
  expect(pickedTime("25:00", now)).toBeNull();
  expect(pickedTime("noon", now)).toBeNull();
});

test("Not today holds until the next 04:00 at least six hours away", () => {
  expect(notTodayUntil(at(2, 2, 0))).toEqual(at(3, 4, 0));
  expect(notTodayUntil(at(2, 3, 59))).toEqual(at(3, 4, 0));
  expect(notTodayUntil(at(2, 10, 0))).toEqual(at(3, 4, 0));
  expect(notTodayUntil(at(2, 23, 0))).toEqual(at(4, 4, 0));
  expect(notTodayUntil(at(1, 21, 0))).toEqual(at(2, 4, 0));
});

test("each answer says what Sara sees and until when", () => {
  const now = at(2, 14, 32);
  expect(answerHint("coming", "Sara", now)).toBe("Sara sees that you’re on your way.");
  expect(answerHint("soon", "Sara", now)).toBe(`Sara sees you’ll come at ${clock(at(2, 14, 42))}. They can knock again then.`);
  expect(answerHint("later", "Sara", now)).toBe("Pick a time. Sara can’t knock before it, and Raven reminds them then.");
  expect(answerHint("not_today", "Sara", now)).toBe(`Sara sees you can’t today. They can knock again from ${clock(at(3, 4, 0))} tomorrow.`);
  expect(dismissHint("Sara", at(2, 14, 47).toISOString(), now)).toBe(`Clears it for you. Sara isn’t told and sees “No answer yet” until ${clock(at(2, 14, 47))}.`);
  expect(answerToast("soon", "Sara", at(2, 14, 42), now)).toBe(`Told Sara you’ll come at ${clock(at(2, 14, 42))}.`);
  expect(answerToast("later", "Sara", at(2, 16, 32), now)).toBe(`Raven will remind Sara at ${clock(at(2, 16, 32))}.`);
  expect(answerToast("coming", "Sara", now, now)).toBe("Told Sara you’re coming.");
  expect(answerToast("not_today", "Sara", now, now)).toBe("Told Sara not today.");
  expect(overlayAnswers("Sara", now).map((answer) => answer.label)).toEqual([
    "Coming now",
    `Coming at ${clock(at(2, 14, 42))}`,
    `Ask again at ${clock(at(2, 15, 32))}`,
    "Not today",
  ]);
});

const base = at(2, 14, 0).getTime();
const sent: ProfileKnockState = {
  userId: "sara", state: "pending", outcome: "pending",
  expiresAt: new Date(base + 900_000).toISOString(),
  retryAt: new Date(base + 960_000).toISOString(),
};

test("a sent knock waits, ends quietly, then can be sent again without a reload", () => {
  expect(knockerView(sent, "Sara", base)).toMatchObject({ disabled: true, label: "Knock sent", description: `No answer yet. The knock ends quietly at ${clock(at(2, 14, 15))}.` });
  expect(knockerView(sent, "Sara", base + 900_000)).toMatchObject({ disabled: true, label: "Knock in 60s" });
  expect(knockerView(sent, "Sara", base + 959_999)).toMatchObject({ disabled: true, label: "Knock in 1s" });
  expect(knockerView(sent, "Sara", base + 960_000)).toMatchObject({ disabled: false, label: "Knock" });
  expect(knockerView(undefined, "Sara", base).disabled).toBe(false);
});

test("the knocker reads each answer with its time", () => {
  const replied = (reply: ProfileKnockState["reply"], until: Date): ProfileKnockState => ({
    ...sent, state: "replied", reply, replyUntil: until.toISOString(), retryAt: until.toISOString(),
  });
  expect(knockerView(replied("coming", at(2, 14, 5)), "Sara", base)).toMatchObject({ disabled: true, label: "On the way", answerLine: "Sara is coming now." });
  expect(knockerView(replied("soon", at(2, 14, 10)), "Sara", base)).toMatchObject({
    label: `Coming at ${clock(at(2, 14, 10))}`,
    answerLine: `Sara will come at ${clock(at(2, 14, 10))}. You can knock again then.`,
  });
  expect(knockerView(replied("later", at(2, 16, 0)), "Sara", base)).toMatchObject({
    disabled: true,
    label: `Knock at ${clock(at(2, 16, 0))}`,
    answerLine: `Sara asked you to knock again at ${clock(at(2, 16, 0))}. Raven will remind you then.`,
  });
  expect(knockerView(replied("not_today", at(3, 4, 0)), "Sara", base)).toMatchObject({
    label: "Not today",
    answerLine: `Sara can’t today. You can knock again from ${clock(at(3, 4, 0))} tomorrow.`,
  });
  // A Later whose time has come is the reminder, before the server says so.
  expect(knockerView(replied("later", at(2, 16, 0)), "Sara", at(2, 16, 0).getTime())).toMatchObject({ disabled: false, label: "Knock", answerLine: "Sara asked you to knock again now." });
  expect(knockerView({ ...replied("later", at(2, 13, 0)), state: "reminder" }, "Sara", base)).toMatchObject({ disabled: false, answerLine: "Sara asked you to knock again now." });
});

test("no wording leaves a vague time or says the knock was dismissed", () => {
  const now = at(2, 14, 32);
  const lines = [
    ...(["coming", "soon", "later", "not_today"] as const).map((reply) => answerHint(reply, "Sara", now)),
    ...overlayAnswers("Sara", now).flatMap((answer) => [answer.label, answer.hint]),
    knockerView(sent, "Sara", base).description,
  ];
  for (const line of lines) expect(line).not.toMatch(/evening|soon|in a bit|dismissed|ignored/i);
});

test("answers become lines, and only new ones become notifications", () => {
  const soon: ProfileKnockState = {
    ...sent, knockId: "k1", name: "Sara", state: "replied", reply: "later",
    replyUntil: at(2, 16, 0).toISOString(), retryAt: at(2, 16, 0).toISOString(),
  };
  expect(knockAnswers([sent, soon], base).map((item) => [item.key, item.from, item.reminder])).toEqual([["k1:replied", "Sara", false]]);
  const first = newKnockAnswers(null, "me", [soon], base);
  expect(first.fresh).toEqual([]);
  expect(newKnockAnswers(first.seen, "me", [soon], base).fresh).toEqual([]);
  const due = newKnockAnswers(first.seen, "me", [soon], at(2, 16, 0).getTime());
  expect(due.fresh).toEqual([{ name: "Sara", line: "Sara asked you to knock again now." }]);
});

test("a message says what the knocker sees, and holds them back only when a time was picked", () => {
  const now = at(2, 14, 0);
  expect(messageSummary("Sara", null, now)).toBe("Sara sees your note and can knock again any time.");
  expect(messageSummary("Sara", at(2, 16, 0), now)).toBe(`Sara sees your note and can’t knock before ${clock(at(2, 16, 0))}. Raven won’t remind them.`);
  expect(answerToast("message", "Sara", now, now)).toBe("Sent Sara your note.");
  expect(answerToast("message", "Sara", at(2, 16, 0), now)).toBe(`Sent Sara your note. They can’t knock before ${clock(at(2, 16, 0))}.`);

  const note: ProfileKnockState = {
    ...sent, knockId: "k2", name: "Sara", state: "replied", reply: "message", message: "In a meeting",
    replyUntil: at(2, 16, 0).toISOString(), retryAt: at(2, 16, 0).toISOString(),
  };
  expect(knockerView(note, "Sara", base)).toMatchObject({
    disabled: true,
    label: `Knock at ${clock(at(2, 16, 0))}`,
    answerLine: `Sara wrote: “In a meeting”. You can knock again at ${clock(at(2, 16, 0))}.`,
  });
  // Once the hold passes, or with none, the note stays and Knock works.
  expect(knockerView(note, "Sara", at(2, 16, 0).getTime())).toMatchObject({ disabled: false, label: "Knock", answerLine: "Sara wrote: “In a meeting”" });
  expect(knockAnswers([note], base).map((item) => item.context)).toEqual([`Sara wrote: “In a meeting”. You can knock again at ${clock(at(2, 16, 0))}.`]);
});
