package relay

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"sync"
	"testing"
	"time"
)

// The same fixtures are checked by the Rust side in workshop/frames.rs. If a byte here
// changes, change it there too.
func TestFrameFixtures(t *testing.T) {
	cases := []struct {
		name  string
		frame Frame
		hex   string
	}{
		{"hello", Frame{Type: FrameHello, Token: "abc", Role: RolePublisher}, "010100000006" + "0003616263" + "01"},
		{"open", Frame{Type: FrameOpen, ShareID: "s1", Kind: KindTCP, FlowID: 7}, "010500000009" + "00027331" + "01" + "00000007"},
		{"incoming", Frame{Type: FrameIncoming, FlowID: 9, UserID: "u", Kind: KindUDP}, "010600000008" + "00000009" + "000175" + "02"},
		{"error", Frame{Type: FrameError, Code: "c", Message: "m"}, "010900000006" + "000163" + "00016d"},
		{"accepted", Frame{Type: FrameAccepted, DatagramMTU: 1200}, "010700000002" + "04b0"},
	}
	for _, c := range cases {
		got := hex.EncodeToString(c.frame.Encode())
		if got != c.hex {
			t.Errorf("%s: encoded %s, want %s", c.name, got, c.hex)
		}
		back, err := ReadFrame(bytes.NewReader(c.frame.Encode()))
		if err != nil || back != c.frame {
			t.Errorf("%s: round trip gave %+v, %v", c.name, back, err)
		}
	}
	flow, payload, ok := DecodeDatagram(EncodeDatagram(5, []byte("hi")))
	if !ok || flow != 5 || string(payload) != "hi" || hex.EncodeToString(EncodeDatagram(5, []byte("hi"))) != "000000056869" {
		t.Errorf("datagram round trip failed: %d %q %v", flow, payload, ok)
	}
}

func TestFrameRejectsBadInput(t *testing.T) {
	if _, err := ReadFrame(bytes.NewReader([]byte{2, 1, 0, 0, 0, 0})); err == nil {
		t.Error("an unknown version should fail")
	}
	if _, err := ReadFrame(bytes.NewReader([]byte{1, 1, 0xff, 0xff, 0xff, 0xff})); err == nil {
		t.Error("an oversized body should fail")
	}
	if _, err := ReadFrame(bytes.NewReader([]byte{1, 1, 0, 0, 0, 1, 9})); err == nil {
		t.Error("a truncated body should fail")
	}
	if _, err := ReadFrame(bytes.NewReader([]byte{1, 99, 0, 0, 0, 0})); err == nil {
		t.Error("an unknown type should fail")
	}
}

type fakePub struct {
	mu     sync.Mutex
	closed []string
}

func (f *fakePub) OpenStream(context.Context) (Stream, error) { return nil, errors.New("not used") }
func (f *fakePub) SendDatagram([]byte) error                  { return nil }
func (f *fakePub) Close(reason string) {
	f.mu.Lock()
	f.closed = append(f.closed, reason)
	f.mu.Unlock()
}

type fakeConsumer = fakePub

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func testRegistry(t *testing.T, mutate func(*Limits)) (*Registry, *clock, *[]string) {
	t.Helper()
	limits := DefaultLimits()
	limits.Enabled = true
	if mutate != nil {
		mutate(&limits)
	}
	r := NewRegistry(limits)
	clk := &clock{t: time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)}
	r.now = clk.now
	events := []string{}
	r.OnEvent = func(kind string, info ShareInfo, reason EndReason) {
		entry := kind + ":" + info.ID
		if reason != "" {
			entry += ":" + string(reason)
		}
		events = append(events, entry)
	}
	return r, clk, &events
}

func spec(publisher string) Spec {
	return Spec{PublisherID: publisher, PlaceKind: "nest", PlaceID: "n1", Name: "web", Protocol: "tcp", Port: 8080, Everyone: true}
}

