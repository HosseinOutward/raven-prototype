export type MessageChoice = "erase" | "keep";

/** The name the server gives a copy of someone's data, so a saved file reads the same. */
export function exportFileName(username: string, now: Date): string {
  return `raven-${username}-${now.toISOString().slice(0, 10)}.zip`;
}

/** The file's own name from the path the save dialog returned, for the toast. */
export function savedFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** The delete button is live only when every question is answered. */
export function canDeleteAccount(input: { choice: MessageChoice | null; typed: string; username: string; password: string }): boolean {
  return input.choice !== null && input.typed === input.username && input.password.length > 0;
}

/** The clock time to try again at, in the reader's own clock, from a `Retry-After` in seconds. */
export function retryTime(retryAfterSeconds: number | undefined, now: Date): string {
  const at = new Date(now.getTime() + Math.max(retryAfterSeconds ?? 0, 0) * 1000);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** What to tell someone whose download did not happen. */
export function exportErrorText(error: { status?: number; message: string; retryAfterSeconds?: number }, now: Date): string {
  if (error.status === 429) return `You’ve downloaded 3 copies this hour. Try again at ${retryTime(error.retryAfterSeconds, now)}.`;
  return `Couldn’t prepare your copy. Nothing was saved. ${error.message} Try again in a minute.`;
}

/** What to tell someone whose account was not deleted. */
export function deleteErrorText(error: { status?: number; message: string }): string {
  if (error.status === 403) return "That isn’t your password. Your account wasn’t deleted.";
  return `Couldn’t delete your account. Nothing was changed. ${error.message}`;
}
