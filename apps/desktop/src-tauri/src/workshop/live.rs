//! A live check against a running API and relay, run by hand: it needs two accounts, a
//! call with shares in it, and a relay with a self-signed certificate (debug builds only
//! accept one, with `RAVEN_RELAY_INSECURE=1`). `cargo test workshop::live -- --ignored`.
//! The setup script is described in docs/plans/workshop/01-port-sharing.md.

use std::{process::Command, sync::Arc, time::Duration};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, UdpSocket},
};

use super::{
    consumer,
    flows::Counters,
    frames::{ROLE_CONSUMER, ROLE_PUBLISHER},
    link::{self, Link, QuicLink},
    publisher,
};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("set {name}"))
}

/// Creates a share through the API, as the publisher's app would. Shares are made just in
/// time because one nobody attaches to within 30 seconds ends.
fn create_share(name: &str, protocol: &str, port: u16, minutes: u32) -> String {
    let body = format!(
        r#"{{"placeKind":"nest","placeId":"{}","name":"{name}","protocol":"{protocol}","port":{port},"audience":"all","minutes":{minutes}}}"#,
        env("LIVE_NEST")
    );
    let out = Command::new("curl")
        .args(["-s", "-X", "POST", "-H", "Content-Type: application/json", "-H", "X-Raven-Client-Version: 0.1.8", "-H"])
        .arg(format!("X-Session-ID: {}", env("LIVE_PUB_TOKEN")))
        .args(["-d", &body])
        .arg(format!("{}/v1/workshop/shares", env("LIVE_API")))
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let start = text.find(r#""id":""#).unwrap_or_else(|| panic!("share not created: {text}")) + 6;
    text[start..start + text[start..].find('"').unwrap()].to_string()
}

fn quiet() -> publisher::Report {
    Arc::new(|message| println!("notice: {message}"))
}

async fn connect(role: u8, token: &str, share: &str) -> Arc<QuicLink> {
    let endpoint = env("LIVE_ENDPOINT");
    Arc::new(link::connect(&[endpoint], token, role, share).await.expect("connect to the relay"))
}

/// Starts a consumer for a share and returns its local port and its task.
async fn consume(share: &str, protocol: &str, port: u16) -> (u16, tokio::task::JoinHandle<String>) {
    let link = connect(ROLE_CONSUMER, &env("LIVE_CON_TOKEN"), share).await;
    let (tcp, udp) = (protocol != "udp", protocol != "tcp");
    let listeners = consumer::bind(port, tcp, udp).await.unwrap();
    let local = listeners.port;
    let id = share.to_string();
    (local, tokio::spawn(async move { consumer::run(link, id, listeners, Arc::new(Counters::default()), quiet()).await }))
}

fn publish(link: Arc<QuicLink>, port: u16) -> tokio::task::JoinHandle<String> {
    tokio::spawn(async move { publisher::run(link, port, Arc::new(Counters::default()), quiet()).await })
}

async fn http_get(port: u16) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.expect("connect to the consumer's port");
    stream.write_all(b"GET / HTTP/1.0\r\n\r\n").await.unwrap();
    let mut body = String::new();
    let _ = tokio::time::timeout(Duration::from_secs(10), stream.read_to_string(&mut body)).await;
    body
}

