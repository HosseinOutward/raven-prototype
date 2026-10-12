import type { ProfileKnockState } from "@/lib/api";

export function profileKnockPresentation(state: ProfileKnockState | undefined, now: number) {
  if (!state || now >= Date.parse(state.retryAt)) {
    return { disabled: false, label: "Knock", description: "A knock asks without demanding. They can answer, or leave it." };
  }
  if (state.state === "pending" && now < Date.parse(state.expiresAt)) {
    const minutes = Math.max(1, Math.ceil((Date.parse(state.expiresAt) - now) / 60_000));
    return { disabled: true, label: "Knock sent", description: `Waiting for an answer. Expires in ${minutes} min. After dismissal or expiry, wait one minute before knocking again.` };
  }
  const seconds = Math.max(1, Math.ceil((Date.parse(state.retryAt) - now) / 1000));
  const expired = state.state === "pending" || state.outcome === "expired";
  return {
    disabled: true,
    label: `Knock in ${seconds}s`,
    description: expired ? "Your knock expired. Give them a moment before knocking again." : "Your knock was dismissed. Give them a moment before knocking again.",
  };
}
