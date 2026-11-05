# Workshop 02: WebSocket fallback for the relay

Builds on `01-port-sharing.md`. Read its Context, decisions and Stage B first: this plan adds a second route to the same relay, for networks and servers where UDP to the relay is blocked or the server sits behind a CDN that does not proxy raw QUIC.

## Design

- **Server:** `GET /relay/ws` upgrades to WebSocket, using `gofiber/contrib/websocket`. Over it runs `hashicorp/yamux` for streams, with a dedicated yamux stream carrying length-prefixed datagrams. The same `relay` logic runs behind a Go `Link` interface, so a QUIC consumer can reach a WSS publisher.
- **Client:** `WssLink` uses `tokio-tungstenite`, `ws_stream_tungstenite` and the `yamux` crate.
  - The client races the endpoints in the order the server lists them, starting QUIC first and WSS 300 ms later. It remembers the winner per server.
  - Keepalive runs every 20 s, under the CDN idle timeouts.
- **The UI route line for WSS through a CDN** names WebSocket over TLS on 443 and says that the CDN terminates TLS. Production's edge accepts only 80/tcp from ArvanCloud, so the leg from the CDN to the origin is plain HTTP, and the UI must say that too. It warns that UDP over this route adds delay.

## Verification

- Go tests: a yamux-over-WebSocket link round-trips a stream and a datagram, and a QUIC consumer reaches a WSS publisher through the relay.
- Rust test: endpoint racing picks WSS when the QUIC endpoint does not answer.
- Live, once: block UDP to the relay, check that the WSS route is chosen and that the share panel's route line names it, including the CDN's TLS ending.
- One `/code-review low` at the end.
