package relay

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// EndReason says why a share or a consumer's part in it ended. Clients show a sentence
// for each.
type EndReason string

const (
	ReasonStopped          EndReason = "stopped"
	ReasonExpired          EndReason = "expired"
	ReasonPublisherOffline EndReason = "publisher_offline"
	ReasonLeftPlace        EndReason = "left_place"
	ReasonRelayRestarted   EndReason = "relay_restarted"
)

// Event kinds delivered to OnEvent.
const (
	EventAdded   = "added"
	EventUpdated = "updated"
	EventEnded   = "ended"
)

// Stream is one bidirectional byte stream to a client.
type Stream interface {
	io.ReadWriteCloser
	// CloseWrite sends end-of-stream but keeps reading.
	CloseWrite() error
	// Abort drops the stream in both directions.
	Abort()
}

// PublisherConn is the relay's handle on the connection that owns a share.
type PublisherConn interface {
	OpenStream(ctx context.Context) (Stream, error)
	SendDatagram(data []byte) error
	Close(reason string)
}

// ConsumerConn is the relay's handle on a consumer's connection.
type ConsumerConn interface {
	SendDatagram(data []byte) error
	Close(reason string)
}

// Spec is what a publisher asks for.
type Spec struct {
	PublisherID string
	PlaceKind   string // "nest" or "room"
	PlaceID     string
	Name        string
	Protocol    string // "tcp", "udp" or "both"
	Port        int
	Everyone    bool
	Audience    []string
}

// Consumer is one member connected to a share.
type Consumer struct {
	UserID string
	conn   ConsumerConn
	flows  map[uint64]func() // closers of this consumer's TCP connections and UDP flows
	udp    map[uint32]uint32 // the consumer's flow id to the relay's
}

// udpFlow is one UDP conversation, keyed by the relay's id.
type udpFlow struct {
	consumer     *Consumer
	consumerFlow uint32
	lastSeen     atomic.Int64 // unix nanoseconds
	end          func()
}

// Share is one published port.
type Share struct {
	ID          string
	PublisherID string
	PlaceKind   string
	PlaceID     string
	Name        string
	Protocol    string
	Port        int
	Everyone    bool
	Audience    map[string]bool
	CreatedAt   time.Time
	Bucket      *Bucket

	// Guarded by the registry's mutex.
	expiresAt      time.Time
	attachDeadline time.Time
	pub            PublisherConn
	consumers      map[string]*Consumer
	udp            map[uint32]*udpFlow
	nextFlow       uint32
	nextKey        uint64
	ended          bool

	UDPDropped atomic.Uint64
	BytesUp    atomic.Uint64 // consumer to publisher
	BytesDown  atomic.Uint64 // publisher to consumer
}

// Allows reports whether a user is in the share's audience. The publisher always is.
func (s *Share) Allows(userID string) bool {
	return userID == s.PublisherID || s.Everyone || s.Audience[userID]
}

func (s *Share) allowsTCP() bool { return s.Protocol == "tcp" || s.Protocol == "both" }
func (s *Share) allowsUDP() bool { return s.Protocol == "udp" || s.Protocol == "both" }

// ShareInfo is the JSON form of a share, for the API and for events.
type ShareInfo struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	PlaceKind   string   `json:"placeKind"`
	PlaceID     string   `json:"placeId"`
	PublisherID string   `json:"publisherId"`
	Protocol    string   `json:"protocol"`
	Port        int      `json:"port"`
	Everyone    bool     `json:"everyone"`
	Audience    []string `json:"audience"`
	ExpiresAt   string   `json:"expiresAt"`
	Online      bool     `json:"online"`
	Consumers   []string `json:"consumers"`
	UDPDropped  uint64   `json:"udpDropped"`
}

var (
	ErrNotFound   = errors.New("That share isn’t available.")
	ErrNotYours   = errors.New("Only the person who shared the port can do that.")
	ErrNotInShare = errors.New("You aren’t in this share’s audience.")
	ErrOffline    = errors.New("The person sharing this port isn’t connected to the relay.")
	ErrProtocol   = errors.New("This share doesn’t carry that kind of traffic.")
)

// Registry is every active share on this server. It is in memory on purpose: a share
// dies with its publisher's relay connection anyway, and a restart ends all of them.
type Registry struct {
	mu     sync.Mutex
	limits Limits
	shares map[string]*Share
	now    func() time.Time

	// Usage is the per-user daily byte count.
	Usage *DailyUsage
	// OnEvent is told about every change. It is called with no lock held.
	OnEvent func(kind string, info ShareInfo, reason EndReason)
}

