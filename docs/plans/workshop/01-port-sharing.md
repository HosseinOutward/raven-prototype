# Workshop 01: port sharing

## Context

Soroush wants SSH-tunnel-style port sharing between members of a nest, relayed by the server (no P2P), for things like a shared Minecraft server or a terminal session. It is the first of the **Workshop** features: power-user features that are off by default, with short, technical copy that names every protocol, encryption layer and route. (Soroush dropped the full-sentences rule on 2026-11-06: it made the UI hard to follow.)

This plan covers stages A–C: the server control plane, the relay over QUIC, and the desktop. `02-wss-fallback.md` adds the WebSocket fallback. E2EE is plan 03, written later.

### Decisions (Soroush, 2026-11-06)

- **Name:** Workshop, with the corvid tool-use theme. Each Workshop feature has its own switch, off by default, with a full explanation under the switch whether it is on or off.
- **Protocols:** the publisher picks TCP, UDP, or Both (the same port number for both).
- **Transport:** QUIC first, then WebSocket over TLS on 443 as the fallback. Every relay leg is encrypted. The UI states the route and who can read the bytes, including a CDN that terminates TLS.
- **E2EE:** later (plan 03), as Noise XX between the publisher and each consumer, with per-device X25519 keys, trust on first use, and fingerprints. Until then the UI says plainly that the relay and any CDN can read forwarded bytes. There is no inner TLS layer, and no bring-your-own key.
- **Audience:** everyone in the nest, or picked members.
- **Lifetime:** a share ends when the publisher stops it, goes offline, closes the app, or reaches their timeout. The timeout defaults to 2 hours, is capped at 12 hours, and can be extended by hand while online.
- **Audit log:** none for now.
- **Who may publish:** every user, for now. `docs/permissions.md` gets a "Planned" note: a per-tree, per-user "Share ports" permission that owners and moderators change in tree settings.
- **Abuse:** treat VPN-like use as a real risk and keep it small (rules below).

### Choices made in this plan

- **The Workshop is its own category in the System group of User settings.** There is no Advanced category to hide it behind, and an always-visible category that does nothing until a switch is turned on is simpler.
- **The relay runs inside the API process** (`services/api/internal/relay`), so authentication, nest access and capabilities are checked by the same code. The API gets a new UDP listener for QUIC. The relay never dials anything: it only joins two Raven clients, so the server can never act as an internet exit.
- **Shares live in memory, not the database.** They die with the publisher's relay connection anyway. A server restart ends every share, and clients show "The relay restarted. Share the port again." No migration is needed except for the capabilities.
- **The target is always loopback.** The publisher's client only dials `127.0.0.1` or `[::1]`, and the server never sees a target host. A consumer's listener binds only to `127.0.0.1`.
- **Place rules:**
  - In a voice nest, the publisher and the consumers must be in the call (`session_participants.left_at IS NULL`). Leaving the call ends their part.
  - In a text room, they must be members (`chatAccessFor` passes), and the publisher must hold a live relay connection.

## Abuse limits (server-side, env with defaults)

| Limit | Default | Env |
|---|---|---|
| Master switch for port sharing on this server | off | `RAVEN_WORKSHOP_PORTS=on` |
| Active shares per publisher | 3 | `RAVEN_WORKSHOP_MAX_SHARES` |
| Consumers per share | 8 | `RAVEN_WORKSHOP_MAX_CONSUMERS` |
| Open TCP connections plus UDP flows per consumer per share | 16 | `RAVEN_WORKSHOP_MAX_FLOWS` |
| Bandwidth per share, both directions | 20 Mbit/s | `RAVEN_WORKSHOP_SHARE_MBPS` |
| Bytes per user per UTC day, publisher plus consumer | 20 GB | `RAVEN_WORKSHOP_DAILY_GB` |
| Share duration default and maximum | 120 and 720 minutes | `RAVEN_WORKSHOP_MAX_MINUTES` (max only) |

