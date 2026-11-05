//! One connection to the relay. `Link` is what publishing and consuming need from it, so a
//! second route (WebSocket over TLS on 443, plan 02) can sit behind the same trait.

use std::{future::Future, io, net::SocketAddr, sync::Arc, time::Duration};

use quinn::crypto::rustls::QuicClientConfig;
use tokio::io::{AsyncRead, AsyncWrite};

use super::frames::{
    read_frame, write_frame, Frame, ALPN, ROLE_CONSUMER, ROLE_PUBLISHER,
};

#[derive(Debug)]
pub enum DatagramError {
    /// The datagram is larger than the path carries. It is dropped and counted.
    TooLarge,
    /// The connection is gone.
    Closed,
}

pub trait Link: Send + Sync + 'static {
    type Tx: AsyncWrite + Unpin + Send + 'static;
    type Rx: AsyncRead + Unpin + Send + 'static;

    fn open_stream(&self) -> impl Future<Output = io::Result<(Self::Tx, Self::Rx)>> + Send;
    fn accept_stream(&self) -> impl Future<Output = io::Result<(Self::Tx, Self::Rx)>> + Send;
    fn send_datagram(&self, data: Vec<u8>) -> Result<(), DatagramError>;
    fn recv_datagram(&self) -> impl Future<Output = io::Result<Vec<u8>>> + Send;
    /// Resolves when the connection ends, with the reason the relay gave (for example
    /// `publisher_offline`) or a description of the failure.
    fn closed(&self) -> impl Future<Output = String> + Send;
    /// Names the route in a sentence fragment, for example
    /// `QUIC with TLS 1.3 to relay.example:7443`.
    fn route(&self) -> String;
    fn close(&self, reason: &str);
}

#[derive(Debug)]
pub struct ConnectError(pub String);

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub struct QuicLink {
    conn: quinn::Connection,
    host_port: String,
    // The control stream stays open for the life of the connection.
    _ctrl: (quinn::SendStream, quinn::RecvStream),
    /// Largest UDP payload the relay says every path carries.
    pub datagram_mtu: u16,
}

fn io_err(error: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::Other, error.to_string())
}

impl Link for QuicLink {
    type Tx = quinn::SendStream;
    type Rx = quinn::RecvStream;

    async fn open_stream(&self) -> io::Result<(Self::Tx, Self::Rx)> {
        self.conn.open_bi().await.map_err(io_err)
    }

    async fn accept_stream(&self) -> io::Result<(Self::Tx, Self::Rx)> {
        self.conn.accept_bi().await.map_err(io_err)
    }

    fn send_datagram(&self, data: Vec<u8>) -> Result<(), DatagramError> {
        self.conn.send_datagram(data.into()).map_err(|error| match error {
            quinn::SendDatagramError::TooLarge => DatagramError::TooLarge,
            _ => DatagramError::Closed,
        })
    }

    async fn recv_datagram(&self) -> io::Result<Vec<u8>> {
        self.conn.read_datagram().await.map(|b| b.to_vec()).map_err(io_err)
    }

    async fn closed(&self) -> String {
        match self.conn.closed().await {
            quinn::ConnectionError::ApplicationClosed(close) => {
                String::from_utf8_lossy(&close.reason).into_owned()
            }
            quinn::ConnectionError::LocallyClosed => "stopped".to_string(),
            other => format!("connection_lost: {other}"),
        }
    }

    fn route(&self) -> String {
        format!("QUIC with TLS 1.3 to {}", self.host_port)
    }

    fn close(&self, reason: &str) {
        self.conn.close(0u32.into(), reason.as_bytes());
    }
}

fn client_config() -> Result<quinn::ClientConfig, ConnectError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| ConnectError(format!("Raven couldn’t set up TLS 1.3: {e}")))?;

    #[cfg(debug_assertions)]
    let mut tls = if std::env::var("RAVEN_RELAY_INSECURE").is_ok_and(|v| v == "1") {
        // Debug builds only: lets a local relay use a self-signed certificate. This code is
        // not compiled into release builds, which always verify against the webpki roots.
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(insecure::AcceptAny(provider)))
            .with_no_client_auth()
    } else {
        builder.with_root_certificates(webpki_roots()).with_no_client_auth()
    };
    #[cfg(not(debug_assertions))]
    let mut tls = builder.with_root_certificates(webpki_roots()).with_no_client_auth();

    tls.alpn_protocols = vec![ALPN.to_vec()];
    let quic = QuicClientConfig::try_from(tls)
        .map_err(|e| ConnectError(format!("Raven couldn’t set up QUIC: {e}")))?;
    let mut config = quinn::ClientConfig::new(Arc::new(quic));
    let mut transport = quinn::TransportConfig::default();
    transport.keep_alive_interval(Some(Duration::from_secs(15)));
    transport.max_idle_timeout(Some(Duration::from_secs(30).try_into().expect("idle timeout")));
    transport.datagram_receive_buffer_size(Some(1 << 20));
    transport.datagram_send_buffer_size(1 << 20);
    config.transport_config(Arc::new(transport));
    Ok(config)
}

