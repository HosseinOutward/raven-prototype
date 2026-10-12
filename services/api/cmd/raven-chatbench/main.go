// Command raven-chatbench measures Raven's text chat under load and checks that nothing
// is lost, repeated or reordered while it does.
//
// It talks to a running API over HTTP exactly as a desktop client does: it signs users
// in, opens an event stream for each, sends messages, and follows the client's side of
// the sync protocol (apply events in sequence order, fetch changes on a gap, list and
// catch up after every reconnect, retry a failed send with the same id). At the end it
// compares what every simulated client holds against what the server acknowledged.
//
// Point it at a database you can throw away: it creates users, friendships, groups and
// trees and does not remove them. docs/chat-testing.md has the commands and the targets.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	mrand "math/rand"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type options struct {
	api, adminUser, adminPassword, scenario, out   string
	users, dms, groups, groupSize, nests, nestSize int
	rate, burstRate                                float64
	duration, burstAfter, burstFor, disruptAfter   time.Duration
	// warmup is sent like the rest but left out of the timings: a server that has just
	// started is still opening database connections, which says nothing about steady use.
	warmup  time.Duration
	workers int
}

func main() {
	var o options
	flag.StringVar(&o.api, "api", "http://127.0.0.1:6977", "base URL of the Raven API")
	flag.StringVar(&o.adminUser, "admin-user", "admin", "an admin account, used to create the test users")
	flag.StringVar(&o.adminPassword, "admin-password", "", "that account's password (or RAVEN_BENCH_ADMIN_PASSWORD)")
	flag.StringVar(&o.scenario, "scenario", "smoke", "smoke, steady, burst, fanout, reconnect or restart")
	flag.StringVar(&o.out, "out", "", "write the result as JSON to this file")
	flag.IntVar(&o.users, "users", 0, "people (0 uses the scenario's number)")
	flag.IntVar(&o.dms, "dms", -1, "direct messages")
	flag.IntVar(&o.groups, "groups", -1, "groups")
	flag.IntVar(&o.groupSize, "group-size", 0, "people per group")
	flag.IntVar(&o.nests, "nests", -1, "text nests, each in its own tree")
	flag.IntVar(&o.nestSize, "nest-size", 0, "people per text nest")
	flag.Float64Var(&o.rate, "rate", 0, "messages per second")
	flag.DurationVar(&o.duration, "duration", 0, "how long to send for, after the warm-up")
	flag.DurationVar(&o.warmup, "warmup", 10*time.Second, "send for this long before timing anything")
	flag.IntVar(&o.workers, "workers", 256, "concurrent senders")
	flag.Parse()
	if o.adminPassword == "" {
		o.adminPassword = os.Getenv("RAVEN_BENCH_ADMIN_PASSWORD")
	}
	if err := applyScenario(&o); err != nil {
		fatal(err)
	}
	result, err := run(o)
	if err != nil {
		fatal(err)
	}
	printResult(result)
	if o.out != "" {
		raw, _ := json.MarshalIndent(result, "", "  ")
		if err := os.WriteFile(o.out, raw, 0o644); err != nil {
			fatal(err)
		}
	}
	if !result.Passed {
		os.Exit(1)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "raven-chatbench:", err)
	os.Exit(2)
}

// applyScenario fills in whatever the flags left unset.
func applyScenario(o *options) error {
	type preset struct {
		users, dms, groups, groupSize, nests, nestSize int
		rate                                           float64
		duration                                       time.Duration
	}
	presets := map[string]preset{
		"smoke":     {20, 5, 2, 5, 1, 20, 10, 20 * time.Second},
		"steady":    {300, 150, 15, 20, 4, 150, 50, 5 * time.Minute},
		"burst":     {300, 150, 15, 20, 4, 150, 20, 40 * time.Second},
		"fanout":    {300, 0, 0, 0, 1, 300, 20, 60 * time.Second},
		"reconnect": {300, 150, 15, 20, 4, 150, 30, 60 * time.Second},
		"restart":   {300, 150, 15, 20, 4, 150, 30, 90 * time.Second},
	}
	p, ok := presets[o.scenario]
	if !ok {
		return fmt.Errorf("unknown scenario %q", o.scenario)
	}
	if o.users == 0 {
		o.users = p.users
	}
	if o.dms < 0 {
		o.dms = p.dms
	}
	if o.groups < 0 {
		o.groups = p.groups
	}
	if o.groupSize == 0 {
		o.groupSize = p.groupSize
	}
	if o.nests < 0 {
		o.nests = p.nests
	}
	if o.nestSize == 0 {
		o.nestSize = p.nestSize
	}
	if o.rate == 0 {
		o.rate = p.rate
	}
	if o.duration == 0 {
		o.duration = p.duration
	}
	switch o.scenario {
	case "burst":
		o.burstRate, o.burstAfter, o.burstFor = 200, 20*time.Second, 10*time.Second
	case "reconnect", "restart":
		o.disruptAfter = 20 * time.Second
	}
	if o.dms*2 > o.users || o.groupSize > o.users || o.nestSize > o.users {
		return errors.New("not enough users for that many conversations")
	}
	return nil
}

// ---- the API as a client sees it ---------------------------------------------

type apiClient struct {
	base string
	http *http.Client
}

func newAPIClient(base string) *apiClient {
	transport := &http.Transport{
		MaxIdleConns:        2048,
		MaxIdleConnsPerHost: 2048,
		MaxConnsPerHost:     0,
		IdleConnTimeout:     90 * time.Second,
	}
	return &apiClient{base: strings.TrimRight(base, "/"), http: &http.Client{Transport: transport, Timeout: 30 * time.Second}}
}

func setClientHeaders(req *http.Request, token string) {
	req.Header.Set("X-Raven-Client-Version", "0.1.0")
	req.Header.Set("X-Raven-Capabilities", "chat-v1")
	req.Header.Set("X-Raven-Device", "raven-chatbench")
	if token != "" {
		req.Header.Set("X-Session-ID", token)
	}
}

