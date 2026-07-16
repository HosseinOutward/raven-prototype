# Raven updater signing custody

Raven uses Tauri's updater signature trust model. Windows Authenticode and OS-level AppImage signing are separate and intentionally postponed.

## Current identity

- Private key: `%USERPROFILE%\.raven\updater\raven-updater.key`
- Public key: `%USERPROFILE%\.raven\updater\raven-updater.key.pub`
- DPAPI-protected password: `%USERPROFILE%\.raven\updater\raven-updater.password.dpapi`
- Embedded trust root: `apps/desktop/src-tauri/tauri.conf.json`

The private directory ACL must grant only the current Windows user. The release CLI compares the complete local public-key file with the embedded trust root before every signature. A mismatch fails closed. The plaintext password file used during bootstrap was removed after a successful sign test and DPAPI migration.

The private key and password must never be placed in the repository, `.env`, S3, the backend, the operations frontend, or the homelab. Tauri signing runs only after the Linux artifact returns to the workstation.

## Encrypted offline backup

DPAPI is not a portable backup. It is tied to the current Windows identity and workstation.

Create two offline encrypted copies:

1. Mount an encrypted removable volume that is not continuously connected.
2. Copy `raven-updater.key` and `raven-updater.key.pub` into the encrypted volume.
3. Decrypt the DPAPI password in memory and write it directly into the mounted encrypted volume without printing it or placing it in an unencrypted temporary path.
4. Store a second encrypted copy in a physically separate location.
5. Keep the encryption recovery material separate from both copies.
6. On an offline test machine, restore the key and password, sign a disposable file, and verify it with `tools/release/signature-verify` and the committed public key.
7. Unmount both encrypted volumes.

Record the backup date and verification result without recording the password or private-key content.

## Loss and rotation

Losing the private key prevents existing installations from trusting future updates. Do not generate a replacement as a routine fix.

Key rotation requires an old-key-signed bridge release that embeds the new public key, followed by verified adoption before releases are signed only with the new key. If the old key is suspected compromised, pause all channels, withdraw affected discovery, publish a clear recovery notice, and use manual recovery installation until a reviewed trust migration exists.

Do not overwrite the current key files during investigation.

