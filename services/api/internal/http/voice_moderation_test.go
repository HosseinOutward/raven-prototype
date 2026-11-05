package http

import (
	"encoding/json"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
)

type permissionRecorder struct {
	mu   sync.Mutex
	sent map[string]*livekit.ParticipantPermission
}

func recordPermissions(server *Server) *permissionRecorder {
	recorder := &permissionRecorder{sent: map[string]*livekit.ParticipantPermission{}}
	server.setParticipantPermission = func(room, identity string, permission *livekit.ParticipantPermission) {
		recorder.mu.Lock()
		defer recorder.mu.Unlock()
		recorder.sent[room+"|"+identity] = permission
	}
	return recorder
}

func (r *permissionRecorder) forIdentity(room, identity string) *livekit.ParticipantPermission {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sent[room+"|"+identity]
}

func voicePath(nestID, userID string) string {
	return "/v1/nests/" + nestID + "/participants/" + userID + "/voice"
}

func testUserID(t *testing.T, server *Server, username string) string {
	t.Helper()
	var id string
	if err := server.db.QueryRow(`SELECT id FROM users WHERE username = ?`, username).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func addTestTreeMember(t *testing.T, server *Server, ownerToken, treeID, username string) {
	t.Helper()
	postJSON(t, server, ownerToken, "/v1/trees/"+treeID+"/members", map[string]string{"username": username}, http.StatusCreated)
}

func TestServerMuteFollowsRankInASpace(t *testing.T) {
	server, ownerToken := newTestServer(t)
	stubLiveKit(server)
	recordPermissions(server)
	treeID := createTestTree(t, server, ownerToken, "Crew")
	ownerID := testUserID(t, server, "alice")
	mod, modToken := createTestUser(t, server, "mod")
	mem, memToken := createTestUser(t, server, "mem")
	other, _ := createTestUser(t, server, "other")
	outsider, outsiderToken := createTestUser(t, server, "outsider")
	addTestTreeMember(t, server, ownerToken, treeID, "mod")
	addTestTreeMember(t, server, ownerToken, treeID, "mem")
	addTestTreeMember(t, server, ownerToken, treeID, "other")
	postJSON(t, server, ownerToken, "/v1/trees/"+treeID+"/members/"+mod.ID+"/role", map[string]string{"role": "moderator"}, http.StatusOK)
	nestID := createTestNest(t, server, ownerToken, "/v1/trees/"+treeID+"/nests", "Standup")

	muted := map[string]bool{"muted": true}
	postJSON(t, server, memToken, voicePath(nestID, other.ID), muted, http.StatusForbidden)
	postJSON(t, server, modToken, voicePath(nestID, ownerID), muted, http.StatusForbidden)
	postJSON(t, server, modToken, voicePath(nestID, mod.ID), muted, http.StatusForbidden)
	postJSON(t, server, ownerToken, voicePath(nestID, ownerID), muted, http.StatusForbidden)
	postJSON(t, server, outsiderToken, voicePath(nestID, mem.ID), muted, http.StatusNotFound)
	postJSON(t, server, modToken, voicePath(nestID, outsider.ID), muted, http.StatusNotFound)

	postJSON(t, server, modToken, voicePath(nestID, mem.ID), muted, http.StatusOK)
	postJSON(t, server, ownerToken, voicePath(nestID, mod.ID), muted, http.StatusOK)
}

func TestServerMuteIsEnforcedAndSurvivesRejoin(t *testing.T) {
	server, ownerToken := newTestServer(t)
	stubLiveKit(server)
	recorder := recordPermissions(server)
	treeID := createTestTree(t, server, ownerToken, "Crew")
	mem, memToken := createTestUser(t, server, "mem")
	addTestTreeMember(t, server, ownerToken, treeID, "mem")
	nestID := createTestNest(t, server, ownerToken, "/v1/trees/"+treeID+"/nests", "Standup")
	room := liveKitSessionName(nestID)
	postJSON(t, server, memToken, "/v1/nests/"+nestID+"/join", nil, http.StatusOK)
	postJSON(t, server, memToken, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)

	postJSON(t, server, ownerToken, voicePath(nestID, mem.ID), map[string]bool{"deafened": true}, http.StatusOK)
	audio := recorder.forIdentity(room, mem.ID+"#audio")
	if audio == nil || audio.CanPublish || audio.CanSubscribe || !audio.CanPublishData || !audio.CanUpdateMetadata {
		t.Fatalf("audio identity not limited: %+v", audio)
	}
	viewer := recorder.forIdentity(room, mem.ID)
	if viewer == nil || !viewer.CanSubscribe || !viewer.CanPublish || len(viewer.CanPublishSources) != 2 {
		t.Fatalf("viewer should keep video and lose audio sources: %+v", viewer)
	}
	if recorder.forIdentity(room, mem.ID+"#video") == nil {
		t.Fatal("video identity was not limited")
	}

	person := participantByUsername(t, sessionParticipants(t, server, memToken, nestID), "mem")
	if !person.ServerDeafened || person.ServerMuted || person.Deafened {
		t.Fatalf("session should show only the server deafen: %+v", person)
	}

	// Leaving the call and the space does not clear it.
	postJSON(t, server, memToken, "/v1/nests/"+nestID+"/session/leave", nil, http.StatusOK)
	postJSON(t, server, memToken, "/v1/trees/"+treeID+"/leave", nil, http.StatusNoContent)
	addTestTreeMember(t, server, ownerToken, treeID, "mem")
	nest, err := server.findNest(nestID)
	if err != nil {
		t.Fatal(err)
	}
	limits, err := server.voiceLimitsOf(nest, mem.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !limits.Deafened {
		t.Fatal("leaving and coming back cleared the deafen")
	}

	// Mute and deafen are separate: lifting one keeps the other.
	postJSON(t, server, ownerToken, voicePath(nestID, mem.ID), map[string]bool{"muted": true}, http.StatusOK)
	postJSON(t, server, ownerToken, voicePath(nestID, mem.ID), map[string]bool{"deafened": false}, http.StatusOK)
	if limits, _ = server.voiceLimitsOf(nest, mem.ID); !limits.Muted || limits.Deafened {
		t.Fatalf("lifting a deafen must leave the mute: %+v", limits)
	}
	audio = recorder.forIdentity(room, mem.ID+"#audio")
	if audio.CanPublish || !audio.CanSubscribe {
		t.Fatalf("a muted person should hear again and still not publish: %+v", audio)
	}

	// The new owner cannot stay limited: nobody could lift it.
	if _, err := server.transferTreeOwnershipCore(treeID, mem.ID); err != nil {
		t.Fatal(err)
	}
	if limits, _ = server.voiceLimitsOf(nest, mem.ID); limits.Any() {
		t.Fatalf("a new owner should have no limits: %+v", limits)
	}
}

func TestServerMuteInATemporaryRoom(t *testing.T) {
	server, aliceToken := newTestServer(t)
	stubLiveKit(server)
	recordPermissions(server)
	aliceID := testUserID(t, server, "alice")
	bob, bobToken := createTestUser(t, server, "bob")
	nestID := createTestNest(t, server, aliceToken, "/v1/nests/temporary", "Quick call")
	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/invitations", map[string]string{"username": "bob"}, http.StatusCreated)
	postJSON(t, server, bobToken, "/v1/nests/"+nestID+"/join", nil, http.StatusOK)

	postJSON(t, server, bobToken, voicePath(nestID, aliceID), map[string]bool{"muted": true}, http.StatusForbidden)
	postJSON(t, server, aliceToken, voicePath(nestID, aliceID), map[string]bool{"muted": true}, http.StatusForbidden)
	response := postJSON(t, server, aliceToken, voicePath(nestID, bob.ID), map[string]bool{"muted": true}, http.StatusOK)
	var result struct {
		ServerMuted bool `json:"serverMuted"`
	}
	if err := json.Unmarshal(response, &result); err != nil || !result.ServerMuted {
		t.Fatalf("unexpected response %s: %v", response, err)
	}
	nest, err := server.findNest(nestID)
	if err != nil {
		t.Fatal(err)
	}
	if limits, _ := server.voiceLimitsOf(nest, bob.ID); !limits.Muted {
		t.Fatal("the mute was not stored on the seat")
	}
}

func TestHeartbeatReappliesLimitsForAnOldToken(t *testing.T) {
	server, aliceToken := newTestServer(t)
	stubLiveKit(server)
	recorder := recordPermissions(server)
	bob, bobToken := createTestUser(t, server, "bob")
	nestID := createTestNest(t, server, aliceToken, "/v1/nests/temporary", "Quick call")
	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/invitations", map[string]string{"username": "bob"}, http.StatusCreated)
	postJSON(t, server, bobToken, "/v1/nests/"+nestID+"/join", nil, http.StatusOK)
	postJSON(t, server, aliceToken, voicePath(nestID, bob.ID), map[string]bool{"muted": true}, http.StatusOK)

	room := liveKitSessionName(nestID)
	recorder.mu.Lock()
	delete(recorder.sent, room+"|"+bob.ID+"#audio")
	recorder.mu.Unlock()
	if err := server.heartbeatNestActivity(bob.ID, nestID); err != nil {
		t.Fatal(err)
	}
	if audio := recorder.forIdentity(room, bob.ID+"#audio"); audio == nil || audio.CanPublish {
		t.Fatalf("the heartbeat should have limited them again: %+v", audio)
	}
}

func TestVoiceLimitTrackerThrottlesAndHealsALift(t *testing.T) {
	tracker := newVoiceLimitTracker()
	now := time.Now()
	if tracker.due("k", false, now) {
		t.Fatal("someone never limited has nothing to send")
	}
	if !tracker.due("k", true, now) {
		t.Fatal("the first heartbeat of someone limited should send")
	}
	if tracker.due("k", true, now.Add(5*time.Second)) {
		t.Fatal("should wait out the interval")
	}
	if !tracker.due("k", true, now.Add(voiceLimitReapplyEvery)) {
		t.Fatal("should send again after the interval")
	}
	if !tracker.due("k", false, now.Add(voiceLimitReapplyEvery+time.Second)) {
		t.Fatal("a lift should be sent once more")
	}
	if tracker.due("k", false, now.Add(2*voiceLimitReapplyEvery)) {
		t.Fatal("and then forgotten")
	}
}
