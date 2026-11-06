package relay

import (
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hashicorp/yamux"
)

// hijackedWS behaves like a WebSocket on Fiber's hijacked connection: Close does nothing.
type hijackedWS struct{ *websocket.Conn }

func (hijackedWS) Close() error { return nil }

// recordingWS keeps the error that ended the WebSocket, so a test can read the close
// reason without a second reader on the connection.
type recordingWS struct {
	*websocket.Conn
	ended chan error
}

func (r *recordingWS) NextReader() (int, io.Reader, error) {
	kind, rd, err := r.Conn.NextReader()
	if err != nil {
		select {
		case r.ended <- err:
		default:
		}
	}
	return kind, rd, err
}

// wsClient is a Raven client on the WebSocket route.
type wsClient struct {
	ws    *recordingWS
	sess  *yamux.Session
	ctrl  *yamux.Stream
	dgram *yamux.Stream
}

func (h *harness) wsURL() string {
	h.t.Helper()
	upgrader := websocket.Upgrader{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		// Like Fiber's: the connection closes only when the handler returns.
		h.srv.ServeWebSocket(hijackedWS{ws})
		_ = ws.Close()
	}))
	h.t.Cleanup(ts.Close)
	return "ws" + strings.TrimPrefix(ts.URL, "http") + "/v1/relay/ws"
}

func dialWS(t *testing.T, url, token string, role uint8, shareID string) (*wsClient, error) {
	t.Helper()
	ws, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.Close() })
	rec := &recordingWS{Conn: ws, ended: make(chan error, 1)}
	sess, err := yamux.Client(&wsBytes{ws: rec}, YamuxConfig())
	if err != nil {
		t.Fatal(err)
	}
	ctrl, err := sess.OpenStream()
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteFrame(ctrl, Frame{Type: FrameHello, Token: token, Role: role}); err != nil {
		return nil, err
	}
	if f, err := ReadFrame(ctrl); err != nil || f.Type != FrameHelloOK {
		return nil, wrapFrame(f, err)
	}
	if err := WriteFrame(ctrl, Frame{Type: FrameAttach, ShareID: shareID}); err != nil {
		return nil, err
	}
	if f, err := ReadFrame(ctrl); err != nil || f.Type != FrameAttachOK {
		return nil, wrapFrame(f, err)
	}
	dgram, err := sess.OpenStream()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dgram.Write([]byte{DatagramTag}); err != nil {
		t.Fatal(err)
	}
	return &wsClient{ws: rec, sess: sess, ctrl: ctrl, dgram: dgram}, nil
}

func (c *wsClient) sendDatagram(data []byte) error {
	framed := binary.BigEndian.AppendUint16(nil, uint16(len(data)))
	_, err := c.dgram.Write(append(framed, data...))
	return err
}

func (c *wsClient) readDatagram() ([]byte, error) {
	_ = c.dgram.SetReadDeadline(time.Now().Add(5 * time.Second))
	var size [2]byte
	if _, err := io.ReadFull(c.dgram, size[:]); err != nil {
		return nil, err
	}
	buf := make([]byte, binary.BigEndian.Uint16(size[:]))
	_, err := io.ReadFull(c.dgram, buf)
	return buf, err
}

func (c *wsClient) openFlow(t *testing.T, shareID string, kind uint8, flow uint32) (*yamux.Stream, Frame) {
	t.Helper()
	s, err := c.sess.OpenStream()
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteFrame(s, Frame{Type: FrameOpen, ShareID: shareID, Kind: kind, FlowID: flow}); err != nil {
		t.Fatal(err)
	}
	_ = s.SetReadDeadline(time.Now().Add(5 * time.Second))
	answer, err := ReadFrame(s)
	if err != nil {
		t.Fatal(err)
	}
	_ = s.SetReadDeadline(time.Time{})
	return s, answer
}