#[tokio::test]
#[ignore]
async fn port_sharing_end_to_end() {
    let (pub_token, tcp_port) = (env("LIVE_PUB_TOKEN"), env("LIVE_TCP_PORT").parse::<u16>().unwrap());

    // TCP: a python http.server on the publisher's computer, reached on the consumer's.
    let tcp_share = create_share("web", "tcp", tcp_port, 60);
    let tcp_pub_link = connect(ROLE_PUBLISHER, &pub_token, &tcp_share).await;
    let tcp_pub = publish(tcp_pub_link.clone(), tcp_port);
    let (local, consumer_task) = consume(&tcp_share, "tcp", 0).await;
    let page = http_get(local).await;
    assert!(page.starts_with("HTTP/1.0 200"), "TCP through the relay failed: {page:?}");
    println!("TCP ok on 127.0.0.1:{local}");

    // The publisher's app closing ends the share with publisher_offline.
    tcp_pub_link.close("app closed");
    let reason = tokio::time::timeout(Duration::from_secs(10), consumer_task).await.expect("consumer ended").unwrap();
    assert_eq!(reason, "publisher_offline");
    assert!(TcpStream::connect(("127.0.0.1", local)).await.is_err(), "the consumer's port should have closed");
    tcp_pub.abort();
    println!("publisher_offline ok");

    // UDP: an echo on the publisher's computer.
    let udp_port: u16 = env("LIVE_UDP_PORT").parse().unwrap();
    let echo = UdpSocket::bind(("127.0.0.1", udp_port)).await.unwrap();
    tokio::spawn(async move {
        let mut buf = [0u8; 2048];
        while let Ok((n, from)) = echo.recv_from(&mut buf).await {
            let _ = echo.send_to(&buf[..n], from).await;
        }
    });
    let udp_share = create_share("echo", "udp", udp_port, 60);
    let udp_pub_link = connect(ROLE_PUBLISHER, &pub_token, &udp_share).await;
    let _udp_pub = publish(udp_pub_link.clone(), udp_port);
    let (local, _udp_consumer) = consume(&udp_share, "udp", 0).await;
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let mut got = [0u8; 64];
    let mut ok = false;
    for _ in 0..5 {
        client.send_to(b"ping", ("127.0.0.1", local)).await.unwrap();
        if let Ok(Ok(n)) = tokio::time::timeout(Duration::from_secs(2), client.recv(&mut got)).await {
            ok = &got[..n] == b"ping";
            break;
        }
    }
    assert!(ok, "UDP echo through the relay failed");
    println!("UDP ok on 127.0.0.1:{local}");

    // Stopping the share closes the consumer's port.
    let stop_share = create_share("web2", "tcp", tcp_port, 60);
    let stop_pub = publish(connect(ROLE_PUBLISHER, &pub_token, &stop_share).await, tcp_port);
    let (stop_local, stop_consumer) = consume(&stop_share, "tcp", 0).await;
    assert!(http_get(stop_local).await.starts_with("HTTP/1.0 200"));
    let status = Command::new("curl")
        .args(["-s", "-o", "NUL", "-w", "%{http_code}", "-X", "DELETE", "-H", &format!("X-Session-ID: {pub_token}"), "-H", "X-Raven-Client-Version: 0.1.8"])
        .arg(format!("{}/v1/workshop/shares/{stop_share}", env("LIVE_API")))
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&status.stdout), "204");
    let reason = tokio::time::timeout(Duration::from_secs(10), stop_consumer).await.expect("consumer ended").unwrap();
    assert_eq!(reason, "stopped");
    assert!(TcpStream::connect(("127.0.0.1", stop_local)).await.is_err(), "the consumer's port should have closed");
    stop_pub.abort();
    println!("stop ok");

    // A share ends when its time is up (created with a one-minute limit).
    let expiry_share = create_share("short", "tcp", tcp_port, 1);
    let expiry = publish(connect(ROLE_PUBLISHER, &pub_token, &expiry_share).await, tcp_port);
    let reason = tokio::time::timeout(Duration::from_secs(90), expiry).await.expect("share should have expired").unwrap();
    assert_eq!(reason, "expired");
    println!("expiry ok");
}

/// Publishes a working TCP share and one with nothing behind it, then holds them open so
/// a person can try them from the app. `LIVE_HOLD_SECS` (default 600) says how long.
#[tokio::test]
#[ignore]
async fn hold_shares_for_the_app() {
    let token = env("LIVE_PUB_TOKEN");
    let port: u16 = env("LIVE_TCP_PORT").parse().unwrap();
    let hold: u64 = std::env::var("LIVE_HOLD_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(600);
    let mut tasks = Vec::new();
    for (name, share_port) in [("web", port), ("ghost", 47099)] {
        let share = create_share(name, "tcp", share_port, 120);
        println!("shared {name} on {share_port}: {share}");
        tasks.push(publish(connect(ROLE_PUBLISHER, &token, &share).await, share_port));
    }
    tokio::time::sleep(Duration::from_secs(hold)).await;
}

/// Opens one TCP connection to a share as the consumer, to make the sharer's app report
/// what it finds. `LIVE_SHARE` names the share; `LIVE_CON_TOKEN` is the consumer's session.
#[tokio::test]
#[ignore]
async fn poke_share() {
    let share = env("LIVE_SHARE");
    let (local, _task) = consume(&share, "tcp", 0).await;
    let _ = http_get(local).await;
    tokio::time::sleep(Duration::from_secs(3)).await;
}
