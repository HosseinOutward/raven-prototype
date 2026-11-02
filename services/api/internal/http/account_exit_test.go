package http

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
	"strings"
	"testing"

	"raven/services/api/internal/auth"
	profilemedia "raven/services/api/internal/media"
)

func readExportZip(t *testing.T, raw []byte) map[string][]byte {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatalf("export is not a zip: %v", err)
	}
	files := map[string][]byte{}
	for _, file := range reader.File {
		opened, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		content, err := io.ReadAll(opened)
		_ = opened.Close()
		if err != nil {
			t.Fatal(err)
		}
		files[file.Name] = content
	}
	return files
}

func joinedExport(files map[string][]byte, prefix string) string {
	var out strings.Builder
	for name, content := range files {
		if strings.HasPrefix(name, prefix) {
			out.Write(content)
		}
	}
	return out.String()
}

func deleteAccountBody(user User, messages string) map[string]string {
	return map[string]string{"password": "secret", "confirmUsername": user.Username, "messages": messages}
}

func TestAccountExportHoldsWhatThePersonCanReadAndNothingElse(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	s.profileMedia = &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	group := chatNewGroup(t, s, alice, "Study group", bob)

	chatSend(t, s, alice.token, dm.ID, "old words before the clear")
	chatDo(t, s, http.MethodPost, alice.token, "/v1/chat/conversations/"+dm.ID+"/clear", nil, http.StatusNoContent)
	chatSend(t, s, bob.token, dm.ID, "bob after the clear")
	hidden := chatSend(t, s, bob.token, dm.ID, "bob words alice hid")
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/chat/conversations/"+dm.ID+"/messages/"+hidden.ID+"?for=me", nil, http.StatusOK)
	chatSend(t, s, bob.token, group.ID, "bob in the group")

	mine := attachmentCreate(t, s, alice.token, group.ID, true)
	attachmentSend(t, s, alice.token, group.ID, []string{mine.ID}, http.StatusCreated)
	theirs := attachmentCreate(t, s, bob.token, group.ID, true)
	attachmentSend(t, s, bob.token, group.ID, []string{theirs.ID}, http.StatusCreated)

	status, raw, header, err := chatCall(s, http.MethodGet, alice.token, "/v1/account/export", nil)
	if err != nil || status != http.StatusOK {
		t.Fatalf("export: status %d err %v body %s", status, err, raw)
	}
	if !strings.Contains(header.Get("Content-Disposition"), `filename="raven-alice-`) {
		t.Fatalf("Content-Disposition = %q", header.Get("Content-Disposition"))
	}
	files := readExportZip(t, raw)
	for _, name := range []string{"README.txt", "account.json", "friends.json", "trees.json", "calls.json"} {
		if _, ok := files[name]; !ok {
			t.Fatalf("export lacks %s; has %v", name, keysOf(files))
		}
	}
	transcripts := joinedExport(files, "conversations/")
	for _, want := range []string{"bob after the clear", "bob in the group"} {
		if !strings.Contains(transcripts, want) {
			t.Fatalf("export lacks %q", want)
		}
	}
	for _, unwanted := range []string{"old words before the clear", "bob words alice hid"} {
		if strings.Contains(transcripts, unwanted) {
			t.Fatalf("export holds %q, which alice cannot read", unwanted)
		}
	}
	var txt, jsonDocs int
	for name := range files {
		switch {
		case strings.HasPrefix(name, "conversations/") && strings.HasSuffix(name, ".txt"):
			txt++
		case strings.HasPrefix(name, "conversations/") && strings.HasSuffix(name, ".json"):
			jsonDocs++
		}
	}
	if txt != 2 || jsonDocs != 2 {
		t.Fatalf("conversations: %d txt, %d json, want 2 each", txt, jsonDocs)
	}

	var sent, others int
	for name := range files {
		if strings.HasPrefix(name, "files/"+mine.ID+"-") {
			sent++
		}
		if strings.HasPrefix(name, "files/"+theirs.ID+"-") {
			others++
		}
	}
	if sent != 1 || others != 0 {
		t.Fatalf("files: %d of alice's, %d of bob's; has %v", sent, others, keysOf(files))
	}

	var hash string
	if err := s.db.QueryRow(`SELECT password_hash FROM users WHERE id = ?`, alice.user.ID).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	for name, content := range files {
		if strings.Contains(string(content), hash) || strings.Contains(strings.ToLower(string(content)), "password_hash") {
			t.Fatalf("%s holds password material", name)
		}
	}
}

