package relay

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Limits are the server-side abuse limits. They exist so that port sharing stays a tool
// for people working together and does not become a way to move bulk traffic.
type Limits struct {
	// Enabled is the master switch (RAVEN_WORKSHOP_PORTS=on). Off by default.
	Enabled        bool
	MaxShares      int   // active shares per publisher
	MaxConsumers   int   // consumers per share
	MaxFlows       int   // TCP connections plus UDP flows per consumer per share
	ShareMbps      int   // bandwidth per share, both directions together
	DailyBytes     int64 // bytes per user per UTC day, as publisher plus as consumer
	DefaultMinutes int
	MaxMinutes     int
}

// DefaultLimits are the limits when no environment variable says otherwise.
func DefaultLimits() Limits {
	return Limits{
		MaxShares:      3,
		MaxConsumers:   8,
		MaxFlows:       16,
		ShareMbps:      20,
		DailyBytes:     20 << 30,
		DefaultMinutes: 120,
		MaxMinutes:     720,
	}
}

// LimitsFromEnv reads the RAVEN_WORKSHOP_* variables. A value that is missing or not a
// positive number keeps its default.
func LimitsFromEnv() Limits {
	l := DefaultLimits()
	l.Enabled = strings.EqualFold(strings.TrimSpace(os.Getenv("RAVEN_WORKSHOP_PORTS")), "on")
	intEnv := func(name string, into *int) {
		if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name))); err == nil && v > 0 {
			*into = v
		}
	}
	intEnv("RAVEN_WORKSHOP_MAX_SHARES", &l.MaxShares)
	intEnv("RAVEN_WORKSHOP_MAX_CONSUMERS", &l.MaxConsumers)
	intEnv("RAVEN_WORKSHOP_MAX_FLOWS", &l.MaxFlows)
	intEnv("RAVEN_WORKSHOP_SHARE_MBPS", &l.ShareMbps)
	intEnv("RAVEN_WORKSHOP_MAX_MINUTES", &l.MaxMinutes)
	if gb, err := strconv.ParseFloat(strings.TrimSpace(os.Getenv("RAVEN_WORKSHOP_DAILY_GB")), 64); err == nil && gb > 0 {
		l.DailyBytes = int64(gb * (1 << 30))
	}
	if l.DefaultMinutes > l.MaxMinutes {
		l.DefaultMinutes = l.MaxMinutes
	}
	return l
}

// BytesPerSecond is the share bandwidth in bytes.
func (l Limits) BytesPerSecond() int64 { return int64(l.ShareMbps) * 1_000_000 / 8 }

// Bucket is a token bucket. Take blocks until n bytes may pass, so a share cannot move
// more than its rate over time, and a burst is limited to one second's worth.
type Bucket struct {
	mu     sync.Mutex
	rate   float64 // bytes per second
	burst  float64
	tokens float64
	last   time.Time
	now    func() time.Time
	sleep  func(time.Duration)
}

// NewBucket makes a full bucket that refills at bytesPerSecond.
func NewBucket(bytesPerSecond int64) *Bucket {
	b := &Bucket{rate: float64(bytesPerSecond), burst: float64(bytesPerSecond), now: time.Now, sleep: time.Sleep}
	b.tokens = b.burst
	b.last = b.now()
	return b
}

// Reserve takes n bytes and returns how long the caller must wait before sending them.
func (b *Bucket) Reserve(n int) time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	b.tokens += now.Sub(b.last).Seconds() * b.rate
	if b.tokens > b.burst {
		b.tokens = b.burst
	}
	b.last = now
	b.tokens -= float64(n)
	if b.tokens >= 0 {
		return 0
	}
	return time.Duration(-b.tokens / b.rate * float64(time.Second))
}

// TryTake takes n bytes only if they are available now, for traffic that is dropped
// rather than delayed.
func (b *Bucket) TryTake(n int) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	b.tokens += now.Sub(b.last).Seconds() * b.rate
	if b.tokens > b.burst {
		b.tokens = b.burst
	}
	b.last = now
	if b.tokens < float64(n) {
		return false
	}
	b.tokens -= float64(n)
	return true
}

// Take reserves n bytes and waits for them.
func (b *Bucket) Take(n int) {
	if wait := b.Reserve(n); wait > 0 {
		b.sleep(wait)
	}
}

// DailyUsage counts bytes per user per UTC day. It lives in memory, so a restart resets it.
type DailyUsage struct {
	mu    sync.Mutex
	limit int64
	now   func() time.Time
	days  map[string]dayCount
}

type dayCount struct {
	day   string
	bytes int64
}

func NewDailyUsage(limit int64) *DailyUsage {
	return &DailyUsage{limit: limit, now: time.Now, days: map[string]dayCount{}}
}

// Add charges bytes to a user and reports whether they are still within the day's cap.
func (d *DailyUsage) Add(userID string, bytes int64) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	day := d.now().UTC().Format("2006-01-02")
	c := d.days[userID]
	if c.day != day {
		c = dayCount{day: day}
	}
	c.bytes += bytes
	d.days[userID] = c
	return c.bytes <= d.limit
}

// Exhausted reports whether a user has already used the day's cap.
func (d *DailyUsage) Exhausted(userID string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	c := d.days[userID]
	return c.day == d.now().UTC().Format("2006-01-02") && c.bytes >= d.limit
}

// LimitError names the limit that was reached and its value, in a sentence for the user.
type LimitError struct{ Message string }

func (e *LimitError) Error() string { return e.Message }

func limitErr(format string, args ...any) error {
	return &LimitError{Message: fmt.Sprintf(format, args...)}
}
