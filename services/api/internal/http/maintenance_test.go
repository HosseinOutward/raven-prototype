package http

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func receiveUpdate(t *testing.T, client *streamClient) LiveUpdate {
	t.Helper()
	select {
	case frame := <-client.frames:
		var update LiveUpdate
		if err := json.Unmarshal(frame.data, &update); err != nil {
			t.Fatal(err)
		}
		return update
	case <-time.After(time.Second):
		t.Fatal("expected a live update")
		return LiveUpdate{}
	}
}

func expectNoUpdate(t *testing.T, client *streamClient, who string) {
	t.Helper()
	select {
	case frame := <-client.frames:
		t.Fatalf("%s should not have received an update, got %s", who, frame.data)
	default:
	}
}

func TestEntryNoticeReachesOnlyThePeopleInsideTheNest(t *testing.T) {
	server, aliceToken := newTestServer(t)
	bob, bobToken := createTestUser(t, server, "bob")
	charlie, charlieToken := createTestUser(t, server, "charlie")
	alice := currentTestUser(t, server, "alice")

	treeResponse := postJSON(t, server, aliceToken, "/v1/trees", map[string]string{"name": "Core"}, http.StatusCreated)
	var treePayload struct {
		Tree Tree `json:"tree"`
	}
	if err := json.Unmarshal(treeResponse, &treePayload); err != nil {
		t.Fatal(err)
	}
	postJSON(t, server, aliceToken, "/v1/trees/"+treePayload.Tree.ID+"/members", map[string]string{"username": "bob"}, http.StatusCreated)
	nestResponse := postJSON(t, server, aliceToken, "/v1/trees/"+treePayload.Tree.ID+"/nests", map[string]string{"name": "Standup"}, http.StatusCreated)
	var nestPayload struct {
		Nest Nest `json:"nest"`
	}
	if err := json.Unmarshal(nestResponse, &nestPayload); err != nil {
		t.Fatal(err)
	}
	nestPath := "/v1/nests/" + nestPayload.Nest.ID

	// Nobody is inside yet: the notice is accepted but there is no one to tell.
	emptyResponse := postJSON(t, server, bobToken, nestPath+"/entry-notice", nil, http.StatusOK)
	var empty struct {
		Notified     int `json:"notified"`
		DelaySeconds int `json:"delaySeconds"`
	}
	if err := json.Unmarshal(emptyResponse, &empty); err != nil {
		t.Fatal(err)
	}
	if empty.Notified != 0 {
		t.Fatalf("an empty Nest should notify nobody, got %d", empty.Notified)
	}

	postJSON(t, server, aliceToken, nestPath+"/join", nil, http.StatusOK)
	postJSON(t, server, aliceToken, nestPath+"/session/join", nil, http.StatusOK)

	aliceStream := server.events.subscribe(alice.ID)
	bobStream := server.events.subscribe(bob.ID)
	charlieStream := server.events.subscribe(charlie.ID)

	response := postJSON(t, server, bobToken, nestPath+"/entry-notice", nil, http.StatusOK)
	var notice struct {
		Notified     int `json:"notified"`
		DelaySeconds int `json:"delaySeconds"`
	}
	if err := json.Unmarshal(response, &notice); err != nil {
		t.Fatal(err)
	}
	if notice.Notified != 1 || notice.DelaySeconds != nestEntryDelaySeconds {
		t.Fatalf("unexpected entry notice response: %+v", notice)
	}

	update := receiveUpdate(t, aliceStream)
	if update.Type != "nest.entering" || update.NestID != nestPayload.Nest.ID || update.ActorID != bob.ID || update.ActorName == "" {
		t.Fatalf("occupant received the wrong update: %+v", update)
	}
	expectNoUpdate(t, bobStream, "the person entering")
	expectNoUpdate(t, charlieStream, "someone outside the Nest")

	deleteJSON(t, server, bobToken, nestPath+"/entry-notice", http.StatusOK)
	if cancelled := receiveUpdate(t, aliceStream); cancelled.Type != "nest.entering.cancelled" || cancelled.ActorID != bob.ID {
		t.Fatalf("occupant did not see the cancellation: %+v", cancelled)
	}

	// Someone who may not join directly cannot announce themselves either.
	postJSON(t, server, charlieToken, nestPath+"/entry-notice", nil, http.StatusForbidden)
	expectNoUpdate(t, aliceStream, "the occupant, after a rejected notice")
}