- The daily count is kept in memory, so a restart resets it. That is acceptable for now.
- There are two new capabilities: `workshop.share_ports` and `workshop.use_ports`. Their defaults are allowed. They follow the `CapabilityInvitesCreate` pattern in `database/invite_migrations.go`, are listed in `Capabilities`, and get per-account overrides in `apps/admin` for free.
- The server's master switch is off by default, so a self-hoster opts in.

## Stage A: server control plane

Files to read first: `services/api/internal/http/capabilities.go`, `policy.go` (`nestAccess`, `requireNestEntry`), `chat_access.go` (`chatAccessFor`), `events.go` (`publishTo`, `nestAudience`), `server.go` (routes near line 290, `requireAuth`), `database/permissions_migrations.go`, `database/invite_migrations.go`.

- **`http/workshop.go`**, routes under `authenticated`:
  - `GET /workshop/config` returns whether port sharing is enabled, the limits, and the relay endpoint list from `RAVEN_RELAY_ENDPOINTS` (for example `quic://relay.example:7443,wss://example/relay`).
  - `POST /workshop/shares` takes `{placeKind: "nest"|"room", placeId, name, protocol: "tcp"|"udp"|"both", port, audience: "all"|[userIds], minutes}`. It checks the switch, the capability, place access, the share count, a minutes cap, a port in 1–65535, and that picked users are members of the place. It returns the share with `expiresAt`.
  - `POST /workshop/shares/:id/extend {minutes}` is publisher only and sets `expiresAt = now + minutes`, capped.
  - `DELETE /workshop/shares/:id` is publisher only.
  - `GET /workshop/places/:kind/:id/shares` returns the shares the caller may see.
- **`relay` package state:** an in-memory registry `shares map[id]*Share` holds publisher, place, audience, protocol, port, expiry, consumer set, counters and a token bucket. A ticker ends expired shares.
- **Events:** `workshop.share.added|updated|ended` go to the place audience through the existing broker (`publishTo`). An `ended` event carries a reason: `stopped`, `expired`, `publisher_offline`, `left_place`, `relay_restarted`.
- **Re-check access** when a connection opens, not only at creation. Hook the existing leave and removal paths (call leave, tree removal, chat member removal) so a share or consumer that loses access is ended at once.

## Stage B: relay data plane over QUIC

Files to read first: `services/api/cmd/raven-api/main.go` (startup and env), `infra/raven/compose.yaml`, `infra/raven/firewall/raven-firewall-apply`.

- **Dependency:** `github.com/quic-go/quic-go`, which supports streams and RFC 9221 datagrams. Listen on `RAVEN_RELAY_QUIC_ADDR` (for example `:7443/udp`) using ALPN `raven-relay/1` and TLS 1.3, with the certificate from `RAVEN_RELAY_TLS_CERT` and `RAVEN_RELAY_TLS_KEY`.
  - The certificate must be publicly trusted in v1, because the client verifies against webpki roots.
  - The QUIC hostname must not go through a CDN (DNS-only), since CDNs don't proxy raw QUIC.
- **Session:**
  - The first stream is the control stream. The client sends `Hello{sessionToken, role}`, and the server authenticates with the same code as `requireAuth`.
  - A publisher sends `Attach{shareId}`. That relay connection now owns the share, and when it closes, the share ends with reason `publisher_offline`.
  - Keepalive runs every 15 s, and the idle timeout is 30 s.
- **TCP:**
  1. The consumer opens a stream and sends `Open{shareId, kind: tcp}`.
  2. The relay checks the audience, place presence, flow cap and expiry.
  3. The relay opens a stream to the publisher with `Incoming{flowId, fromUserId, kind: tcp}`.
  4. The publisher dials `127.0.0.1:port`, falling back to `[::1]:port`. If that is refused, it replies `Refused{reason: "nothing is listening"}`.
  5. The relay pipes bytes both ways with the share's token bucket applied.
