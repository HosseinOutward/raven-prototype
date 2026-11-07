package http

import (
	"net/http"
	"strings"
	"sync"
	"testing"

	profilemedia "raven/services/api/internal/media"
)

type chatSavePayload struct {
	ConversationID string        `json:"conversationId"`
	Saved          []ChatMessage `json:"saved"`
	AlreadySaved   []ChatMessage `json:"alreadySaved"`
}

func chatSave(t *testing.T, s *Server, person chatPerson, want int, ids ...string) chatSavePayload {
	t.Helper()
	raw := chatDo(t, s, http.MethodPost, person.token, "/v1/chat/saved/messages", map[string]any{"messageIds": ids}, want)
	if want >= 300 {
		return chatSavePayload{}
	}
	return chatDecode[chatSavePayload](t, raw)
}

func chatOpenSaved(t *testing.T, s *Server, person chatPerson) ChatConversation {
	t.Helper()
	status, raw, _, err := chatCall(s, http.MethodPost, person.token, "/v1/chat/saved", nil)
	if err != nil || (status != http.StatusOK && status != http.StatusCreated) {
		t.Fatalf("open saved: %d %s %v", status, raw, err)
	}
	return chatDecode[chatConversationPayload](t, raw).Conversation
}

func chatMessageDeleted(t *testing.T, s *Server, id string) bool {
	t.Helper()
	var deletedAt *string
	if err := s.db.QueryRow(`SELECT deleted_at FROM chat_messages WHERE id = ?`, id).Scan(&deletedAt); err != nil {
		t.Fatal(err)
	}
	return deletedAt != nil
}

func chatFetchVariant(t *testing.T, s *Server, person chatPerson, m ChatMessage, want int) {
	t.Helper()
	a := m.Attachments[0]
	attachmentRaw(t, s, http.MethodGet, person.token, attachmentBase(m.ConversationID)+"/attachments/"+a.ID+"/variants/"+a.Variants[0], nil, want)
}

func TestChatSavedIsOnePerPersonEvenWhenOpenedAtOnce(t *testing.T) {
	s, alice, bob, _ := chatPair(t)
	ids := make(chan string, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, raw, _, err := chatCall(s, http.MethodPost, alice.token, "/v1/chat/saved", nil)
			if err != nil || (status != http.StatusOK && status != http.StatusCreated) {
				t.Errorf("open saved: %d %s %v", status, raw, err)
				return
			}
			var payload chatConversationPayload
			payload = chatDecode[chatConversationPayload](t, raw)
			ids <- payload.Conversation.ID
		}()
	}
	wg.Wait()
	close(ids)
	first := ""
	for id := range ids {
		if first == "" {
			first = id
		}
		if id != first {
			t.Fatalf("two Saved messages: %s and %s", first, id)
		}
	}
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM chat_conversations WHERE kind = 'saved'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("saved conversations = %d, %v", count, err)
	}
	saved := chatFind(chatList(t, s, alice.token), first)
	if saved == nil || saved.Kind != chatKindSaved || saved.Name != "Saved messages" || !saved.CanSend || saved.CanManage || saved.MemberCount != 1 {
		t.Fatalf("summary: %+v", saved)
	}
	if chatFind(chatList(t, s, bob.token), first) != nil {
		t.Fatal("someone else sees it")
	}
	chatDo(t, s, http.MethodGet, bob.token, "/v1/chat/conversations/"+first+"/messages", nil, http.StatusNotFound)
	chatDo(t, s, http.MethodPost, alice.token, "/v1/chat/conversations/"+first+"/members", map[string]any{"userIds": []string{bob.user.ID}}, http.StatusBadRequest)
}

func TestChatSavedNotesHaveNoEditWindowAndNoReadStatus(t *testing.T) {
	s, alice, _, _ := chatPair(t)
	saved := chatOpenSaved(t, s, alice)
	note := chatSend(t, s, alice.token, saved.ID, "remember the milk")
	if _, err := s.db.Exec(`UPDATE chat_messages SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?`, note.ID); err != nil {
		t.Fatal(err)
	}
	chatDo(t, s, http.MethodPost, alice.token, "/v1/chat/conversations/"+saved.ID+"/messages/"+note.ID+"/edit", map[string]string{"body": "remember the bread"}, http.StatusOK)
	category, err := chatReadCategory(s.db, chatAccess{Kind: chatKindSaved})
	if err != nil {
		t.Fatal(err)
	}
	if on, err := chatReadSwitchOn(s.db, category, alice.user.ID); err != nil || on {
		t.Fatalf("read status in saved: %v %v", on, err)
	}
	if got := chatFind(chatList(t, s, alice.token), saved.ID); got.UnreadCount != 0 {
		t.Fatalf("unread %d", got.UnreadCount)
	}
}