// A consumer on the WebSocket route reaches a publisher on QUIC: TCP and UDP.
func TestWebSocketConsumerReachesAQUICPublisher(t *testing.T) {
	h := newHarness(t, testPolicy{})
	url := h.wsURL()
	share, err := h.reg.Create(Spec{PublisherID: "alice", PlaceKind: "nest", PlaceID: "n", Name: "x", Protocol: "both", Port: 1, Everyone: true}, 60)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := h.dial("alice", RolePublisher, share.ID)
	if err != nil {
		t.Fatal(err)
	}
	servePublisher(pub, echoServer(t))
	bob, err := dialWS(t, url, "bob", RoleConsumer, share.ID)
	if err != nil {
		t.Fatal(err)
	}

	tcp, answer := bob.openFlow(t, share.ID, KindTCP, 0)
	if answer.Type != FrameAccepted {
		t.Fatalf("tcp flow refused: %+v", answer)
	}
	msg := strings.Repeat("hello over websocket ", 4000)
	go func() { _, _ = tcp.Write([]byte(msg)) }()
	got := make([]byte, len(msg))
	_ = tcp.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(tcp, got); err != nil || string(got) != msg {
		t.Fatalf("tcp echo: %v", err)
	}

	if _, answer := bob.openFlow(t, share.ID, KindUDP, 9); answer.Type != FrameAccepted {
		t.Fatalf("udp flow refused: %+v", answer)
	}
	if err := bob.sendDatagram(EncodeDatagram(9, []byte("ping"))); err != nil {
		t.Fatal(err)
	}
	data, err := bob.readDatagram()
	if err != nil {
		t.Fatal(err)
	}
	if flow, payload, _ := DecodeDatagram(data); flow != 9 || string(payload) != "echo:ping" {
		t.Fatalf("udp echo flow=%d %q", flow, payload)
	}
}

// The reason a share ended reaches a WebSocket client in the close frame.
func TestWebSocketClientHearsWhyTheShareEnded(t *testing.T) {
	h := newHarness(t, testPolicy{})
	url := h.wsURL()
	share, _ := h.reg.Create(Spec{PublisherID: "alice", PlaceKind: "nest", PlaceID: "n", Name: "x", Protocol: "tcp", Port: 1, Everyone: true}, 60)
	pub, err := dialWS(t, url, "alice", RolePublisher, share.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dialWS(t, url, "mallory", RoleConsumer, "nope"); err == nil {
		t.Fatal("an unknown share must be refused")
	}
	h.reg.End(share.ID, ReasonStopped)
	select {
	case err := <-pub.ws.ended:
		var closed *websocket.CloseError
		if !errors.As(err, &closed) || closed.Text != string(ReasonStopped) {
			t.Fatalf("got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the publisher should be disconnected")
	}
}

// wsServePublisher plays the sharing client on the WebSocket route: TCP flows to target.
func wsServePublisher(c *wsClient, target string) {
	go func() {
		for {
			s, err := c.sess.AcceptStream()
			if err != nil {
				return
			}
			go func() {
				in, err := ReadFrame(s)
				if err != nil || in.Type != FrameIncoming {
					return
				}
				local, err := net.Dial("tcp", target)
				if err != nil {
					_ = WriteFrame(s, Frame{Type: FrameRefused, Reason: "Nothing is listening on that port."})
					return
				}
				_ = WriteFrame(s, Frame{Type: FrameAccepted})
				go func() { _, _ = io.Copy(local, s); _ = local.Close() }()
				_, _ = io.Copy(s, local)
				_ = s.Close()
			}()
		}
	}()
}

// Stopping a share with an open flow, both people on the WebSocket route, ends at once.
func TestStoppingAShareOverWebSocketDoesNotHang(t *testing.T) {
	h := newHarness(t, testPolicy{})
	url := h.wsURL()
	share, _ := h.reg.Create(Spec{PublisherID: "alice", PlaceKind: "nest", PlaceID: "n", Name: "x", Protocol: "tcp", Port: 1, Everyone: true}, 60)
	pub, err := dialWS(t, url, "alice", RolePublisher, share.ID)
	if err != nil {
		t.Fatal(err)
	}
	wsServePublisher(pub, echoServer(t))
	bob, err := dialWS(t, url, "bob", RoleConsumer, share.ID)
	if err != nil {
		t.Fatal(err)
	}
	tcp, answer := bob.openFlow(t, share.ID, KindTCP, 0)
	if answer.Type != FrameAccepted {
		t.Fatalf("refused: %+v", answer)
	}
	if _, err := tcp.Write([]byte("hi")); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 2)
	if _, err := io.ReadFull(tcp, got); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { h.reg.End(share.ID, ReasonStopped); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		panic("End hung")
	}
}

// Closing never waits for the client: one that has gone silent must not hold it up.
func TestClosingDoesNotWaitForASilentClient(t *testing.T) {
	closed := make(chan struct{})
	upgrader := websocket.Upgrader{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		conn, err := newWSConn(hijackedWS{ws})
		if err != nil {
			return
		}
		conn.Close("stopped")
		close(closed)
	}))
	t.Cleanup(ts.Close)
	// The client connects and then reads nothing.
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(ts.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("Close waited for the client")
	}
}