- **UDP:**
  - Each consumer-side source address is a flow. Datagrams are `[flowId u32][payload]`, sent as QUIC datagrams.
  - The publisher keeps one UDP socket per flow toward `127.0.0.1:port`. A flow closes after 60 s idle.
  - A datagram larger than the path MTU is dropped and counted, and the counter is shown in the UI.
- **Frames:** one small length-prefixed binary format in `relay/frames.go`, mirrored in Rust, with a version byte.
- **Production (`infra/raven`):** open the QUIC UDP port in compose and nftables, add a DNS-only relay hostname, and add a certificate. **Deploying is Soroush's call.** Write the steps; do not run them.

### Deployment steps (not run)

The code is built and the API starts the relay only when `RAVEN_RELAY_QUIC_ADDR` is set, so nothing changes in production until these are done by hand.

1. **DNS:** add a DNS-only (not proxied) A record `relay.<raven domain>` pointing at the host's public address. A CDN would not carry QUIC.
2. **Certificate:** issue a publicly trusted certificate for that hostname (for example `certbot certonly --standalone -d relay.<domain>`, or a DNS-01 challenge) and put `fullchain.pem` and `privkey.pem` under `/srv/raven/relay-tls/` on the host. Renewal replaces the files; restart the `api` container afterwards, because the certificate is read once at start.
3. **`infra/raven/compose.yaml`**, in the `api` service:
   - `ports: ["7443:7443/udp"]`
   - `volumes: ["/srv/raven/relay-tls:/etc/raven-relay:ro"]`
   - `environment:` `RAVEN_WORKSHOP_PORTS: "on"`, `RAVEN_RELAY_QUIC_ADDR: ":7443"`, `RAVEN_RELAY_TLS_CERT: /etc/raven-relay/fullchain.pem`, `RAVEN_RELAY_TLS_KEY: /etc/raven-relay/privkey.pem`, `RAVEN_RELAY_ENDPOINTS: quic://relay.<domain>:7443`
4. **`infra/raven/firewall/raven-firewall-apply`:** in the forward chain, next to the LiveKit media rule, add `meta l4proto udp ct original proto-dst 7443 accept`, update the header comment, then run the script. It checks the rules with `nft -c` before installing.
5. **Image:** build and load a new `raven-api` image (the API now links `quic-go`), set `RAVEN_VERSION`, and `docker compose up -d api`.
6. **Check:** `GET /v1/workshop/config` reports `enabled: true` and the endpoint, and a Raven client with the switch on can share a port.
7. **Rollback:** unset `RAVEN_WORKSHOP_PORTS` (or the whole block) and restart `api`. Every share ends, no data is kept.

## Stage C: desktop

Files to read first: `apps/desktop/src-tauri/src/lib.rs` (command registration), `Cargo.toml`, `apps/desktop/src/lib/api.ts`, `lib/eventStream.ts`, `shells/ravenv1/UserSettings.tsx`, `shells/ravenv1/SettingsScaffold.tsx`, the `raven-ui` skill, `RAVEN_UI_RULES.md`.

- **Rust `src-tauri/src/workshop/`:**
  - `link.rs` holds the `Link` trait (`open_stream`, `accept_stream`, `send_datagram`, `recv_datagram`, `route()`) and the `QuicLink` built on `quinn` with the existing `rustls`.
  - `publisher.rs` and `consumer.rs` hold the logic. `mod.rs` exposes the Tauri commands `workshop_publish`, `workshop_stop`, `workshop_connect` and `workshop_disconnect`, plus `workshop://status` events.
  - **Consumer listening:** the consumer listens on `127.0.0.1:<same port>` and falls back to a free port. For Both, it uses one port number for TCP and UDP.
  - **Ending:** the consumer's listeners close when the share ends or when the consumer leaves the place.
- **TS:**
  - `lib/workshop.ts` holds the API calls, the per-device preference `raven.workshop.portSharing` (off by default), and the state built from events.
  - In settings, the **Workshop** category in the System group has one switch per feature, each with a full explanation under it.