// AttachGrace is how long a new share waits for its publisher to connect to the relay.
const AttachGrace = 30 * time.Second

func NewRegistry(limits Limits) *Registry {
	return &Registry{
		limits: limits,
		shares: map[string]*Share{},
		now:    time.Now,
		Usage:  NewDailyUsage(limits.DailyBytes),
	}
}

func (r *Registry) Limits() Limits { return r.limits }

func newID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func (r *Registry) clampMinutes(minutes int) int {
	if minutes <= 0 {
		minutes = r.limits.DefaultMinutes
	}
	if minutes > r.limits.MaxMinutes {
		minutes = r.limits.MaxMinutes
	}
	return minutes
}

// Create registers a share. The caller has already checked access to the place.
func (r *Registry) Create(spec Spec, minutes int) (*Share, error) {
	r.mu.Lock()
	active := 0
	for _, s := range r.shares {
		if s.PublisherID == spec.PublisherID {
			active++
		}
	}
	if active >= r.limits.MaxShares {
		r.mu.Unlock()
		return nil, limitErr("You already share %d ports, which is the most this server allows.", r.limits.MaxShares)
	}
	now := r.now()
	share := &Share{
		ID:             newID(),
		PublisherID:    spec.PublisherID,
		PlaceKind:      spec.PlaceKind,
		PlaceID:        spec.PlaceID,
		Name:           spec.Name,
		Protocol:       spec.Protocol,
		Port:           spec.Port,
		Everyone:       spec.Everyone,
		Audience:       map[string]bool{},
		CreatedAt:      now,
		Bucket:         NewBucket(r.limits.BytesPerSecond()),
		expiresAt:      now.Add(time.Duration(r.clampMinutes(minutes)) * time.Minute),
		attachDeadline: now.Add(AttachGrace),
		consumers:      map[string]*Consumer{},
		udp:            map[uint32]*udpFlow{},
	}
	for _, id := range spec.Audience {
		if id != spec.PublisherID {
			share.Audience[id] = true
		}
	}
	r.shares[share.ID] = share
	info := r.infoLocked(share)
	r.mu.Unlock()
	r.emit(EventAdded, info, "")
	return share, nil
}

func (r *Registry) infoLocked(s *Share) ShareInfo {
	audience := make([]string, 0, len(s.Audience))
	for id := range s.Audience {
		audience = append(audience, id)
	}
	sort.Strings(audience)
	consumers := make([]string, 0, len(s.consumers))
	for id := range s.consumers {
		consumers = append(consumers, id)
	}
	sort.Strings(consumers)
	return ShareInfo{
		ID: s.ID, Name: s.Name, PlaceKind: s.PlaceKind, PlaceID: s.PlaceID,
		PublisherID: s.PublisherID, Protocol: s.Protocol, Port: s.Port,
		Everyone: s.Everyone, Audience: audience,
		ExpiresAt: s.expiresAt.UTC().Format(time.RFC3339), Online: s.pub != nil,
		Consumers: consumers, UDPDropped: s.UDPDropped.Load(),
	}
}

func (r *Registry) emit(kind string, info ShareInfo, reason EndReason) {
	if r.OnEvent != nil {
		r.OnEvent(kind, info, reason)
	}
}

// Info returns the current JSON form of a share.
func (r *Registry) Info(id string) (ShareInfo, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.shares[id]
	if !ok {
		return ShareInfo{}, false
	}
	return r.infoLocked(s), true
}

// Get returns a live share.
func (r *Registry) Get(id string) *Share {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.shares[id]
}

// Extend sets a share's end to minutes from now, within the maximum.
func (r *Registry) Extend(id, userID string, minutes int) (ShareInfo, error) {
	r.mu.Lock()
	s, ok := r.shares[id]
	if !ok {
		r.mu.Unlock()
		return ShareInfo{}, ErrNotFound
	}
	if s.PublisherID != userID {
		r.mu.Unlock()
		return ShareInfo{}, ErrNotYours
	}
	s.expiresAt = r.now().Add(time.Duration(r.clampMinutes(minutes)) * time.Minute)
	info := r.infoLocked(s)
	r.mu.Unlock()
	r.emit(EventUpdated, info, "")
	return info, nil
}

// Stop ends a share on its publisher's request.
func (r *Registry) Stop(id, userID string) error {
	r.mu.Lock()
	s, ok := r.shares[id]
	r.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	if s.PublisherID != userID {
		return ErrNotYours
	}
	r.End(id, ReasonStopped)
	return nil
}

