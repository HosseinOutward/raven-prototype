# Raven manual update recovery

Manual recovery is for an updater that cannot safely complete or for a signing-key incident. It is not a silent fallback.

1. Keep Raven closed after leaving any active Nest, call flow, publication, screen share, or device setup.
2. Export or back up critical local Raven state before a migration marked irreversible.
3. Obtain the recovery installer or AppImage through the authenticated Raven recovery surface or an operator-provided URL.
4. Verify the published SHA-256 through a separate authenticated Raven channel.
5. On Windows, run the NSIS installer deliberately. No Authenticode identity is promised during closed alpha; the Tauri updater signature remains the in-app trust mechanism.
6. On Linux, make the AppImage executable and launch it from a new versioned path. Do not replace the prior file until startup health is confirmed.
7. Sign in, inspect Update Diagnostics, and confirm compatibility before joining a Nest.

Never install a blocked version or use a predecessor that is no longer protocol-compatible. Preserve the failed installer, redacted diagnostics, installed and target versions, and coarse error category until the incident is resolved.

