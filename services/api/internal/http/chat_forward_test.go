package http

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	profilemedia "raven/services/api/internal/media"
)

type chatForwardPayload struct {
	ConversationID string        `json:"conversationId"`
	Messages       []ChatMessage `json:"messages"`
}

func chatForward(t *testing.T, s *Server, person chatPerson, to string, want int, ids []string, options map[string]any) []ChatMessage {
	t.Helper()
	body := map[string]any{"messageIds": ids, "to": to}
	for k, v := range options {
		body[k] = v
	}
	raw := chatDo(t, s, http.MethodPost, person.token, "/v1/chat/forward", body, want)
	if want >= 300 {
		return nil
	}
	return chatDecode[chatForwardPayload](t, raw).Messages
}

func chatHistoryFind(t *testing.T, s *Server, person chatPerson, conversationID, messageID string) ChatMessage {
	t.Helper()
	raw := chatDo(t, s, http.MethodGet, person.token, "/v1/chat/conversations/"+conversationID+"/messages?limit=100", nil, http.StatusOK)
	var page struct {
		Messages []ChatMessage `json:"messages"`
	}
	if err := json.Unmarshal(raw, &page); err != nil {
		t.Fatal(err)
	}
	for _, m := range page.Messages {
		if m.ID == messageID {
			return m
		}
	}
	t.Fatalf("message %s not in history", messageID)
	return ChatMessage{}
}

// A group's name is private. carol reads the nest but is not in the group.
func TestChatForwardSourceFollowsTheViewer(t *testing.T) {
	s, aliceToken := newTestServer(t)
	alice := chatAlice(t, s, aliceToken)
	bob := chatNewPerson(t, s, "bob")
	carol := chatNewPerson(t, s, "carol")
	chatBefriend(t, s, alice, bob)
	group := chatNewGroup(t, s, alice, "secret-plans", bob)
	original := chatSend(t, s, bob.token, group.ID, "the plan")
	tree := chatNewTree(t, s, alice, "hall", carol)
	nest := chatNewTextNest(t, s, alice.token, tree.id, "general", "")

	aliceStream, carolStream := chatListen(s, alice), chatListen(s, carol)
	forwards := chatForward(t, s, alice, nest.ID, http.StatusCreated, []string{original.ID}, map[string]any{"note": "look"})
	if len(forwards) != 2 || forwards[1].Body != "look" || forwards[1].Origin != nil {
		t.Fatalf("forward and note: %+v", forwards)
	}
	copied := forwards[0]
	source := copied.Origin.Source
	if source == nil || source.Name != "secret-plans" || source.Seq != original.Seq || source.ConversationID != group.ID {
		t.Fatalf("alice's source: %+v", source)
	}
	if copied.Origin.SenderID != bob.user.ID {
		t.Fatalf("sender: %+v", copied.Origin)
	}

	seen := chatHistoryFind(t, s, carol, nest.ID, copied.ID)
	if seen.Origin == nil || seen.Origin.SenderName != "bob" || seen.Origin.Source != nil {
		t.Fatalf("carol's origin: %+v", seen.Origin)
	}

	// The events carry the same answer as the history.
	event := nextChatEvent(t, carolStream)
	if event.Message == nil || event.Message.ID != copied.ID || event.Message.Origin == nil || event.Message.Origin.Source != nil {
		t.Fatalf("carol's event: %+v", event.Message)
	}
	raw, _ := json.Marshal(event)
	if strings.Contains(string(raw), "secret-plans") {
		t.Fatalf("group name reached carol: %s", raw)
	}
	event = nextChatEvent(t, aliceStream)
	if event.Message == nil || event.Message.Origin == nil || event.Message.Origin.Source == nil || event.Message.Origin.Source.Name != "secret-plans" {
		t.Fatalf("alice's event: %+v", event.Message)
	}

	// A reaction on the copy publishes it again; carol still gets no source.
	chatDo(t, s, http.MethodPost, carol.token, "/v1/chat/conversations/"+nest.ID+"/messages/"+copied.ID+"/reactions", map[string]any{"emoji": "\U0001F44D", "add": true}, http.StatusOK)
	for {
		event = nextChatEvent(t, carolStream)
		if event.Type == "message.updated" {
			break
		}
	}
	if raw, _ := json.Marshal(event); strings.Contains(string(raw), "secret-plans") {
		t.Fatalf("group name reached carol with a reaction: %s", raw)
	}

	// Nobody can follow a removed source.
	if _, err := s.db.Exec(`UPDATE chat_messages SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = ?`, original.ID); err != nil {
		t.Fatal(err)
	}
	if got := chatHistoryFind(t, s, alice, nest.ID, copied.ID); got.Origin.Source != nil {
		t.Fatalf("source of a removed original: %+v", got.Origin.Source)
	}
}

