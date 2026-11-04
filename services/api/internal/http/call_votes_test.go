package http

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestCallVoteCounting(t *testing.T) {
	now := time.Now()
	build := func(voters int, ballots ...bool) *callVote {
		vote := &callVote{voters: map[string]bool{}, ballots: map[string]bool{}, endsAt: now.Add(time.Minute)}
		for i := 0; i < voters; i++ {
			vote.voters[string(rune('a'+i))] = true
		}
		for i, yes := range ballots {
			vote.ballots[string(rune('a'+i))] = yes
		}
		return vote
	}
	cases := []struct {
		name    string
		vote    *callVote
		needed  int
		outcome string
	}{
		{"two voters, one yes", build(2, true), 2, callVoteOpen},
		{"two voters, both yes", build(2, true, true), 2, callVotePassed},
		{"two voters, one no cannot pass", build(2, true, false), 2, callVoteFailed},
		{"three voters, two yes", build(3, true, true), 2, callVotePassed},
		{"four voters, half is not enough", build(4, true, true), 3, callVoteOpen},
		{"four voters, three yes", build(4, true, true, true), 3, callVotePassed},
		{"four voters, two no fails early", build(4, true, false, false), 3, callVoteFailed},
		{"five voters, three yes", build(5, true, true, true), 3, callVotePassed},
		{"five voters, three no fails early", build(5, true, false, false, false), 3, callVoteFailed},
	}
	for _, test := range cases {
		if got := test.vote.needed(); got != test.needed {
			t.Errorf("%s: needed %d, want %d", test.name, got, test.needed)
		}
		if got := test.vote.outcome(now); got != test.outcome {
			t.Errorf("%s: outcome %s, want %s", test.name, got, test.outcome)
		}
	}
	if got := build(3, true).outcome(now.Add(time.Hour)); got != callVoteFailed {
		t.Errorf("a vote past its time should fail, got %s", got)
	}
}

type voteRoom struct {
	server                          *Server
	treeID, nestID                  string
	alice, bob, carol, dave         string // tokens
	aliceID, bobID, carolID, daveID string
}

// newVoteRoom puts alice (the owner), bob, carol and dave in one call.
func newVoteRoom(t *testing.T) voteRoom {
	t.Helper()
	server, alice := newTestServer(t)
	room := voteRoom{server: server, alice: alice, aliceID: aliceUserID(t, server)}
	room.treeID = createTestTree(t, server, alice, "Core")
	room.nestID = createTestNest(t, server, alice, "/v1/trees/"+room.treeID+"/nests", "Standup")
	joinCall(t, server, alice, room.nestID)
	for _, person := range []struct {
		name  string
		token *string
		id    *string
	}{{"bob", &room.bob, &room.bobID}, {"carol", &room.carol, &room.carolID}, {"dave", &room.dave, &room.daveID}} {
		user, token := createTestUser(t, server, person.name)
		*person.token, *person.id = token, user.ID
		postJSON(t, server, alice, "/v1/trees/"+room.treeID+"/members", map[string]string{"username": person.name}, http.StatusCreated)
		joinCall(t, server, token, room.nestID)
	}
	return room
}

func (r voteRoom) start(t *testing.T, token, targetID string, status int) CallVoteUpdate {
	t.Helper()
	raw := postJSON(t, r.server, token, "/v1/nests/"+r.nestID+"/votes", map[string]string{"targetUserId": targetID}, status)
	return decodeVote(t, raw)
}

func (r voteRoom) ballot(t *testing.T, token, voteID string, yes bool, status int) CallVoteUpdate {
	t.Helper()
	raw := postJSON(t, r.server, token, "/v1/nests/"+r.nestID+"/votes/"+voteID+"/ballot", map[string]bool{"yes": yes}, status)
	return decodeVote(t, raw)
}