func TestChatSavingNeedsToReadTheMessage(t *testing.T) {
	s, alice, bob, _ := chatPair(t)
	carol := chatNewPerson(t, s, "carol")
	chatBefriend(t, s, alice, carol)
	group := chatNewGroup(t, s, alice, "Study group", bob)
	message := chatSend(t, s, bob.token, group.ID, "only for the group")

	chatSave(t, s, carol, http.StatusNotFound, message.ID)
	chatSave(t, s, carol, http.StatusNotFound, "no-such-message")
	chatSave(t, s, alice, http.StatusBadRequest)

	hidden := chatSend(t, s, bob.token, group.ID, "hidden by alice")
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/chat/conversations/"+group.ID+"/messages/"+hidden.ID+"?for=me", nil, http.StatusOK)
	chatSave(t, s, alice, http.StatusNotFound, hidden.ID)

	var system string
	if err := s.db.QueryRow(`SELECT id FROM chat_messages WHERE conversation_id = ? AND kind = 'system' LIMIT 1`, group.ID).Scan(&system); err != nil {
		t.Fatal(err)
	}
	chatSave(t, s, alice, http.StatusNotFound, system)
	var copies int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM chat_messages WHERE origin_message_id IS NOT NULL`).Scan(&copies); err != nil || copies != 0 {
		t.Fatalf("copies after refusals: %d %v", copies, err)
	}
}

func TestChatSavingTwiceKeepsOneCopyThatOutlivesTheGroup(t *testing.T) {
	s, alice, bob, _ := chatPair(t)
	store := &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	s.profileMedia = store
	carol := chatNewPerson(t, s, "carol")
	chatBefriend(t, s, bob, carol)
	group := chatNewGroup(t, s, bob, "Study group", alice, carol)
	text := chatSend(t, s, bob.token, group.ID, "ask <@u:"+carol.user.ID+"> about it")
	image := attachmentSend(t, s, bob.token, group.ID, []string{attachmentCreate(t, s, bob.token, group.ID, true).ID}, http.StatusCreated)

	first := chatSave(t, s, alice, http.StatusCreated, image.ID, text.ID)
	if len(first.Saved) != 2 || len(first.AlreadySaved) != 0 {
		t.Fatalf("first save: %+v", first)
	}
	// In the order they were written.
	copyText, copyImage := first.Saved[0], first.Saved[1]
	if copyText.Body != "ask @carol about it" || copyText.SenderID != alice.user.ID {
		t.Fatalf("text copy: %+v", copyText)
	}
	origin := copyText.Origin
	if origin == nil || origin.SenderID != bob.user.ID || origin.SenderName != "bob" || origin.CreatedAt != text.CreatedAt ||
		origin.Source == nil || origin.Source.ConversationID != group.ID || origin.Source.Kind != chatKindGroup ||
		origin.Source.Name != "Study group" || origin.Source.Seq != text.Seq {
		t.Fatalf("origin: %+v %+v", origin, origin.Source)
	}
	if len(copyImage.Attachments) != 1 || copyImage.Attachments[0].ID == image.Attachments[0].ID {
		t.Fatalf("image copy attachments: %+v", copyImage.Attachments)
	}
	objects := len(store.objects)

	again := chatSave(t, s, alice, http.StatusOK, text.ID)
	if len(again.Saved) != 0 || len(again.AlreadySaved) != 1 || again.AlreadySaved[0].ID != copyText.ID {
		t.Fatalf("second save: %+v", again)
	}
	if len(store.objects) != objects {
		t.Fatal("saving copied bytes")
	}

	// Leaving the group keeps the copy, but no longer names the source.
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/chat/conversations/"+group.ID+"/members/"+alice.user.ID, nil, http.StatusNoContent)
	page := chatHistory(t, s, alice.token, first.ConversationID, "")
	if len(page.Messages) != 2 || page.Messages[0].Origin == nil || page.Messages[0].Origin.Source != nil || page.Messages[0].Origin.SenderName != "bob" {
		t.Fatalf("after leaving: %+v", page.Messages)
	}
	chatFetchVariant(t, s, alice, copyImage, http.StatusOK)

	// The group is deleted: its objects are queued, but the copy still holds them.
	chatDo(t, s, http.MethodDelete, bob.token, "/v1/chat/conversations/"+group.ID, nil, http.StatusNoContent)
	if err := s.drainChatObjectPurges(); err != nil {
		t.Fatal(err)
	}
	if len(store.objects) != objects || attachmentCount(t, s, "chat_object_purges") != 0 {
		t.Fatalf("objects %d -> %d", objects, len(store.objects))
	}
	chatFetchVariant(t, s, alice, copyImage, http.StatusOK)

	// Deleting the last copy lets the objects go.
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/chat/conversations/"+first.ConversationID+"/messages/"+copyImage.ID+"?for=everyone", nil, http.StatusOK)
	if err := s.drainChatObjectPurges(); err != nil {
		t.Fatal(err)
	}
	if len(store.objects) != objects-2 {
		t.Fatalf("objects after last copy went: %d, want %d", len(store.objects), objects-2)
	}
}

func TestChatDeleteForEveryoneTakesTheCopiesAndOnlyUnusedObjects(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	store := &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	s.profileMedia = store
	image := attachmentSend(t, s, bob.token, dm.ID, []string{attachmentCreate(t, s, bob.token, dm.ID, true).ID}, http.StatusCreated)
	other := attachmentSend(t, s, bob.token, dm.ID, []string{attachmentCreate(t, s, bob.token, dm.ID, true).ID}, http.StatusCreated)
	aliceCopies := chatSave(t, s, alice, http.StatusCreated, image.ID, other.ID).Saved
	bobCopy := chatSave(t, s, bob, http.StatusCreated, image.ID).Saved[0]
	if aliceCopies[0].Origin.Source == nil || aliceCopies[0].Origin.Source.Kind != chatKindDM ||
		aliceCopies[0].Origin.Source.Name != "bob" || aliceCopies[0].Origin.Source.PeerID != bob.user.ID {
		t.Fatalf("dm source as alice sees it: %+v", aliceCopies[0].Origin.Source)
	}
	if bobCopy.Origin.Source == nil || bobCopy.Origin.Source.Name != "alice" {
		t.Fatalf("dm source as bob sees it: %+v", bobCopy.Origin.Source)
	}

	// Alice deletes her copy of other: the original still holds its objects.
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/chat/conversations/"+aliceCopies[1].ConversationID+"/messages/"+aliceCopies[1].ID+"?for=everyone", nil, http.StatusOK)
	if err := s.drainChatObjectPurges(); err != nil {
		t.Fatal(err)
	}
	if len(store.objects) != 4 {
		t.Fatalf("objects = %d, want 4", len(store.objects))
	}
	chatFetchVariant(t, s, bob, other, http.StatusOK)

	aliceStream := chatListen(s, alice)
	chatDo(t, s, http.MethodDelete, bob.token, "/v1/chat/conversations/"+dm.ID+"/messages/"+image.ID+"?for=everyone", nil, http.StatusOK)
	for _, id := range []string{aliceCopies[0].ID, bobCopy.ID} {
		if !chatMessageDeleted(t, s, id) {
			t.Fatalf("copy %s survived", id)
		}
	}
	gotCopyEvent := false
	for i := 0; i < 2; i++ {
		event := nextChatEvent(t, aliceStream)
		if event.Message != nil && event.Message.ID == aliceCopies[0].ID && event.Message.DeletedAt != nil {
			gotCopyEvent = true
		}
	}
	if !gotCopyEvent {
		t.Fatal("alice was not told her copy went")
	}
	if err := s.drainChatObjectPurges(); err != nil {
		t.Fatal(err)
	}
	if len(store.objects) != 2 {
		t.Fatalf("objects = %d, want 2", len(store.objects))
	}
	chatFetchVariant(t, s, bob, other, http.StatusOK)
}

func TestChatErasingAnAccountTakesCopiesOfItsMessagesAndKeepingDoesNot(t *testing.T) {
	for _, choice := range []string{"erase", "keep"} {
		t.Run(choice, func(t *testing.T) {
			s, alice, bob, dm := chatPair(t)
			s.profileMedia = &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
			message := chatSend(t, s, bob.token, dm.ID, "bob's words")
			copied := chatSave(t, s, alice, http.StatusCreated, message.ID).Saved[0]
			note := chatSend(t, s, alice.token, copied.ConversationID, "alice's own note")
			bobSaved := chatSave(t, s, bob, http.StatusCreated, message.ID).Saved[0]

			chatDo(t, s, http.MethodPost, bob.token, "/v1/account/delete", deleteAccountBody(bob.user, choice), http.StatusNoContent)

			if got := chatMessageDeleted(t, s, copied.ID); got != (choice == "erase") {
				t.Fatalf("%s: copy deleted = %v", choice, got)
			}
			if chatMessageDeleted(t, s, note.ID) {
				t.Fatal("alice's own note went")
			}
			var left int
			if err := s.db.QueryRow(`SELECT COUNT(*) FROM chat_messages WHERE id = ?`, bobSaved.ID).Scan(&left); err != nil || left != 0 {
				t.Fatalf("bob's Saved messages outlived the account: %d %v", left, err)
			}
		})
	}
}

func TestChatCopiesCannotBeEditedAndExportHoldsSaved(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	message := chatSend(t, s, bob.token, dm.ID, "keep this")
	copied := chatSave(t, s, alice, http.StatusCreated, message.ID).Saved[0]
	chatDo(t, s, http.MethodPost, alice.token, "/v1/chat/conversations/"+copied.ConversationID+"/messages/"+copied.ID+"/edit", map[string]string{"body": "changed"}, http.StatusConflict)

	summary := chatFind(chatList(t, s, alice.token), copied.ConversationID)
	if exportTitle(*summary) != "Saved messages" {
		t.Fatalf("export title %q", exportTitle(*summary))
	}
	if line := exportTranscriptLine(copied); !strings.Contains(line, "(from bob): keep this") {
		t.Fatalf("export line %q", line)
	}
}
