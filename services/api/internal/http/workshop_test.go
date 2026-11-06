package http

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"

	"raven/services/api/internal/relay"
)

type workshopConn struct {
	mu     sync.Mutex
	closed []string
}

func (c *workshopConn) OpenStream(context.Context) (relay.Stream, error) {
	return nil, errors.New("not used")
}
func (c *workshopConn) SendDatagram([]byte) error { return nil }
func (c *workshopConn) Close(reason string) {
	c.mu.Lock()
	c.closed = append(c.closed, reason)
	c.mu.Unlock()
}

// enableWorkshop turns the server's switch on with limits a test can adjust, and records
// the events the registry publishes.
func enableWorkshop(server *Server, mutate func(*relay.Limits)) *[]string {
	limits := relay.DefaultLimits()
	limits.Enabled = true
	if mutate != nil {
		mutate(&limits)
	}
	server.workshop = relay.NewRegistry(limits)
	events := []string{}
	server.workshop.OnEvent = func(kind string, info relay.ShareInfo, reason relay.EndReason) {
		events = append(events, kind+":"+string(reason))
		server.publishWorkshopEvent(kind, info, reason)
	}
	return &events
}

type shareReply struct {
	Share relay.ShareInfo `json:"share"`
}

func createShare(t *testing.T, server *Server, token string, body map[string]any, status int) relay.ShareInfo {
	t.Helper()
	raw := postJSON(t, server, token, "/v1/workshop/shares", body, status)
	if status != http.StatusCreated {
		return relay.ShareInfo{}
	}
	var reply shareReply
	if err := json.Unmarshal(raw, &reply); err != nil {
		t.Fatal(err)
	}
	return reply.Share
}

func nestShare(nestID string, extra map[string]any) map[string]any {
	body := map[string]any{"placeKind": "nest", "placeId": nestID, "name": "web", "protocol": "tcp", "port": 8080, "audience": "all", "minutes": 60}
	for k, v := range extra {
		body[k] = v
	}
	return body
}

func listShares(t *testing.T, server *Server, token, kind, placeID string) []relay.ShareInfo {
	t.Helper()
	var reply struct {
		Shares []relay.ShareInfo `json:"shares"`
	}
	if err := json.Unmarshal(getJSON(t, server, token, "/v1/workshop/places/"+kind+"/"+placeID+"/shares", http.StatusOK), &reply); err != nil {
		t.Fatal(err)
	}
	return reply.Shares
}

func TestWorkshopIsOffUntilTheServerTurnsItOn(t *testing.T) {
	room := newVoteRoom(t)
	var config struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.Unmarshal(getJSON(t, room.server, room.alice, "/v1/workshop/config", http.StatusOK), &config); err != nil || config.Enabled {
		t.Fatalf("port sharing should be off by default: %v %+v", err, config)
	}
	createShare(t, room.server, room.alice, nestShare(room.nestID, nil), http.StatusForbidden)
	if got := listShares(t, room.server, room.alice, "nest", room.nestID); len(got) != 0 {
		t.Fatalf("nothing is listed while it is off: %v", got)
	}
	getJSON(t, room.server, "", "/v1/relay/ws", http.StatusNotFound)
}

func TestWorkshopValidation(t *testing.T) {
	room := newVoteRoom(t)
	enableWorkshop(room.server, func(l *relay.Limits) { l.MaxShares = 2; l.MaxMinutes = 90 })
	s, a := room.server, room.alice

	createShare(t, s, a, nestShare(room.nestID, map[string]any{"minutes": 91}), http.StatusBadRequest)
	createShare(t, s, a, nestShare(room.nestID, map[string]any{"port": 0}), http.StatusBadRequest)
	createShare(t, s, a, nestShare(room.nestID, map[string]any{"port": 70000}), http.StatusBadRequest)
	createShare(t, s, a, nestShare(room.nestID, map[string]any{"protocol": "icmp"}), http.StatusBadRequest)
	createShare(t, s, a, nestShare(room.nestID, map[string]any{"placeKind": "planet"}), http.StatusNotFound)
	createShare(t, s, a, nestShare("missing", nil), http.StatusNotFound)

	outsider, outsiderToken := createTestUser(t, s, "erin")
	createShare(t, s, a, nestShare(room.nestID, map[string]any{"audience": []string{outsider.ID}}), http.StatusBadRequest)
	createShare(t, s, outsiderToken, nestShare(room.nestID, nil), http.StatusForbidden)
	createShare(t, s, a, nestShare(room.nestID, map[string]any{"audience": []string{}}), http.StatusBadRequest)
	createShare(t, s, a, nestShare(room.nestID, nil), http.StatusCreated)
	createShare(t, s, a, nestShare(room.nestID, map[string]any{"audience": []string{room.aliceID}}), http.StatusBadRequest)

	// The cap is on active shares per publisher.
	raw := postJSON(t, s, a, "/v1/workshop/shares", nestShare(room.nestID, nil), http.StatusCreated)
	_ = raw
	body := postJSON(t, s, a, "/v1/workshop/shares", nestShare(room.nestID, nil), http.StatusTooManyRequests)
	if !strings.Contains(string(body), "2") {
		t.Fatalf("the message should name the limit: %s", body)
	}
}

