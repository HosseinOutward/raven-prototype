package http

import (
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func chatReact(t *testing.T, s *Server, person chatPerson, conversationID, messageID, emoji string, add bool, want int) ChatMessage {
	t.Helper()
	raw := chatDo(t, s, http.MethodPost, person.token, "/v1/chat/conversations/"+conversationID+"/messages/"+messageID+"/reactions", map[string]any{"emoji": emoji, "add": add}, want)
	if want != 200 {
		return ChatMessage{}
	}
	return chatDecode[chatMessagePayload](t, raw).Message
}

func TestValidChatReaction(t *testing.T) {
	for _, s := range []string{"👍", "❤️", "👍🏽", "👨‍👩‍👧", "🧑🏻‍❤️‍💋‍🧑🏼", "🇮🇷", "🏳️‍🌈", "1️⃣", "🏴\U000e0067\U000e0062\U000e0073\U000e0063\U000e0074\U000e007f", "#️⃣", "*️⃣", "©️", "®️", "™️"} {
		if !validChatReaction(s) {
			t.Errorf("rejected %q", s)
		}
	}
	for _, s := range []string{"", "a", "👍 ", "👍a", "<b>", strings.Repeat("👍", 17), "\u200d", "1", "👍1️⃣", "\xff", strings.Repeat("❤️", 12)} {
		if validChatReaction(s) {
			t.Errorf("accepted %q", s)
		}
	}
}

func TestChatReactionsSyncAndNoops(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	message := chatSend(t, s, alice.token, dm.ID, "hello")
	other := chatNewGroup(t, s, alice, "Later", bob)
	before := chatList(t, s, bob.token)
	stream := chatListen(s, bob)
	own := chatListen(s, alice)
	want := []ChatReaction{{Emoji: "👍", Count: 1, UserIDs: []string{alice.user.ID}}}
	got := chatReact(t, s, alice, dm.ID, message.ID, "👍", true, 200)
	if !reflect.DeepEqual(got.Reactions, want) || got.ChangedSeq != message.Seq+1 || got.Seq != message.Seq || got.EditedAt != nil {
		t.Fatalf("reaction response: %+v", got)
	}
	for _, client := range []*streamClient{stream, own} {
		event := nextChatEvent(t, client)
		if event.Type != "message.updated" || event.Seq != got.ChangedSeq || event.Message == nil || !reflect.DeepEqual(event.Message.Reactions, want) {
			t.Fatalf("event: %+v", event)
		}
	}
	if !reflect.DeepEqual(chatHistory(t, s, bob.token, dm.ID, "").Messages[0].Reactions, want) || !reflect.DeepEqual(chatChanges(t, s, bob.token, dm.ID, message.Seq).Messages[0].Reactions, want) {
		t.Fatal("missing reactions in sync")
	}
	after := chatList(t, s, bob.token)
	if len(before) != 2 || before[0].ID != other.ID || after[0].ID != before[0].ID {
		t.Fatal("reaction reordered conversations")
	}
	b, a := chatFind(before, dm.ID), chatFind(after, dm.ID)
	if a.LastActivityMs != b.LastActivityMs || a.UnreadCount != b.UnreadCount || a.LastMessage.Seq != b.LastMessage.Seq || a.LastSeq != b.LastSeq+1 {
		t.Fatalf("activity changed: before=%+v after=%+v", b, a)
	}
	chatReact(t, s, alice, dm.ID, message.ID, "👍", true, 200)
	chatReact(t, s, bob, dm.ID, message.ID, "❤️", false, 200)
	if chatLastSeq(t, s, dm.ID) != got.ChangedSeq {
		t.Fatal("noop consumed sequence")
	}
	noChatEvent(t, stream, "bob")
	noChatEvent(t, own, "alice")
	removed := chatReact(t, s, alice, dm.ID, message.ID, "👍", false, 200)
	if len(removed.Reactions) != 0 || removed.ChangedSeq != got.ChangedSeq+1 {
		t.Fatal("remove failed")
	}
	if event := nextChatEvent(t, stream); event.Type != "message.updated" || len(event.Message.Reactions) != 0 {
		t.Fatalf("remove event: %+v", event)
	}
}

func TestChatReactionsReplaceOldestAndKeepOrder(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	m := chatSend(t, s, alice.token, dm.ID, "hello")
	chatReact(t, s, alice, dm.ID, m.ID, "👍", true, 200)
	chatReact(t, s, bob, dm.ID, m.ID, "👍", true, 200)
	chatReact(t, s, alice, dm.ID, m.ID, "❤️", true, 200)
	chatReact(t, s, alice, dm.ID, m.ID, "😂", true, 200)
	got := chatReact(t, s, alice, dm.ID, m.ID, "🙏", true, 200)
	want := []ChatReaction{{"👍", 1, []string{bob.user.ID}}, {"❤️", 1, []string{alice.user.ID}}, {"😂", 1, []string{alice.user.ID}}, {"🙏", 1, []string{alice.user.ID}}}
	if !reflect.DeepEqual(got.Reactions, want) {
		t.Fatalf("got %+v want %+v", got.Reactions, want)
	}
	got = chatReact(t, s, alice, dm.ID, m.ID, "👍", true, 200)
	if !reflect.DeepEqual(got.Reactions[0].UserIDs, []string{bob.user.ID, alice.user.ID}) || got.Reactions[0].Count != 2 {
		t.Fatalf("user order: %+v", got.Reactions)
	}
}

func TestChatReactionKindLimitRollsBackReplacement(t *testing.T) {
	s, alice, _, dm := chatPair(t)
	m := chatSend(t, s, alice.token, dm.ID, "hello")
	// Seed a full message; Alice's oldest is shared, so replacing it cannot free a kind.
	for i := 0; i < 20; i++ {
		if _, err := s.db.Exec(`INSERT INTO chat_reactions VALUES (?, ?, ?, ?, ?)`, m.ID, dm.ID, fmt.Sprintf("person-%d", i), string(rune(0x1f600+i)), fmt.Sprintf("2026-01-01T00:00:%02dZ", i)); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 3; i++ {
		chatReact(t, s, alice, dm.ID, m.ID, string(rune(0x1f600+i)), true, 200)
	}
	before := chatLastSeq(t, s, dm.ID)
	stream := chatListen(s, alice)
	chatReact(t, s, alice, dm.ID, m.ID, "🙏", true, 422)
	if chatLastSeq(t, s, dm.ID) != before {
		t.Fatal("refusal consumed sequence")
	}
	noChatEvent(t, stream, "alice")
	got := chatHistory(t, s, alice.token, dm.ID, "").Messages[0]
	if len(got.Reactions) != 20 || got.Reactions[0].Count != 2 {
		t.Fatalf("replacement did not roll back: %+v", got.Reactions)
	}
}

func TestChatReactionRefusals(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	m := chatSend(t, s, alice.token, dm.ID, "hello")
	stranger := chatNewPerson(t, s, "stranger")
	chatReact(t, s, stranger, dm.ID, m.ID, "👍", true, 404)
	chatReact(t, s, alice, dm.ID, "missing", "👍", true, 404)
	chatReact(t, s, alice, dm.ID, m.ID, "a", true, 400)
	group := chatNewGroup(t, s, alice, "Group", bob)
	chatReact(t, s, alice, group.ID, m.ID, "👍", true, 404)
	system := chatHistory(t, s, alice.token, group.ID, "").Messages[0]
	chatReact(t, s, alice, group.ID, system.ID, "👍", true, 409)
	base := "/v1/chat/conversations/" + dm.ID
	chatDo(t, s, http.MethodDelete, bob.token, base+"/messages/"+m.ID+"?for=me", nil, 200)
	chatReact(t, s, bob, dm.ID, m.ID, "👍", true, 404)
	chatDo(t, s, http.MethodPost, alice.token, base+"/clear", nil, 204)
	chatReact(t, s, alice, dm.ID, m.ID, "👍", true, 404)
	gm := chatSend(t, s, alice.token, group.ID, "group message")
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/chat/conversations/"+group.ID+"/members/"+bob.user.ID, nil, 204)
	chatReact(t, s, bob, group.ID, gm.ID, "👍", true, 404)
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/chat/conversations/"+group.ID+"/messages/"+gm.ID+"?for=everyone", nil, 200)
	chatReact(t, s, alice, group.ID, gm.ID, "👍", true, 409)
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/friends/"+bob.user.ID, nil, 204)
	chatReact(t, s, bob, dm.ID, m.ID, "👍", true, 403)
}

func TestChatReactionCleanup(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	m := chatSend(t, s, alice.token, dm.ID, "hello")
	chatReact(t, s, alice, dm.ID, m.ID, "👍", true, 200)
	base := "/v1/chat/conversations/" + dm.ID
	chatDo(t, s, http.MethodDelete, bob.token, base+"/messages/"+m.ID+"?for=me", nil, 200)
	chatDo(t, s, http.MethodPost, bob.token, base+"/clear", nil, 204)
	count := func(want int) {
		t.Helper()
		var got int
		if err := s.db.QueryRow(`SELECT COUNT(*) FROM chat_reactions`).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("reaction rows: %d want %d", got, want)
		}
	}
	count(1)
	raw := chatDo(t, s, http.MethodDelete, alice.token, base+"/messages/"+m.ID+"?for=everyone", nil, 200)
	if len(chatDecode[chatMessagePayload](t, raw).Message.Reactions) != 0 {
		t.Fatal("deleted message carries reactions")
	}
	count(0)
	group := chatNewGroup(t, s, alice, "Group", bob)
	gm := chatSend(t, s, alice.token, group.ID, "hello")
	chatReact(t, s, alice, group.ID, gm.ID, "👍", true, 200)
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/chat/conversations/"+group.ID, nil, 204)
	count(0)
}

func TestChatReactionsRespectAudienceAndHydrateSingleResponses(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	parent := chatSend(t, s, alice.token, dm.ID, "parent")
	m := chatDecode[chatMessagePayload](t, chatReply(t, s, alice.token, dm.ID, "reply", parent.ID, 201)).Message
	chatReact(t, s, alice, dm.ID, m.ID, "👍", true, 200)
	base := "/v1/chat/conversations/" + dm.ID
	edited := chatDecode[chatMessagePayload](t, chatDo(t, s, http.MethodPost, alice.token, base+"/messages/"+m.ID+"/edit", map[string]string{"body": "edited"}, 200)).Message
	if len(edited.Reactions) != 1 {
		t.Fatal("edit lost reactions")
	}
	duplicate := chatDecode[chatMessagePayload](t, chatDo(t, s, http.MethodPost, alice.token, base+"/messages", map[string]string{"clientMessageId": m.ClientMessageID, "body": "retry"}, 200)).Message
	if !reflect.DeepEqual(duplicate.Reactions, edited.Reactions) {
		t.Fatal("duplicate send lost reactions")
	}
	chatDo(t, s, http.MethodDelete, bob.token, base+"/messages/"+m.ID+"?for=me", nil, 200)
	stream := chatListen(s, bob)
	chatReact(t, s, alice, dm.ID, m.ID, "❤️", true, 200)
	event := nextChatEvent(t, stream)
	if event.Type != "conversation.bump" || event.Message != nil {
		t.Fatalf("hidden message leaked: %+v", event)
	}
}

func TestChatReactionsTreeCleanup(t *testing.T) {
	s, alice, bob, _ := chatPair(t)
	tree := chatNewTree(t, s, alice, "Tree", bob)
	nest := chatNewTextNest(t, s, alice.token, tree.id, "general", "")
	m := chatSend(t, s, alice.token, nest.ID, "hello")
	chatReact(t, s, bob, nest.ID, m.ID, "👍", true, 200)
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/trees/"+tree.id, map[string]string{"confirmation": "Tree"}, 204)
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM chat_reactions WHERE conversation_id = ?`, nest.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("tree deletion left reactions")
	}
}