// End removes a share and closes everything attached to it.
func (r *Registry) End(id string, reason EndReason) bool {
	r.mu.Lock()
	s, ok := r.shares[id]
	if !ok {
		r.mu.Unlock()
		return false
	}
	delete(r.shares, id)
	s.ended = true
	info := r.infoLocked(s)
	pub := s.pub
	s.pub = nil
	var conns []ConsumerConn
	var closers []func()
	for _, c := range s.consumers {
		conns = append(conns, c.conn)
		for _, closer := range c.flows {
			closers = append(closers, closer)
		}
	}
	s.consumers = map[string]*Consumer{}
	r.mu.Unlock()
	for _, closer := range closers {
		closer()
	}
	for _, c := range conns {
		c.Close(string(reason))
	}
	if pub != nil {
		pub.Close(string(reason))
	}
	r.emit(EventEnded, info, reason)
	return true
}

// EndAll ends every share, for a server that is stopping.
func (r *Registry) EndAll(reason EndReason) {
	r.mu.Lock()
	ids := make([]string, 0, len(r.shares))
	for id := range r.shares {
		ids = append(ids, id)
	}
	r.mu.Unlock()
	for _, id := range ids {
		r.End(id, reason)
	}
}

// Attach makes a connection the owner of a share. When it closes, the share ends.
func (r *Registry) Attach(id, userID string, conn PublisherConn) (*Share, error) {
	r.mu.Lock()
	s, ok := r.shares[id]
	if !ok {
		r.mu.Unlock()
		return nil, ErrNotFound
	}
	if s.PublisherID != userID {
		r.mu.Unlock()
		return nil, ErrNotYours
	}
	if s.pub != nil {
		old := s.pub
		s.pub = conn
		info := r.infoLocked(s)
		r.mu.Unlock()
		// A client that reconnects replaces its previous connection, which is then no
		// longer the owner and so does not end the share when it closes.
		old.Close("replaced")
		r.emit(EventUpdated, info, "")
		return s, nil
	}
	s.pub = conn
	info := r.infoLocked(s)
	r.mu.Unlock()
	r.emit(EventUpdated, info, "")
	return s, nil
}

// Detach is called when a publisher's connection closes. It ends the share unless the
// connection had already been replaced.
func (r *Registry) Detach(id string, conn PublisherConn) {
	r.mu.Lock()
	s, ok := r.shares[id]
	owner := ok && s.pub == conn
	r.mu.Unlock()
	if owner {
		r.End(id, ReasonPublisherOffline)
	}
}

// Publisher returns the live connection that owns a share, if any.
func (r *Registry) Publisher(s *Share) PublisherConn {
	r.mu.Lock()
	defer r.mu.Unlock()
	return s.pub
}

// Join adds a consumer. The caller has already checked place access and capability.
func (r *Registry) Join(id, userID string, conn ConsumerConn) (*Share, *Consumer, error) {
	r.mu.Lock()
	s, ok := r.shares[id]
	if !ok {
		r.mu.Unlock()
		return nil, nil, ErrNotFound
	}
	if userID == s.PublisherID || !s.Allows(userID) {
		r.mu.Unlock()
		return nil, nil, ErrNotInShare
	}
	if s.pub == nil {
		r.mu.Unlock()
		return nil, nil, ErrOffline
	}
	if old, exists := s.consumers[userID]; !exists && len(s.consumers) >= r.limits.MaxConsumers {
		r.mu.Unlock()
		return nil, nil, limitErr("This share already has %d people connected, which is the most this server allows.", r.limits.MaxConsumers)
	} else if exists {
		defer old.conn.Close("replaced")
		for _, closer := range old.flows {
			defer closer()
		}
		for _, relayID := range old.udp {
			delete(s.udp, relayID)
		}
	}
	c := &Consumer{UserID: userID, conn: conn, flows: map[uint64]func(){}, udp: map[uint32]uint32{}}
	s.consumers[userID] = c
	info := r.infoLocked(s)
	r.mu.Unlock()
	r.emit(EventUpdated, info, "")
	return s, c, nil
}

// Leave removes a consumer whose connection closed.
func (r *Registry) Leave(id string, c *Consumer) {
	r.mu.Lock()
	s, ok := r.shares[id]
	if !ok || s.consumers[c.UserID] != c {
		r.mu.Unlock()
		return
	}
	delete(s.consumers, c.UserID)
	for _, relayID := range c.udp {
		delete(s.udp, relayID)
	}
	var closers []func()
	for _, closer := range c.flows {
		closers = append(closers, closer)
	}
	info := r.infoLocked(s)
	r.mu.Unlock()
	for _, closer := range closers {
		closer()
	}
	r.emit(EventUpdated, info, "")
}