func TestChatForwardPublicNestSourceIsShownToEveryone(t *testing.T) {
	s, aliceToken := newTestServer(t)
	alice := chatAlice(t, s, aliceToken)
	bob := chatNewPerson(t, s, "bob")
	tree := chatNewTree(t, s, alice, "square")
	nest := chatNewTextNest(t, s, alice.token, tree.id, "plaza", "")
	original := chatSend(t, s, alice.token, nest.ID, "hello all")
	chatBefriend(t, s, alice, bob)
	group := chatNewGroup(t, s, alice, "friends", bob)

	forwards := chatForward(t, s, alice, group.ID, http.StatusCreated, []string{original.ID}, nil)
	if got := chatHistoryFind(t, s, bob, group.ID, forwards[0].ID); got.Origin.Source != nil {
		t.Fatalf("private nest source shown: %+v", got.Origin.Source)
	}
	if _, err := s.db.Exec(`UPDATE trees SET visibility = 'public' WHERE id = ?`, tree.id); err != nil {
		t.Fatal(err)
	}
	got := chatHistoryFind(t, s, bob, group.ID, forwards[0].ID)
	if got.Origin.Source == nil || got.Origin.Source.Name != "plaza" || got.Origin.Source.TreeID != tree.id {
		t.Fatalf("public nest source: %+v", got.Origin.Source)
	}
}

func TestChatForwardHideFlagsAreHonoredAndInherited(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	carol := chatNewPerson(t, s, "carol")
	chatBefriend(t, s, bob, carol)
	original := chatSend(t, s, alice.token, dm.ID, "from alice")
	groupA := chatNewGroup(t, s, bob, "a", alice)
	groupB := chatNewGroup(t, s, bob, "b", alice, carol)

	hidden := chatForward(t, s, bob, groupA.ID, http.StatusCreated, []string{original.ID}, map[string]any{"hideSender": true})[0]
	if hidden.Origin.SenderID != "" || hidden.Origin.SenderName != "" || hidden.Origin.Source == nil {
		t.Fatalf("hide sender: %+v", hidden.Origin)
	}
	// alice forwards it again: she can hide more but cannot bring the sender back.
	again := chatForward(t, s, alice, groupB.ID, http.StatusCreated, []string{hidden.ID}, map[string]any{"hideSource": true})[0]
	if again.Origin.SenderID != "" || again.Origin.Source != nil {
		t.Fatalf("hide flags inherited: %+v", again.Origin)
	}
	if again.Origin.CreatedAt != original.CreatedAt {
		t.Fatalf("first origin kept: %+v", again.Origin)
	}
}

