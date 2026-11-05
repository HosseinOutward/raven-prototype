//! The relay's wire frames. This mirrors `services/api/internal/relay/frames.go` byte for
//! byte; the fixtures in the tests below are the same ones the Go tests pin.
//!
//! `[version u8 = 1][type u8][body length u32 big-endian][body]`. Inside a body a string is
//! `[length u16][UTF-8 bytes]` and integers are big-endian.

use std::io;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const FRAME_VERSION: u8 = 1;
pub const MAX_FRAME_BODY: usize = 4096;
pub const ALPN: &[u8] = b"raven-relay/1";

pub const ROLE_CONSUMER: u8 = 0;
pub const ROLE_PUBLISHER: u8 = 1;
pub const KIND_TCP: u8 = 1;
pub const KIND_UDP: u8 = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Frame {
    Hello { token: String, role: u8 },
    HelloOk { user_id: String },
    Attach { share_id: String },
    AttachOk { datagram_mtu: u16 },
    Open { share_id: String, kind: u8, flow_id: u32 },
    Incoming { flow_id: u32, user_id: String, kind: u8 },
    Accepted { datagram_mtu: u16 },
    Refused { reason: String },
    Error { code: String, message: String },
}

impl Frame {
    fn type_byte(&self) -> u8 {
        match self {
            Frame::Hello { .. } => 1,
            Frame::HelloOk { .. } => 2,
            Frame::Attach { .. } => 3,
            Frame::AttachOk { .. } => 4,
            Frame::Open { .. } => 5,
            Frame::Incoming { .. } => 6,
            Frame::Accepted { .. } => 7,
            Frame::Refused { .. } => 8,
            Frame::Error { .. } => 9,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut body = Vec::new();
        match self {
            Frame::Hello { token, role } => {
                put_str(&mut body, token);
                body.push(*role);
            }
            Frame::HelloOk { user_id } => put_str(&mut body, user_id),
            Frame::Attach { share_id } => put_str(&mut body, share_id),
            Frame::AttachOk { datagram_mtu } | Frame::Accepted { datagram_mtu } => {
                body.extend_from_slice(&datagram_mtu.to_be_bytes())
            }
            Frame::Open { share_id, kind, flow_id } => {
                put_str(&mut body, share_id);
                body.push(*kind);
                body.extend_from_slice(&flow_id.to_be_bytes());
            }
            Frame::Incoming { flow_id, user_id, kind } => {
                body.extend_from_slice(&flow_id.to_be_bytes());
                put_str(&mut body, user_id);
                body.push(*kind);
            }
            Frame::Refused { reason } => put_str(&mut body, reason),
            Frame::Error { code, message } => {
                put_str(&mut body, code);
                put_str(&mut body, message);
            }
        }
        let mut out = Vec::with_capacity(6 + body.len());
        out.push(FRAME_VERSION);
        out.push(self.type_byte());
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(&body);
        out
    }

    pub fn decode_body(kind: u8, body: &[u8]) -> io::Result<Frame> {
        let mut r = Reader { buf: body };
        let frame = match kind {
            1 => Frame::Hello { token: r.string()?, role: r.u8()? },
            2 => Frame::HelloOk { user_id: r.string()? },
            3 => Frame::Attach { share_id: r.string()? },
            4 => Frame::AttachOk { datagram_mtu: r.u16()? },
            5 => Frame::Open { share_id: r.string()?, kind: r.u8()?, flow_id: r.u32()? },
            6 => Frame::Incoming { flow_id: r.u32()?, user_id: r.string()?, kind: r.u8()? },
            7 => Frame::Accepted { datagram_mtu: r.u16()? },
            8 => Frame::Refused { reason: r.string()? },
            9 => Frame::Error { code: r.string()?, message: r.string()? },
            other => return Err(invalid(format!("relay frame type {other} is not known"))),
        };
        Ok(frame)
    }
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn put_str(out: &mut Vec<u8>, value: &str) {
    let bytes = value.as_bytes();
    let len = bytes.len().min(0xffff);
    out.extend_from_slice(&(len as u16).to_be_bytes());
    out.extend_from_slice(&bytes[..len]);
}

struct Reader<'a> {
    buf: &'a [u8],
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> io::Result<&[u8]> {
        if self.buf.len() < n {
            return Err(invalid("relay frame is too short"));
        }
        let (head, tail) = self.buf.split_at(n);
        self.buf = tail;
        Ok(head)
    }
    fn u8(&mut self) -> io::Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> io::Result<u16> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> io::Result<u32> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn string(&mut self) -> io::Result<String> {
        let n = self.u16()? as usize;
        String::from_utf8(self.take(n)?.to_vec()).map_err(|_| invalid("relay frame text is not UTF-8"))
    }
}

pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, frame: &Frame) -> io::Result<()> {
    w.write_all(&frame.encode()).await
}

