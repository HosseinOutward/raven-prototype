// How times are written in conversations. These are the times of messages, shown as
// plain facts; nothing here says when a person was last around.

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function valid(iso: string): number | null {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : null;
}

/** "10:42", in the person's own clock style. */
export function clockTime(iso: string): string {
  const time = valid(iso);
  return time === null ? "" : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(time);
}

/** "11 October 2026, 10:42", for a tooltip. */
export function fullTime(iso: string): string {
  const time = valid(iso);
  return time === null ? "" : new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" }).format(time);
}

export function sameDay(a: string, b: string): boolean {
  const first = valid(a);
  const second = valid(b);
  return first !== null && second !== null && startOfDay(first) === startOfDay(second);
}

/** The heading between messages of different days: "Today", "Yesterday", "Monday", "3 March". */
export function dayLabel(iso: string, now = Date.now()): string {
  const time = valid(iso);
  if (time === null) return "";
  const days = Math.round((startOfDay(now) - startOfDay(time)) / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(time);
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(undefined, sameYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" }).format(time);
}

/** The short time beside a conversation in a list: "10:42", "Mon", "3 Mar", "3 Mar 2025". */
export function listTime(time: number, now = Date.now()): string {
  if (!Number.isFinite(time) || time <= 0) return "";
  const days = Math.round((startOfDay(now) - startOfDay(time)) / DAY_MS);
  if (days <= 0) return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(time);
  if (days < 7) return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(time);
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(undefined, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }).format(time);
}
