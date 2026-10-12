package http

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"
)

// friendCall is a request whose status the test wants to look at, whatever it is.
func friendCall(t *testing.T, server *Server, method, token, path string, body any) (int, []byte) {
	t.Helper()
	var raw []byte
	if body != nil {
		var err error
		if raw, err = json.Marshal(body); err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	setTestCompatibilityHeaders(req)
	req.Header.Set("X-Session-ID", token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := server.app.Test(req, 20000)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	payload := new(bytes.Buffer)
	if _, err := payload.ReadFrom(resp.Body); err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, payload.Bytes()
}

func sendFriendRequest(t *testing.T, server *Server, token, toUserID string) FriendRequest {
	t.Helper()
	var created struct {
		FriendRequest FriendRequest `json:"friendRequest"`
	}
	if err := json.Unmarshal(postJSON(t, server, token, "/v1/friend-requests", map[string]string{"toUserId": toUserID}, http.StatusCreated), &created); err != nil {
		t.Fatal(err)
	}
	return created.FriendRequest
}

func countRows(t *testing.T, server *Server, query string, args ...any) int {
	t.Helper()
	var count int
	if err := server.db.QueryRow(query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestFriendRequestsThatCrossLeaveOnePending(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := currentTestUser(t, server, "alice")
	bob, bobToken := createTestUser(t, server, "bob")

	for round := 0; round < 30; round++ {
		if _, err := server.db.Exec(`DELETE FROM friend_requests`); err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		var aliceStatus, bobStatus int
		wg.Add(2)
		go func() {
			defer wg.Done()
			aliceStatus, _ = friendCall(t, server, http.MethodPost, aliceToken, "/v1/friend-requests", map[string]string{"toUserId": bob.ID})
		}()
		go func() {
			defer wg.Done()
			bobStatus, _ = friendCall(t, server, http.MethodPost, bobToken, "/v1/friend-requests", map[string]string{"toUserId": alice.ID})
		}()
		wg.Wait()

		if pending := countRows(t, server, `SELECT COUNT(*) FROM friend_requests WHERE status = 'pending'`); pending != 1 {
			t.Fatalf("round %d: %d pending requests between two people, want 1 (alice %d, bob %d)", round, pending, aliceStatus, bobStatus)
		}
		created := 0
		for _, status := range []int{aliceStatus, bobStatus} {
			switch status {
			case http.StatusCreated:
				created++
			case http.StatusConflict:
			default:
				t.Fatalf("round %d: unexpected status %d (alice %d, bob %d)", round, status, aliceStatus, bobStatus)
			}
		}
		if created != 1 {
			t.Fatalf("round %d: %d requests created, want 1", round, created)
		}
	}
}

func TestFriendRequestAcceptedWhileCancelledHasOneOutcome(t *testing.T) {
	server, aliceToken := newTestServer(t)
	bob, bobToken := createTestUser(t, server, "bob")

	for round := 0; round < 40; round++ {
		if _, err := server.db.Exec(`DELETE FROM friendships`); err != nil {
			t.Fatal(err)
		}
		if _, err := server.db.Exec(`DELETE FROM friend_requests`); err != nil {
			t.Fatal(err)
		}
		request := sendFriendRequest(t, server, aliceToken, bob.ID)
		var wg sync.WaitGroup
		var acceptStatus, cancelStatus int
		wg.Add(2)
		go func() {
			defer wg.Done()
			acceptStatus, _ = friendCall(t, server, http.MethodPost, bobToken, "/v1/friend-requests/"+request.ID+"/accept", nil)
		}()
		go func() {
			defer wg.Done()
			cancelStatus, _ = friendCall(t, server, http.MethodPost, aliceToken, "/v1/friend-requests/"+request.ID+"/cancel", nil)
		}()
		wg.Wait()

		var status string
		if err := server.db.QueryRow(`SELECT status FROM friend_requests WHERE id = ?`, request.ID).Scan(&status); err != nil {
			t.Fatal(err)
		}
		friendships := countRows(t, server, `SELECT COUNT(*) FROM friendships`)
		switch {
		case acceptStatus == http.StatusOK && cancelStatus == http.StatusConflict:
			if status != "accepted" || friendships != 2 {
				t.Fatalf("round %d: accept won but status=%s friendships=%d", round, status, friendships)
			}
		case cancelStatus == http.StatusOK && acceptStatus == http.StatusConflict:
			if status != "cancelled" || friendships != 0 {
				t.Fatalf("round %d: cancel won but status=%s friendships=%d", round, status, friendships)
			}
		default:
			t.Fatalf("round %d: accept=%d cancel=%d, want exactly one to succeed", round, acceptStatus, cancelStatus)
		}
	}
}

func TestFriendUpdatesReachOnlyTheTwoPeople(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := currentTestUser(t, server, "alice")
	bob, bobToken := createTestUser(t, server, "bob")
	carol, _ := createTestUser(t, server, "carol")

	aliceStream := server.events.subscribe(alice.ID)
	bobStream := server.events.subscribe(bob.ID)
	carolStream := server.events.subscribe(carol.ID)

	expect := func(step, updateType string) {
		t.Helper()
		for name, stream := range map[string]*streamClient{"alice": aliceStream, "bob": bobStream} {
			select {
			case frame := <-stream.frames:
				var update LiveUpdate
				if err := json.Unmarshal(frame.data, &update); err != nil {
					t.Fatal(err)
				}
				if update.Type != updateType {
					t.Fatalf("%s: %s got %q, want %q", step, name, update.Type, updateType)
				}
			case <-time.After(2 * time.Second):
				t.Fatalf("%s: %s was not told", step, name)
			}
		}
		select {
		case frame := <-carolStream.frames:
			t.Fatalf("%s: carol, who is not involved, was sent %s", step, frame.data)
		case <-time.After(100 * time.Millisecond):
		}
	}

	request := sendFriendRequest(t, server, aliceToken, bob.ID)
	expect("send", "friend_request.created")
	postJSON(t, server, aliceToken, "/v1/friend-requests/"+request.ID+"/cancel", nil, http.StatusOK)
	expect("cancel", "friend_request.cancelled")
	request = sendFriendRequest(t, server, aliceToken, bob.ID)
	expect("send again", "friend_request.created")
	postJSON(t, server, bobToken, "/v1/friend-requests/"+request.ID+"/accept", nil, http.StatusOK)
	expect("accept", "friend_request.accepted")
	deleteJSON(t, server, bobToken, "/v1/friends/"+alice.ID, http.StatusNoContent)
	expect("remove", "friend.removed")
}

func TestDeclinedFriendRequestHoldsOffTheNextOne(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := currentTestUser(t, server, "alice")
	bob, bobToken := createTestUser(t, server, "bob")

	request := sendFriendRequest(t, server, aliceToken, bob.ID)
	postJSON(t, server, bobToken, "/v1/friend-requests/"+request.ID+"/decline", nil, http.StatusOK)
	postJSON(t, server, aliceToken, "/v1/friend-requests", map[string]string{"toUserId": bob.ID}, http.StatusTooManyRequests)
	if pending := countRows(t, server, `SELECT COUNT(*) FROM friend_requests WHERE status = 'pending'`); pending != 0 {
		t.Fatalf("a refused request was stored: %d pending", pending)
	}

	// The wait has passed.
	old := time.Now().UTC().Add(-25 * time.Hour).Format(time.RFC3339Nano)
	if _, err := server.db.Exec(`UPDATE friend_requests SET resolved_at = ? WHERE id = ?`, old, request.ID); err != nil {
		t.Fatal(err)
	}
	again := sendFriendRequest(t, server, aliceToken, bob.ID)
	postJSON(t, server, bobToken, "/v1/friend-requests/"+again.ID+"/decline", nil, http.StatusOK)

	// Declining someone does not stop you asking them yourself.
	sendFriendRequest(t, server, bobToken, alice.ID)
}

func TestWithdrawnFriendRequestCanBeSentAgain(t *testing.T) {
	server, aliceToken := newTestServer(t)
	bob, _ := createTestUser(t, server, "bob")

	request := sendFriendRequest(t, server, aliceToken, bob.ID)
	postJSON(t, server, aliceToken, "/v1/friend-requests/"+request.ID+"/cancel", nil, http.StatusOK)
	sendFriendRequest(t, server, aliceToken, bob.ID)
}

func TestFriendRequestAnswersAreFinalAndSaidPlainly(t *testing.T) {
	server, aliceToken := newTestServer(t)
	bob, bobToken := createTestUser(t, server, "bob")

	request := sendFriendRequest(t, server, aliceToken, bob.ID)
	postJSON(t, server, bobToken, "/v1/friend-requests/"+request.ID+"/accept", nil, http.StatusOK)

	for _, action := range []string{"accept", "decline"} {
		status, body := friendCall(t, server, http.MethodPost, bobToken, "/v1/friend-requests/"+request.ID+"/"+action, nil)
		if status != http.StatusConflict || !bytes.Contains(body, []byte("already answered")) {
			t.Fatalf("%s after accept: %d %s", action, status, body)
		}
	}
	status, body := friendCall(t, server, http.MethodPost, bobToken, "/v1/friend-requests/missing/accept", nil)
	if status != http.StatusNotFound || !bytes.Contains(body, []byte("isn’t available")) {
		t.Fatalf("unknown request: %d %s", status, body)
	}
	status, body = friendCall(t, server, http.MethodPost, aliceToken, "/v1/friend-requests", map[string]string{"toUserId": bob.ID})
	if status != http.StatusConflict || !bytes.Contains(body, []byte("already friends")) {
		t.Fatalf("request to a friend: %d %s", status, body)
	}
}

func TestUserSearchMatchesBothNamesLiterally(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := currentTestUser(t, server, "alice")
	bob, bobToken := createTestUser(t, server, "bob")
	carol, _ := createTestUser(t, server, "carol")
	if _, err := server.db.Exec(`UPDATE user_preferences SET display_name = 'Robert 100%' WHERE user_id = ?`, bob.ID); err != nil {
		t.Fatal(err)
	}

	search := func(token, query string) []PublicUser {
		t.Helper()
		values := url.Values{"q": {query}}
		var result struct {
			Users []PublicUser `json:"users"`
		}
		if err := json.Unmarshal(getJSON(t, server, token, "/v1/users/search?"+values.Encode(), http.StatusOK), &result); err != nil {
			t.Fatal(err)
		}
		return result.Users
	}

	if users := search(aliceToken, "rober"); len(users) != 1 || users[0].ID != bob.ID || users[0].DisplayName != "Robert 100%" {
		t.Fatalf("search by display name: %+v", users)
	}
	if users := search(aliceToken, "0%"); len(users) != 1 || users[0].ID != bob.ID {
		t.Fatalf("a typed %% should match itself: %+v", users)
	}
	for _, wildcard := range []string{"%%", "__", "a_i"} {
		if users := search(aliceToken, wildcard); len(users) != 0 {
			t.Fatalf("%q listed people: %+v", wildcard, users)
		}
	}

	relationship := func(token, query, userID string) PublicUser {
		t.Helper()
		for _, user := range search(token, query) {
			if user.ID == userID {
				return user
			}
		}
		t.Fatalf("%q did not find %s", query, userID)
		return PublicUser{}
	}
	if user := relationship(aliceToken, "ali", alice.ID); user.Relationship != "self" {
		t.Fatalf("self: %+v", user)
	}
	if user := relationship(aliceToken, "caro", carol.ID); user.Relationship != "none" || user.FriendRequestID != "" {
		t.Fatalf("stranger: %+v", user)
	}
	request := sendFriendRequest(t, server, aliceToken, bob.ID)
	if user := relationship(aliceToken, "bob", bob.ID); user.Relationship != "outgoing_pending" || user.FriendRequestID != request.ID {
		t.Fatalf("sender's view: %+v", user)
	}
	if user := relationship(bobToken, "ali", alice.ID); user.Relationship != "incoming_pending" || user.FriendRequestID != request.ID {
		t.Fatalf("recipient's view: %+v", user)
	}
	postJSON(t, server, bobToken, "/v1/friend-requests/"+request.ID+"/accept", nil, http.StatusOK)
	if user := relationship(aliceToken, "bob", bob.ID); user.Relationship != "friends" || user.FriendRequestID != "" {
		t.Fatalf("friends: %+v", user)
	}
}
