import type { ServerProperties } from "./api";

/** Which ways in a server offers besides an administrator making the account. */
export interface AccountsOffered {
  signUp: boolean;
  invitations: boolean;
}

/** Reads `properties.accounts`; a server from before sign-up offers neither. */
export function accountsOffered(server: Pick<ServerProperties, "properties"> | null | undefined): AccountsOffered {
  const accounts = server?.properties?.accounts;
  if (!accounts || typeof accounts !== "object") return { signUp: false, invitations: false };
  const { signUp, invitations } = accounts as Record<string, unknown>;
  return { signUp: signUp === true, invitations: invitations === true };
}

/** The message an inviter sends a friend: everything needed to join, in one paste. */
export function inviteMessage(serverUrl: string, code: string, expiresAt: string, locale?: string): string {
  const date = new Date(expiresAt);
  const until = Number.isNaN(date.getTime()) ? "it expires" : date.toLocaleDateString(locale, { dateStyle: "long" });
  return `Join me on Raven.\nServer: ${serverUrl}\nInvite code: ${code}\nIt works once, until ${until}.`;
}
