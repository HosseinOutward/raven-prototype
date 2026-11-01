package http

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// trySignUp asks for a new account and returns the status, the new session and the body.
func trySignUp(t *testing.T, server *Server, body map[string]string) (int, string, []byte) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/auth/sign-up", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	resp, err := server.app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	payload, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header.Get("X-Session-ID"), payload
}

func setAccountSettings(t *testing.T, server *Server, adminToken string, signUp, invitations bool) {
	t.Helper()
	postJSON(t, server, adminToken, "/v1/admin/settings/accounts", AccountSettings{SignUpOpen: signUp, InvitationsOpen: invitations}, http.StatusOK)
}

func makeInvite(t *testing.T, server *Server, token string) (Invite, string) {
	t.Helper()
	var payload struct {
		Invite Invite `json:"invite"`
		Code   string `json:"code"`
	}
	if err := json.Unmarshal(postJSON(t, server, token, "/v1/invites", nil, http.StatusCreated), &payload); err != nil {
		t.Fatal(err)
	}
	return payload.Invite, payload.Code
}

func friendIDs(t *testing.T, server *Server, token string) map[string]bool {
	t.Helper()
	var payload struct {
		Friends []struct {
			UserID string `json:"userId"`
		} `json:"friends"`
	}
	if err := json.Unmarshal(getJSON(t, server, token, "/v1/friends", http.StatusOK), &payload); err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, friend := range payload.Friends {
		ids[friend.UserID] = true
	}
	return ids
}

func TestOpenSignUpFollowsTheSwitch(t *testing.T) {
	server, _ := newTestServer(t)
	_, adminToken := newAdmin(t, server, "root")
	newcomer := map[string]string{"username": "newcomer", "displayName": "New Comer", "password": "a long password"}

	if status, _, body := trySignUp(t, server, newcomer); status != http.StatusForbidden {
		t.Fatalf("sign-up while closed: %d %s", status, body)
	}
	var properties ServerProperties
	if err := json.Unmarshal(getJSON(t, server, "", "/v1/server/properties", http.StatusOK), &properties); err != nil {
		t.Fatal(err)
	}
	if accounts := properties.Properties["accounts"].(map[string]any); accounts["signUp"] != false || accounts["invitations"] != false {
		t.Fatalf("closed server advertises %v", accounts)
	}

	setAccountSettings(t, server, adminToken, true, false)
	status, token, body := trySignUp(t, server, newcomer)
	if status != http.StatusOK || token == "" {
		t.Fatalf("sign-up while open: %d %s", status, body)
	}
	me := currentTestUserByToken(t, server, token)
	if me.Username != "newcomer" || me.DisplayName != "New Comer" || me.Role != "user" {
		t.Fatalf("new account is %+v", me)
	}
	if status, _, _ := trySignUp(t, server, newcomer); status != http.StatusConflict {
		t.Fatalf("a taken name gave %d", status)
	}
	// A code is not a way around the Invitations switch.
	if status, _, _ := trySignUp(t, server, map[string]string{"username": "other", "password": "a long password", "inviteCode": "ABCDE-12345"}); status != http.StatusForbidden {
		t.Fatalf("a code while invitations are off gave %d", status)
	}
}

func TestAnInviteMakesFriendsAndWorksOnce(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := currentTestUser(t, server, "alice")
	_, adminToken := newAdmin(t, server, "root")

	// Nobody may invite until both the switch and the capability allow it.
	postJSON(t, server, aliceToken, "/v1/invites", nil, http.StatusForbidden)
	setCapability(t, server, adminToken, alice.ID, "invites.create", "allow", nil)
	postJSON(t, server, aliceToken, "/v1/invites", nil, http.StatusForbidden)
	setAccountSettings(t, server, adminToken, false, true)

	invite, code := makeInvite(t, server, aliceToken)
	if invite.State != "open" || len(code) != 11 || invite.Hint != normalizeInviteCode(code)[6:] {
		t.Fatalf("invite %+v, code %q", invite, code)
	}
	// Typed loosely: lower case, no dash, spaces around.
	status, token, body := trySignUp(t, server, map[string]string{"username": "bob", "password": "a long password", "inviteCode": "  " + normalizeInviteCode(code) + " "})
	if status != http.StatusOK {
		t.Fatalf("redeeming: %d %s", status, body)
	}
	bob := currentTestUserByToken(t, server, token)
	if !friendIDs(t, server, aliceToken)[bob.ID] || !friendIDs(t, server, token)[alice.ID] {
		t.Fatal("inviter and invitee are not friends both ways")
	}
	if status, _, _ := trySignUp(t, server, map[string]string{"username": "carol", "password": "a long password", "inviteCode": code}); status != http.StatusBadRequest {
		t.Fatalf("a used code gave %d", status)
	}
	var listed struct {
		Invites []Invite `json:"invites"`
	}
	if err := json.Unmarshal(getJSON(t, server, aliceToken, "/v1/invites", http.StatusOK), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Invites) != 1 || listed.Invites[0].State != "used" || listed.Invites[0].UsedBy == nil || listed.Invites[0].UsedBy.ID != bob.ID {
		t.Fatalf("listed %+v", listed.Invites)
	}
}

