package http

import (
	"net/http"
	"testing"
)

func TestChatNotificationsAreMineAlone(t *testing.T) {
	server, alice, bob, dm := chatPair(t)
	second := chatPerson{user: alice.user, token: loginTestUser(t, server, "alice")}
	own := chatListen(server, second)
	other := chatListen(server, bob)
	outsider := chatNewPerson(t, server, "outsider")
	unrelated := chatListen(server, outsider)
	base := "/v1/chat/conversations/" + dm.ID
	if dm.Notify != "default" {
		t.Fatalf("default: %+v", dm)
	}
	seq := chatLastSeq(t, server, dm.ID)
	for _, mode := range []string{"off", "on", "default"} {
		raw := chatDo(t, server, http.MethodPost, alice.token, base+"/notifications", map[string]string{"mode": mode}, http.StatusOK)
		if got := chatDecode[chatConversationPayload](t, raw).Conversation.Notify; got != mode {
			t.Fatalf("got %q, want %q", got, mode)
		}
		if entry := chatFind(chatList(t, server, second.token), dm.ID); entry == nil || entry.Notify != mode {
			t.Fatalf("list: %+v", entry)
		}
		if event := nextChatEvent(t, own); event.Type != "conversation.changed" || event.ConversationID != dm.ID {
			t.Fatalf("other device: %+v", event)
		}
		noChatEvent(t, other, "peer")
		noChatEvent(t, unrelated, "outsider")
	}
	if got := chatDecode[chatConversationPayload](t, chatDo(t, server, http.MethodGet, bob.token, base, nil, http.StatusOK)).Conversation.Notify; got != "default" {
		t.Fatalf("peer changed: %s", got)
	}
	if chatLastSeq(t, server, dm.ID) != seq {
		t.Fatal("notification settings must not advance seq")
	}
	for _, body := range []any{map[string]string{"mode": "bad"}, map[string]string{}, map[string]string{"mode": ""}, map[string]any{"mode": true}} {
		chatDo(t, server, http.MethodPost, alice.token, base+"/notifications", body, http.StatusBadRequest)
	}
	noChatEvent(t, own, "invalid input")
	missing := chatDo(t, server, http.MethodPost, outsider.token, "/v1/chat/conversations/missing/notifications", map[string]string{"mode": "on"}, http.StatusNotFound)
	hidden := chatDo(t, server, http.MethodPost, outsider.token, base+"/notifications", map[string]string{"mode": "on"}, http.StatusNotFound)
	if string(missing) != string(hidden) {
		t.Fatalf("outsider response differs: %s / %s", missing, hidden)
	}
}
