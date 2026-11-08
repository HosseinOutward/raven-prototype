package relay

import (
	"context"
	"errors"
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

// Server joins publishers and consumers. One connection serves one role in one share: a
// publisher connection owns the share, a consumer connection uses it.
type Server struct {
	reg    *Registry
	policy Policy
	ln     *quic.Listener // nil until Listen; WebSocket clients come through the API
	flowID atomic.Uint32

	// The connections each sign-in (session token) holds, so they can be cut when the
	// sign-in ends.
	mu       sync.Mutex
	sessions map[string]map[Conn]struct{}
}

func NewServer(reg *Registry, policy Policy) *Server {
	return &Server{reg: reg, policy: policy, sessions: map[string]map[Conn]struct{}{}}
}

func (s *Server) track(token string, conn Conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessions[token] == nil {
		s.sessions[token] = map[Conn]struct{}{}
	}
	s.sessions[token][conn] = struct{}{}
}

func (s *Server) untrack(token string, conn Conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions[token], conn)
	if len(s.sessions[token]) == 0 {
		delete(s.sessions, token)
	}
}

// Sessions lists the sign-ins that hold connections, for a sweep that checks they are
// still valid.
func (s *Server) Sessions() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	tokens := make([]string, 0, len(s.sessions))
	for token := range s.sessions {
		tokens = append(tokens, token)
	}
	return tokens
}

// EndSession closes every connection a sign-in holds: it was signed out, revoked or
// expired. A publisher's share ends with its connection.
func (s *Server) EndSession(token string) {
	s.mu.Lock()
	conns := make([]Conn, 0, len(s.sessions[token]))
	for conn := range s.sessions[token] {
		conns = append(conns, conn)
	}
	s.mu.Unlock()
	for _, conn := range conns {
		conn.Close("signed_out")
	}
}

// Conn is one client connection to the relay, over QUIC or over WebSocket. The first
// stream the client opens is the control stream.
type Conn interface {
	AcceptStream(ctx context.Context) (Stream, error)
	OpenStream(ctx context.Context) (Stream, error)
	SendDatagram(data []byte) error
	ReceiveDatagram(ctx context.Context) ([]byte, error)
	// Context ends when the connection does.
	Context() context.Context
	// Close ends the connection, giving the client the reason.
	Close(reason string)
}

func refuse(ctrl Stream, conn Conn, code, message string) {
	_ = WriteFrame(ctrl, Frame{Type: FrameError, Code: code, Message: message})
	// Give the frame a moment to leave before the connection closes.
	time.Sleep(50 * time.Millisecond)
	conn.Close(code)
}

// Serve runs one client connection until it ends, whatever transport carries it.
func (s *Server) Serve(conn Conn) {
	// A client that hasn't said hello and attached in time is dropped.
	late := time.AfterFunc(helloTimeout, func() { conn.Close("hello_timeout") })
	defer late.Stop()
	ctx, cancel := context.WithTimeout(conn.Context(), helloTimeout)
	ctrl, err := conn.AcceptStream(ctx)
	cancel()
	if err != nil {
		conn.Close("hello")
		return
	}
	hello, err := ReadFrame(ctrl)
	if err != nil || hello.Type != FrameHello {
		refuse(ctrl, conn, "bad_hello", "The relay didn’t understand this connection.")
		return
	}
	userID, err := s.policy.Authenticate(hello.Token)
	if err != nil {
		refuse(ctrl, conn, "unauthenticated", err.Error())
		return
	}
	s.track(hello.Token, conn)
	defer s.untrack(hello.Token, conn)
	if err := WriteFrame(ctrl, Frame{Type: FrameHelloOK, UserID: userID}); err != nil {
		conn.Close("hello")
		return
	}
	attach, err := ReadFrame(ctrl)
	if err != nil || attach.Type != FrameAttach {
		refuse(ctrl, conn, "bad_attach", "The relay didn’t understand this connection.")
		return
	}
	if !late.Stop() {
		return
	}
	switch hello.Role {
	case RolePublisher:
		s.servePublisher(conn, ctrl, userID, attach.ShareID)
	case RoleConsumer:
		s.serveConsumer(conn, ctrl, userID, attach.ShareID)
	default:
		refuse(ctrl, conn, "bad_role", "The relay didn’t understand this connection.")
	}
}