type apiError struct {
	status     int
	retryAfter time.Duration
	body       string
}

func (e *apiError) Error() string { return fmt.Sprintf("status %d: %s", e.status, e.body) }

// call makes one request. A non-2xx answer comes back as *apiError.
func (c *apiClient) call(method, token, path string, body, out any) (int, http.Header, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, c.base+path, reader)
	if err != nil {
		return 0, nil, err
	}
	setClientHeaders(req, token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, resp.Header, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		failure := &apiError{status: resp.StatusCode, body: strings.TrimSpace(string(raw))}
		if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil {
			failure.retryAfter = time.Duration(seconds) * time.Second
		}
		return resp.StatusCode, resp.Header, failure
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return resp.StatusCode, resp.Header, err
		}
	}
	return resp.StatusCode, resp.Header, nil
}

func (c *apiClient) login(username, password string) (string, string, error) {
	var out struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	_, header, err := c.call(http.MethodPost, "", "/v1/auth/login", map[string]string{"username": username, "password": password}, &out)
	if err != nil {
		return "", "", err
	}
	return out.User.ID, header.Get("X-Session-ID"), nil
}

// ---- the simulated population --------------------------------------------------

type person struct {
	index           int
	id, name, token string
	client          *simClient
}

type conversation struct {
	id, kind string
	members  []*person
	// acked maps a sequence number the server acknowledged to the send it belongs to.
	mu    sync.Mutex
	acked map[int64]*sendRecord
}

type sendRecord struct {
	clientID string
	started  time.Time
	retried  bool
}

func randomID() string {
	raw := make([]byte, 8)
	_, _ = rand.Read(raw)
	return hex.EncodeToString(raw)
}

// parallel runs fn for each index on a few goroutines and returns the first error.
func parallel(count, width int, fn func(index int) error) error {
	var wait sync.WaitGroup
	var first atomic.Value
	next := int64(-1)
	for worker := 0; worker < width; worker++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for {
				index := int(atomic.AddInt64(&next, 1))
				if index >= count || first.Load() != nil {
					return
				}
				if err := fn(index); err != nil {
					first.CompareAndSwap(nil, err)
					return
				}
			}
		}()
	}
	wait.Wait()
	if err, ok := first.Load().(error); ok {
		return err
	}
	return nil
}

func befriend(api *apiClient, a, b *person) error {
	var created struct {
		FriendRequest struct {
			ID string `json:"id"`
		} `json:"friendRequest"`
	}
	if _, _, err := api.call(http.MethodPost, a.token, "/v1/friend-requests", map[string]string{"toUserId": b.id}, &created); err != nil {
		return fmt.Errorf("friend request: %w", err)
	}
	if _, _, err := api.call(http.MethodPost, b.token, "/v1/friend-requests/"+created.FriendRequest.ID+"/accept", nil, nil); err != nil {
		return fmt.Errorf("accept friend request: %w", err)
	}
	return nil
}

type conversationPayload struct {
	Conversation struct {
		ID string `json:"id"`
	} `json:"conversation"`
}

func provision(o options, api *apiClient, run string) ([]*person, []*conversation, error) {
	_, adminToken, err := api.login(o.adminUser, o.adminPassword)
	if err != nil {
		return nil, nil, fmt.Errorf("sign in as %s: %w", o.adminUser, err)
	}
	const password = "bench-password-1"
	people := make([]*person, o.users)
	fmt.Printf("creating %d users…\n", o.users)
	if err := parallel(o.users, 8, func(index int) error {
		name := fmt.Sprintf("b%s-%04d", run, index)
		if _, _, err := api.call(http.MethodPost, adminToken, "/v1/admin/users", map[string]string{"username": name, "password": password, "role": "user"}, nil); err != nil {
			return fmt.Errorf("create %s: %w", name, err)
		}
		id, token, err := api.login(name, password)
		if err != nil {
			return fmt.Errorf("sign in %s: %w", name, err)
		}
		people[index] = &person{index: index, id: id, name: name, token: token}
		return nil
	}); err != nil {
		return nil, nil, err
	}

	conversations := []*conversation{}
	var mu sync.Mutex
	add := func(c *conversation) {
		c.acked = map[int64]*sendRecord{}
		mu.Lock()
		conversations = append(conversations, c)
		mu.Unlock()
	}

	fmt.Printf("creating %d direct messages, %d groups of %d, %d text nests of %d…\n", o.dms, o.groups, o.groupSize, o.nests, o.nestSize)
	if err := parallel(o.dms, 16, func(index int) error {
		a, b := people[index*2], people[index*2+1]
		if err := befriend(api, a, b); err != nil {
			return err
		}
		var out conversationPayload
		if _, _, err := api.call(http.MethodPost, a.token, "/v1/chat/dms", map[string]string{"userId": b.id}, &out); err != nil {
			return fmt.Errorf("open direct message: %w", err)
		}
		add(&conversation{id: out.Conversation.ID, kind: "dm", members: []*person{a, b}})
		return nil
	}); err != nil {
		return nil, nil, err
	}

	// A group's owner must be friends with everyone in it. Work the pairs out first and
	// make each friendship once, so two groups never race to create the same one.
	groupMembers := make([][]*person, o.groups)
	type pair struct{ a, b int }
	friends := map[pair]struct{}{}
	for index := 0; index < o.dms; index++ {
		friends[pair{index * 2, index*2 + 1}] = struct{}{}
	}
	wanted := []pair{}
	for index := range groupMembers {
		members := make([]*person, 0, o.groupSize)
		for offset := 0; offset < o.groupSize; offset++ {
			members = append(members, people[(index*7+offset*3)%o.users])
		}
		members = uniquePeople(members)
		groupMembers[index] = members
		for _, member := range members[1:] {
			key := pair{members[0].index, member.index}
			if key.a > key.b {
				key.a, key.b = key.b, key.a
			}
			if _, ok := friends[key]; !ok {
				friends[key] = struct{}{}
				wanted = append(wanted, key)
			}
		}
	}
	if err := parallel(len(wanted), 16, func(index int) error {
		return befriend(api, people[wanted[index].a], people[wanted[index].b])
	}); err != nil {
		return nil, nil, err
	}

	if err := parallel(o.groups, 4, func(index int) error {
		members := groupMembers[index]
		owner := members[0]
		ids := []string{}
		for _, member := range members[1:] {
			ids = append(ids, member.id)
		}
		var out conversationPayload
		if _, _, err := api.call(http.MethodPost, owner.token, "/v1/chat/groups", map[string]any{"name": fmt.Sprintf("Bench group %d", index), "memberIds": ids}, &out); err != nil {
			return fmt.Errorf("create group: %w", err)
		}
		add(&conversation{id: out.Conversation.ID, kind: "group", members: members})
		return nil
	}); err != nil {
		return nil, nil, err
	}

	for index := 0; index < o.nests; index++ {
		members := make([]*person, 0, o.nestSize)
		for offset := 0; offset < o.nestSize; offset++ {
			members = append(members, people[(index*11+offset)%o.users])
		}
		owner := members[0]
		var tree struct {
			Tree struct {
				ID string `json:"id"`
			} `json:"tree"`
		}
		if _, _, err := api.call(http.MethodPost, owner.token, "/v1/trees", map[string]string{"name": fmt.Sprintf("Bench tree %s %d", run, index)}, &tree); err != nil {
			return nil, nil, fmt.Errorf("create tree: %w", err)
		}
		rest := members[1:]
		if err := parallel(len(rest), 8, func(i int) error {
			_, _, err := api.call(http.MethodPost, owner.token, "/v1/trees/"+tree.Tree.ID+"/members", map[string]string{"username": rest[i].name}, nil)
			return err
		}); err != nil {
			return nil, nil, fmt.Errorf("add tree member: %w", err)
		}
		var out conversationPayload
		if _, _, err := api.call(http.MethodPost, owner.token, "/v1/trees/"+tree.Tree.ID+"/text-nests", map[string]string{"name": "general"}, &out); err != nil {
			return nil, nil, fmt.Errorf("create text nest: %w", err)
		}
		add(&conversation{id: out.Conversation.ID, kind: "nest", members: members})
	}
	return people, conversations, nil
}

