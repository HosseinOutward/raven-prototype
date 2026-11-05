package relay

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/quic-go/quic-go"
)

// Policy is what the relay asks the rest of the API: who a session token belongs to and
// whether that person may still publish or consume in the share's place. It is asked
// when a connection opens and for every flow, so losing access takes effect at once.
type Policy interface {
	Authenticate(token string) (userID string, err error)
	MayPublish(userID string, share ShareInfo) error
	MayConsume(userID string, share ShareInfo) error
}

// Server is the QUIC listener. One QUIC connection serves one role in one share: a
// publisher connection owns the share, a consumer connection uses it.
type Server struct {
	reg    *Registry
	policy Policy
	ln     *quic.Listener
	flowID atomic.Uint32
}

func NewServer(reg *Registry, policy Policy) *Server {
	return &Server{reg: reg, policy: policy}
}

const (
	// DatagramHint is the UDP payload size every path carries (QUIC guarantees 1200-byte
	// packets), which clients use to drop what would not fit.
	DatagramHint = 1000

	helloTimeout = 10 * time.Second
	keepAlive    = 15 * time.Second
	idleTimeout  = 30 * time.Second
	// Application error codes for closing a connection.
	codeOK       quic.ApplicationErrorCode = 0
	codeRejected quic.ApplicationErrorCode = 1
	codeEnded    quic.ApplicationErrorCode = 2
)

// QUICConfig is the transport configuration both ends use.
func QUICConfig() *quic.Config {
	return &quic.Config{
		EnableDatagrams: true,
		KeepAlivePeriod: keepAlive,
		MaxIdleTimeout:  idleTimeout,
	}
}

// Listen starts accepting connections on a UDP address such as ":7443". The certificate
// must be publicly trusted, because clients verify it against the usual roots.
func (s *Server) Listen(addr, certFile, keyFile string) error {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return fmt.Errorf("relay certificate: %w", err)
	}
	return s.ListenTLS(addr, &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
		NextProtos:   []string{ALPN},
	})
}

// ListenTLS is Listen with a ready TLS configuration. Tests use it.
func (s *Server) ListenTLS(addr string, conf *tls.Config) error {
	ln, err := quic.ListenAddr(addr, conf, QUICConfig())
	if err != nil {
		return err
	}
	s.ln = ln
	go s.acceptLoop()
	return nil
}

// Addr is the address the listener is bound to.
func (s *Server) Addr() string { return s.ln.Addr().String() }

// Close stops accepting connections and drops the ones open.
func (s *Server) Close() {
	if s.ln != nil {
		_ = s.ln.Close()
	}
}