func keysOf(files map[string][]byte) []string {
	names := []string{}
	for name := range files {
		names = append(names, name)
	}
	return names
}

func TestDeletingAnAccountAndErasingItsMessages(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	store := &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	s.profileMedia = store
	group := chatNewGroup(t, s, alice, "Study group", bob)

	aliceDM := chatSend(t, s, alice.token, dm.ID, "alice says hi")
	bobDM := chatSend(t, s, bob.token, dm.ID, "bob says hi")
	aliceGroup := chatSend(t, s, alice.token, group.ID, "alice in group")
	bobGroup := chatSend(t, s, bob.token, group.ID, "bob in group")
	chatDo(t, s, http.MethodPost, alice.token, "/v1/chat/conversations/"+group.ID+"/messages/"+bobGroup.ID+"/reactions", map[string]any{"emoji": "👍", "add": true}, http.StatusOK)
	attachment := attachmentCreate(t, s, alice.token, group.ID, true)
	attachmentSend(t, s, alice.token, group.ID, []string{attachment.ID}, http.StatusCreated)
	_, adminToken := newAdmin(t, s, "root")

	chatDo(t, s, http.MethodPost, alice.token, "/v1/account/delete", deleteAccountBody(alice.user, "erase"), http.StatusNoContent)

	var body string
	var deletedAt *string
	for _, id := range []string{aliceDM.ID, aliceGroup.ID} {
		if err := s.db.QueryRow(`SELECT body, deleted_at FROM chat_messages WHERE id = ?`, id).Scan(&body, &deletedAt); err != nil {
			t.Fatal(err)
		}
		if body != "" || deletedAt == nil {
			t.Fatalf("alice's message %s: body %q deletedAt %v", id, body, deletedAt)
		}
	}
	for _, id := range []string{bobDM.ID, bobGroup.ID} {
		if err := s.db.QueryRow(`SELECT body, deleted_at FROM chat_messages WHERE id = ?`, id).Scan(&body, &deletedAt); err != nil {
			t.Fatal(err)
		}
		if body == "" || deletedAt != nil {
			t.Fatalf("bob's message %s was touched", id)
		}
	}
	if n := countRows(t, s, `SELECT COUNT(*) FROM chat_reactions WHERE user_id = ?`, alice.user.ID); n != 0 {
		t.Fatalf("%d reactions left", n)
	}
	if n := countRows(t, s, `SELECT COUNT(*) FROM chat_object_purges`); n != 2 {
		t.Fatalf("%d objects queued for purge, want the 2 variants of alice's image", n)
	}
	if n := countRows(t, s, `SELECT COUNT(*) FROM chat_attachments WHERE uploader_id = ?`, alice.user.ID); n != 0 {
		t.Fatalf("%d attachments left", n)
	}

	// Bob sees the markers, and his group went on without her.
	history := chatHistory(t, s, bob.token, dm.ID, "")
	found := false
	for _, message := range history.Messages {
		if message.ID == aliceDM.ID {
			found = message.DeletedAt != nil && message.Body == ""
		}
	}
	if !found {
		t.Fatal("bob does not see alice's direct message as deleted")
	}

	afterwards := chatFind(chatList(t, s, bob.token), dm.ID)
	if afterwards == nil || afterwards.CanSend || !afterwards.PeerDeleted || afterwards.Name != "Deleted account" {
		t.Fatalf("bob's direct message with alice: %+v", afterwards)
	}
	sendBody := map[string]string{"clientMessageId": "c-" + auth.NewID(), "body": "are you there"}
	refused := chatDo(t, s, http.MethodPost, bob.token, "/v1/chat/conversations/"+dm.ID+"/messages", sendBody, http.StatusForbidden)
	if !strings.Contains(string(refused), "This account was deleted. You can still read your conversation.") {
		t.Fatalf("refusal: %s", refused)
	}

	// She is gone for sign-in, search, sessions, the admin and the name.
	if status, _, _, err := chatCall(s, http.MethodPost, "", "/v1/auth/login", map[string]string{"username": "alice", "password": "secret"}); err != nil || status != http.StatusUnauthorized {
		t.Fatalf("sign-in after deletion: status %d err %v", status, err)
	}
	chatDo(t, s, http.MethodGet, alice.token, "/v1/auth/me", nil, http.StatusUnauthorized)
	if n := countRows(t, s, `SELECT COUNT(*) FROM auth_sessions WHERE user_id = ?`, alice.user.ID); n != 0 {
		t.Fatalf("%d sessions left", n)
	}
	found2 := chatDo(t, s, http.MethodGet, bob.token, "/v1/users/search?q=alice", nil, http.StatusOK)
	if strings.Contains(string(found2), alice.user.ID) {
		t.Fatalf("search still finds her: %s", found2)
	}
	if n := countRows(t, s, `SELECT COUNT(*) FROM friendships WHERE user_id = ? OR friend_user_id = ?`, alice.user.ID, alice.user.ID); n != 0 {
		t.Fatalf("%d friendships left", n)
	}
	chatDo(t, s, http.MethodPost, adminToken, "/v1/admin/users/"+alice.user.ID+"/reactivate", nil, http.StatusConflict)
	chatDo(t, s, http.MethodPost, adminToken, "/v1/admin/users/"+alice.user.ID+"/password-reset", nil, http.StatusConflict)
	if _, err := s.CreateUser("alice", "secret", "user"); err == nil {
		t.Fatal("the name was free to take again")
	}
	listed := string(chatDo(t, s, http.MethodGet, adminToken, "/v1/admin/users/"+alice.user.ID, nil, http.StatusOK))
	if !strings.Contains(listed, `"deleted":true`) {
		t.Fatalf("admin detail: %s", listed)
	}
	if n := countRows(t, s, `SELECT COUNT(*) FROM admin_audit_events WHERE action = 'account.deleted' AND entity_id = ?`, alice.user.ID); n != 1 {
		t.Fatalf("%d audit rows", n)
	}
}

