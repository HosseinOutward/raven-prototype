# Raven 0.1.7

## New

- Raven has a new logo: a speech bubble that is also a raven's head. It replaces the app icon, the taskbar icon and the browser tab icon.
- The page where friends download Raven for the first time now lives at the front door of the updates address, so there is one link to send to a new friend.

## Fixed

- "What's new" on the Updates page now shows real headings, lists and formatting. Before, you saw the raw text with `#` and `**` marks in it.
- A harmless browser notice that the chat list produced while you scrolled no longer fills Raven's error log, which makes real problems easier to find if you send the log to Soroush.

## For people who run their own Raven server

- The server can now keep chat pictures and other media in a plain folder on its disk, set with `RAVEN_MEDIA_DIR`, instead of needing an S3-style store.
- Ready-made server images for Raven and its admin page are on Docker Hub (`soroushtaheri/raven-api` and `soroushtaheri/raven-admin`), for amd64 and arm64, together with a ready-to-run self-hosting bundle. The guide is `docs/self-hosting.md`.
