// Answers to a knock on a person, and every sentence either side reads about them.
// The rule (raven-ui writing.md, "Answers that affect someone else"): each answer says,
// before it is chosen, what the other person sees, what they can do next and until when,
// as a real clock time. Every surface takes its words from here; do not write them
// anywhere else.

import type { KnockReply, ProfileKnockState } from "@/lib/api";
import { clockTime } from "@/lib/chat/time";
import type { SeenKnocks } from "@/lib/notifications";
import type { PendingItem } from "./state";

const MINUTE = 60_000;

function startOfDay(time: number) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** "15:32" today, "04:00 tomorrow", "10:00 Wednesday" further on. Always a real time. */
export function formatWhen(at: Date | string, now: Date): string {
  const time = typeof at === "string" ? Date.parse(at) : at.getTime();
  const clock = clockTime(new Date(time).toISOString());
  const days = Math.round((startOfDay(time) - startOfDay(now.getTime())) / (24 * 60 * MINUTE));
  if (days <= 0) return clock;
  if (days === 1) return `${clock} tomorrow`;
  return `${clock} ${new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(time)}`;
}

/** The fixed choices under Ask me later…, each naming the exact time it means. */
export function laterChoices(now: Date): { label: string; until: Date }[] {
  return [
    [30, "In 30 min"],
    [60, "In 1 hour"],
    [120, "In 2 hours"],
    [240, "In 4 hours"],
  ].map(([minutes, words]) => {
    const until = new Date(now.getTime() + (minutes as number) * MINUTE);
    return { label: `${words} · ${formatWhen(until, now)}`, until };
  });
}

/** The time picked in "Pick a time…": its next occurrence, or null if under 15 min away. */
export function pickedTime(hhmm: string, now: Date): Date | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime() - now.getTime() < 15 * MINUTE ? null : at;
}

/** Not today holds until the next 04:00 that is at least six hours away. */
export function notTodayUntil(now: Date): Date {
  const at = new Date(now);
  at.setHours(4, 0, 0, 0);
  while (at.getTime() - now.getTime() < 6 * 60 * MINUTE) at.setDate(at.getDate() + 1);
  return at;
}

/** The longest note a message answer can carry. */
export const KNOCK_MESSAGE_MAX = 140;

/** When an answer holds until. Ask me later and a message have no time of their own: the answerer picks it. */
export function answerUntil(reply: Exclude<KnockReply, "later" | "message">, now: Date): Date {
  if (reply === "coming") return new Date(now.getTime() + 5 * MINUTE);
  if (reply === "soon") return new Date(now.getTime() + 10 * MINUTE);
  return notTodayUntil(now);
}

// ---- The person knocked on ----

export const answerLabels: Record<KnockReply, string> = {
  coming: "Coming now",
  soon: "Coming in 10 min",
  later: "Ask me later…",
  not_today: "Not today",
  message: "Send a message…",
};

/** The line under each answer in the menu: what {name} sees, what they can do, until when. */
export function answerHint(reply: KnockReply, name: string, now: Date): string {
  if (reply === "coming") return `${name} sees that you’re on your way.`;
  if (reply === "soon") return `${name} sees you’ll come at ${formatWhen(answerUntil("soon", now), now)}. They can knock again then.`;
  if (reply === "later") return `Pick a time. ${name} can’t knock before it, and Raven reminds them then.`;
  if (reply === "message") return `Write ${name} a short note, and choose whether they can knock again.`;
  return `${name} sees you can’t today. They can knock again from ${formatWhen(notTodayUntil(now), now)}.`;
}

export function dismissHint(name: string, expiresAt: string, now: Date): string {
  return `Only clears your list. ${name} isn’t told, and their knock ends at ${formatWhen(expiresAt, now)}.`;
}

/** The overlay's knock card has no expiry to name, so its hint leaves the time out. */
export function overlayRemoveHint(name: string) {
  return `Only clears your list. ${name} isn’t told.`;
}

/** The first line of the Ask me later… choices: what the pick controls. */
export function laterHeading(name: string) {
  return `${name} can knock again at:`;
}

/** The question above the choices in the message dialog. */
export function messageHoldQuestion(name: string) {
  return `Can ${name} knock again?`;
}

/** What {name} will see and be able to do, said under the message before it is sent. */
export function messageSummary(name: string, until: Date | null, now: Date): string {
  return until
    ? `${name} sees your note and can’t knock before ${formatWhen(until, now)}. Raven won’t remind them.`
    : `${name} sees your note and can knock again any time.`;
}

/** What was sent, said once the answer has gone. */
export function answerToast(reply: KnockReply, name: string, until: Date, now: Date): string {
  if (reply === "coming") return `Told ${name} you’re coming.`;
  if (reply === "soon") return `Told ${name} you’ll come at ${formatWhen(until, now)}.`;
  if (reply === "later") return `Raven will remind ${name} at ${formatWhen(until, now)}.`;
  if (reply === "message") {
    return until.getTime() > now.getTime() ? `Sent ${name} your note. They can’t knock before ${formatWhen(until, now)}.` : `Sent ${name} your note.`;
  }
  return `Told ${name} not today.`;
}

