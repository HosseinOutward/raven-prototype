/** Fold Raven's native media roles into the user identity shown by the UI. */
export function stripSidecarIdentity(identity: string) {
  if (identity.endsWith("#audio")) return identity.slice(0, -"#audio".length);
  if (identity.endsWith("#video")) return identity.slice(0, -"#video".length);
  return identity;
}
