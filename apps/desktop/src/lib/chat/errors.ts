// How the chat code reads a failed request.
//
// It looks at the shape of the error (`ApiError` has a `status`) rather than importing
// the API client, so this folder stays free of the client's import-time setup and its
// logic can be tested on its own.

export interface HttpFailure extends Error {
  status: number;
  /** How long the server asked to wait before trying again. */
  retryAfterSeconds?: number;
}

export function isHttpFailure(error: unknown): error is HttpFailure {
  return error instanceof Error && typeof (error as Partial<HttpFailure>).status === "number";
}

/** The HTTP status of a failed request, or null when it never got an answer. */
export function httpStatusOf(error: unknown): number | null {
  return isHttpFailure(error) ? error.status : null;
}

/** What to show for a failed action: the server's own words when it gave any. */
export function failureText(error: unknown, fallback: string): string {
  if (isHttpFailure(error) && error.message) return error.message;
  return fallback;
}