fn webpki_roots() -> rustls::RootCertStore {
    rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned())
}

#[cfg(debug_assertions)]
mod insecure {
    use std::sync::Arc;

    use rustls::{
        client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
        crypto::CryptoProvider,
        pki_types::{CertificateDer, ServerName, UnixTime},
        DigitallySignedStruct, Error, SignatureScheme,
    };

    #[derive(Debug)]
    pub struct AcceptAny(pub Arc<CryptoProvider>);

    impl ServerCertVerifier for AcceptAny {
        fn verify_server_cert(
            &self,
            _: &CertificateDer<'_>,
            _: &[CertificateDer<'_>],
            _: &ServerName<'_>,
            _: &[u8],
            _: UnixTime,
        ) -> Result<ServerCertVerified, Error> {
            Ok(ServerCertVerified::assertion())
        }
        fn verify_tls12_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }
        fn verify_tls13_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }
        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            self.0.signature_verification_algorithms.supported_schemes()
        }
    }
}

/// Splits `quic://host:port` into `host:port`. Other routes are not used by this plan.
fn quic_target(endpoint: &str) -> Option<&str> {
    endpoint.strip_prefix("quic://").map(|rest| rest.trim_end_matches('/'))
}

async fn connect_one(host_port: &str) -> Result<quinn::Connection, ConnectError> {
    let unreachable = |why: &str| ConnectError(format!("The relay at {host_port} is unreachable: {why}."));
    let host = host_port.rsplit_once(':').map(|(h, _)| h).unwrap_or(host_port);
    let host = host.trim_matches(|c| c == '[' || c == ']');
    let addr: SocketAddr = tokio::net::lookup_host(host_port)
        .await
        .map_err(|e| unreachable(&e.to_string()))?
        .next()
        .ok_or_else(|| unreachable("the name has no address"))?;
    let bind: SocketAddr = if addr.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" }.parse().expect("bind address");
    let mut endpoint = quinn::Endpoint::client(bind).map_err(|e| unreachable(&e.to_string()))?;
    endpoint.set_default_client_config(client_config()?);
    let connecting = endpoint.connect(addr, host).map_err(|e| unreachable(&e.to_string()))?;
    match tokio::time::timeout(Duration::from_secs(5), connecting).await {
        Ok(Ok(conn)) => Ok(conn),
        Ok(Err(e)) => Err(unreachable(&e.to_string())),
        Err(_) => Err(unreachable("it didn’t answer within 5 seconds")),
    }
}

/// Connects to the first route that works, signs in with the session token and says which
/// share this connection serves. `role` is `ROLE_PUBLISHER` or `ROLE_CONSUMER`.
pub async fn connect(endpoints: &[String], token: &str, role: u8, share_id: &str) -> Result<QuicLink, ConnectError> {
    debug_assert!(role == ROLE_PUBLISHER || role == ROLE_CONSUMER);
    let mut last: Option<ConnectError> = None;
    for target in endpoints.iter().filter_map(|e| quic_target(e)) {
        let conn = match connect_one(target).await {
            Ok(conn) => conn,
            Err(error) => {
                last = Some(error);
                continue;
            }
        };
        // A relay that answers but refuses us is an answer; trying another route would
        // only repeat it.
        return handshake(conn, target, token, role, share_id).await;
    }
    Err(last.unwrap_or_else(|| ConnectError("This server has no relay route Raven can use.".to_string())))
}

async fn handshake(conn: quinn::Connection, host_port: &str, token: &str, role: u8, share_id: &str) -> Result<QuicLink, ConnectError> {
    let (mut tx, mut rx) = conn.open_bi().await.map_err(|e| ConnectError(format!("The relay closed the connection: {e}.")))?;
    let lost = |e: io::Error| ConnectError(format!("The relay closed the connection: {e}."));
    write_frame(&mut tx, &Frame::Hello { token: token.to_string(), role }).await.map_err(lost)?;
    expect(&mut rx, |f| matches!(f, Frame::HelloOk { .. })).await?;
    write_frame(&mut tx, &Frame::Attach { share_id: share_id.to_string() }).await.map_err(lost)?;
    let datagram_mtu = match expect(&mut rx, |f| matches!(f, Frame::AttachOk { .. })).await? {
        Frame::AttachOk { datagram_mtu } => datagram_mtu,
        _ => 0,
    };
    Ok(QuicLink { conn, host_port: host_port.to_string(), _ctrl: (tx, rx), datagram_mtu })
}

async fn expect(rx: &mut quinn::RecvStream, ok: impl Fn(&Frame) -> bool) -> Result<Frame, ConnectError> {
    match read_frame(rx).await {
        Ok(Frame::Error { message, .. }) => Err(ConnectError(message)),
        Ok(frame) if ok(&frame) => Ok(frame),
        Ok(_) => Err(ConnectError("The relay sent something Raven didn’t expect.".to_string())),
        Err(e) => Err(ConnectError(format!("The relay closed the connection: {e}."))),
    }
}
