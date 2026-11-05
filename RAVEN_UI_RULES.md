# Raven UI Rules

Raven UI direction:

- Dark canvas with rounded surface containers.
- Surface containers on the dark canvas should not use visible borders unless there is a strong interaction reason.
- Prefer polished production UX language over prototype/debug labels.
- Avoid native-looking controls. Use shadcn components consistently.
- Keep the persistent bottom media controls visually primary.
- Nests/rooms are the active communication unit. Trees/spaces are the social container.
- Do not introduce broad redesigns unless explicitly requested.
- Preserve existing architecture unless a change is necessary.

## Workshop copy

The Workshop (Settings › Workshop) holds power-user features that are off until a person turns them on. Their wording differs from the rest of Raven:

- Under every Workshop switch, on or off, say in full sentences what the feature does, the protocol it uses, the encryption on each leg, the route the data takes, and who can read it. Name the real things (QUIC, TLS 1.3, TCP, UDP, 127.0.0.1, a relay, a CDN).
- Do not explain basic terms such as what a port is or what encryption means. The reader chose this section.
- Say what is not protected as plainly as what is. Until end-to-end encryption exists, every port sharing panel states that the relay’s operator, and any CDN on the route that ends TLS, can read the forwarded bytes.
- Errors name the limit and its value ("You already share 3 ports, which is the most this server allows.").
