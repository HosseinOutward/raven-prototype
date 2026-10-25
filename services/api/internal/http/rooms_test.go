package http

import (
	"encoding/json"
	"net/http"
	"testing"
)

// drainUpdates returns the nest and tree updates waiting on a stream, oldest first.
func drainUpdates(t *testing.T, client *streamClient) []LiveUpdate {
	t.Helper()
	updates := []LiveUpdate{}
	for {
		select {
		case frame := <-client.frames:
			if frame.event != streamEventNest {
				continue
			}
			var update LiveUpdate
			if err := json.Unmarshal(frame.data, &update); err != nil {
				t.Fatal(err)
			}
			updates = append(updates, update)
		default:
			return updates
		}
	}
}

func hasUpdate(updates []LiveUpdate, updateType, nestID string) bool {
	for _, update := range updates {
		if update.Type == updateType && (nestID == "" || update.NestID == nestID) {
			return true
		}
	}
	return false
}

func treeNestNames(t *testing.T, server *Server, token, treeID string) []string {
	t.Helper()
	var details TreeDetails
	if err := json.Unmarshal(getJSON(t, server, token, "/v1/trees/"+treeID, http.StatusOK), &details); err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, nest := range append(details.ActiveNests, details.InactiveNests...) {
		names = append(names, nest.Name)
	}
	return names
}

func TestModeratorsRenameAndEndVoiceRoomsAndMembersCannot(t *testing.T) {
	server, aliceToken := newTestServer(t)
	bob := chatNewPerson(t, server, "bob")
	carol := chatNewPerson(t, server, "carol")
	treeID := createTestTree(t, server, aliceToken, "Core")
	base := "/v1/trees/" + treeID
	postJSON(t, server, aliceToken, base+"/members", map[string]string{"username": "bob"}, http.StatusCreated)
	postJSON(t, server, aliceToken, base+"/members", map[string]string{"username": "carol", "role": "moderator"}, http.StatusCreated)
	nestID := createTestNest(t, server, aliceToken, base+"/nests", "Standup")
	bobStream := server.events.subscribe(bob.user.ID)

	postJSON(t, server, bob.token, "/v1/nests/"+nestID+"/settings", map[string]string{"name": "Mine"}, http.StatusForbidden)
	postJSON(t, server, bob.token, "/v1/nests/"+nestID+"/archive", nil, http.StatusForbidden)
	if updates := drainUpdates(t, bobStream); len(updates) != 0 {
		t.Fatalf("a refused change was announced: %+v", updates)
	}

	postJSON(t, server, carol.token, "/v1/nests/"+nestID+"/settings", map[string]string{"name": "Sync"}, http.StatusOK)
	if !hasUpdate(drainUpdates(t, bobStream), "nest.changed", nestID) {
		t.Fatal("the other members were not told about the new name")
	}
	if names := treeNestNames(t, server, bob.token, treeID); len(names) != 1 || names[0] != "Sync" {
		t.Fatalf("the tree lists %v after the rename", names)
	}

	postJSON(t, server, carol.token, "/v1/nests/"+nestID+"/archive", nil, http.StatusNoContent)
	ended := drainUpdates(t, bobStream)
	t.Logf("updates after ending: %+v", ended)
	if !hasUpdate(ended, "nest.changed", nestID) {
		t.Fatal("the other members were not told the room was ended")
	}
	if names := treeNestNames(t, server, bob.token, treeID); len(names) != 0 {
		t.Fatalf("an ended room is still listed: %v", names)
	}
	postJSON(t, server, carol.token, "/v1/nests/"+nestID+"/settings", map[string]string{"name": "Back"}, http.StatusNotFound)
}

func TestDeletingATextRoomHidesItAndKeepsItsMessages(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	bob := chatNewPerson(t, server, "bob")
	carol := chatNewPerson(t, server, "carol")
	tree := chatNewTree(t, server, alice, "Design", bob)
	chatDo(t, server, http.MethodPost, alice.token, "/v1/trees/"+tree.id+"/members", map[string]string{"username": "carol", "role": "moderator"}, http.StatusCreated)
	nest := chatNewTextNest(t, server, alice.token, tree.id, "general", "")
	other := chatNewTextNest(t, server, alice.token, tree.id, "random", "")
	chatSend(t, server, alice.token, nest.ID, "this stays in the database")
	chatSend(t, server, bob.token, nest.ID, "so does this")
	base := "/v1/chat/conversations/" + nest.ID

	// Renaming and deleting belong to the people who run the tree.
	chatDo(t, server, http.MethodPost, bob.token, base+"/settings", map[string]string{"name": "mine"}, http.StatusForbidden)
	chatDo(t, server, http.MethodDelete, bob.token, base, nil, http.StatusForbidden)
	renamed := chatDecode[chatConversationPayload](t, chatDo(t, server, http.MethodPost, carol.token, base+"/settings", map[string]string{"name": "lobby"}, http.StatusOK)).Conversation
	if renamed.Name != "lobby" {
		t.Fatalf("the moderator's rename did not stick: %+v", renamed)
	}

	bobStream := chatListen(server, bob)
	chatDo(t, server, http.MethodDelete, carol.token, base, nil, http.StatusNoContent)
	if event := nextChatEvent(t, bobStream); event.Type != "conversation.removed" || event.ConversationID != nest.ID {
		t.Fatalf("members should be told the room is gone: %+v", event)
	}
	if !hasUpdate(drainUpdates(t, bobStream), "tree.layout_updated", "") {
		t.Fatal("members should be told the tree's layout changed")
	}

	// Gone for everyone, including the people who run the tree.
	for _, person := range []chatPerson{alice, bob, carol} {
		chatDo(t, server, http.MethodGet, person.token, base+"/messages", nil, http.StatusNotFound)
		chatDo(t, server, http.MethodPost, person.token, base+"/settings", map[string]string{"name": "again"}, http.StatusNotFound)
		if chatFind(chatList(t, server, person.token), nest.ID) != nil {
			t.Fatalf("%s still lists the deleted room", person.user.Username)
		}
	}
	for _, item := range chatLayout(t, server, alice.token, tree.id).Items {
		if item.ID == nest.ID {
			t.Fatal("the deleted room is still in the tree's layout")
		}
	}
	chatSend(t, server, alice.token, other.ID, "the other room is untouched")

	// What was written is kept.
	var status string
	if err := server.db.QueryRow(`SELECT status FROM chat_conversations WHERE id = ?`, nest.ID).Scan(&status); err != nil || status != "deleted" {
		t.Fatalf("the room should be kept, marked deleted: status %q, err %v", status, err)
	}
	var messages int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM chat_messages WHERE conversation_id = ?`, nest.ID).Scan(&messages); err != nil {
		t.Fatal(err)
	}
	if messages < 2 {
		t.Fatalf("the messages were deleted with the room: %d left", messages)
	}
}