func TestChatForwardNeedsToReadAndToSend(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	carol := chatNewPerson(t, s, "carol")
	store := &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	s.profileMedia = store
	secret := chatSend(t, s, alice.token, dm.ID, "between us")
	dave := chatNewPerson(t, s, "dave")
	chatBefriend(t, s, carol, dave)
	own := chatNewGroup(t, s, carol, "carols", dave)
	chatForward(t, s, carol, own.ID, http.StatusNotFound, []string{secret.ID}, nil)

	// Not in the target at all.
	mine := chatSend(t, s, carol.token, own.ID, "mine")
	chatForward(t, s, carol, dm.ID, http.StatusNotFound, []string{mine.ID}, nil)

	// A destination they cannot send in refuses text and images, and stores nothing.
	group := chatNewGroup(t, s, alice, "room", bob)
	image := attachmentSend(t, s, alice.token, group.ID, []string{attachmentCreate(t, s, alice.token, group.ID, true).ID}, http.StatusCreated)
	if _, err := s.db.Exec(`DELETE FROM friendships`); err != nil {
		t.Fatal(err)
	}
	before := attachmentCount(t, s, "chat_attachments")
	chatForward(t, s, bob, dm.ID, http.StatusForbidden, []string{image.ID}, nil)
	if after := attachmentCount(t, s, "chat_attachments"); after != before {
		t.Fatalf("attachments %d, want %d", after, before)
	}

	// A forward takes one conversation at a time, and at most 50 messages.
	chatForward(t, s, alice, group.ID, http.StatusBadRequest, []string{secret.ID, image.ID}, nil)
	ids := []string{}
	for i := 0; i < 51; i++ {
		ids = append(ids, fmt.Sprintf("id-%d", i))
	}
	chatForward(t, s, alice, group.ID, http.StatusBadRequest, ids, nil)
}

func TestChatForwardOfAForwardGoesWithTheFirstDelete(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	group := chatNewGroup(t, s, bob, "room", alice)
	other := chatNewGroup(t, s, alice, "other", bob)
	original := chatSend(t, s, alice.token, dm.ID, "regret")
	first := chatForward(t, s, bob, group.ID, http.StatusCreated, []string{original.ID}, nil)[0]
	second := chatForward(t, s, alice, other.ID, http.StatusCreated, []string{first.ID}, nil)[0]

	chatDo(t, s, http.MethodDelete, alice.token, "/v1/chat/conversations/"+dm.ID+"/messages/"+original.ID+"?for=everyone", nil, http.StatusOK)
	for _, id := range []string{first.ID, second.ID} {
		if !chatMessageDeleted(t, s, id) {
			t.Fatalf("forward %s survived", id)
		}
	}
}

func TestChatForwardKeepsTheOriginalOrderAndCountsEachMessage(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	group := chatNewGroup(t, s, alice, "room", bob)
	first := chatSend(t, s, alice.token, dm.ID, "one")
	second := chatSend(t, s, bob.token, dm.ID, "two")
	third := chatSend(t, s, alice.token, dm.ID, "three")
	got := chatForward(t, s, alice, group.ID, http.StatusCreated, []string{third.ID, first.ID, second.ID}, nil)
	if len(got) != 3 || got[0].Body != "one" || got[1].Body != "two" || got[2].Body != "three" || got[0].Seq >= got[2].Seq {
		t.Fatalf("order: %+v", got)
	}
	ids := []string{first.ID, second.ID, third.ID}
	for used := 3; used+3 <= chatForwardPerMinute; used += 3 {
		chatForward(t, s, alice, group.ID, http.StatusCreated, ids, nil)
	}
	chatForward(t, s, alice, group.ID, http.StatusTooManyRequests, ids, nil)
}

func TestChatForwardOfASavedNoteShowsNoSource(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	saved := chatOpenSaved(t, s, alice)
	note := chatSend(t, s, alice.token, saved.ID, "a note to self")
	got := chatForward(t, s, alice, dm.ID, http.StatusCreated, []string{note.ID}, nil)[0]
	if got.Origin == nil || got.Origin.SenderID != alice.user.ID || got.Origin.Source != nil {
		t.Fatalf("origin of a forwarded note: %+v", got.Origin)
	}
	if seen := chatHistoryFind(t, s, bob, dm.ID, got.ID); seen.Origin.Source != nil {
		t.Fatalf("bob sees a source: %+v", seen.Origin.Source)
	}
}
