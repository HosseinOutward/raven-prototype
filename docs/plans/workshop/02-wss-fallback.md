# Workshop 02: WebSocket fallback for the relay

Builds on `01-port-sharing.md`. Read its Context, decisions and Stage B first: this plan adds a second route to the same relay, for networks and servers where UDP to the relay is blocked or the server sits behind a CDN that does not proxy raw QUIC.

## Design

- **Server:** `GET /relay/ws` upgrades to WebSocket, using `gofiber/contrib/websocket`. Over it runs `hashicorp/yamux` for streams, with a dedicated yamux stream carrying length-prefixed datagrams. The same `relay` logic runs behind a Go `Link` interface, so a QUIC consumer can reach a WSS publisher.
- **Client:** `WssLink` uses `tokio-tungstenite` and the `yamux` crate, with a small adapter from WebSocket messages to a byte stream in place of `ws_stream_tungstenite` (which targets `async-tungstenite`).
  - The client races the endpoints in the order the server lists them, starting QUIC first and WSS 300 ms later. It remembers the winner per server.
  - Keepalive runs every 20 s, under the CDN idle timeouts.
- **The UI route line for WSS through a CDN** names WebSocket over TLS on 443 and says that the CDN terminates TLS. Production's edge accepts only 80/tcp from ArvanCloud, so the leg from the CDN to the origin is plain HTTP, and the UI must say that too. It warns that UDP over this route adds delay.

## Verification

- Go tests: a yamux-over-WebSocket link round-trips a stream and a datagram, and a QUIC consumer reaches a WSS publisher through the relay.
- Rust test: endpoint racing picks WSS when the QUIC endpoint does not answer.
- Live, once: block UDP to the relay, check that the WSS route is chosen and that the share panel's route line names it, including the CDN's TLS ending.
- One `/code-review low` at the end.

## As built (2026-11-06)

- **Go:** `relay.Conn` is the transport-agnostic connection; `quicConn` and `wsConn` implement it, and `Server.Serve` runs either. The route is `GET /v1/relay/ws`, off while the server switch is. The second stream the client opens, right after `AttachOk`, starts with the byte `0xD6` and carries datagrams as `[u16 length][payload]`. A WebSocket close frame carries the end reason (for example `stopped`). yamux has no stream reset, so an abort is a close plus a read deadline.
- **Rust:** `RelayLink` is either route; `link::connect` starts each listed route 300 ms after the one before it, and the first that connects wins and is tried first next time (in memory, per endpoint list). `ws://` works only in debug builds with `RAVEN_RELAY_INSECURE=1`, for the local rig.
- **Route notes are declared, not detected:** `RAVEN_RELAY_ENDPOINTS` takes space-separated notes after a URL, `behind-cdn` and `origin-http`. `/workshop/config` returns them as `routeNotes`, and the share panel and Settings show only what is declared. Over WebSocket the panel also says UDP rides TCP.
- **Keepalive:** yamux pings every 20 s from the server (the Rust yamux crate answers but doesn't send its own).

## Deploying to `raven` (Soroush's call; not done)

ArvanCloud passes WebSockets on this account: LiveKit's signalling on `rtc.rvn.bluehour.cloud` already runs through it (proxied, origin over HTTP). Arvan doesn't publish its WebSocket idle timeout; the 20 s ping is well under the 60–100 s that CDNs commonly use. Not confirmed with Arvan.

1. `infra/raven/edge-nginx.conf` now has `location = /v1/relay/ws` on `mimir.rvn` with the upgrade headers and a 12 h timeout. Copy it to the host and reload nginx.
2. In the `api` service's environment: `RAVEN_WORKSHOP_PORTS=on` and `RAVEN_RELAY_ENDPOINTS=wss://mimir.rvn.bluehour.cloud/v1/relay/ws behind-cdn origin-http`. Add the QUIC route in front of it once plan 01's steps (DNS-only record, UDP port, certificate) are done: `quic://<relay host>:7443,wss://… behind-cdn origin-http`.
3. Better than declaring `origin-http`: set Arvan's origin protocol for `mimir.rvn` to HTTPS with a certificate on the edge. Then every relay leg has TLS, and the note can go. It changes the edge (443 open to Arvan's ranges in nftables, a certificate in nginx), so it is a separate decision.
4. Check from a network without UDP: the share panel shows `WebSocket with TLS to mimir.rvn.bluehour.cloud` and the three notes.

## Not verified

- The race and fallback were run on one PC against a local relay. A two-machine test (publisher and consumer on different networks, or through Arvan) needs a deploy or a second PC.
