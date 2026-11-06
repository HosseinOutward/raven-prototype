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

- Be short and technical. Name the real things (QUIC, TLS 1.3, TCP, UDP, `127.0.0.1`, relay, CDN) and use them as labels and values, not inside long sentences.
- Under every Workshop switch, on or off, show what the feature does in one line, then the facts as label and value rows: route, transport, end-to-end encryption, what is reachable, lifetime. No paragraphs.
- Do not explain basic terms (what a port or encryption is). The reader chose this section.
- Say what is not protected as plainly as what is, in one line. Until end-to-end encryption exists, every port sharing panel says: "Not end-to-end encrypted. The relay and any CDN that ends TLS can read forwarded traffic."
- Errors name the limit and its value: "You already share 3 ports, the most this server allows."