func uniquePeople(in []*person) []*person {
	seen := map[int]struct{}{}
	out := []*person{}
	for _, p := range in {
		if _, ok := seen[p.index]; ok {
			continue
		}
		seen[p.index] = struct{}{}
		out = append(out, p)
	}
	return out
}

// ---- one simulated client ------------------------------------------------------

type chatMessage struct {
	ID              string `json:"id"`
	ConversationID  string `json:"conversationId"`
	Seq             int64  `json:"seq"`
	ChangedSeq      int64  `json:"changedSeq"`
	ClientMessageID string `json:"clientMessageId"`
	Kind            string `json:"kind"`
}

type chatEvent struct {
	Type           string       `json:"type"`
	ConversationID string       `json:"conversationId"`
	Seq            int64        `json:"seq"`
	Message        *chatMessage `json:"message"`
}

type heldConversation struct {
	// synced is how far this client knows it is complete.
	synced int64
	// have is every message it holds, by seq; live is the subset that arrived on a stream.
	have, live map[int64]struct{}
	// lastLive is the highest seq the current connection has delivered.
	lastLive int64
}

// simClient is one signed-in app: a stream, and what it has pieced together from it.
type simClient struct {
	bench  *bench
	person *person

	mu   sync.Mutex
	held map[string]*heldConversation

	// drop ends the current connection only; the client then reconnects by itself.
	dropMu sync.Mutex
	drop   context.CancelFunc
}

func (c *simClient) dropStream() {
	c.dropMu.Lock()
	if c.drop != nil {
		c.drop()
	}
	c.dropMu.Unlock()
}

func (c *simClient) conversation(id string) *heldConversation {
	held := c.held[id]
	if held == nil {
		held = &heldConversation{have: map[int64]struct{}{}, live: map[int64]struct{}{}}
		c.held[id] = held
	}
	return held
}

// streamLoop keeps the client's stream open, the way the desktop app does: after a drop
// it waits (one second with jitter, doubling while the server stays away), reconnects,
// and catches up.
func (c *simClient) streamLoop(ctx context.Context) {
	delay := time.Second
	for ctx.Err() == nil {
		connected := c.streamOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		c.bench.streamDrops.Add(1)
		if connected {
			delay = time.Second
		}
		wait := time.Duration(float64(delay) * (0.5 + mrand.Float64()))
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if delay *= 2; delay > 30*time.Second {
			delay = 30 * time.Second
		}
	}
}

func (c *simClient) streamOnce(parent context.Context) bool {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	c.dropMu.Lock()
	c.drop = cancel
	c.dropMu.Unlock()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.bench.api.base+"/v1/nest-events", nil)
	if err != nil {
		return false
	}
	setClientHeaders(req, c.person.token)
	req.Header.Set("Accept", "text/event-stream")
	resp, err := c.bench.streamHTTP.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	opened := time.Now()
	c.mu.Lock()
	for _, held := range c.held {
		held.lastLive = 0
	}
	c.mu.Unlock()
	c.bench.streamsOpen.Add(1)
	defer c.bench.streamsOpen.Add(-1)

	// Events that arrive while the catch-up is running are applied as they come; the
	// catch-up fills in whatever is older than them. A catch-up that fails is tried
	// again for as long as this connection lasts: until it succeeds the client does not
	// know what it missed.
	go func() {
		wait := 500 * time.Millisecond
		for ctx.Err() == nil {
			err := c.catchUp()
			if err == nil {
				c.bench.catchUps.add(time.Since(opened))
				return
			}
			if ctx.Err() != nil {
				return
			}
			c.bench.catchUpRetries.Add(1)
			c.bench.problem("catch-up after stream open (retried)", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Duration(float64(wait) * (0.5 + mrand.Float64()))):
			}
			if wait *= 2; wait > 8*time.Second {
				wait = 8 * time.Second
			}
		}
	}()

	reader := bufio.NewReaderSize(resp.Body, 64*1024)
	var event string
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return true
		}
		line = strings.TrimRight(line, "\r\n")
		switch {
		case strings.HasPrefix(line, "event: "):
			event = line[len("event: "):]
		case strings.HasPrefix(line, "data: "):
			if event == "chat" {
				c.onChat([]byte(line[len("data: "):]), time.Now())
			}
		case line == "":
			event = ""
		}
	}
}

