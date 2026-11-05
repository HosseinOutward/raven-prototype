//! Pieces both ends of a share use: the UDP flow table with its idle expiry, the traffic
//! counters, and a byte copy that counts.

use std::{
    collections::HashMap,
    io,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// A UDP flow closes after this long without a datagram in either direction.
pub const UDP_IDLE: Duration = Duration::from_secs(60);

/// Traffic on one share, read once a second for the live readout.
#[derive(Default)]
pub struct Counters {
    /// Bytes from consumers to the sharing computer's port.
    pub bytes_up: AtomicU64,
    /// Bytes back from it.
    pub bytes_down: AtomicU64,
    /// TCP connections plus UDP flows open right now.
    pub flows: AtomicU64,
    /// UDP datagrams dropped because they did not fit the path or the flow was gone.
    pub udp_dropped: AtomicU64,
}

impl Counters {
    pub fn add(counter: &AtomicU64, n: u64) {
        counter.fetch_add(n, Ordering::Relaxed);
    }
    pub fn get(counter: &AtomicU64) -> u64 {
        counter.load(Ordering::Relaxed)
    }
}

/// Keeps a flow count accurate for as long as the guard lives.
pub struct FlowGuard<'a>(&'a AtomicU64);

impl<'a> FlowGuard<'a> {
    pub fn new(counter: &'a AtomicU64) -> Self {
        counter.fetch_add(1, Ordering::Relaxed);
        Self(counter)
    }
}

impl Drop for FlowGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

struct Entry<T> {
    value: T,
    last_seen: Instant,
}

/// UDP flows by id. Every use of a flow refreshes it; `expire` removes the ones that went
/// quiet. The caller passes the time so tests do not have to wait.
pub struct FlowTable<T> {
    idle: Duration,
    flows: HashMap<u32, Entry<T>>,
}

impl<T> FlowTable<T> {
    pub fn new(idle: Duration) -> Self {
        Self { idle, flows: HashMap::new() }
    }

    pub fn insert(&mut self, id: u32, value: T, now: Instant) {
        self.flows.insert(id, Entry { value, last_seen: now });
    }

    /// Returns the flow and marks it as just used.
    pub fn touch(&mut self, id: u32, now: Instant) -> Option<&mut T> {
        let entry = self.flows.get_mut(&id)?;
        entry.last_seen = now;
        Some(&mut entry.value)
    }

    pub fn remove(&mut self, id: u32) -> Option<T> {
        self.flows.remove(&id).map(|e| e.value)
    }

    /// Removes and returns every flow idle for longer than the limit.
    pub fn expire(&mut self, now: Instant) -> Vec<(u32, T)> {
        let idle = self.idle;
        let stale: Vec<u32> = self
            .flows
            .iter()
            .filter(|(_, e)| now.saturating_duration_since(e.last_seen) >= idle)
            .map(|(id, _)| *id)
            .collect();
        stale.into_iter().filter_map(|id| self.flows.remove(&id).map(|e| (id, e.value))).collect()
    }

    pub fn len(&self) -> usize {
        self.flows.len()
    }
}

/// Copies until the reader ends, adding what it moved to the counter, then closes the
/// writer's sending side so the other end sees the end of the stream.
pub async fn copy_counted<R, W>(mut reader: R, mut writer: W, counter: &AtomicU64) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n]).await?;
        Counters::add(counter, n as u64);
    }
    let _ = writer.shutdown().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_flows_expire_and_active_ones_stay() {
        let start = Instant::now();
        let mut table = FlowTable::new(Duration::from_secs(60));
        table.insert(1, "quiet", start);
        table.insert(2, "busy", start);
        assert!(table.expire(start + Duration::from_secs(59)).is_empty());

        // A datagram on flow 2 at +50 s keeps it alive past flow 1's deadline.
        assert_eq!(table.touch(2, start + Duration::from_secs(50)), Some(&mut "busy"));
        let gone = table.expire(start + Duration::from_secs(61));
        assert_eq!(gone, vec![(1, "quiet")]);
        assert_eq!(table.len(), 1);

        assert_eq!(table.expire(start + Duration::from_secs(111)), vec![(2, "busy")]);
        assert_eq!(table.len(), 0);
        assert!(table.touch(2, start).is_none());
    }

    #[test]
    fn removing_a_flow_forgets_it() {
        let now = Instant::now();
        let mut table = FlowTable::new(UDP_IDLE);
        table.insert(7, (), now);
        assert!(table.remove(7).is_some());
        assert!(table.remove(7).is_none());
    }

    #[test]
    fn the_guard_counts_open_flows() {
        let counter = AtomicU64::new(0);
        {
            let _a = FlowGuard::new(&counter);
            let _b = FlowGuard::new(&counter);
            assert_eq!(counter.load(Ordering::Relaxed), 2);
        }
        assert_eq!(counter.load(Ordering::Relaxed), 0);
    }
}