func TestWorkshopCapabilitiesGateSharingAndUsing(t *testing.T) {
	room := newVoteRoom(t)
	enableWorkshop(room.server, nil)
	admin, adminToken := newAdmin(t, room.server, "root")
	_ = admin
	setCapability(t, room.server, adminToken, room.bobID, "workshop.share_ports", "deny", nil)
	createShare(t, room.server, room.bob, nestShare(room.nestID, nil), http.StatusForbidden)
	createShare(t, room.server, room.alice, nestShare(room.nestID, nil), http.StatusCreated)

	setCapability(t, room.server, adminToken, room.carolID, "workshop.use_ports", "deny", nil)
	if err := room.server.workshopMayConsume(room.carolID, "nest", room.nestID); err == nil {
		t.Fatal("carol may not use ports")
	}
	if err := room.server.workshopMayConsume(room.daveID, "nest", room.nestID); err != nil {
		t.Fatalf("dave may: %v", err)
	}
}

func TestSharingNeedsBeingInTheCall(t *testing.T) {
	room := newVoteRoom(t)
	enableWorkshop(room.server, nil)
	_, erinToken := createTestUser(t, room.server, "erin")
	postJSON(t, room.server, room.alice, "/v1/trees/"+room.treeID+"/members", map[string]string{"username": "erin"}, http.StatusCreated)
	createShare(t, room.server, erinToken, nestShare(room.nestID, nil), http.StatusForbidden)
}

func TestSharesAreVisibleOnlyToTheirAudience(t *testing.T) {
	room := newVoteRoom(t)
	enableWorkshop(room.server, nil)
	picked := createShare(t, room.server, room.alice, nestShare(room.nestID, map[string]any{"name": "private", "audience": []string{room.bobID}}), http.StatusCreated)
	createShare(t, room.server, room.alice, nestShare(room.nestID, map[string]any{"name": "open"}), http.StatusCreated)
	if got := listShares(t, room.server, room.bob, "nest", room.nestID); len(got) != 2 {
		t.Fatalf("bob sees both, got %d", len(got))
	}
	got := listShares(t, room.server, room.carol, "nest", room.nestID)
	if len(got) != 1 || got[0].ID == picked.ID {
		t.Fatalf("carol sees only the open share: %+v", got)
	}
	_, outsiderToken := createTestUser(t, room.server, "erin")
	getJSON(t, room.server, outsiderToken, "/v1/workshop/places/nest/"+room.nestID+"/shares", http.StatusNotFound)
}

func TestOnlyThePublisherExtendsOrStops(t *testing.T) {
	room := newVoteRoom(t)
	events := enableWorkshop(room.server, func(l *relay.Limits) { l.MaxMinutes = 120 })
	share := createShare(t, room.server, room.alice, nestShare(room.nestID, nil), http.StatusCreated)
	path := "/v1/workshop/shares/" + share.ID
	postJSON(t, room.server, room.bob, path+"/extend", map[string]int{"minutes": 30}, http.StatusForbidden)
	postJSON(t, room.server, room.alice, path+"/extend", map[string]int{"minutes": 500}, http.StatusBadRequest)
	postJSON(t, room.server, room.alice, path+"/extend", map[string]int{"minutes": 90}, http.StatusOK)
	deleteJSON(t, room.server, room.bob, path, http.StatusForbidden)
	deleteJSON(t, room.server, room.alice, path, http.StatusNoContent)
	deleteJSON(t, room.server, room.alice, path, http.StatusNotFound)
	want := []string{"added:", "updated:", "ended:stopped"}
	if strings.Join(*events, ",") != strings.Join(want, ",") {
		t.Fatalf("events %v, want %v", *events, want)
	}
}

