// Package relay is the Workshop's port sharing: an in-memory registry of shares and a
// QUIC data plane that joins a publisher's client to a consumer's client.
//
// The relay never dials anything. It only pipes bytes between two Raven clients that
// both authenticated, so the server can never act as an exit to the internet.
package relay

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Frames are the small binary messages the two ends exchange on a control stream and at
// the start of every data stream. The format is mirrored in
// apps/desktop/src-tauri/src/workshop/frames.rs; the fixtures in frames_test.go pin it.
//
//	[version u8 = 1][type u8][body length u32 big-endian][body]
//
// Inside a body, a string is [length u16][UTF-8 bytes] and integers are big-endian.
const FrameVersion = 1

// MaxFrameBody keeps a hostile peer from asking for a huge allocation.
const MaxFrameBody = 4096

// ALPN is the protocol name both ends offer in the QUIC handshake.
const ALPN = "raven-relay/1"

type FrameType uint8

const (
	// FrameHello opens a connection: the session token and the role of this connection.
	FrameHello FrameType = 1
	// FrameHelloOK answers a Hello that authenticated.
	FrameHelloOK FrameType = 2
	// FrameAttach is sent by a publisher to say which share this connection serves.
	FrameAttach FrameType = 3
	// FrameAttachOK answers an Attach.
	FrameAttachOK FrameType = 4
	// FrameOpen is sent by a consumer to start a TCP connection or a UDP flow.
	FrameOpen FrameType = 5
	// FrameIncoming is sent by the relay to the publisher for each new flow.
	FrameIncoming FrameType = 6
	// FrameAccepted says the publisher reached the local port.
	FrameAccepted FrameType = 7
	// FrameRefused says the flow could not start. Its reason is a sentence for the user.
	FrameRefused FrameType = 8
	// FrameError ends a connection or a request: a code and a sentence for the user.
	FrameError FrameType = 9
)

// Roles a connection can have, in Hello.
const (
	RoleConsumer  uint8 = 0
	RolePublisher uint8 = 1
)

// Kinds of flow.
const (
	KindTCP uint8 = 1
	KindUDP uint8 = 2
)

// Frame is one decoded message. Only the fields of its type are meaningful.
type Frame struct {
	Type FrameType

	Token       string // Hello
	Role        uint8  // Hello
	UserID      string // HelloOK, Incoming (the consumer)
	ShareID     string // Attach, Open
	Kind        uint8  // Open, Incoming
	FlowID      uint32 // Open (the consumer's own id for a UDP flow), Incoming (the relay's)
	Reason      string // Refused
	Code        string // Error
	Message     string // Error
	DatagramMTU uint16 // AttachOK, Accepted for UDP: largest payload the path carries
}

var errFrameShort = errors.New("relay frame is too short")

type frameWriter struct{ buf []byte }

func (w *frameWriter) u8(v uint8)   { w.buf = append(w.buf, v) }
func (w *frameWriter) u16(v uint16) { w.buf = binary.BigEndian.AppendUint16(w.buf, v) }
func (w *frameWriter) u32(v uint32) { w.buf = binary.BigEndian.AppendUint32(w.buf, v) }
func (w *frameWriter) str(v string) {
	if len(v) > 0xffff {
		v = v[:0xffff]
	}
	w.u16(uint16(len(v)))
	w.buf = append(w.buf, v...)
}

type frameReader struct {
	buf []byte
	err error
}

func (r *frameReader) take(n int) []byte {
	if r.err != nil || len(r.buf) < n {
		r.err = errFrameShort
		return nil
	}
	out := r.buf[:n]
	r.buf = r.buf[n:]
	return out
}
func (r *frameReader) u8() uint8 {
	if b := r.take(1); b != nil {
		return b[0]
	}
	return 0
}
func (r *frameReader) u16() uint16 {
	if b := r.take(2); b != nil {
		return binary.BigEndian.Uint16(b)
	}
	return 0
}
func (r *frameReader) u32() uint32 {
	if b := r.take(4); b != nil {
		return binary.BigEndian.Uint32(b)
	}
	return 0
}
func (r *frameReader) str() string {
	n := int(r.u16())
	if b := r.take(n); b != nil {
		return string(b)
	}
	return ""
}

