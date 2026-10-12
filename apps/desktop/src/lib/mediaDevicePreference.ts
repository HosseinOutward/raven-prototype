/** Normalize a persisted native device id without turning malformed data into Default. */
export function normalizeSelectedDeviceId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Prefer the active source selection, falling back to the saved preference only when the source has no choice yet. */
export function selectedDeviceIdForSource(
  activeDeviceId: string | null | undefined,
  savedDeviceId: string | null | undefined,
) {
  return activeDeviceId ?? savedDeviceId ?? null;
}
