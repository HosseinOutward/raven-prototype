const HYPHENATED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fold Raven's native media roles into the user identity shown by the UI.
 *
 * User ids are 32 hex digits. The audio engine parses the LiveKit identity into a
 * UUID and reports it back hyphenated, so a remote speaker's audio id would never
 * match the user id the stage, the overlay and the video engine use.
 */
export function stripSidecarIdentity(identity: string) {
  let base = identity;
  if (base.endsWith("#audio")) base = base.slice(0, -"#audio".length);
  else if (base.endsWith("#video")) base = base.slice(0, -"#video".length);
  return HYPHENATED_UUID.test(base) ? base.replace(/-/g, "").toLowerCase() : base;
}