/** The overlay has no room for hints, so its labels carry the time themselves. */
export function overlayAnswers(name: string, now: Date): { reply: KnockReply; label: string; hint: string; until?: Date }[] {
  const inAnHour = laterChoices(now)[1].until;
  return [
    { reply: "coming", label: "Coming now", hint: answerHint("coming", name, now) },
    { reply: "soon", label: `Coming at ${formatWhen(answerUntil("soon", now), now)}`, hint: answerHint("soon", name, now) },
    {
      reply: "later",
      label: `Ask again at ${formatWhen(inAnHour, now)}`,
      hint: `${name} can’t knock before ${formatWhen(inAnHour, now)}, and Raven reminds them then.`,
      until: inAnHour,
    },
    { reply: "not_today", label: "Not today", hint: answerHint("not_today", name, now), until: notTodayUntil(now) },
  ];
}

// ---- The person who knocked ----

export interface KnockerView {
  disabled: boolean;
  label: string;
  description: string;
  /** The line in "Reaching you" and in a notification, when there is an answer to show. */
  answerLine?: string;
}

/** A Later whose time has come reads as the reminder even before the next refresh. */
export function isReminderDue(state: ProfileKnockState, now: number) {
  return state.state === "reminder" || (state.state === "replied" && state.reply === "later" && now >= Date.parse(state.retryAt));
}

/** What the knock button and its description say, for each state of a knock you sent. */
export function knockerView(state: ProfileKnockState | undefined, name: string, now: number): KnockerView {
  const at = new Date(now);
  if (state && isReminderDue(state, now)) {
    const line = `${name} asked you to knock again now.`;
    return { disabled: false, label: "Knock", description: line, answerLine: line };
  }
  if (state?.state === "replied" && state.reply === "message") {
    // The note shows for a while, also after the knocker may knock again.
    const held = now < Date.parse(state.retryAt);
    const when = formatWhen(state.retryAt, at);
    const note = `${name} wrote: “${state.message ?? ""}”`;
    const line = held ? `${note}. You can knock again at ${when}.` : note;
    return { disabled: held, label: held ? `Knock at ${when}` : "Knock", description: line, answerLine: line };
  }
  if (!state || now >= Date.parse(state.retryAt)) {
    return { disabled: false, label: "Knock", description: `A knock asks without demanding. ${name} can answer, or leave it.` };
  }
  if (state.state === "replied" && state.reply) {
    const when = formatWhen(state.retryAt, at);
    if (state.reply === "coming") {
      const line = `${name} is coming now.`;
      return { disabled: true, label: "On the way", description: line, answerLine: line };
    }
    if (state.reply === "soon") {
      const line = `${name} will come at ${when}. You can knock again then.`;
      return { disabled: true, label: `Coming at ${when}`, description: line, answerLine: line };
    }
    if (state.reply === "later") {
      const line = `${name} asked you to knock again at ${when}. Raven will remind you then.`;
      return { disabled: true, label: `Knock at ${when}`, description: line, answerLine: line };
    }
    const line = `${name} can’t today. You can knock again from ${when}.`;
    return { disabled: true, label: "Not today", description: line, answerLine: line };
  }
  if (state.state === "pending" && now < Date.parse(state.expiresAt)) {
    return { disabled: true, label: "Knock sent", description: `No answer. Raven doesn’t say whether ${name} saw it. The knock ends at ${formatWhen(state.expiresAt, at)}.` };
  }
  const seconds = Math.max(1, Math.ceil((Date.parse(state.retryAt) - now) / 1000));
  return {
    disabled: true,
    label: `Knock in ${seconds}s`,
    description: `Your knock ended without an answer. You can knock again in ${seconds} s.`,
  };
}

type AnswerItem = Extract<PendingItem, { kind: "answer" }>;

/** Answers to knocks you sent, as lines in "Reaching you". */
export function knockAnswers(states: ReadonlyArray<ProfileKnockState>, now: number): AnswerItem[] {
  const items: AnswerItem[] = [];
  for (const state of states) {
    if (!state.knockId || (state.state !== "replied" && state.state !== "reminder")) continue;
    const name = state.name || "They";
    const line = knockerView(state, name, now).answerLine;
    if (!line) continue;
    const reminder = isReminderDue(state, now);
    items.push({ id: state.knockId, kind: "answer", from: name, fromId: state.userId, context: line, key: `${state.knockId}:${reminder ? "reminder" : "replied"}`, reminder });
  }
  return items;
}

/**
 * Which answers are new since the last home load, for notifications. Like new knocks,
 * the first load only records what is there, so a restart never replays an answer.
 */
export function newKnockAnswers(
  seen: SeenKnocks | null,
  userId: string,
  states: ReadonlyArray<ProfileKnockState>,
  now: number,
): { seen: SeenKnocks; fresh: { name: string; line: string }[] } {
  const items = knockAnswers(states, now);
  const ids = new Set(items.map((item) => item.key));
  if (!seen || seen.userId !== userId) return { seen: { userId, ids }, fresh: [] };
  const fresh = items.filter((item) => !seen.ids.has(item.key)).map((item) => ({ name: item.from, line: item.context }));
  return { seen: { userId, ids }, fresh };
}