// Encode returns the frame as bytes ready to write.
func (f Frame) Encode() []byte {
	body := frameWriter{}
	switch f.Type {
	case FrameHello:
		body.str(f.Token)
		body.u8(f.Role)
	case FrameHelloOK:
		body.str(f.UserID)
	case FrameAttach:
		body.str(f.ShareID)
	case FrameAttachOK:
		body.u16(f.DatagramMTU)
	case FrameOpen:
		body.str(f.ShareID)
		body.u8(f.Kind)
		body.u32(f.FlowID)
	case FrameIncoming:
		body.u32(f.FlowID)
		body.str(f.UserID)
		body.u8(f.Kind)
	case FrameAccepted:
		body.u16(f.DatagramMTU)
	case FrameRefused:
		body.str(f.Reason)
	case FrameError:
		body.str(f.Code)
		body.str(f.Message)
	}
	out := make([]byte, 0, 6+len(body.buf))
	out = append(out, FrameVersion, byte(f.Type))
	out = binary.BigEndian.AppendUint32(out, uint32(len(body.buf)))
	return append(out, body.buf...)
}

// DecodeBody parses a frame body of a known type.
func DecodeBody(t FrameType, body []byte) (Frame, error) {
	r := frameReader{buf: body}
	f := Frame{Type: t}
	switch t {
	case FrameHello:
		f.Token = r.str()
		f.Role = r.u8()
	case FrameHelloOK:
		f.UserID = r.str()
	case FrameAttach:
		f.ShareID = r.str()
	case FrameAttachOK:
		f.DatagramMTU = r.u16()
	case FrameOpen:
		f.ShareID = r.str()
		f.Kind = r.u8()
		f.FlowID = r.u32()
	case FrameIncoming:
		f.FlowID = r.u32()
		f.UserID = r.str()
		f.Kind = r.u8()
	case FrameAccepted:
		f.DatagramMTU = r.u16()
	case FrameRefused:
		f.Reason = r.str()
	case FrameError:
		f.Code = r.str()
		f.Message = r.str()
	default:
		return Frame{}, fmt.Errorf("relay frame type %d is not known", t)
	}
	if r.err != nil {
		return Frame{}, r.err
	}
	return f, nil
}

// WriteFrame writes one frame to a stream.
func WriteFrame(w io.Writer, f Frame) error {
	_, err := w.Write(f.Encode())
	return err
}

// ReadFrame reads exactly one frame from a stream, leaving the stream positioned at the
// first byte after it (the start of the raw bytes of a TCP flow, for example).
func ReadFrame(r io.Reader) (Frame, error) {
	var head [6]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return Frame{}, err
	}
	if head[0] != FrameVersion {
		return Frame{}, fmt.Errorf("relay frame version %d is not supported", head[0])
	}
	size := binary.BigEndian.Uint32(head[2:])
	if size > MaxFrameBody {
		return Frame{}, errors.New("relay frame is too large")
	}
	body := make([]byte, size)
	if _, err := io.ReadFull(r, body); err != nil {
		return Frame{}, err
	}
	return DecodeBody(FrameType(head[1]), body)
}

// EncodeDatagram prefixes a UDP payload with its flow id.
func EncodeDatagram(flow uint32, payload []byte) []byte {
	out := make([]byte, 4, 4+len(payload))
	binary.BigEndian.PutUint32(out, flow)
	return append(out, payload...)
}

// DecodeDatagram splits a datagram into its flow id and payload.
func DecodeDatagram(data []byte) (uint32, []byte, bool) {
	if len(data) < 4 {
		return 0, nil, false
	}
	return binary.BigEndian.Uint32(data), data[4:], true
}