- **Share UI:** a "Ports" control in the voice nest and text room headers, shown only when the switch is on and the server reports the feature enabled. It opens a panel with:
  - **Shares:** each share's name, protocol and port, publisher, audience and time left.
  - **For consumers:** Connect or Disconnect, plus copying `127.0.0.1:<port>`.
  - **For publishers:** "Share a port" (name, protocol, port, audience, minutes), Extend, Stop, the connected members, and a live traffic readout.
  - **The route line,** for example "QUIC with TLS 1.3 to relay.example:7443".
- **Errors, each in a full sentence:** the local port is taken, nothing is listening on the publisher's side, the relay is unreachable on every route, a limit is reached (the message names the limit and its value), the share expired, or access was lost.
- **Wording rule:** add a "Workshop copy" section to the `raven-ui` skill and `RAVEN_UI_RULES.md`. It says to name the protocol, encryption, route and who can read the traffic, briefly, as label and value facts, and not to explain basic terms. Until plan 03, every share panel states that the relay operator and any CDN on the route can read the forwarded bytes.
- **Docs:** `docs/permissions.md` gets the "Planned" note. `docs/self-hosting.md` covers the env vars, the QUIC port and certificate, and the CDN caveats (proxying raw QUIC, idle timeouts, terms on bulk traffic).

## Verification

- **Go unit tests in `http/workshop_test.go` and `relay/*_test.go`:**
  - Validation: capability off, switch off, minutes over the cap, a non-member pick, the share cap.
  - Lifecycle: expiry, extend, and the publisher disconnecting.
  - Access: the audience check, leaving a call ending consumer access, and the flow cap.
  - Traffic: the bandwidth bucket, the daily cap, and a frame round trip.
- **Rust unit tests:** frame encode and decode matches the Go fixtures; UDP flow table idle expiry.
- **A live run once at the end**, with two local accounts per `reference_raven_live_call_testing` and a local relay with a self-signed certificate allowed only in debug builds:
  - Share a TCP `python -m http.server`, and check it works through `127.0.0.1` on the consumer side.
  - Share a UDP echo, and check it works.
  - Stop the share, and check the consumer's port closes.
  - Wait for expiry, and check the share ends.
  - Close the publisher's app, and check the share ends with `publisher_offline`.
- **One `/code-review low` at the end.**

## Live check, as run on 2026-11-06

`apps/desktop/src-tauri/src/workshop/live.rs` is an ignored test that drives the real Rust publisher and consumer against a real API and relay. To run it:

1. Make a self-signed certificate for `127.0.0.1` with `openssl req -x509 -newkey ec ... -addext subjectAltName=DNS:localhost,IP:127.0.0.1`.
2. Start the API with a scratch SQLite file and `RAVEN_WORKSHOP_PORTS=on`, `RAVEN_RELAY_QUIC_ADDR=127.0.0.1:7443`, the certificate and key, and `RAVEN_RELAY_ENDPOINTS=quic://127.0.0.1:7443`.
3. Create two accounts (`raven-api user create`), sign both in, put them in one tree, join one nest's call, and send `POST /v1/presence/heartbeat {"nestId": ...}` for both every few seconds, as the app does. Without that the call membership lapses.
4. Start `python -m http.server 47001 --bind 127.0.0.1`.
5. Set `LIVE_ENDPOINT`, `LIVE_API`, `LIVE_PUB_TOKEN`, `LIVE_CON_TOKEN`, `LIVE_NEST`, `LIVE_TCP_PORT=47001`, `LIVE_UDP_PORT=47002` and `RAVEN_RELAY_INSECURE=1`, then `cargo test --lib workshop::live -- --ignored --nocapture`.

It checks TCP through the relay, `publisher_offline` when the publisher closes, UDP echo, Stop closing the consumer’s port, and expiry of a one-minute share.