func (s *Server) servePublisher(conn Conn, ctrl Stream, userID, shareID string) {
	info, ok := s.reg.Info(shareID)
	if !ok {
		refuse(ctrl, conn, "not_found", ErrNotFound.Error())
		return
	}
	if err := s.policy.MayPublish(userID, info); err != nil {
		refuse(ctrl, conn, "no_access", err.Error())
		return
	}
	share, err := s.reg.Attach(shareID, userID, conn)
	if err != nil {
		refuse(ctrl, conn, "attach", err.Error())
		return
	}
	defer s.reg.Detach(shareID, conn)
	if err := WriteFrame(ctrl, Frame{Type: FrameAttachOK, DatagramMTU: DatagramHint}); err != nil {
		conn.Close("attach")
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
			if f == nil || !s.mayCarry(share, f.consumer.UserID, len(payload)) {
				share.UDPDropped.Add(1)
				continue
			}
			f.lastSeen.Store(time.Now().UnixNano())
			if err := f.consumer.conn.SendDatagram(EncodeDatagram(f.consumerFlow, payload)); err != nil {
				share.UDPDropped.Add(1)
				continue
			}
			s.carried(share, f.consumer.UserID, len(payload))
			share.BytesDown.Add(uint64(len(payload)))
		}
	}()
	// The control stream stays open; reading it notices a client that went away.
	_, _ = io.Copy(io.Discard, ctrl)
	<-conn.Context().Done()
}

func (s *Server) serveConsumer(conn Conn, ctrl Stream, userID, shareID string) {
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
	share, consumer, err := s.reg.Join(shareID, userID, conn)
	if err != nil {
		refuse(ctrl, conn, "join", err.Error())
		return
	}
	defer s.reg.Leave(shareID, consumer)
	if err := WriteFrame(ctrl, Frame{Type: FrameAttachOK, DatagramMTU: DatagramHint}); err != nil {
		conn.Close("attach")
		return
	}
	go s.consumerDatagrams(conn, share, consumer)
	go func() { _, _ = io.Copy(io.Discard, ctrl) }()
	// opening bounds the streams still waiting for their Open frame. They hold no flow
	// slot yet, and yamux (unlike QUIC) has no cap on open streams of its own.
	opening := make(chan struct{}, s.reg.Limits().MaxFlows)
	for {
		stream, err := conn.AcceptStream(conn.Context())
		if err != nil {
			return
		}
		select {
		case opening <- struct{}{}:
			go s.openFlow(conn, share, consumer, stream, opening)
		default:
			stream.Abort()
		}
	}
}

func (s *Server) consumerDatagrams(conn Conn, share *Share, c *Consumer) {
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
		if f == nil || pub == nil || !s.mayCarry(share, c.UserID, len(payload)) {
			share.UDPDropped.Add(1)
			continue
		}
		f.lastSeen.Store(time.Now().UnixNano())
		if err := pub.SendDatagram(EncodeDatagram(relayID, payload)); err != nil {
			// A datagram larger than the path carries is dropped and counted.
			share.UDPDropped.Add(1)
			continue
		}
		s.carried(share, c.UserID, len(payload))
		share.BytesUp.Add(uint64(len(payload)))
	}
}

// mayCarry reports whether a datagram fits both people's day and the share's rate. Only
// datagrams that are then sent count toward the day, through carried.
func (s *Server) mayCarry(share *Share, consumerID string, n int) bool {
	return !s.reg.Usage.Exhausted(share.PublisherID) && !s.reg.Usage.Exhausted(consumerID) && share.Bucket.TryTake(n)
}

func (s *Server) carried(share *Share, consumerID string, n int) {
	s.reg.Usage.Add(share.PublisherID, int64(n))
	s.reg.Usage.Add(consumerID, int64(n))
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
func (s *Server) openFlow(conn Conn, share *Share, c *Consumer, stream Stream, opening chan struct{}) {
	late := time.AfterFunc(helloTimeout, stream.Abort)
	open, err := ReadFrame(stream)
	// Stop reports false once the timer has fired: the stream is already aborted.
	timedOut := !late.Stop()
	<-opening
	if timedOut || err != nil || open.Type != FrameOpen || open.ShareID != share.ID {
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