func TestDeletingAnAccountCanLeaveTheMessagesBehind(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	group := chatNewGroup(t, s, alice, "Study group", bob)
	aliceDM := chatSend(t, s, alice.token, dm.ID, "alice says hi")
	aliceGroup := chatSend(t, s, alice.token, group.ID, "alice in group")

	chatDo(t, s, http.MethodPost, alice.token, "/v1/account/delete", deleteAccountBody(alice.user, "keep"), http.StatusNoContent)

	var body string
	for _, id := range []string{aliceDM.ID, aliceGroup.ID} {
		var deletedAt *string
		if err := s.db.QueryRow(`SELECT body, deleted_at FROM chat_messages WHERE id = ?`, id).Scan(&body, &deletedAt); err != nil {
			t.Fatal(err)
		}
		if body == "" || deletedAt != nil {
			t.Fatalf("message %s was erased", id)
		}
	}
	history := chatHistory(t, s, bob.token, group.ID, "")
	var seen bool
	for _, message := range history.Messages {
		if message.ID == aliceGroup.ID {
			seen = message.Body == "alice in group" && message.SenderName == "Deleted account"
		}
	}
	if !seen {
		t.Fatalf("bob's view of the group: %+v", chatBodies(history.Messages))
	}
	if role := countRows(t, s, `SELECT COUNT(*) FROM chat_members WHERE conversation_id = ? AND user_id = ? AND role = 'owner' AND state = 'joined'`, group.ID, bob.user.ID); role != 1 {
		t.Fatal("the group did not pass to bob")
	}
	if n := countRows(t, s, `SELECT COUNT(*) FROM chat_members WHERE conversation_id = ? AND user_id = ? AND state = 'joined'`, group.ID, alice.user.ID); n != 0 {
		t.Fatal("alice is still in the group")
	}
}