func TestShareCapPerPublisher(t *testing.T) {
	r, _, _ := testRegistry(t, func(l *Limits) { l.MaxShares = 2 })
	for i := 0; i < 2; i++ {
		if _, err := r.Create(spec("alice"), 0); err != nil {
			t.Fatal(err)
		}
	}
	_, err := r.Create(spec("alice"), 0)
	var limit *LimitError
	if !errors.As(err, &limit) || limit.Message == "" {
		t.Fatalf("the third share should hit the limit, got %v", err)
	}
	if _, err := r.Create(spec("bob"), 0); err != nil {
		t.Fatalf("another publisher has their own count: %v", err)
	}
}

func TestExpiryExtendAndCap(t *testing.T) {
	r, clk, events := testRegistry(t, nil)
	share, _ := r.Create(spec("alice"), 0)
	pub := &fakePub{}
	if _, err := r.Attach(share.ID, "alice", pub); err != nil {
		t.Fatal(err)
	}
	info, _ := r.Info(share.ID)
	if want := clk.t.Add(120 * time.Minute).Format(time.RFC3339); info.ExpiresAt != want {
		t.Fatalf("default duration: got %s want %s", info.ExpiresAt, want)
	}
	if _, err := r.Extend(share.ID, "bob", 30); !errors.Is(err, ErrNotYours) {
		t.Fatalf("only the publisher extends, got %v", err)
	}
	clk.t = clk.t.Add(100 * time.Minute)
	info, err := r.Extend(share.ID, "alice", 100000)
	if err != nil {
		t.Fatal(err)
	}
	if want := clk.t.Add(720 * time.Minute).Format(time.RFC3339); info.ExpiresAt != want {
		t.Fatalf("extension is capped: got %s want %s", info.ExpiresAt, want)
	}
	clk.t = clk.t.Add(719 * time.Minute)
	r.ExpireDue()
	if r.Get(share.ID) == nil {
		t.Fatal("not expired yet")
	}
	clk.t = clk.t.Add(2 * time.Minute)
	r.ExpireDue()
	if r.Get(share.ID) != nil {
		t.Fatal("share should have expired")
	}
	if len(pub.closed) != 1 || pub.closed[0] != "expired" {
		t.Fatalf("publisher should be told: %v", pub.closed)
	}
	last := (*events)[len(*events)-1]
	if last != "ended:"+share.ID+":expired" {
		t.Fatalf("last event %s", last)
	}
}

func TestUnattachedShareEndsAfterGrace(t *testing.T) {
	r, clk, _ := testRegistry(t, nil)
	share, _ := r.Create(spec("alice"), 0)
	clk.t = clk.t.Add(AttachGrace - time.Second)
	r.ExpireDue()
	if r.Get(share.ID) == nil {
		t.Fatal("still within the grace period")
	}
	clk.t = clk.t.Add(2 * time.Second)
	r.ExpireDue()
	if r.Get(share.ID) != nil {
		t.Fatal("a share nobody attached to should end")
	}
}

func TestPublisherDisconnectEndsShareAndConsumers(t *testing.T) {
	r, _, events := testRegistry(t, nil)
	share, _ := r.Create(spec("alice"), 0)
	pub := &fakePub{}
	r.Attach(share.ID, "alice", pub)
	bob := &fakeConsumer{}
	_, c, err := r.Join(share.ID, "bob", bob)
	if err != nil {
		t.Fatal(err)
	}
	flowClosed := false
	if _, err := r.AcquireFlow(share, c, func() { flowClosed = true }); err != nil {
		t.Fatal(err)
	}
	r.Detach(share.ID, pub)
	if r.Get(share.ID) != nil || !flowClosed || len(bob.closed) != 1 || bob.closed[0] != "publisher_offline" {
		t.Fatalf("share=%v flowClosed=%v bob=%v", r.Get(share.ID), flowClosed, bob.closed)
	}
	if got := (*events)[len(*events)-1]; got != "ended:"+share.ID+":publisher_offline" {
		t.Fatalf("event %s", got)
	}
}

func TestAReplacedPublisherConnectionDoesNotEndTheShare(t *testing.T) {
	r, _, _ := testRegistry(t, nil)
	share, _ := r.Create(spec("alice"), 0)
	first, second := &fakePub{}, &fakePub{}
	r.Attach(share.ID, "alice", first)
	r.Attach(share.ID, "alice", second)
	r.Detach(share.ID, first)
	if r.Get(share.ID) == nil {
		t.Fatal("the old connection closing must not end the share")
	}
	if _, err := r.Attach(share.ID, "bob", &fakePub{}); !errors.Is(err, ErrNotYours) {
		t.Fatalf("only the publisher attaches, got %v", err)
	}
}