func (c *simClient) onChat(raw []byte, at time.Time) {
	var event chatEvent
	if err := json.Unmarshal(raw, &event); err != nil || event.Seq == 0 {
		return
	}
	c.mu.Lock()
	held := c.conversation(event.ConversationID)
	if held.lastLive != 0 && event.Seq <= held.lastLive {
		c.bench.orderViolations.Add(1)
	}
	held.lastLive = event.Seq
	gap := event.Seq > held.synced+1
	if event.Seq == held.synced+1 {
		held.synced = event.Seq
	}
	duplicate := false
	if event.Type == "message.created" && event.Message != nil {
		// Delivered twice on streams. A message that also came through a catch-up is
		// expected and not counted: the client merges those by id.
		if _, ok := held.live[event.Message.Seq]; ok {
			duplicate = true
		}
		held.live[event.Message.Seq] = struct{}{}
		held.have[event.Message.Seq] = struct{}{}
	}
	synced := held.synced
	c.mu.Unlock()

	if duplicate {
		c.bench.liveDuplicates.Add(1)
	}
	if event.Type == "message.created" && event.Message != nil {
		c.bench.delivered(event.Message, at)
	}
	if gap {
		c.bench.gapFetches.Add(1)
		go func() {
			if err := c.fetchChanges(event.ConversationID, synced); err != nil {
				c.bench.syncFailed("changes after a gap", err)
			}
		}()
	}
}

type changesPayload struct {
	Messages []chatMessage `json:"messages"`
	Reset    bool          `json:"reset"`
	AsOfSeq  int64         `json:"asOfSeq"`
}

// merge records messages learned from a catch-up or a reload.
func (c *simClient) merge(conversationID string, messages []chatMessage, asOfSeq int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	held := c.conversation(conversationID)
	for _, message := range messages {
		if message.Kind != "text" {
			continue
		}
		if _, ok := held.have[message.Seq]; !ok {
			held.have[message.Seq] = struct{}{}
			c.bench.learnedBySync.Add(1)
		}
	}
	if asOfSeq > held.synced {
		held.synced = asOfSeq
	}
}

// fetchChanges asks for what changed after `after` and merges it.
func (c *simClient) fetchChanges(conversationID string, after int64) error {
	var page changesPayload
	path := fmt.Sprintf("/v1/chat/conversations/%s/changes?after=%d", conversationID, after)
	if _, _, err := c.bench.api.call(http.MethodGet, c.person.token, path, nil, &page); err != nil {
		return err
	}
	if page.Reset {
		return c.reload(conversationID)
	}
	c.merge(conversationID, page.Messages, page.AsOfSeq)
	return nil
}

// reload walks the whole history, which is what "too far behind to patch" means here.
// A real client loads only the newest page and pages back on demand; the bench needs
// everything in order to compare.
func (c *simClient) reload(conversationID string) error {
	after := int64(0)
	for {
		var page struct {
			Messages     []chatMessage `json:"messages"`
			HasMoreAfter bool          `json:"hasMoreAfter"`
			AsOfSeq      int64         `json:"asOfSeq"`
		}
		path := fmt.Sprintf("/v1/chat/conversations/%s/messages?after=%d&limit=100", conversationID, after)
		if _, _, err := c.bench.api.call(http.MethodGet, c.person.token, path, nil, &page); err != nil {
			return err
		}
		done := !page.HasMoreAfter || len(page.Messages) == 0
		asOf := int64(0)
		if done {
			asOf = page.AsOfSeq
		}
		c.merge(conversationID, page.Messages, asOf)
		if done {
			return nil
		}
		after = page.Messages[len(page.Messages)-1].Seq
	}
}

// catchUp is what a client does after every stream open: list its conversations and
// fetch the changes for each one that moved on without it.
func (c *simClient) catchUp() error {
	var list struct {
		Conversations []struct {
			ID      string `json:"id"`
			LastSeq int64  `json:"lastSeq"`
		} `json:"conversations"`
	}
	if _, _, err := c.bench.api.call(http.MethodGet, c.person.token, "/v1/chat/conversations", nil, &list); err != nil {
		return err
	}
	for _, entry := range list.Conversations {
		c.mu.Lock()
		held := c.conversation(entry.ID)
		behind := entry.LastSeq > held.synced
		after := held.synced
		c.mu.Unlock()
		if !behind {
			continue
		}
		if err := c.fetchChanges(entry.ID, after); err != nil {
			return err
		}
	}
	return nil
}

// ---- the run ---------------------------------------------------------------------

type samples struct {
	mu     sync.Mutex
	values []float64
}

func (s *samples) add(d time.Duration) {
	s.mu.Lock()
	s.values = append(s.values, float64(d.Microseconds())/1000)
	s.mu.Unlock()
}

func (s *samples) reset() {
	s.mu.Lock()
	s.values = nil
	s.mu.Unlock()
}

func (s *samples) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.values)
}