func (s *Server) acceptLoop() {
	for {
		conn, err := s.ln.Accept(context.Background())
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

// quicStream adapts a QUIC stream to Stream.
type quicStream struct{ s *quic.Stream }

func (q quicStream) Read(p []byte) (int, error)  { return q.s.Read(p) }
func (q quicStream) Write(p []byte) (int, error) { return q.s.Write(p) }
func (q quicStream) CloseWrite() error           { return q.s.Close() }
func (q quicStream) Close() error {
	q.s.CancelRead(0)
	return q.s.Close()
}
func (q quicStream) Abort() {
	q.s.CancelRead(1)
	q.s.CancelWrite(1)
}

type quicPeer struct{ c *quic.Conn }

func (p quicPeer) OpenStream(ctx context.Context) (Stream, error) {
	s, err := p.c.OpenStreamSync(ctx)
	if err != nil {
		return nil, err
	}
	return quicStream{s}, nil
}
func (p quicPeer) SendDatagram(b []byte) error { return p.c.SendDatagram(b) }
func (p quicPeer) Close(reason string) {
	_ = p.c.CloseWithError(codeEnded, reason)
}

func refuse(ctrl *quic.Stream, conn *quic.Conn, code, message string) {
	_ = WriteFrame(ctrl, Frame{Type: FrameError, Code: code, Message: message})
	// Give the frame a moment to leave before the connection closes.
	time.Sleep(50 * time.Millisecond)
	_ = conn.CloseWithError(codeRejected, code)
}

func (s *Server) handle(conn *quic.Conn) {
	ctx, cancel := context.WithTimeout(conn.Context(), helloTimeout)
	ctrl, err := conn.AcceptStream(ctx)
	if err != nil {
		cancel()
		_ = conn.CloseWithError(codeRejected, "hello")
		return
	}
	_ = ctrl.SetReadDeadline(time.Now().Add(helloTimeout))
	hello, err := ReadFrame(ctrl)
	cancel()
	if err != nil || hello.Type != FrameHello {
		refuse(ctrl, conn, "bad_hello", "The relay didn’t understand this connection.")
		return
	}
	userID, err := s.policy.Authenticate(hello.Token)
	if err != nil {
		refuse(ctrl, conn, "unauthenticated", err.Error())
		return
	}
	if err := WriteFrame(ctrl, Frame{Type: FrameHelloOK, UserID: userID}); err != nil {
		return
	}
	attach, err := ReadFrame(ctrl)
	if err != nil || attach.Type != FrameAttach {
		refuse(ctrl, conn, "bad_attach", "The relay didn’t understand this connection.")
		return
	}
	_ = ctrl.SetReadDeadline(time.Time{})
	switch hello.Role {
	case RolePublisher:
		s.servePublisher(conn, ctrl, userID, attach.ShareID)
	case RoleConsumer:
		s.serveConsumer(conn, ctrl, userID, attach.ShareID)
	default:
		refuse(ctrl, conn, "bad_role", "The relay didn’t understand this connection.")
	}
}

func (s *Server) servePublisher(conn *quic.Conn, ctrl *quic.Stream, userID, shareID string) {
	info, ok := s.reg.Info(shareID)
	if !ok {
		refuse(ctrl, conn, "not_found", ErrNotFound.Error())
		return
	}
	if err := s.policy.MayPublish(userID, info); err != nil {
		refuse(ctrl, conn, "no_access", err.Error())
		return
	}
	peer := quicPeer{conn}
	share, err := s.reg.Attach(shareID, userID, peer)
	if err != nil {
		refuse(ctrl, conn, "attach", err.Error())
		return
	}
	defer s.reg.Detach(shareID, peer)
	if err := WriteFrame(ctrl, Frame{Type: FrameAttachOK, DatagramMTU: DatagramHint}); err != nil {
		return
	}
	// Datagrams from the publisher carry the relay's flow id and go to that flow's consumer.
	go func() {
		for {
			data, err := conn.ReceiveDatagram(conn.Context())
			if err != nil {
				return
			}
			flowID, payload, ok := DecodeDatagram(data)
			if !ok {
				continue
			}
			f := s.reg.UDPByRelayID(share, flowID)
			if f == nil || !s.reg.Usage.Add(share.PublisherID, int64(len(payload))) ||
				!s.reg.Usage.Add(f.consumer.UserID, int64(len(payload))) || !share.Bucket.TryTake(len(payload)) {
				share.UDPDropped.Add(1)
				continue
			}
			f.lastSeen.Store(time.Now().UnixNano())
			if err := f.consumer.conn.SendDatagram(EncodeDatagram(f.consumerFlow, payload)); err != nil {
				share.UDPDropped.Add(1)
				continue
			}
			share.BytesDown.Add(uint64(len(payload)))
		}
	}()
	// The control stream stays open; reading it notices a client that went away.
	_, _ = io.Copy(io.Discard, ctrl)
	<-conn.Context().Done()
}

func (s *Server) serveConsumer(conn *quic.Conn, ctrl *quic.Stream, userID, shareID string) {
	info, ok := s.reg.Info(shareID)
	if !ok {
		refuse(ctrl, conn, "not_found", ErrNotFound.Error())
		return
	}
	if err := s.policy.MayConsume(userID, info); err != nil {
		refuse(ctrl, conn, "no_access", err.Error())
		return
	}
	if s.reg.Usage.Exhausted(userID) {
		refuse(ctrl, conn, "daily_limit", "You have used the day’s port sharing traffic this server allows. It resets at midnight UTC.")
		return
	}
	peer := quicPeer{conn}
	share, consumer, err := s.reg.Join(shareID, userID, peer)
	if err != nil {
		refuse(ctrl, conn, "join", err.Error())
		return
	}
	defer s.reg.Leave(shareID, consumer)
	if err := WriteFrame(ctrl, Frame{Type: FrameAttachOK, DatagramMTU: DatagramHint}); err != nil {
		return
	}
	go s.consumerDatagrams(conn, share, consumer)
	go func() { _, _ = io.Copy(io.Discard, ctrl) }()
	for {
		stream, err := conn.AcceptStream(conn.Context())
		if err != nil {
			return
		}
		go s.openFlow(conn, share, consumer, quicStream{stream})
	}
}

func (s *Server) consumerDatagrams(conn *quic.Conn, share *Share, c *Consumer) {
	for {
		data, err := conn.ReceiveDatagram(conn.Context())
		if err != nil {
			return
		}
		cflow, payload, ok := DecodeDatagram(data)
		if !ok {
			continue
		}
		relayID, f := s.reg.UDPFor(share, c, cflow)
		pub := s.reg.Publisher(share)
		if f == nil || pub == nil || !s.reg.Usage.Add(share.PublisherID, int64(len(payload))) ||
			!s.reg.Usage.Add(c.UserID, int64(len(payload))) || !share.Bucket.TryTake(len(payload)) {
			share.UDPDropped.Add(1)
			continue
		}
		f.lastSeen.Store(time.Now().UnixNano())
		if err := pub.SendDatagram(EncodeDatagram(relayID, payload)); err != nil {
			// A datagram larger than the path carries is dropped and counted.
			share.UDPDropped.Add(1)
			continue
		}
		share.BytesUp.Add(uint64(len(payload)))
	}
}

// reject answers an Open with a reason and drops the stream.
func reject(stream Stream, reason string) {
	_ = WriteFrame(stream, Frame{Type: FrameRefused, Reason: reason})
	_ = stream.CloseWrite()
}

func reasonOf(err error) string {
	var limit *LimitError
	if errors.As(err, &limit) {
		return limit.Message
	}
	return err.Error()
}

// openFlow starts one TCP connection or UDP flow for a consumer.
func (s *Server) openFlow(conn *quic.Conn, share *Share, c *Consumer, stream Stream) {
	open, err := ReadFrame(stream)
	if err != nil || open.Type != FrameOpen || open.ShareID != share.ID {
		reject(stream, "The relay didn’t understand that request.")
		return
	}
	// Access is checked again for every flow, not only when the connection opened.
	info, ok := s.reg.Info(share.ID)
	if !ok {
		reject(stream, ErrNotFound.Error())
		return
	}
	if err := s.policy.MayConsume(c.UserID, info); err != nil {
		reject(stream, err.Error())
		return
	}
	if !time.Now().Before(shareExpiry(info)) {
		reject(stream, "This share has expired.")
		return
	}
	if (open.Kind == KindTCP && !share.allowsTCP()) || (open.Kind == KindUDP && !share.allowsUDP()) || (open.Kind != KindTCP && open.Kind != KindUDP) {
		reject(stream, ErrProtocol.Error())
		return
	}
	pub := s.reg.Publisher(share)
	if pub == nil {
		reject(stream, ErrOffline.Error())
		return
	}

	// safeEnd drops both streams of this flow. It can be called from other goroutines
	// (the registry, when the share or consumer ends) before pubStream exists.
	var pubStream Stream
	var mu sync.Mutex
	safeEnd := func() {
		mu.Lock()
		defer mu.Unlock()
		stream.Abort()
		if pubStream != nil {
			pubStream.Abort()
		}
	}
	release, err := s.reg.AcquireFlow(share, c, safeEnd)
	if err != nil {
		reject(stream, reasonOf(err))
		return
	}
	defer release()

	ctx, cancel := context.WithTimeout(conn.Context(), 10*time.Second)
	opened, err := pub.OpenStream(ctx)
	cancel()
	if err != nil {
		reject(stream, ErrOffline.Error())
		return
	}
	mu.Lock()
	pubStream = opened
	mu.Unlock()

	relayID := s.flowID.Add(1)
	if open.Kind == KindUDP {
		id, _, err := s.reg.AddUDP(share, c, open.FlowID, safeEnd)
		if err != nil {
			reject(stream, reasonOf(err))
			pubStream.Abort()
			return
		}
		relayID = id
		defer s.reg.RemoveUDP(share, id)
	}
	if err := WriteFrame(pubStream, Frame{Type: FrameIncoming, FlowID: relayID, UserID: c.UserID, Kind: open.Kind}); err != nil {
		reject(stream, ErrOffline.Error())
		pubStream.Abort()
		return
	}
	answer, err := ReadFrame(pubStream)
	if err != nil {
		reject(stream, ErrOffline.Error())
		pubStream.Abort()
		return
	}
	if answer.Type == FrameRefused {
		reject(stream, answer.Reason)
		pubStream.Abort()
		return
	}
	if answer.Type != FrameAccepted {
		reject(stream, "The sharer’s Raven sent something the relay didn’t understand.")
		pubStream.Abort()
		return
	}
	if err := WriteFrame(stream, Frame{Type: FrameAccepted, DatagramMTU: answer.DatagramMTU}); err != nil {
		pubStream.Abort()
		return
	}
	if open.Kind == KindUDP {
		// The streams carry no bytes for UDP; they only mark the flow's life.
		done := make(chan struct{}, 2)
		go func() { _, _ = io.Copy(io.Discard, stream); done <- struct{}{} }()
		go func() { _, _ = io.Copy(io.Discard, pubStream); done <- struct{}{} }()
		<-done
		safeEnd()
		return
	}
	s.pipe(share, c.UserID, stream, pubStream)
}

func shareExpiry(info ShareInfo) time.Time {
	t, err := time.Parse(time.RFC3339, info.ExpiresAt)
	if err != nil {
		return time.Time{}
	}
	return t
}

// pipe copies bytes both ways between a consumer's stream and the publisher's, paced by
// the share's bucket and counted against both people's day.
func (s *Server) pipe(share *Share, consumerID string, consumer, publisher Stream) {
	var wg sync.WaitGroup
	copyOne := func(from, to Stream, counter *atomic.Uint64) {
		defer wg.Done()
		buf := make([]byte, 32*1024)
		for {
			n, err := from.Read(buf)
			if n > 0 {
				share.Bucket.Take(n)
				if !s.reg.Usage.Add(share.PublisherID, int64(n)) || !s.reg.Usage.Add(consumerID, int64(n)) {
					consumer.Abort()
					publisher.Abort()
					return
				}
				if _, werr := to.Write(buf[:n]); werr != nil {
					consumer.Abort()
					publisher.Abort()
					return
				}
				counter.Add(uint64(n))
			}
			if err != nil {
				if errors.Is(err, io.EOF) {
					_ = to.CloseWrite()
				} else {
					consumer.Abort()
					publisher.Abort()
				}
				return
			}
		}
	}
	wg.Add(2)
	go copyOne(consumer, publisher, &share.BytesUp)
	go copyOne(publisher, consumer, &share.BytesDown)
	wg.Wait()
	consumer.Abort()
	publisher.Abort()
}