func TestAudienceAndConsumerLimits(t *testing.T) {
	r, _, _ := testRegistry(t, func(l *Limits) { l.MaxConsumers = 2 })
	picked := spec("alice")
	picked.Everyone = false
	picked.Audience = []string{"bob", "carol", "dave"}
	share, _ := r.Create(picked, 0)
	if _, _, err := r.Join(share.ID, "bob", &fakeConsumer{}); !errors.Is(err, ErrOffline) {
		t.Fatalf("nobody connects before the publisher does, got %v", err)
	}
	r.Attach(share.ID, "alice", &fakePub{})
	if _, _, err := r.Join(share.ID, "erin", &fakeConsumer{}); !errors.Is(err, ErrNotInShare) {
		t.Fatalf("erin is not in the audience, got %v", err)
	}
	if _, _, err := r.Join(share.ID, "alice", &fakeConsumer{}); !errors.Is(err, ErrNotInShare) {
		t.Fatalf("the publisher does not consume their own share, got %v", err)
	}
	r.Join(share.ID, "bob", &fakeConsumer{})
	r.Join(share.ID, "carol", &fakeConsumer{})
	var limit *LimitError
	if _, _, err := r.Join(share.ID, "dave", &fakeConsumer{}); !errors.As(err, &limit) {
		t.Fatalf("a third consumer hits the cap, got %v", err)
	}
	old := &fakeConsumer{}
	bobAgain := &fakeConsumer{}
	r.Join(share.ID, "bob", bobAgain)
	_ = old
	if info, _ := r.Info(share.ID); len(info.Consumers) != 2 {
		t.Fatalf("a reconnecting consumer replaces their old connection: %v", info.Consumers)
	}
}

func TestVisibilityFollowsTheAudience(t *testing.T) {
	r, _, _ := testRegistry(t, nil)
	picked := spec("alice")
	picked.Everyone = false
	picked.Audience = []string{"bob"}
	r.Create(picked, 0)
	r.Create(spec("alice"), 0)
	if got := len(r.ListPlace("nest", "n1", "bob")); got != 2 {
		t.Errorf("bob sees both: %d", got)
	}
	if got := len(r.ListPlace("nest", "n1", "carol")); got != 1 {
		t.Errorf("carol sees only the open one: %d", got)
	}
	if got := len(r.ListPlace("nest", "other", "bob")); got != 0 {
		t.Errorf("another place has none: %d", got)
	}
}

func TestEndConsumerClosesOnlyThatConsumer(t *testing.T) {
	r, _, _ := testRegistry(t, nil)
	share, _ := r.Create(spec("alice"), 0)
	r.Attach(share.ID, "alice", &fakePub{})
	bob, carol := &fakeConsumer{}, &fakeConsumer{}
	_, bc, _ := r.Join(share.ID, "bob", bob)
	r.Join(share.ID, "carol", carol)
	closed := false
	r.AcquireFlow(share, bc, func() { closed = true })
	r.EndConsumer(share.ID, "bob", ReasonLeftPlace)
	if !closed || len(bob.closed) != 1 || len(carol.closed) != 0 {
		t.Fatalf("closed=%v bob=%v carol=%v", closed, bob.closed, carol.closed)
	}
	if info, _ := r.Info(share.ID); len(info.Consumers) != 1 || info.Consumers[0] != "carol" {
		t.Fatalf("consumers %v", info.Consumers)
	}
}

func TestFlowCapPerConsumer(t *testing.T) {
	r, _, _ := testRegistry(t, func(l *Limits) { l.MaxFlows = 2 })
	share, _ := r.Create(spec("alice"), 0)
	r.Attach(share.ID, "alice", &fakePub{})
	_, c, _ := r.Join(share.ID, "bob", &fakeConsumer{})
	var releases []func()
	for i := 0; i < 2; i++ {
		release, err := r.AcquireFlow(share, c, func() {})
		if err != nil {
			t.Fatal(err)
		}
		releases = append(releases, release)
	}
	var limit *LimitError
	if _, err := r.AcquireFlow(share, c, func() {}); !errors.As(err, &limit) {
		t.Fatalf("the third flow hits the cap, got %v", err)
	}
	releases[0]()
	if _, err := r.AcquireFlow(share, c, func() {}); err != nil {
		t.Fatalf("a freed slot can be reused: %v", err)
	}
}

