//! The sharing side. The relay opens a stream for every TCP connection or UDP flow a
//! consumer starts. This side dials only the loopback address of the shared port, so a
//! share can never reach anything else on this computer or the network.

use std::{
    net::{Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use tokio::{
    io::AsyncWriteExt,
    net::{TcpStream, UdpSocket},
    task::{AbortHandle, JoinSet},
};

use super::{
    flows::{copy_counted, Counters, FlowGuard, FlowTable, UDP_IDLE},
    frames::{decode_datagram, encode_datagram, read_frame, write_frame, Frame, KIND_TCP, KIND_UDP},
    link::{DatagramError, Link},
};

/// Tells the user about a problem that does not end the share.
pub type Report = Arc<dyn Fn(String) + Send + Sync>;

struct UdpFlow {
    socket: Arc<UdpSocket>,
    reader: AbortHandle,
}

type Flows = Arc<Mutex<FlowTable<UdpFlow>>>;

/// Dials the shared port: IPv4 loopback first, then IPv6. Nothing else is ever dialled.
async fn dial_local(port: u16) -> Option<TcpStream> {
    for addr in [SocketAddr::from((Ipv4Addr::LOCALHOST, port)), SocketAddr::from((Ipv6Addr::LOCALHOST, port))] {
        if let Ok(Ok(stream)) = tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(addr)).await {
            return Some(stream);
        }
    }
    None
}

/// Serves a share until the connection ends. Returns the reason the relay gave.
pub async fn run<L: Link>(link: Arc<L>, port: u16, counters: Arc<Counters>, report: Report) -> String {
    let mut tasks: JoinSet<()> = JoinSet::new();
    let flows: Flows = Arc::new(Mutex::new(FlowTable::new(UDP_IDLE)));
    let mut sweep = tokio::time::interval(Duration::from_secs(5));
    let closed = link.closed();
    tokio::pin!(closed);
    loop {
        tokio::select! {
            reason = &mut closed => return reason,
            accepted = link.accept_stream() => match accepted {
                Ok((tx, rx)) => {
                    let (link, counters, report, flows) = (link.clone(), counters.clone(), report.clone(), flows.clone());
                    tasks.spawn(async move { serve_flow(link, tx, rx, port, counters, report, flows).await });
                }
                Err(_) => return (&mut closed).await,
            },
            datagram = link.recv_datagram() => match datagram {
                Ok(data) => deliver_datagram(&data, &flows, &counters),
                Err(_) => return (&mut closed).await,
            },
            _ = sweep.tick() => {
                let gone = flows.lock().unwrap().expire(Instant::now());
                for (_, flow) in gone {
                    flow.reader.abort();
                    Counters::add_flows(&counters, -1);
                }
            }
            Some(_) = tasks.join_next() => {}
        }
    }
}

impl Counters {
    /// UDP flows are counted when they open and when they go; TCP ones use `FlowGuard`.
    pub fn add_flows(counters: &Counters, delta: i64) {
        use std::sync::atomic::Ordering;
        if delta >= 0 {
            counters.flows.fetch_add(delta as u64, Ordering::Relaxed);
        } else {
            counters.flows.fetch_sub((-delta) as u64, Ordering::Relaxed);
        }
    }
}

fn deliver_datagram(data: &[u8], flows: &Flows, counters: &Counters) {
    let Some((flow, payload)) = decode_datagram(data) else { return };
    let socket = flows.lock().unwrap().touch(flow, Instant::now()).map(|f| f.socket.clone());
    match socket {
        Some(socket) if socket.try_send(payload).is_ok() => {
            Counters::add(&counters.bytes_up, payload.len() as u64);
        }
        _ => Counters::add(&counters.udp_dropped, 1),
    }
}

async fn serve_flow<L: Link>(
    link: Arc<L>,
    mut tx: L::Tx,
    mut rx: L::Rx,
    port: u16,
    counters: Arc<Counters>,
    report: Report,
    flows: Flows,
) {
    let Ok(Frame::Incoming { flow_id, kind, .. }) = read_frame(&mut rx).await else { return };
    match kind {
        KIND_TCP => {
            let Some(local) = dial_local(port).await else {
                let message = format!("Nothing is listening on port {port} on this computer, so someone’s connection was refused.");
                report(message.clone());
                let _ = write_frame(&mut tx, &Frame::Refused { reason: format!("Nothing is listening on port {port} on the sharing computer.") }).await;
                // A dropped yamux stream is reset, and a reset loses the refusal on the relay.
                let _ = tx.shutdown().await;
                return;
            };
            if write_frame(&mut tx, &Frame::Accepted { datagram_mtu: 0 }).await.is_err() {
                return;
            }
            let _flow = FlowGuard::new(&counters.flows);
            let (read_local, write_local) = local.into_split();
            let up = copy_counted(rx, write_local, &counters.bytes_up);
            let down = copy_counted(read_local, tx, &counters.bytes_down);
            let _ = tokio::join!(up, down);
        }
        KIND_UDP => {
            let Ok(socket) = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await else {
                let _ = write_frame(&mut tx, &Frame::Refused { reason: "The sharing computer couldn’t open a UDP socket.".into() }).await;
                let _ = tx.shutdown().await;
                return;
            };
            if socket.connect((Ipv4Addr::LOCALHOST, port)).await.is_err() {
                let _ = write_frame(&mut tx, &Frame::Refused { reason: format!("The sharing computer couldn’t reach UDP port {port}.") }).await;
                let _ = tx.shutdown().await;
                return;
            }
            if write_frame(&mut tx, &Frame::Accepted { datagram_mtu: 0 }).await.is_err() {
                return;
            }
            let socket = Arc::new(socket);
            // Replies from the local program go back to the relay tagged with the flow.
            let reader = {
                let (socket, link, counters, flows) = (socket.clone(), link.clone(), counters.clone(), flows.clone());
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 64 * 1024];
                    while let Ok(n) = socket.recv(&mut buf).await {
                        let touched = flows.lock().unwrap().touch(flow_id, Instant::now()).is_some();
                        if !touched {
                            return;
                        }
                        match link.send_datagram(encode_datagram(flow_id, &buf[..n])) {
                            Ok(()) => Counters::add(&counters.bytes_down, n as u64),
                            Err(DatagramError::TooLarge) => Counters::add(&counters.udp_dropped, 1),
                            Err(DatagramError::Closed) => return,
                        }
                    }
                })
            };
            Counters::add_flows(&counters, 1);
            flows.lock().unwrap().insert(flow_id, UdpFlow { socket, reader: reader.abort_handle() }, Instant::now());
            // The stream marks the flow's life: when the relay ends it, the flow goes too.
            let _ = read_frame(&mut rx).await;
            if let Some(flow) = flows.lock().unwrap().remove(flow_id) {
                flow.reader.abort();
                Counters::add_flows(&counters, -1);
            }
        }
        _ => {}
    }
}