func decodeVote(t *testing.T, raw []byte) CallVoteUpdate {
	t.Helper()
	var body struct {
		Vote CallVoteUpdate `json:"vote"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	return body.Vote
}

func TestStartingACallVote(t *testing.T) {
	room := newVoteRoom(t)
	room.start(t, room.alice, room.aliceID, http.StatusBadRequest)

	outsider, outsiderToken := createTestUser(t, room.server, "erin")
	postJSON(t, room.server, room.alice, "/v1/trees/"+room.treeID+"/members", map[string]string{"username": "erin"}, http.StatusCreated)
	postJSON(t, room.server, outsiderToken, "/v1/nests/"+room.nestID+"/join", nil, http.StatusOK)
	// Erin is in the space but not the call: she cannot start one, or be its target.
	room.start(t, outsiderToken, room.bobID, http.StatusForbidden)
	room.start(t, room.alice, outsider.ID, http.StatusConflict)

	vote := room.start(t, room.alice, room.bobID, http.StatusCreated)
	if vote.Total != 3 || vote.Needed != 2 || vote.Yes != 1 || vote.Outcome != callVoteOpen || !vote.Voted {
		t.Fatalf("unexpected vote: %+v", vote)
	}
	room.start(t, room.carol, room.daveID, http.StatusConflict)
}

func TestACallVoteNeedsThreePeople(t *testing.T) {
	server, alice := newTestServer(t)
	treeID := createTestTree(t, server, alice, "Core")
	nestID := createTestNest(t, server, alice, "/v1/trees/"+treeID+"/nests", "Standup")
	bob, bobToken := createTestUser(t, server, "bob")
	postJSON(t, server, alice, "/v1/trees/"+treeID+"/members", map[string]string{"username": "bob"}, http.StatusCreated)
	joinCall(t, server, alice, nestID)
	joinCall(t, server, bobToken, nestID)
	postJSON(t, server, alice, "/v1/nests/"+nestID+"/votes", map[string]string{"targetUserId": bob.ID}, http.StatusConflict)
}

func TestBallots(t *testing.T) {
	room := newVoteRoom(t)
	vote := room.start(t, room.alice, room.bobID, http.StatusCreated)

	// A second ballot, the target's ballot, and a late joiner's ballot are all refused.
	room.ballot(t, room.alice, vote.ID, true, http.StatusConflict)
	room.ballot(t, room.bob, vote.ID, false, http.StatusForbidden)
	_, erinToken := createTestUser(t, room.server, "erin")
	postJSON(t, room.server, room.alice, "/v1/trees/"+room.treeID+"/members", map[string]string{"username": "erin"}, http.StatusCreated)
	joinCall(t, room.server, erinToken, room.nestID)
	room.ballot(t, erinToken, vote.ID, true, http.StatusForbidden)

	// A voter who left has no say, and their missing ballot counts as no.
	postJSON(t, room.server, room.dave, "/v1/nests/"+room.nestID+"/session/leave", nil, http.StatusOK)
	room.ballot(t, room.dave, vote.ID, true, http.StatusForbidden)

	if got := room.ballot(t, room.carol, vote.ID, false, http.StatusOK); got.Yes != 1 || got.Outcome != callVoteOpen {
		t.Fatalf("one no of three leaves it open: %+v", got)
	}
}

func TestCurrentCallVoteOnlyReachesThePeopleInIt(t *testing.T) {
	room := newVoteRoom(t)
	vote := room.start(t, room.alice, room.bobID, http.StatusCreated)
	_, erinToken := createTestUser(t, room.server, "erin")
	path := "/v1/nests/" + room.nestID + "/votes/current"

	if got := decodeVote(t, getJSON(t, room.server, room.bob, path, http.StatusOK)); got.ID != vote.ID || got.Voted {
		t.Fatalf("the target should see the vote: %+v", got)
	}
	if got := decodeVote(t, getJSON(t, room.server, room.alice, path, http.StatusOK)); !got.Voted {
		t.Fatalf("the starter has voted: %+v", got)
	}
	if got := decodeVote(t, getJSON(t, room.server, room.carol, path, http.StatusOK)); got.Voted {
		t.Fatalf("carol has not voted: %+v", got)
	}
	if got := decodeVote(t, getJSON(t, room.server, erinToken, path, http.StatusOK)); got.ID != "" {
		t.Fatalf("someone outside the vote saw it: %+v", got)
	}
}

func TestPassingAVoteRemovesFromTheCallNotTheSpace(t *testing.T) {
	room := newVoteRoom(t)
	recorder := recorderFor(t, room.server)
	vote := room.start(t, room.alice, room.bobID, http.StatusCreated)
	if got := room.ballot(t, room.carol, vote.ID, true, http.StatusOK); got.Outcome != callVotePassed {
		t.Fatalf("outcome %s", got.Outcome)
	}
	if inCall(t, room.server, room.bobID, room.nestID) {
		t.Fatal("bob is still in the call")
	}
	for _, identity := range []string{room.bobID, room.bobID + "#audio", room.bobID + "#video"} {
		if !recorder.wasRemoved(room.nestID, identity) {
			t.Fatalf("LiveKit was not asked to remove %s", identity)
		}
	}
	var state string
	if err := room.server.db.QueryRow(`SELECT state FROM nest_members WHERE nest_id = ? AND user_id = ?`, room.nestID, room.bobID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "joined" {
		t.Fatalf("membership became %s", state)
	}
	if role := treeRoleInDB(t, room.server, room.treeID, room.bobID); role != "member" {
		t.Fatalf("space role became %q", role)
	}

	base := "/v1/nests/" + room.nestID
	for _, path := range []string{"/livekit-token", "/session/join", "/presence/join"} {
		raw := postJSON(t, room.server, room.bob, base+path, nil, http.StatusForbidden)
		if !strings.Contains(string(raw), "voted out") {
			t.Fatalf("%s should say why: %s", path, raw)
		}
	}
	postJSON(t, room.server, room.bob, "/v1/knocks", map[string]string{"nestId": room.nestID}, http.StatusForbidden)

	// Leaving the space and coming back does not clear it.
	postJSON(t, room.server, room.bob, "/v1/trees/"+room.treeID+"/leave", nil, http.StatusNoContent)
	postJSON(t, room.server, room.alice, "/v1/trees/"+room.treeID+"/members", map[string]string{"username": "bob"}, http.StatusCreated)
	postJSON(t, room.server, room.bob, base+"/join", nil, http.StatusOK)
	postJSON(t, room.server, room.bob, base+"/livekit-token", nil, http.StatusForbidden)

	// Once the time is up, everything works again.
	past := time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)
	if _, err := room.server.db.Exec(`UPDATE nest_members SET removed_until = ? WHERE nest_id = ? AND user_id = ?`, past, room.nestID, room.bobID); err != nil {
		t.Fatal(err)
	}
	joinCall(t, room.server, room.bob, room.nestID)
}

func TestOwnersCanBeVotedOutAndNobodyLiftsIt(t *testing.T) {
	room := newVoteRoom(t)
	vote := room.start(t, room.bob, room.aliceID, http.StatusCreated)
	room.ballot(t, room.carol, vote.ID, true, http.StatusOK)
	postJSON(t, room.server, room.alice, "/v1/nests/"+room.nestID+"/livekit-token", nil, http.StatusForbidden)
	if role := treeRoleInDB(t, room.server, room.treeID, room.aliceID); role != "owner" {
		t.Fatalf("ownership changed: %q", role)
	}
}

func TestTheTargetLeavingDoesNotStopAVote(t *testing.T) {
	room := newVoteRoom(t)
	vote := room.start(t, room.alice, room.bobID, http.StatusCreated)
	postJSON(t, room.server, room.bob, "/v1/nests/"+room.nestID+"/session/leave", nil, http.StatusOK)
	if got := room.ballot(t, room.carol, vote.ID, true, http.StatusOK); got.Outcome != callVotePassed {
		t.Fatalf("outcome %s", got.Outcome)
	}
	postJSON(t, room.server, room.bob, "/v1/nests/"+room.nestID+"/livekit-token", nil, http.StatusForbidden)
}

func TestCallVoteCooldowns(t *testing.T) {
	room := newVoteRoom(t)
	vote := room.start(t, room.alice, room.bobID, http.StatusCreated)
	room.ballot(t, room.carol, vote.ID, false, http.StatusOK)
	if got := room.ballot(t, room.dave, vote.ID, false, http.StatusOK); got.Outcome != callVoteFailed {
		t.Fatalf("outcome %s", got.Outcome)
	}
	// The same target cannot come up again, and the starter of a failed vote must wait.
	room.start(t, room.carol, room.bobID, http.StatusConflict)
	room.start(t, room.alice, room.carolID, http.StatusConflict)
	// Someone else can still start a vote about someone else.
	room.start(t, room.carol, room.daveID, http.StatusCreated)
}

func TestACallVoteExpires(t *testing.T) {
	room := newVoteRoom(t)
	room.server.callVotes.window = 20 * time.Millisecond
	client := room.server.events.subscribe(room.carolID)
	vote := room.start(t, room.alice, room.bobID, http.StatusCreated)
	deadline := time.After(5 * time.Second)
	for {
		select {
		case frame := <-client.frames:
			var update LiveUpdate
			if err := json.Unmarshal(frame.data, &update); err != nil {
				t.Fatal(err)
			}
			if update.Vote != nil && update.Vote.Outcome == callVoteFailed {
				if !inCall(t, room.server, room.bobID, room.nestID) {
					t.Fatal("a failed vote must not remove anyone")
				}
				room.ballot(t, room.carol, vote.ID, true, http.StatusNotFound)
				return
			}
		case <-deadline:
			t.Fatal("the vote never expired")
		}
	}
}

func TestCallVoteEventsGoOnlyToThePeopleInItAndCarryNoBallots(t *testing.T) {
	room := newVoteRoom(t)
	_, erinToken := createTestUser(t, room.server, "erin")
	postJSON(t, room.server, room.alice, "/v1/trees/"+room.treeID+"/members", map[string]string{"username": "erin"}, http.StatusCreated)
	erin := currentTestUser(t, room.server, "erin")
	_ = erinToken
	outside := room.server.events.subscribe(erin.ID)
	target := room.server.events.subscribe(room.bobID)

	vote := room.start(t, room.alice, room.bobID, http.StatusCreated)
	room.ballot(t, room.carol, vote.ID, false, http.StatusOK)

	seen := 0
	for len(target.frames) > 0 {
		frame := <-target.frames
		if !strings.Contains(string(frame.data), `"call.vote"`) {
			continue
		}
		seen++
		for _, leak := range []string{"ballots", room.carolID, room.daveID} {
			if strings.Contains(string(frame.data), leak) {
				t.Fatalf("event leaks %q: %s", leak, frame.data)
			}
		}
	}
	if seen != 2 {
		t.Fatalf("the target should see the start and the tally, saw %d", seen)
	}
	for len(outside.frames) > 0 {
		if frame := <-outside.frames; strings.Contains(string(frame.data), `"call.vote"`) {
			t.Fatalf("someone outside the vote was told: %s", frame.data)
		}
	}
}