func TestDeletingAnAccountNeedsThePasswordTheNameAndAChoice(t *testing.T) {
	s, alice, _, _ := chatPair(t)
	body := deleteAccountBody(alice.user, "erase")

	wrongPassword := map[string]string{"password": "not it", "confirmUsername": "alice", "messages": "erase"}
	chatDo(t, s, http.MethodPost, alice.token, "/v1/account/delete", wrongPassword, http.StatusForbidden)
	wrongName := map[string]string{"password": body["password"], "confirmUsername": "alic", "messages": "erase"}
	chatDo(t, s, http.MethodPost, alice.token, "/v1/account/delete", wrongName, http.StatusBadRequest)
	noChoice := map[string]string{"password": body["password"], "confirmUsername": "alice"}
	chatDo(t, s, http.MethodPost, alice.token, "/v1/account/delete", noChoice, http.StatusBadRequest)

	chatDo(t, s, http.MethodGet, alice.token, "/v1/auth/me", nil, http.StatusOK)
	if n := countRows(t, s, `SELECT COUNT(*) FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL`, alice.user.ID); n != 1 {
		t.Fatal("the account changed")
	}
}

func TestDeletingAnAccountIsBlockedByWhatItOwnsOrIsDoing(t *testing.T) {
	s, alice, bob, _ := chatPair(t)

	treeID := createTestTree(t, s, alice.token, "Design")
	state := chatDecode[accountBlockers](t, chatDo(t, s, http.MethodGet, alice.token, "/v1/account/deletion", nil, http.StatusOK))
	if len(state.OwnedTrees) != 1 || state.OwnedTrees[0].ID != treeID || state.OnlyAdmin || state.InCall {
		t.Fatalf("blockers: %+v", state)
	}
	chatDo(t, s, http.MethodPost, alice.token, "/v1/account/delete", deleteAccountBody(alice.user, "keep"), http.StatusConflict)
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/trees/"+treeID, map[string]string{"confirmation": "Design"}, http.StatusNoContent)

	bobsTree := createTestTree(t, s, bob.token, "Bob's tree")
	chatDo(t, s, http.MethodPost, bob.token, "/v1/trees/"+bobsTree+"/members", map[string]string{"username": "alice"}, http.StatusCreated)
	nestID := createTestNest(t, s, bob.token, "/v1/trees/"+bobsTree+"/nests", "Room")
	now := "2026-11-02T10:00:00Z"
	if _, err := s.db.Exec(
		`INSERT INTO nest_presence (id, nest_id, user_id, joined_at, last_seen_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
		auth.NewID(), nestID, alice.user.ID, now, now, now, now,
	); err != nil {
		t.Fatal(err)
	}
	refused := chatDo(t, s, http.MethodPost, alice.token, "/v1/account/delete", deleteAccountBody(alice.user, "keep"), http.StatusConflict)
	if !strings.Contains(string(refused), "Leave the call first.") {
		t.Fatalf("refusal: %s", refused)
	}
	if _, err := s.db.Exec(`UPDATE nest_presence SET left_at = ?, status = 'left'`, now); err != nil {
		t.Fatal(err)
	}

	root, rootToken := newAdmin(t, s, "root")
	state = chatDecode[accountBlockers](t, chatDo(t, s, http.MethodGet, rootToken, "/v1/account/deletion", nil, http.StatusOK))
	if !state.OnlyAdmin {
		t.Fatalf("blockers: %+v", state)
	}
	chatDo(t, s, http.MethodPost, rootToken, "/v1/account/delete", deleteAccountBody(root, "keep"), http.StatusConflict)

	// With nothing in the way, alice can go.
	chatDo(t, s, http.MethodPost, alice.token, "/v1/account/delete", deleteAccountBody(alice.user, "keep"), http.StatusNoContent)
}