func TestHeartbeatTellsATimedOutClientItIsNoLongerInTheNest(t *testing.T) {
	server, token := newTestServer(t)
	nestID := createTestNest(t, server, token, "/v1/nests/persistent", "Persistent")
	postJSON(t, server, token, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)
	postJSON(t, server, token, "/v1/nests/"+nestID+"/presence/join", nil, http.StatusNoContent)
	postJSON(t, server, token, "/v1/presence", map[string]string{"state": "in_nest", "reachability": "around", "activeNestId": nestID}, http.StatusOK)

	heartbeat := func() bool {
		t.Helper()
		response := postJSON(t, server, token, "/v1/presence/heartbeat", map[string]any{"nestHeartbeat": true, "nestId": nestID}, http.StatusOK)
		var payload struct {
			NestActive *bool `json:"nestActive"`
		}
		if err := json.Unmarshal(response, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.NestActive == nil {
			t.Fatal("a heartbeat that names a Nest must report whether it is still active")
		}
		return *payload.NestActive
	}

	if !heartbeat() {
		t.Fatal("a participant with a fresh heartbeat is inside the Nest")
	}

	// The client stalled past the activity timeout and the server removed it.
	if _, err := server.db.Exec(`UPDATE nest_presence SET last_seen_at = '2000-01-01T00:00:00Z' WHERE nest_id = ?`, nestID); err != nil {
		t.Fatal(err)
	}
	if _, err := server.db.Exec(`UPDATE session_participants SET last_seen_at = '2000-01-01T00:00:00Z' WHERE nest_id = ?`, nestID); err != nil {
		t.Fatal(err)
	}
	server.runMaintenance(time.Now().UTC())

	if heartbeat() {
		t.Fatal("after being timed out the client must learn it is no longer inside")
	}

	// It rejoins and is counted again.
	postJSON(t, server, token, "/v1/nests/"+nestID+"/join", nil, http.StatusOK)
	postJSON(t, server, token, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)
	if !heartbeat() {
		t.Fatal("a client that put itself back is inside the Nest again")
	}
}

func TestPresenceSweepAnnouncesUsersWhoStoppedHeartbeating(t *testing.T) {
	server, token := newTestServer(t)
	postJSON(t, server, token, "/v1/presence", map[string]string{"state": "available", "reachability": "around"}, http.StatusOK)

	now := time.Now().UTC()
	if lapsed, err := server.sweepPresence(now); err != nil || lapsed {
		t.Fatalf("the first sweep only records who is online, lapsed=%v err=%v", lapsed, err)
	}
	if lapsed, err := server.sweepPresence(now.Add(10 * time.Second)); err != nil || lapsed {
		t.Fatalf("a user inside the heartbeat window is still online, lapsed=%v err=%v", lapsed, err)
	}

	later := now.Add(presenceHeartbeatTTL + 5*time.Second)
	if lapsed, err := server.sweepPresence(later); err != nil || !lapsed {
		t.Fatalf("missing heartbeats should be announced once, lapsed=%v err=%v", lapsed, err)
	}
	if lapsed, err := server.sweepPresence(later.Add(10 * time.Second)); err != nil || lapsed {
		t.Fatalf("an already-offline user must not be announced again, lapsed=%v err=%v", lapsed, err)
	}
}

func TestGoodbyeGoesOfflineAtOnceAndKeepsTheChosenStatus(t *testing.T) {
	server, token := newTestServer(t)
	postJSON(t, server, token, "/v1/presence", map[string]string{"state": "dnd", "reachability": "unavailable"}, http.StatusOK)
	alice := currentTestUser(t, server, "alice")
	if _, err := server.sweepPresence(time.Now().UTC()); err != nil {
		t.Fatal(err)
	}

	stream := server.events.subscribe("observer")
	postJSON(t, server, token, "/v1/presence/goodbye", nil, http.StatusNoContent)

	if update := receiveUpdate(t, stream); update.Type != "presence.changed" {
		t.Fatalf("closing the app should be announced, got %+v", update)
	}
	presence, err := server.presenceForUser(alice)
	if err != nil {
		t.Fatal(err)
	}
	if presence.State != "offline" {
		t.Fatalf("a user who said goodbye should read as offline, got %+v", presence)
	}
	if lapsed, err := server.sweepPresence(time.Now().UTC()); err != nil || lapsed {
		t.Fatalf("the goodbye was already announced, lapsed=%v err=%v", lapsed, err)
	}

	// Opening the app again restores the status they had picked.
	response := postJSON(t, server, token, "/v1/presence/heartbeat", map[string]bool{"nestHeartbeat": false}, http.StatusOK)
	var payload struct {
		Presence UserPresence `json:"presence"`
	}
	if err := json.Unmarshal(response, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Presence.State != "dnd" {
		t.Fatalf("the chosen status should survive a goodbye, got %+v", payload.Presence)
	}
}

func TestMaintenanceBroadcastsPresenceThatLapsedWithoutAGoodbye(t *testing.T) {
	server, token := newTestServer(t)
	postJSON(t, server, token, "/v1/presence", map[string]string{"state": "available", "reachability": "around"}, http.StatusOK)
	now := time.Now().UTC()
	server.runMaintenance(now)

	stream := server.events.subscribe("observer")
	server.runMaintenance(now.Add(presenceHeartbeatTTL + 5*time.Second))

	if update := receiveUpdate(t, stream); update.Type != "presence.changed" {
		t.Fatalf("expected a presence broadcast, got %+v", update)
	}
}

func TestEventStreamOpensImmediatelySendsKeepalivesAndStopsWhenTheClientLeaves(t *testing.T) {
	reader, writer := io.Pipe()
	client := newEventBroker().subscribe("someone")
	done := make(chan struct{})
	go func() {
		streamEvents(bufio.NewWriter(writer), client, 20*time.Millisecond)
		close(done)
	}()

	lines := bufio.NewReader(reader)
	readLine := func() string {
		t.Helper()
		line, err := lines.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimRight(line, "\n")
	}
	readUntil := func(want string) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if readLine() == want {
				return
			}
		}
		t.Fatalf("stream never sent %q", want)
	}

	if first := readLine(); first != ": connected" {
		t.Fatalf("the stream should open with a comment, got %q", first)
	}
	client.frames <- streamFrame{event: streamEventNest, data: []byte(`{"type":"nest.changed"}`)}
	readUntil("event: nest-update")
	if data := readLine(); data != `data: {"type":"nest.changed"}` {
		t.Fatalf("unexpected event payload: %q", data)
	}
	readUntil(": keepalive")

	_ = reader.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the stream writer kept running after the client disconnected")
	}
}

func TestTargetedUpdatesAreNotBroadcast(t *testing.T) {
	broker := newEventBroker()
	inside := broker.subscribe("inside")
	outside := broker.subscribe("outside")

	broker.publishTo(LiveUpdate{Type: "nest.entering", ActorName: "Bob"}, []string{"inside"})
	if update := receiveUpdate(t, inside); update.ActorName != "Bob" {
		t.Fatalf("unexpected targeted update: %+v", update)
	}
	expectNoUpdate(t, outside, "a user outside the audience")

	broker.publishTo(LiveUpdate{Type: "nest.entering"}, nil)
	expectNoUpdate(t, inside, "anyone, for an empty audience")

	broker.publish(LiveUpdate{Type: "presence.changed"})
	receiveUpdate(t, inside)
	receiveUpdate(t, outside)
}