func TestInvitesStopWorkingWhenTheyShould(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := currentTestUser(t, server, "alice")
	admin, adminToken := newAdmin(t, server, "root")
	setAccountSettings(t, server, adminToken, false, true)
	two := 2
	setCapability(t, server, adminToken, alice.ID, "invites.create", "allow", &two)
	redeem := func(username, code string) int {
		status, _, _ := trySignUp(t, server, map[string]string{"username": username, "password": "a long password", "inviteCode": code})
		return status
	}

	// Withdrawn.
	withdrawn, withdrawnCode := makeInvite(t, server, aliceToken)
	deleteJSON(t, server, aliceToken, "/v1/invites/"+withdrawn.ID, http.StatusNoContent)
	deleteJSON(t, server, aliceToken, "/v1/invites/"+withdrawn.ID, http.StatusNotFound)
	if status := redeem("one", withdrawnCode); status != http.StatusBadRequest {
		t.Fatalf("a withdrawn code gave %d", status)
	}

	// The limit counts open invites only; the withdrawn one gave its place back.
	_, first := makeInvite(t, server, aliceToken)
	expiring, expiringCode := makeInvite(t, server, aliceToken)
	postJSON(t, server, aliceToken, "/v1/invites", nil, http.StatusForbidden)

	// Expired.
	if _, err := server.db.Exec(`UPDATE account_invites SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?`, expiring.ID); err != nil {
		t.Fatal(err)
	}
	if status := redeem("two", expiringCode); status != http.StatusBadRequest {
		t.Fatalf("an expired code gave %d", status)
	}

	// The inviter losing the right to invite takes their codes with it, and so does
	// turning invitations off, administrators included.
	setCapability(t, server, adminToken, alice.ID, "invites.create", "deny", nil)
	if status := redeem("three", first); status != http.StatusBadRequest {
		t.Fatalf("a code from someone no longer allowed to invite gave %d", status)
	}
	if caps, err := server.capabilitiesFor(server.db, admin.ID, admin.Role); err != nil || !caps.CreateInvites {
		t.Fatalf("an administrator cannot invite while invitations are on: %+v %v", caps, err)
	}
	setAccountSettings(t, server, adminToken, false, false)
	if caps, err := server.capabilitiesFor(server.db, admin.ID, admin.Role); err != nil || caps.CreateInvites {
		t.Fatalf("an administrator can invite while invitations are off: %+v %v", caps, err)
	}
}

func TestGuessingInviteCodesIsSlowedDown(t *testing.T) {
	server, _ := newTestServer(t)
	_, adminToken := newAdmin(t, server, "root")
	setAccountSettings(t, server, adminToken, false, true)
	for i := 0; i < loginMaxFailuresPerPair; i++ {
		if status, _, _ := trySignUp(t, server, map[string]string{"username": "guesser", "password": "a long password", "inviteCode": "ZZZZZ-ZZZZZ"}); status != http.StatusBadRequest {
			t.Fatalf("guess %d gave %d", i, status)
		}
	}
	if status, _, _ := trySignUp(t, server, map[string]string{"username": "guesser", "password": "a long password", "inviteCode": "ZZZZZ-ZZZZZ"}); status != http.StatusTooManyRequests {
		t.Fatalf("after %d wrong codes got %d", loginMaxFailuresPerPair, status)
	}
}

func TestInviteCodesAreReadTheWayPeopleTypeThem(t *testing.T) {
	for typed, want := range map[string]string{
		"abcde-fghjk": "ABCDEFGHJK",
		"OIL01 23456": "0110123456",
		" a b-c ":     "ABC",
	} {
		if got := normalizeInviteCode(typed); got != want {
			t.Errorf("%q read as %q, want %q", typed, got, want)
		}
	}
	code, err := newInviteCode()
	if err != nil || len(code) != 11 || code[5] != '-' || normalizeInviteCode(code) != code[:5]+code[6:] {
		t.Fatalf("new code %q %v", code, err)
	}
}

func currentTestUserByToken(t *testing.T, server *Server, token string) User {
	t.Helper()
	var payload struct {
		User User `json:"user"`
	}
	if err := json.Unmarshal(getJSON(t, server, token, "/v1/auth/me", http.StatusOK), &payload); err != nil {
		t.Fatal(err)
	}
	return payload.User
}