func TestUDPFlowTableExpiresWhenIdle(t *testing.T) {
	r, clk, _ := testRegistry(t, nil)
	share, _ := r.Create(spec("alice"), 0)
	r.Attach(share.ID, "alice", &fakePub{})
	_, c, _ := r.Join(share.ID, "bob", &fakeConsumer{})
	ended := false
	id, flow, err := r.AddUDP(share, c, 42, func() { ended = true })
	if err != nil {
		t.Fatal(err)
	}
	if got, f := r.UDPFor(share, c, 42); got != id || f != flow {
		t.Fatal("lookup by consumer flow")
	}
	if r.UDPByRelayID(share, id) != flow {
		t.Fatal("lookup by relay flow")
	}
	clk.t = clk.t.Add(UDPIdle - time.Second)
	r.expireIdleUDP()
	if ended {
		t.Fatal("not idle long enough")
	}
	flow.lastSeen.Store(clk.t.UnixNano())
	clk.t = clk.t.Add(UDPIdle + time.Second)
	r.expireIdleUDP()
	if !ended {
		t.Fatal("an idle flow should be ended")
	}
	r.RemoveUDP(share, id)
	if r.UDPByRelayID(share, id) != nil {
		t.Fatal("removed flow is gone")
	}
}

func TestBandwidthBucketPacesTraffic(t *testing.T) {
	b := NewBucket(1000)
	now := time.Unix(1000, 0)
	b.now = func() time.Time { return now }
	b.last = now
	b.tokens = 1000
	if wait := b.Reserve(1000); wait != 0 {
		t.Fatalf("a full bucket lets one second through at once, waited %v", wait)
	}
	if wait := b.Reserve(500); wait != 500*time.Millisecond {
		t.Fatalf("half a second of debt, waited %v", wait)
	}
	now = now.Add(2 * time.Second)
	if wait := b.Reserve(1000); wait != 0 {
		t.Fatalf("the bucket refills, waited %v", wait)
	}
	if got := (Limits{ShareMbps: 20}).BytesPerSecond(); got != 2_500_000 {
		t.Fatalf("20 Mbit/s is 2.5 MB/s, got %d", got)
	}
}

func TestDailyCapResetsAtMidnightUTC(t *testing.T) {
	d := NewDailyUsage(100)
	now := time.Date(2026, 11, 6, 23, 0, 0, 0, time.UTC)
	d.now = func() time.Time { return now }
	if !d.Add("u", 60) || d.Exhausted("u") {
		t.Fatal("under the cap")
	}
	if d.Add("u", 60) || !d.Exhausted("u") {
		t.Fatal("over the cap")
	}
	if !d.Add("other", 10) {
		t.Fatal("another user has their own count")
	}
	now = now.Add(2 * time.Hour)
	if d.Exhausted("u") || !d.Add("u", 10) {
		t.Fatal("a new UTC day starts from zero")
	}
}

func TestLimitsFromEnv(t *testing.T) {
	t.Setenv("RAVEN_WORKSHOP_PORTS", "on")
	t.Setenv("RAVEN_WORKSHOP_MAX_SHARES", "5")
	t.Setenv("RAVEN_WORKSHOP_DAILY_GB", "0.5")
	t.Setenv("RAVEN_WORKSHOP_MAX_MINUTES", "60")
	t.Setenv("RAVEN_WORKSHOP_MAX_FLOWS", "nonsense")
	l := LimitsFromEnv()
	if !l.Enabled || l.MaxShares != 5 || l.DailyBytes != 1<<29 || l.MaxMinutes != 60 || l.DefaultMinutes != 60 || l.MaxFlows != 16 {
		t.Fatalf("unexpected limits %+v", l)
	}
	t.Setenv("RAVEN_WORKSHOP_PORTS", "")
	if LimitsFromEnv().Enabled {
		t.Fatal("the switch is off unless it says on")
	}
}