type Percentiles struct {
	Count int     `json:"count"`
	P50   float64 `json:"p50Ms"`
	P95   float64 `json:"p95Ms"`
	P99   float64 `json:"p99Ms"`
	Max   float64 `json:"maxMs"`
}

func (s *samples) percentiles() Percentiles {
	s.mu.Lock()
	values := append([]float64(nil), s.values...)
	s.mu.Unlock()
	if len(values) == 0 {
		return Percentiles{}
	}
	sort.Float64s(values)
	at := func(p float64) float64 {
		index := int(math.Ceil(p*float64(len(values)))) - 1
		if index < 0 {
			index = 0
		}
		return math.Round(values[index]*10) / 10
	}
	return Percentiles{Count: len(values), P50: at(0.50), P95: at(0.95), P99: at(0.99), Max: math.Round(values[len(values)-1]*10) / 10}
}

type bench struct {
	o          options
	api        *apiClient
	streamHTTP *http.Client
	byID       map[string]*conversation

	pendingMu sync.Mutex
	pending   map[string]*sendRecord // by client message id, until acknowledged

	delivery, burstDelivery, ack, catchUps samples
	measureFrom, burstFrom, burstUntil     time.Time

	// problems keeps one example of each kind of failure, so a count of errors comes
	// with what they were.
	problemsMu sync.Mutex
	problems   map[string]int

	sent, acked, failed, retries, duplicateAcks, rateLimited atomic.Int64
	backlog                                                  atomic.Int64
	streamsOpen, streamDrops, syncErrors                     atomic.Int64
	gapFetches, orderViolations, liveDuplicates              atomic.Int64
	learnedBySync, catchUpRetries                            atomic.Int64
}

// problem counts a failure by what it was. Ids and addresses are stripped so that the
// same failure in different conversations counts as one kind.
func (b *bench) problem(where string, err error) {
	text := err.Error()
	var failure *apiError
	if errors.As(err, &failure) {
		text = fmt.Sprintf("status %d: %s", failure.status, failure.body)
	} else if at := strings.Index(text, ": "); at >= 0 && strings.Contains(text[:at], "http") {
		text = text[at+2:]
	}
	b.problemsMu.Lock()
	if b.problems == nil {
		b.problems = map[string]int{}
	}
	b.problems[where+": "+text]++
	b.problemsMu.Unlock()
}

func (b *bench) syncFailed(where string, err error) {
	b.syncErrors.Add(1)
	b.problem(where, err)
}

// delivered records a message arriving on someone's stream.
func (b *bench) delivered(message *chatMessage, at time.Time) {
	b.pendingMu.Lock()
	record := b.pending[message.ClientMessageID]
	b.pendingMu.Unlock()
	if record == nil {
		conv := b.byID[message.ConversationID]
		if conv == nil {
			return
		}
		conv.mu.Lock()
		record = conv.acked[message.Seq]
		conv.mu.Unlock()
		if record == nil {
			return
		}
	}
	if record.retried || record.started.Before(b.measureFrom) {
		// A retried send's delay is the retry's, not the delivery path's, and the
		// warm-up is not timed.
		return
	}
	elapsed := at.Sub(record.started)
	b.delivery.add(elapsed)
	if !b.burstFrom.IsZero() && !record.started.Before(b.burstFrom) && record.started.Before(b.burstUntil) {
		b.burstDelivery.add(elapsed)
	}
}

// send posts one message and, like the client's outbox, keeps retrying a failure that
// could be temporary with the same id, so a retry can never produce a second message.
func (b *bench) send(conv *conversation, sender *person, n int64) {
	record := &sendRecord{clientID: "b-" + randomID() + "-" + strconv.FormatInt(n, 36), started: time.Now()}
	b.pendingMu.Lock()
	b.pending[record.clientID] = record
	b.pendingMu.Unlock()
	b.sent.Add(1)

	body := map[string]string{"clientMessageId": record.clientID, "body": fmt.Sprintf("bench %d · سلام از %s", n, sender.name)}
	path := "/v1/chat/conversations/" + conv.id + "/messages"
	backoff := 500 * time.Millisecond
	deadline := time.Now().Add(2 * time.Minute)
	for {
		var out struct {
			Message   chatMessage `json:"message"`
			Duplicate bool        `json:"duplicate"`
		}
		_, _, err := b.api.call(http.MethodPost, sender.token, path, body, &out)
		if err == nil {
			if !record.retried && !record.started.Before(b.measureFrom) {
				b.ack.add(time.Since(record.started))
			}
			if out.Duplicate {
				b.duplicateAcks.Add(1)
			}
			conv.mu.Lock()
			conv.acked[out.Message.Seq] = record
			conv.mu.Unlock()
			b.pendingMu.Lock()
			delete(b.pending, record.clientID)
			b.pendingMu.Unlock()
			b.acked.Add(1)
			return
		}
		var failure *apiError
		wait := backoff
		if errors.As(err, &failure) {
			if failure.status == http.StatusTooManyRequests {
				b.rateLimited.Add(1)
				if failure.retryAfter > 0 {
					wait = failure.retryAfter
				}
			} else if failure.status < 500 {
				b.failed.Add(1)
				b.problem("send refused", err)
				return
			}
		}
		if time.Now().After(deadline) {
			b.failed.Add(1)
			b.problem("send gave up", err)
			return
		}
		record.retried = true
		b.retries.Add(1)
		time.Sleep(wait)
		if backoff *= 2; backoff > 8*time.Second {
			backoff = 8 * time.Second
		}
	}
}