func TestLeavingTheCallEndsAShareAndConsumerAccess(t *testing.T) {
	room := newVoteRoom(t)
	enableWorkshop(room.server, nil)
	share := createShare(t, room.server, room.alice, nestShare(room.nestID, nil), http.StatusCreated)
	pub, bobConn, carolConn := &workshopConn{}, &workshopConn{}, &workshopConn{}
	if _, err := room.server.workshop.Attach(share.ID, room.aliceID, pub); err != nil {
		t.Fatal(err)
	}
	room.server.workshop.Join(share.ID, room.bobID, bobConn)
	room.server.workshop.Join(share.ID, room.carolID, carolConn)

	postJSON(t, room.server, room.bob, "/v1/nests/"+room.nestID+"/session/leave", nil, http.StatusOK)
	if len(bobConn.closed) != 1 || bobConn.closed[0] != "left_place" || len(carolConn.closed) != 0 {
		t.Fatalf("only bob's part should end: bob=%v carol=%v", bobConn.closed, carolConn.closed)
	}
	if info, ok := room.server.workshop.Info(share.ID); !ok || len(info.Consumers) != 1 {
		t.Fatalf("the share lives on with carol: %+v %v", info, ok)
	}

	postJSON(t, room.server, room.alice, "/v1/nests/"+room.nestID+"/session/leave", nil, http.StatusOK)
	if _, ok := room.server.workshop.Info(share.ID); ok {
		t.Fatal("the share ends when its publisher leaves the call")
	}
	if len(pub.closed) != 1 || pub.closed[0] != "left_place" || len(carolConn.closed) != 1 {
		t.Fatalf("pub=%v carol=%v", pub.closed, carolConn.closed)
	}
}

func TestRemovalFromTheTreeEndsTheirShares(t *testing.T) {
	room := newVoteRoom(t)
	enableWorkshop(room.server, nil)
	share := createShare(t, room.server, room.bob, nestShare(room.nestID, nil), http.StatusCreated)
	deleteJSON(t, room.server, room.alice, "/v1/trees/"+room.treeID+"/members/"+room.bobID, http.StatusNoContent)
	if _, ok := room.server.workshop.Info(share.ID); ok {
		t.Fatal("a share does not outlive its publisher's place in the tree")
	}
}

func TestSharingInATextRoom(t *testing.T) {
	server, aliceToken := newTestServer(t)
	enableWorkshop(server, nil)
	treeID := createTestTree(t, server, aliceToken, "Core")
	bob, bobToken := createTestUser(t, server, "bob")
	postJSON(t, server, aliceToken, "/v1/trees/"+treeID+"/members", map[string]string{"username": "bob"}, http.StatusCreated)
	_, erinToken := createTestUser(t, server, "erin")
	conversation := chatNewTextNest(t, server, aliceToken, treeID, "general", "")

	body := map[string]any{"placeKind": "room", "placeId": conversation.ID, "name": "term", "protocol": "both", "port": 2222, "audience": []string{bob.ID}, "minutes": 30}
	createShare(t, server, erinToken, body, http.StatusNotFound)
	share := createShare(t, server, aliceToken, body, http.StatusCreated)
	if share.Protocol != "both" || share.Everyone || len(share.Audience) != 1 {
		t.Fatalf("unexpected share %+v", share)
	}
	if got := listShares(t, server, bobToken, "room", conversation.ID); len(got) != 1 {
		t.Fatalf("bob sees the room's share: %d", len(got))
	}
	if err := server.workshopMayConsume(bob.ID, "room", conversation.ID); err != nil {
		t.Fatalf("bob is a member: %v", err)
	}
	deleteJSON(t, server, aliceToken, "/v1/trees/"+treeID+"/members/"+bob.ID, http.StatusNoContent)
	if err := server.workshopMayConsume(bob.ID, "room", conversation.ID); !workshopAccessLost(err) {
		t.Fatalf("bob lost the room, got %v", err)
	}
}

func TestTheRelayAuthenticatesLikeTheAPI(t *testing.T) {
	server, token := newTestServer(t)
	user, err := server.workshopAuthenticate(token)
	if err != nil || user.Username != "alice" || user.Capabilities == nil || !user.Capabilities.SharePorts || !user.Capabilities.UsePorts {
		t.Fatalf("a signed-in session authenticates: %+v %v", user, err)
	}
	if _, err := server.workshopAuthenticate("not-a-session"); err == nil {
		t.Fatal("an unknown session must not authenticate")
	}
	postJSON(t, server, token, "/v1/auth/logout", nil, http.StatusNoContent)
	if _, err := server.workshopAuthenticate(token); err == nil {
		t.Fatal("a signed-out session must not authenticate")
	}
}

func TestRelayEndpointsCarryOnlyDeclaredRouteNotes(t *testing.T) {
	t.Setenv("RAVEN_RELAY_ENDPOINTS", "quic://r.example:7443, wss://r.example/v1/relay/ws behind-cdn origin-http made-up")
	endpoints, notes := workshopRelayEndpoints()
	if len(endpoints) != 2 || endpoints[0] != "quic://r.example:7443" || endpoints[1] != "wss://r.example/v1/relay/ws" {
		t.Fatalf("endpoints %v", endpoints)
	}
	if got := notes["wss://r.example/v1/relay/ws"]; len(got) != 2 || got[0] != "behind-cdn" || got[1] != "origin-http" {
		t.Fatalf("notes %v", notes)
	}
	if _, ok := notes["quic://r.example:7443"]; ok {
		t.Fatal("no notes were declared for the QUIC route")
	}
}