// EndConsumer closes one person's part in a share, for example when they left the call.
func (r *Registry) EndConsumer(id, userID string, reason EndReason) {
	r.mu.Lock()
	s, ok := r.shares[id]
	if !ok {
		r.mu.Unlock()
		return
	}
	c, ok := s.consumers[userID]
	r.mu.Unlock()
	if !ok {
		return
	}
	c.conn.Close(string(reason))
	r.Leave(id, c)
}

// AcquireFlow reserves one of a consumer's flow slots. closer is called when the flow
// must end because the consumer or the share is gone. release gives the slot back.
func (r *Registry) AcquireFlow(s *Share, c *Consumer, closer func()) (release func(), err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s.ended || s.consumers[c.UserID] != c {
		return nil, ErrNotFound
	}
	if len(c.flows) >= r.limits.MaxFlows {
		return nil, limitErr("You already have %d connections open to this share, which is the most this server allows.", r.limits.MaxFlows)
	}
	s.nextKey++
	key := s.nextKey
	c.flows[key] = closer
	return func() {
		r.mu.Lock()
		delete(c.flows, key)
		r.mu.Unlock()
	}, nil
}

// AddUDP maps a consumer's UDP flow to a relay flow id the publisher will see.
func (r *Registry) AddUDP(s *Share, c *Consumer, consumerFlow uint32, end func()) (uint32, *udpFlow, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s.ended || s.consumers[c.UserID] != c {
		return 0, nil, ErrNotFound
	}
	if _, dup := c.udp[consumerFlow]; dup {
		return 0, nil, errors.New("That UDP flow is already open.")
	}
	s.nextFlow++
	id := s.nextFlow
	f := &udpFlow{consumer: c, consumerFlow: consumerFlow, end: end}
	f.lastSeen.Store(r.now().UnixNano())
	s.udp[id] = f
	c.udp[consumerFlow] = id
	return id, f, nil
}

// RemoveUDP forgets a UDP flow.
func (r *Registry) RemoveUDP(s *Share, id uint32) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if f, ok := s.udp[id]; ok {
		delete(f.consumer.udp, f.consumerFlow)
		delete(s.udp, id)
	}
}

// UDPFor finds the relay flow for a datagram coming from a consumer.
func (r *Registry) UDPFor(s *Share, c *Consumer, consumerFlow uint32) (uint32, *udpFlow) {
	r.mu.Lock()
	defer r.mu.Unlock()
	id, ok := c.udp[consumerFlow]
	if !ok {
		return 0, nil
	}
	return id, s.udp[id]
}

// UDPByRelayID finds the flow for a datagram coming from the publisher.
func (r *Registry) UDPByRelayID(s *Share, id uint32) *udpFlow {
	r.mu.Lock()
	defer r.mu.Unlock()
	return s.udp[id]
}

// ListPlace returns the shares in a place that a user may see.
func (r *Registry) ListPlace(kind, placeID, userID string) []ShareInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []ShareInfo{}
	for _, s := range r.shares {
		if s.PlaceKind == kind && s.PlaceID == placeID && s.Allows(userID) {
			out = append(out, r.infoLocked(s))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Snapshot returns every live share with its consumers, for re-checking access.

func (r *Registry) Snapshot() []ShareInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]ShareInfo, 0, len(r.shares))
	for _, s := range r.shares {
		out = append(out, r.infoLocked(s))
	}
	return out
}

// ExpireDue ends shares past their time and shares whose publisher never connected.
func (r *Registry) ExpireDue() {
	now := r.now()
	type due struct {
		id     string
		reason EndReason
	}
	var ends []due
	r.mu.Lock()
	for id, s := range r.shares {
		switch {
		case !now.Before(s.expiresAt):
			ends = append(ends, due{id, ReasonExpired})
		case s.pub == nil && !now.Before(s.attachDeadline):
			ends = append(ends, due{id, ReasonPublisherOffline})
		}
	}
	r.mu.Unlock()
	for _, d := range ends {
		r.End(d.id, d.reason)
	}
}

// Run calls ExpireDue every few seconds until ctx ends.
func (r *Registry) Run(ctx context.Context) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.ExpireDue()
			r.expireIdleUDP()
		}
	}
}

// UDPIdle is how long a UDP flow may stay silent before it closes.
const UDPIdle = 60 * time.Second

func (r *Registry) expireIdleUDP() {
	cutoff := r.now().Add(-UDPIdle).UnixNano()
	var ends []func()
	r.mu.Lock()
	for _, s := range r.shares {
		for _, f := range s.udp {
			if f.lastSeen.Load() < cutoff && f.end != nil {
				ends = append(ends, f.end)
			}
		}
	}
	r.mu.Unlock()
	for _, end := range ends {
		end()
	}
}