type Result struct {
	Scenario      string    `json:"scenario"`
	StartedAt     time.Time `json:"startedAt"`
	Users         int       `json:"users"`
	Conversations int       `json:"conversations"`
	RatePerSecond float64   `json:"ratePerSecond"`
	BurstRate     float64   `json:"burstRatePerSecond,omitempty"`
	DurationSec   float64   `json:"durationSeconds"`
	WarmupSec     float64   `json:"warmupSeconds"`

	Sent          int64 `json:"sent"`
	Acknowledged  int64 `json:"acknowledged"`
	Failed        int64 `json:"failed"`
	Retries       int64 `json:"retries"`
	DuplicateAcks int64 `json:"duplicateAcks"`
	RateLimited   int64 `json:"rateLimited"`
	SendBacklog   int64 `json:"sendBacklog"`

	Delivery      Percentiles `json:"sendToRecipient"`
	BurstDelivery Percentiles `json:"sendToRecipientDuringBurst"`
	Ack           Percentiles `json:"sendToAcknowledgement"`
	CatchUp       Percentiles `json:"streamOpenToCaughtUp"`

	AcknowledgedLost int64              `json:"acknowledgedLost"`
	MissingAfterSync int64              `json:"missingAfterSync"`
	LiveDuplicates   int64              `json:"liveDuplicates"`
	OrderViolations  int64              `json:"orderViolations"`
	GapFetches       int64              `json:"gapFetches"`
	LearnedBySync    int64              `json:"messagesLearnedBySync"`
	StreamDrops      int64              `json:"streamDrops"`
	SyncErrors       int64              `json:"syncErrors"`
	CatchUpRetries   int64              `json:"catchUpRetries"`
	RecoverySeconds  float64            `json:"recoverySeconds,omitempty"`
	Server           map[string]float64 `json:"server"`
	Problems         map[string]int     `json:"problems,omitempty"`
	Failures         []string           `json:"failures"`
	Passed           bool               `json:"passed"`
}

func run(o options) (Result, error) {
	api := newAPIClient(o.api)
	runID := randomID()[:6]
	people, conversations, err := provision(o, api, runID)
	if err != nil {
		return Result{}, err
	}
	b := &bench{
		o:          o,
		api:        api,
		streamHTTP: &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 4096, MaxConnsPerHost: 0, DisableCompression: true}},
		byID:       map[string]*conversation{},
		pending:    map[string]*sendRecord{},
	}
	for _, conv := range conversations {
		b.byID[conv.id] = conv
	}

	fmt.Printf("opening %d streams…\n", len(people))
	ctx, cancelAll := context.WithCancel(context.Background())
	defer cancelAll()
	for _, p := range people {
		p.client = &simClient{bench: b, person: p, held: map[string]*heldConversation{}}
		go p.client.streamLoop(ctx)
		// People do not all start their app in the same millisecond.
		time.Sleep(5 * time.Millisecond)
	}
	if err := waitFor(60*time.Second, func() bool {
		return b.streamsOpen.Load() == int64(len(people)) && b.catchUps.count() >= len(people)
	}); err != nil {
		return Result{}, fmt.Errorf("only %d of %d clients connected and caught up", b.catchUps.count(), len(people))
	}
	// Everything so far was getting into place, not the scenario.
	b.catchUps.reset()
	b.streamDrops.Store(0)
	b.gapFetches.Store(0)
	b.catchUpRetries.Store(0)
	b.problemsMu.Lock()
	b.problems = nil
	b.problemsMu.Unlock()
	before := serverMetrics(api, o)

	// Senders. Arrivals are scheduled on the clock, not on the previous send finishing,
	// so a slow server shows up as latency and backlog instead of a lower rate.
	jobs := make(chan func(), 16384)
	var workers sync.WaitGroup
	for worker := 0; worker < o.workers; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for job := range jobs {
				job()
			}
		}()
	}
	weights := map[string]float64{"dm": 0.5, "group": 0.3, "nest": 0.2}
	byKind := map[string][]*conversation{}
	for _, conv := range conversations {
		byKind[conv.kind] = append(byKind[conv.kind], conv)
	}
	pick := func(r *mrand.Rand) *conversation {
		total := 0.0
		for kind, weight := range weights {
			if len(byKind[kind]) > 0 {
				total += weight
			}
		}
		roll := r.Float64() * total
		for _, kind := range []string{"dm", "group", "nest"} {
			if len(byKind[kind]) == 0 {
				continue
			}
			if roll -= weights[kind]; roll <= 0 {
				return byKind[kind][r.Intn(len(byKind[kind]))]
			}
		}
		return conversations[r.Intn(len(conversations))]
	}

	started := time.Now()
	b.measureFrom = started.Add(o.warmup)
	result := Result{Scenario: o.scenario, StartedAt: started.UTC(), Users: len(people), Conversations: len(conversations), RatePerSecond: o.rate, BurstRate: o.burstRate, DurationSec: o.duration.Seconds(), WarmupSec: o.warmup.Seconds()}
	if o.burstRate > 0 {
		b.burstFrom, b.burstUntil = b.measureFrom.Add(o.burstAfter), b.measureFrom.Add(o.burstAfter+o.burstFor)
	}

	var disruption sync.WaitGroup
	if o.disruptAfter > 0 {
		disruption.Add(1)
		go func() {
			defer disruption.Done()
			time.Sleep(o.warmup + o.disruptAfter)
			if o.scenario == "reconnect" {
				// Every connection is cut at once. Each client then reconnects on its
				// own, after the same jittered delay the desktop app uses.
				fmt.Println("dropping every stream…")
				b.catchUps.reset()
				for _, p := range people {
					p.client.dropStream()
				}
				return
			}
			fmt.Println(">>> restart the API now <<<")
			// Wait for the server to go away, then time how long it takes everyone to be
			// back and caught up once it answers again.
			if err := waitFor(60*time.Second, func() bool { return !healthy(api) }); err != nil {
				fmt.Println("the API never went down; nothing to measure")
				return
			}
			b.catchUps.reset()
			_ = waitFor(120*time.Second, func() bool { return healthy(api) })
			back := time.Now()
			_ = waitFor(120*time.Second, func() bool {
				return b.streamsOpen.Load() == int64(len(people)) && b.catchUps.count() >= len(people)
			})
			result.RecoverySeconds = math.Round(time.Since(back).Seconds()*10) / 10
		}()
	}

	rng := mrand.New(mrand.NewSource(time.Now().UnixNano()))
	var n int64
	next := started
	for time.Since(started) < o.warmup+o.duration {
		rate := o.rate
		if o.burstRate > 0 && time.Now().After(b.burstFrom) && time.Now().Before(b.burstUntil) {
			rate = o.burstRate
		}
		next = next.Add(time.Duration(float64(time.Second) / rate))
		if wait := time.Until(next); wait > 0 {
			time.Sleep(wait)
		} else if wait < -time.Second {
			next = time.Now()
		}
		conv := pick(rng)
		sender := conv.members[rng.Intn(len(conv.members))]
		n++
		number := n
		select {
		case jobs <- func() { b.send(conv, sender, number) }:
		default:
			b.backlog.Add(1)
		}
	}
	close(jobs)
	workers.Wait()
	disruption.Wait()

	// Give the last events time to arrive, then let every client do one more catch-up,
	// which is what would happen at its next reconnect.
	time.Sleep(3 * time.Second)
	after := serverMetrics(api, o)
	_ = parallel(len(people), 32, func(index int) error {
		if err := people[index].client.catchUp(); err != nil {
			b.syncFailed("final catch-up", err)
		}
		return nil
	})

	// What the server holds: every acknowledged message must be in the history.
	stored := map[string]map[string]struct{}{}
	var storedMu sync.Mutex
	if err := parallel(len(conversations), 16, func(index int) error {
		conv := conversations[index]
		ids, err := historyClientIDs(api, conv)
		if err != nil {
			return err
		}
		storedMu.Lock()
		stored[conv.id] = ids
		storedMu.Unlock()
		return nil
	}); err != nil {
		return result, fmt.Errorf("reading back history: %w", err)
	}
	for _, conv := range conversations {
		conv.mu.Lock()
		for seq, record := range conv.acked {
			if _, ok := stored[conv.id][record.clientID]; !ok {
				result.AcknowledgedLost++
			}
			// What each client holds: every acknowledged message, exactly once.
			for _, member := range conv.members {
				member.client.mu.Lock()
				_, has := member.client.conversation(conv.id).have[seq]
				member.client.mu.Unlock()
				if !has {
					result.MissingAfterSync++
				}
			}
		}
		conv.mu.Unlock()
	}
	cancelAll()

	result.Sent, result.Acknowledged, result.Failed = b.sent.Load(), b.acked.Load(), b.failed.Load()
	result.Retries, result.DuplicateAcks, result.RateLimited, result.SendBacklog = b.retries.Load(), b.duplicateAcks.Load(), b.rateLimited.Load(), b.backlog.Load()
	result.Delivery, result.BurstDelivery, result.Ack, result.CatchUp = b.delivery.percentiles(), b.burstDelivery.percentiles(), b.ack.percentiles(), b.catchUps.percentiles()
	result.LiveDuplicates, result.OrderViolations, result.GapFetches = b.liveDuplicates.Load(), b.orderViolations.Load(), b.gapFetches.Load()
	result.LearnedBySync, result.StreamDrops, result.SyncErrors = b.learnedBySync.Load(), b.streamDrops.Load(), b.syncErrors.Load()
	result.CatchUpRetries = b.catchUpRetries.Load()
	result.Server = map[string]float64{}
	for name, value := range after {
		result.Server[name] = value
	}
	for _, name := range []string{"raven_db_wait_count_total", `raven_streams_closed_total{reason="lagged"}`} {
		during := after[name] - before[name]
		if during < 0 {
			// The API was restarted during the run, which starts its counters again.
			during = after[name]
		}
		result.Server[name+" (during run)"] = during
	}
	b.problemsMu.Lock()
	result.Problems = b.problems
	b.problemsMu.Unlock()
	result.Failures = judge(o, result)
	result.Passed = len(result.Failures) == 0
	return result, nil
}