/// Reads exactly one frame, leaving the stream at the first byte after it.
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<Frame> {
    let mut head = [0u8; 6];
    r.read_exact(&mut head).await?;
    if head[0] != FRAME_VERSION {
        return Err(invalid(format!("relay frame version {} is not supported", head[0])));
    }
    let size = u32::from_be_bytes(head[2..6].try_into().unwrap()) as usize;
    if size > MAX_FRAME_BODY {
        return Err(invalid("relay frame is too large"));
    }
    let mut body = vec![0u8; size];
    r.read_exact(&mut body).await?;
    Frame::decode_body(head[1], &body)
}

pub fn encode_datagram(flow: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&flow.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

pub fn decode_datagram(data: &[u8]) -> Option<(u32, &[u8])> {
    if data.len() < 4 {
        return None;
    }
    Some((u32::from_be_bytes(data[..4].try_into().unwrap()), &data[4..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The same fixtures as `TestFrameFixtures` in the Go relay package.
    fn fixtures() -> Vec<(Frame, &'static str)> {
        vec![
            (Frame::Hello { token: "abc".into(), role: ROLE_PUBLISHER }, concat!("0101000000060003616263", "01")),
            (Frame::Open { share_id: "s1".into(), kind: KIND_TCP, flow_id: 7 }, concat!("010500000009", "00027331", "01", "00000007")),
            (Frame::Incoming { flow_id: 9, user_id: "u".into(), kind: KIND_UDP }, concat!("010600000008", "00000009", "000175", "02")),
            (Frame::Error { code: "c".into(), message: "m".into() }, concat!("010900000006", "000163", "00016d")),
            (Frame::Accepted { datagram_mtu: 1200 }, concat!("010700000002", "04b0")),
        ]
    }

    #[test]
    fn frames_match_the_go_fixtures() {
        for (frame, expected) in fixtures() {
            assert_eq!(hex(&frame.encode()), expected, "{frame:?}");
        }
    }

    #[test]
    fn frames_round_trip_through_a_stream() {
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        rt.block_on(async {
            for (frame, _) in fixtures() {
                let bytes = frame.encode();
                let mut cursor = std::io::Cursor::new(bytes);
                assert_eq!(read_frame(&mut cursor).await.unwrap(), frame);
            }
        });
    }

    #[test]
    fn bad_frames_are_rejected() {
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        rt.block_on(async {
            for bytes in [
                vec![2, 1, 0, 0, 0, 0],
                vec![1, 1, 0xff, 0xff, 0xff, 0xff],
                vec![1, 1, 0, 0, 0, 1, 9],
                vec![1, 99, 0, 0, 0, 0],
            ] {
                let mut cursor = std::io::Cursor::new(bytes);
                assert!(read_frame(&mut cursor).await.is_err());
            }
        });
    }

    #[test]
    fn datagrams_carry_their_flow_id() {
        let data = encode_datagram(5, b"hi");
        assert_eq!(hex(&data), "000000056869");
        assert_eq!(decode_datagram(&data), Some((5, &b"hi"[..])));
        assert_eq!(decode_datagram(&[1, 2, 3]), None);
    }
}