func waitFor(limit time.Duration, done func() bool) error {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if done() {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return errors.New("timed out")
}

func healthy(api *apiClient) bool {
	client := &http.Client{Timeout: time.Second}
	resp, err := client.Get(api.base + "/healthz")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func historyClientIDs(api *apiClient, conv *conversation) (map[string]struct{}, error) {
	ids := map[string]struct{}{}
	after := int64(0)
	token := conv.members[0].token
	for {
		var page struct {
			Messages     []chatMessage `json:"messages"`
			HasMoreAfter bool          `json:"hasMoreAfter"`
		}
		path := fmt.Sprintf("/v1/chat/conversations/%s/messages?after=%d&limit=100", conv.id, after)
		if _, _, err := api.call(http.MethodGet, token, path, nil, &page); err != nil {
			return nil, err
		}
		for _, message := range page.Messages {
			ids[message.ClientMessageID] = struct{}{}
			after = message.Seq
		}
		if !page.HasMoreAfter || len(page.Messages) == 0 {
			return ids, nil
		}
	}
}

// serverMetrics reads the gauges and counters the gates refer to from the API's own
// metrics endpoint.
func serverMetrics(api *apiClient, o options) map[string]float64 {
	out := map[string]float64{}
	_, token, err := api.login(o.adminUser, o.adminPassword)
	if err != nil {
		return out
	}
	req, err := http.NewRequest(http.MethodGet, api.base+"/v1/admin/metrics", nil)
	if err != nil {
		return out
	}
	setClientHeaders(req, token)
	resp, err := api.http.Do(req)
	if err != nil {
		return out
	}
	defer resp.Body.Close()
	wanted := map[string]bool{
		"raven_go_goroutines": true, "raven_go_heap_alloc_bytes": true, "raven_go_sys_bytes": true,
		"raven_db_open_connections": true, "raven_db_max_open_connections": true, "raven_db_wait_count_total": true,
		"raven_streams_open": true, `raven_streams_closed_total{reason="lagged"}`: true,
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "#") {
			continue
		}
		space := strings.LastIndexByte(line, ' ')
		if space < 0 || !wanted[line[:space]] {
			continue
		}
		if value, err := strconv.ParseFloat(line[space+1:], 64); err == nil {
			out[line[:space]] = value
		}
	}
	return out
}

// judge applies the gates agreed in docs/chat-testing.md. The latency gates are for a
// server on the same machine; a run across a real network has its own.
func judge(o options, r Result) []string {
	failures := []string{}
	fail := func(format string, args ...any) { failures = append(failures, fmt.Sprintf(format, args...)) }
	if r.AcknowledgedLost != 0 {
		fail("%d acknowledged messages are not in the server's history", r.AcknowledgedLost)
	}
	if r.MissingAfterSync != 0 {
		fail("%d client copies are missing after catching up", r.MissingAfterSync)
	}
	if r.LiveDuplicates != 0 {
		fail("%d messages were delivered twice", r.LiveDuplicates)
	}
	if r.OrderViolations != 0 {
		fail("%d events arrived out of order", r.OrderViolations)
	}
	if r.Failed != 0 {
		fail("%d sends were refused or gave up", r.Failed)
	}
	if r.SendBacklog != 0 {
		fail("%d sends could not be started on time", r.SendBacklog)
	}
	if r.SyncErrors != 0 {
		fail("%d catch-ups failed and were not recovered", r.SyncErrors)
	}
	if r.Server[`raven_db_wait_count_total (during run)`] > 0 && o.scenario != "restart" {
		fail("requests waited for a database connection %v times", r.Server[`raven_db_wait_count_total (during run)`])
	}
	if sys := r.Server["raven_go_sys_bytes"]; sys > 300*1024*1024 {
		fail("the API holds %.0f MB", sys/1024/1024)
	}
	gate := func(name string, got Percentiles, p50, p95, p99 float64) {
		if got.Count == 0 {
			fail("%s: nothing was measured", name)
			return
		}
		if p50 > 0 && got.P50 > p50 {
			fail("%s p50 %.1f ms is over %.0f ms", name, got.P50, p50)
		}
		if got.P95 > p95 {
			fail("%s p95 %.1f ms is over %.0f ms", name, got.P95, p95)
		}
		if p99 > 0 && got.P99 > p99 {
			fail("%s p99 %.1f ms is over %.0f ms", name, got.P99, p99)
		}
	}
	undisturbed := func() {
		if r.StreamDrops != 0 {
			fail("%d streams dropped", r.StreamDrops)
		}
		if r.GapFetches != 0 {
			fail("%d gaps had to be fetched", r.GapFetches)
		}
	}
	switch o.scenario {
	case "steady", "smoke":
		gate("send to recipient", r.Delivery, 20, 75, 200)
		undisturbed()
	case "burst":
		gate("send to recipient during the burst", r.BurstDelivery, 0, 200, 500)
		undisturbed()
	case "fanout":
		gate("send to recipient", r.Delivery, 0, 100, 0)
		undisturbed()
	case "reconnect":
		gate("stream open to caught up", r.CatchUp, 0, 2000, 0)
	case "restart":
		gate("stream open to caught up", r.CatchUp, 0, 2000, 0)
		if r.RecoverySeconds == 0 || r.RecoverySeconds > 15 {
			fail("everyone was caught up %.1f s after the API returned (limit 15 s)", r.RecoverySeconds)
		}
	}
	return failures
}

func printResult(r Result) {
	row := func(name string, p Percentiles) {
		fmt.Printf("  %-34s n=%-7d p50 %7.1f ms   p95 %7.1f ms   p99 %7.1f ms   max %8.1f ms\n", name, p.Count, p.P50, p.P95, p.P99, p.Max)
	}
	fmt.Printf("\n%s: %d users, %d conversations, %.0f msg/s", r.Scenario, r.Users, r.Conversations, r.RatePerSecond)
	if r.BurstRate > 0 {
		fmt.Printf(" with a burst of %.0f msg/s", r.BurstRate)
	}
	fmt.Printf(", %.0f s after a %.0f s warm-up\n", r.DurationSec, r.WarmupSec)
	fmt.Printf("  sent %d, acknowledged %d, failed %d, retries %d, rate-limited %d, backlog %d\n", r.Sent, r.Acknowledged, r.Failed, r.Retries, r.RateLimited, r.SendBacklog)
	row("send to recipient", r.Delivery)
	if r.BurstDelivery.Count > 0 {
		row("send to recipient (burst only)", r.BurstDelivery)
	}
	row("send to acknowledgement", r.Ack)
	if r.CatchUp.Count > 0 {
		row("stream open to caught up", r.CatchUp)
	}
	fmt.Printf("  acknowledged but lost %d, missing after sync %d, delivered twice %d, out of order %d\n", r.AcknowledgedLost, r.MissingAfterSync, r.LiveDuplicates, r.OrderViolations)
	fmt.Printf("  stream drops %d, gap fetches %d, learned by sync %d, catch-up retries %d, sync errors %d, duplicate acks %d\n", r.StreamDrops, r.GapFetches, r.LearnedBySync, r.CatchUpRetries, r.SyncErrors, r.DuplicateAcks)
	if r.RecoverySeconds > 0 {
		fmt.Printf("  everyone caught up %.1f s after the API returned\n", r.RecoverySeconds)
	}
	names := make([]string, 0, len(r.Server))
	for name := range r.Server {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fmt.Printf("  %-58s %.0f\n", name, r.Server[name])
	}
	for text, count := range r.Problems {
		fmt.Printf("  problem ×%d: %s\n", count, text)
	}
	if r.Passed {
		fmt.Println("PASS")
		return
	}
	fmt.Println("FAIL")
	for _, failure := range r.Failures {
		fmt.Println("  -", failure)
	}
}
