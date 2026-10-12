package http

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"raven/services/api/internal/auth"
)

func chatSystemEvent(t *testing.T, message ChatMessage) string {
	t.Helper()
	var payload struct {
		Event string `json:"event"`
	}
	if err := json.Unmarshal(message.System, &payload); err != nil {
		t.Fatalf("system message %s: %v", message.System, err)
	}
	return payload.Event
}

func chatMemberIDs(members []ChatMember) []string {
	ids := []string{}
	for _, member := range members {
		ids = append(ids, member.ID)
	}
	return ids
}

func chatGroupMembers(t *testing.T, server *Server, token, conversationID string) []ChatMember {
	t.Helper()
	return chatDecode[chatConversationPayload](t, chatDo(t, server, http.MethodGet, token, "/v1/chat/conversations/"+conversationID, nil, http.StatusOK)).Members
}

// chatCrowd is Alice with three friends. Bob and Carol are not friends with Dave.
func chatCrowd(t *testing.T) (*Server, chatPerson, chatPerson, chatPerson, chatPerson) {
	t.Helper()
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	bob := chatNewPerson(t, server, "bob")
	carol := chatNewPerson(t, server, "carol")
	dave := chatNewPerson(t, server, "dave")
	chatBefriend(t, server, alice, bob)
	chatBefriend(t, server, alice, carol)
	chatBefriend(t, server, alice, dave)
	chatBefriend(t, server, bob, carol)
	return server, alice, bob, carol, dave
}

func TestChatGroupIsCreatedWithFriendsOnly(t *testing.T) {
	server, alice, bob, carol, dave := chatCrowd(t)
	stranger := chatNewPerson(t, server, "stranger")

	chatDo(t, server, http.MethodPost, alice.token, "/v1/chat/groups", map[string]any{"name": "Trip", "memberIds": []string{bob.user.ID, stranger.user.ID}}, http.StatusForbidden)
	chatDo(t, server, http.MethodPost, alice.token, "/v1/chat/groups", map[string]any{"name": "  ", "memberIds": []string{bob.user.ID}}, http.StatusBadRequest)
	chatDo(t, server, http.MethodPost, alice.token, "/v1/chat/groups", map[string]any{"name": "Alone", "memberIds": []string{}}, http.StatusBadRequest)
	if len(chatList(t, server, bob.token)) != 0 {
		t.Fatal("a refused group must leave nothing behind")
	}

	bobStream := chatListen(server, bob)
	raw := chatDo(t, server, http.MethodPost, alice.token, "/v1/chat/groups", map[string]any{"name": "  Weekend   crew ", "memberIds": []string{bob.user.ID, carol.user.ID, bob.user.ID}}, http.StatusCreated)
	created := chatDecode[chatConversationPayload](t, raw)
	group := created.Conversation
	if group.Kind != chatKindGroup || group.Name != "Weekend crew" || group.Role != "owner" || !group.CanManage || group.MemberCount != 3 {
		t.Fatalf("unexpected group: %+v", group)
	}
	if len(created.Members) != 3 || created.Members[0].ID != alice.user.ID || created.Members[0].Role != "owner" {
		t.Fatalf("the owner is listed first: %+v", created.Members)
	}

	// Members learn of it through its first line, for a conversation they did not have.
	event := nextChatEvent(t, bobStream)
	if event.Type != "message.created" || event.ConversationID != group.ID || event.Seq != 1 || event.Message == nil || chatSystemEvent(t, *event.Message) != "group_created" {
		t.Fatalf("a new member saw %+v", event)
	}
	entry := chatFind(chatList(t, server, bob.token), group.ID)
	if entry == nil || entry.Role != "member" || entry.CanManage || entry.UnreadCount != 0 {
		t.Fatalf("a member's view of the group: %+v", entry)
	}
	if chatFind(chatList(t, server, dave.token), group.ID) != nil {
		t.Fatal("someone who was not added must not see the group")
	}
}

func TestChatGroupNewMembersSeeOnlyWhatComesAfterTheyJoin(t *testing.T) {
	server, alice, bob, carol, dave := chatCrowd(t)
	group := chatNewGroup(t, server, alice, "Plans", bob)
	secret := chatSend(t, server, alice.token, group.ID, "before carol arrived")
	base := "/v1/chat/conversations/" + group.ID

	// Bob can add his own friend, but not someone only Alice knows.
	chatDo(t, server, http.MethodPost, bob.token, base+"/members", map[string][]string{"userIds": {dave.user.ID}}, http.StatusForbidden)
	if seq := chatLastSeq(t, server, group.ID); seq != 2 {
		t.Fatalf("a refused add must not use a sequence number, last_seq=%d", seq)
	}
	carolStream := chatListen(server, carol)
	chatDo(t, server, http.MethodPost, bob.token, base+"/members", map[string][]string{"userIds": {carol.user.ID}}, http.StatusOK)

	added := nextChatEvent(t, carolStream)
	if added.Type != "message.created" || added.Seq != 3 || added.Message == nil || chatSystemEvent(t, *added.Message) != "members_added" {
		t.Fatalf("the person added saw %+v", added)
	}
	entry := chatFind(chatList(t, server, carol.token), group.ID)
	if entry == nil || entry.VisibleFromSeq != 3 || entry.UnreadCount != 0 || entry.MemberCount != 3 {
		t.Fatalf("the new member's view: %+v", entry)
	}

	// Nothing from before reaches her: not history, not catch-up, not a later edit.
	history := chatHistory(t, server, carol.token, group.ID, "")
	if len(history.Messages) != 1 || history.Messages[0].Seq != 3 {
		t.Fatalf("history must start where she joined: %+v", history.Messages)
	}
	if changes := chatChanges(t, server, carol.token, group.ID, 0); len(changes.Messages) != 1 || changes.AsOfSeq != 3 {
		t.Fatalf("catch-up must start where she joined: %+v", changes.Messages)
	}
	chatDo(t, server, http.MethodPost, alice.token, base+"/messages/"+secret.ID+"/edit", map[string]string{"body": "edited: still before carol"}, http.StatusOK)
	frame := <-carolStream.frames
	if strings.Contains(string(frame.data), "before carol") {
		t.Fatalf("an edit to an earlier message leaked its text: %s", frame.data)
	}
	var bump ChatEvent
	if err := json.Unmarshal(frame.data, &bump); err != nil {
		t.Fatal(err)
	}
	if bump.Type != "conversation.bump" || bump.Seq != 4 || bump.Message != nil {
		t.Fatalf("she should only learn that something changed: %+v", bump)
	}
	chatReply(t, server, carol.token, group.ID, "replying to the past", secret.ID, http.StatusBadRequest)
	chatDo(t, server, http.MethodDelete, carol.token, base+"/messages/"+secret.ID+"?for=me", nil, http.StatusNotFound)

	// What comes after is hers like anyone's. A reply to the earlier message reaches her
	// without the quoted line.
	chatReply(t, server, alice.token, group.ID, "as I said", secret.ID, http.StatusCreated)
	reply := nextChatEvent(t, carolStream)
	if reply.Type != "message.created" || reply.Message == nil || reply.Message.Body != "as I said" || reply.Message.ReplyTo == nil || !reply.Message.ReplyTo.Unavailable {
		t.Fatalf("a reply to something from before she joined: %+v", reply.Message)
	}

	// Adding someone who is already here changes nothing.
	chatDo(t, server, http.MethodPost, alice.token, base+"/members", map[string][]string{"userIds": {carol.user.ID}}, http.StatusOK)
	if seq := chatLastSeq(t, server, group.ID); seq != 5 {
		t.Fatalf("adding a current member must not use a sequence number, last_seq=%d", seq)
	}
}

func TestChatGroupRemovalAndLeavingEndAccessAtOnce(t *testing.T) {
	server, alice, bob, carol, _ := chatCrowd(t)
	group := chatNewGroup(t, server, alice, "Crew", bob, carol)
	chatSend(t, server, alice.token, group.ID, "everyone is here")
	base := "/v1/chat/conversations/" + group.ID
	bobStream := chatListen(server, bob)
	carolStream := chatListen(server, carol)

	// Only the owner removes people.
	chatDo(t, server, http.MethodDelete, bob.token, base+"/members/"+carol.user.ID, nil, http.StatusForbidden)
	chatDo(t, server, http.MethodDelete, alice.token, base+"/members/"+bob.user.ID, nil, http.StatusNoContent)

	if event := nextChatEvent(t, bobStream); event.Type != "conversation.removed" || event.ConversationID != group.ID {
		t.Fatalf("the person removed should be told it is gone: %+v", event)
	}
	if event := nextChatEvent(t, carolStream); event.Type != "message.created" || chatSystemEvent(t, *event.Message) != "member_removed" {
		t.Fatalf("those who remain see who left: %+v", event)
	}

	chatSend(t, server, alice.token, group.ID, "said after bob was removed")
	noChatEvent(t, bobStream, "someone removed from the group")
	for _, path := range []string{base, base + "/messages", base + "/changes?after=0"} {
		chatDo(t, server, http.MethodGet, bob.token, path, nil, http.StatusNotFound)
	}
	chatDo(t, server, http.MethodPost, bob.token, base+"/messages", map[string]string{"clientMessageId": "c-" + auth.NewID(), "body": "still here?"}, http.StatusNotFound)
	if chatFind(chatList(t, server, bob.token), group.ID) != nil {
		t.Fatal("a group you were removed from leaves your list")
	}
	chatDo(t, server, http.MethodDelete, alice.token, base+"/members/"+bob.user.ID, nil, http.StatusNotFound)

	// Coming back starts afresh: nothing from the time away, nor from before.
	chatDo(t, server, http.MethodPost, alice.token, base+"/members", map[string][]string{"userIds": {bob.user.ID}}, http.StatusOK)
	back := chatHistory(t, server, bob.token, group.ID, "")
	if len(back.Messages) != 1 || chatSystemEvent(t, back.Messages[0]) != "members_added" {
		t.Fatalf("history after rejoining: %+v", back.Messages)
	}

	// Leaving is anyone's right, and the group always keeps an owner.
	chatDo(t, server, http.MethodDelete, alice.token, base+"/members/"+alice.user.ID, nil, http.StatusNoContent)
	members := chatGroupMembers(t, server, carol.token, group.ID)
	if len(members) != 2 || members[0].ID != carol.user.ID || members[0].Role != "owner" {
		t.Fatalf("the longest-standing member becomes owner: %+v", members)
	}
	chatDo(t, server, http.MethodGet, alice.token, base+"/messages", nil, http.StatusNotFound)

	// When the last person leaves, the group and its messages are gone.
	chatDo(t, server, http.MethodDelete, bob.token, base+"/members/"+bob.user.ID, nil, http.StatusNoContent)
	chatDo(t, server, http.MethodDelete, carol.token, base+"/members/"+carol.user.ID, nil, http.StatusNoContent)
	var remaining int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM chat_messages WHERE conversation_id = ?`, group.ID).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("an empty group's messages should be deleted, %d left", remaining)
	}
}

func TestChatGroupOwnerRenamesModeratesAndDeletes(t *testing.T) {
	server, alice, bob, carol, _ := chatCrowd(t)
	group := chatNewGroup(t, server, alice, "Draft name", bob, carol)
	fromBob := chatSend(t, server, bob.token, group.ID, "something out of line")
	base := "/v1/chat/conversations/" + group.ID

	chatDo(t, server, http.MethodPost, bob.token, base+"/settings", map[string]string{"name": "Bob's group"}, http.StatusForbidden)
	renamed := chatDecode[chatConversationPayload](t, chatDo(t, server, http.MethodPost, alice.token, base+"/settings", map[string]string{"name": "Final name"}, http.StatusOK))
	if renamed.Conversation.Name != "Final name" {
		t.Fatalf("unexpected name: %q", renamed.Conversation.Name)
	}
	chatDo(t, server, http.MethodPost, alice.token, base+"/settings", map[string]string{"name": "Final name"}, http.StatusOK)
	if seq := chatLastSeq(t, server, group.ID); seq != 3 {
		t.Fatalf("renaming to the same name must not use a sequence number, last_seq=%d", seq)
	}

	// The owner may delete anyone's message; a member may not delete someone else's.
	chatDo(t, server, http.MethodDelete, carol.token, base+"/messages/"+fromBob.ID+"?for=everyone", nil, http.StatusForbidden)
	chatDo(t, server, http.MethodDelete, alice.token, base+"/messages/"+fromBob.ID+"?for=everyone", nil, http.StatusOK)
	// A system line cannot be deleted by anyone.
	first := chatHistory(t, server, alice.token, group.ID, "").Messages[0]
	chatDo(t, server, http.MethodDelete, alice.token, base+"/messages/"+first.ID+"?for=everyone", nil, http.StatusForbidden)

	bobStream := chatListen(server, bob)
	chatDo(t, server, http.MethodDelete, bob.token, base, nil, http.StatusForbidden)
	chatDo(t, server, http.MethodDelete, alice.token, base, nil, http.StatusNoContent)
	if event := nextChatEvent(t, bobStream); event.Type != "conversation.removed" || event.ConversationID != group.ID {
		t.Fatalf("members should be told the group is gone: %+v", event)
	}
	chatDo(t, server, http.MethodGet, alice.token, base, nil, http.StatusNotFound)
	chatDo(t, server, http.MethodPost, alice.token, base+"/messages", map[string]string{"clientMessageId": "c-" + auth.NewID(), "body": "anyone?"}, http.StatusNotFound)
	if len(chatList(t, server, carol.token)) != 0 {
		t.Fatal("a deleted group leaves everyone's list")
	}

	// A direct message cannot be deleted for the other person.
	dm := chatOpenDM(t, server, alice, bob)
	chatDo(t, server, http.MethodDelete, alice.token, "/v1/chat/conversations/"+dm.ID, nil, http.StatusForbidden)
	chatDo(t, server, http.MethodPost, alice.token, "/v1/chat/conversations/"+dm.ID+"/members", map[string][]string{"userIds": {carol.user.ID}}, http.StatusBadRequest)
}

func TestChatGroupHasASizeLimit(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	friends := []string{}
	for index := 0; index < chatMaxGroupMembers; index++ {
		user, err := server.CreateUser("crowd"+auth.NewID()[:8], "secret", "user")
		if err != nil {
			t.Fatal(err)
		}
		now := "2026-01-01T00:00:00Z"
		for _, pair := range [][2]string{{alice.user.ID, user.ID}, {user.ID, alice.user.ID}} {
			if _, err := server.db.Exec(`INSERT INTO friendships (user_id, friend_user_id, created_at) VALUES (?, ?, ?)`, pair[0], pair[1], now); err != nil {
				t.Fatal(err)
			}
		}
		friends = append(friends, user.ID)
	}
	chatDo(t, server, http.MethodPost, alice.token, "/v1/chat/groups", map[string]any{"name": "Too big", "memberIds": friends}, http.StatusBadRequest)
	raw := chatDo(t, server, http.MethodPost, alice.token, "/v1/chat/groups", map[string]any{"name": "Full", "memberIds": friends[:chatMaxGroupMembers-1]}, http.StatusCreated)
	group := chatDecode[chatConversationPayload](t, raw).Conversation
	if group.MemberCount != chatMaxGroupMembers {
		t.Fatalf("expected a full group, got %d", group.MemberCount)
	}
	chatDo(t, server, http.MethodPost, alice.token, "/v1/chat/conversations/"+group.ID+"/members", map[string][]string{"userIds": {friends[chatMaxGroupMembers-1]}}, http.StatusBadRequest)
}

// ---- text nests ------------------------------------------------------------------

type chatTree struct {
	id string
}

func chatNewTree(t *testing.T, server *Server, owner chatPerson, name string, members ...chatPerson) chatTree {
	t.Helper()
	created := chatDecode[struct {
		Tree Tree `json:"tree"`
	}](t, chatDo(t, server, http.MethodPost, owner.token, "/v1/trees", map[string]string{"name": name}, http.StatusCreated))
	for _, member := range members {
		chatDo(t, server, http.MethodPost, owner.token, "/v1/trees/"+created.Tree.ID+"/members", map[string]string{"username": member.user.Username}, http.StatusCreated)
	}
	return chatTree{id: created.Tree.ID}
}

func chatNewTextNest(t *testing.T, server *Server, token, treeID, name, categoryID string) ChatConversation {
	t.Helper()
	raw := chatDo(t, server, http.MethodPost, token, "/v1/trees/"+treeID+"/text-nests", map[string]string{"name": name, "categoryId": categoryID}, http.StatusCreated)
	return chatDecode[chatConversationPayload](t, raw).Conversation
}

func TestTextNestBelongsToTheTreeAndFollowsItsMembership(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	bob := chatNewPerson(t, server, "bob")
	carol := chatNewPerson(t, server, "carol")
	outsider := chatNewPerson(t, server, "outsider")
	tree := chatNewTree(t, server, alice, "Design", bob)

	// Only owners and moderators add one.
	chatDo(t, server, http.MethodPost, bob.token, "/v1/trees/"+tree.id+"/text-nests", map[string]string{"name": "general"}, http.StatusForbidden)
	chatDo(t, server, http.MethodPost, outsider.token, "/v1/trees/"+tree.id+"/text-nests", map[string]string{"name": "general"}, http.StatusNotFound)
	bobStream := chatListen(server, bob)
	nest := chatNewTextNest(t, server, alice.token, tree.id, "general", "")
	if nest.Kind != chatKindNest || nest.TreeID != tree.id || nest.Name != "general" || !nest.CanManage || nest.MemberCount != 2 {
		t.Fatalf("unexpected text nest: %+v", nest)
	}
	if event := nextChatEvent(t, bobStream); event.Type != "conversation.changed" || event.ConversationID != nest.ID {
		t.Fatalf("tree members should learn of the new text nest: %+v", event)
	}

	// No friendship is needed here: the tree is what they share.
	chatSend(t, server, alice.token, nest.ID, "welcome")
	entry := chatFind(chatList(t, server, bob.token), nest.ID)
	if entry == nil || entry.UnreadCount != 1 || !entry.CanSend || entry.CanManage || entry.Role != "member" {
		t.Fatalf("a member's view: %+v", entry)
	}
	chatSend(t, server, bob.token, nest.ID, "thanks")

	// Someone outside the tree has nothing to do with it.
	base := "/v1/chat/conversations/" + nest.ID
	chatDo(t, server, http.MethodGet, outsider.token, base+"/messages", nil, http.StatusNotFound)
	chatDo(t, server, http.MethodPost, outsider.token, base+"/messages", map[string]string{"clientMessageId": "c-" + auth.NewID(), "body": "hello"}, http.StatusNotFound)
	if chatFind(chatList(t, server, outsider.token), nest.ID) != nil {
		t.Fatal("a text nest must not appear for someone outside the tree")
	}

	// Someone who joins later reads the whole history, and starts with nothing unread.
	chatDo(t, server, http.MethodPost, alice.token, "/v1/trees/"+tree.id+"/members", map[string]string{"username": "carol"}, http.StatusCreated)
	joined := chatFind(chatList(t, server, carol.token), nest.ID)
	if joined == nil || joined.UnreadCount != 0 || joined.ReadSeq != 2 || joined.MemberCount != 3 {
		t.Fatalf("a newcomer's view: %+v", joined)
	}
	if got := chatBodies(chatHistory(t, server, carol.token, nest.ID, "").Messages); len(got) != 2 {
		t.Fatalf("a newcomer reads what came before: %v", got)
	}
	carolStream := chatListen(server, carol)
	chatSend(t, server, bob.token, nest.ID, "hi carol")
	if event := nextChatEvent(t, carolStream); event.Type != "message.created" || event.Message.Body != "hi carol" {
		t.Fatalf("a newcomer receives new messages: %+v", event)
	}

	// A moderator may delete anyone's message; an ordinary member may not.
	fromBob := chatSend(t, server, bob.token, nest.ID, "off topic")
	chatDo(t, server, http.MethodDelete, carol.token, base+"/messages/"+fromBob.ID+"?for=everyone", nil, http.StatusForbidden)
	chatDo(t, server, http.MethodDelete, alice.token, base+"/messages/"+fromBob.ID+"?for=everyone", nil, http.StatusOK)

	// Leaving the tree ends it at once: no events, no history, no sending.
	chatDo(t, server, http.MethodDelete, alice.token, "/v1/trees/"+tree.id+"/members/"+bob.user.ID, nil, http.StatusNoContent)
	bobAfter := chatListen(server, bob)
	chatSend(t, server, alice.token, nest.ID, "after bob left the tree")
	noChatEvent(t, bobAfter, "someone removed from the tree")
	chatDo(t, server, http.MethodGet, bob.token, base+"/messages", nil, http.StatusNotFound)
	chatDo(t, server, http.MethodPost, bob.token, base+"/messages", map[string]string{"clientMessageId": "c-" + auth.NewID(), "body": "still here"}, http.StatusNotFound)
	if chatFind(chatList(t, server, bob.token), nest.ID) != nil {
		t.Fatal("it must leave the list of someone removed from the tree")
	}
}

func TestDeletingATreeRemovesItsTextNestsAndTheirMessages(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	bob := chatNewPerson(t, server, "bob")
	tree := chatNewTree(t, server, alice, "Short lived", bob)
	category := chatDecode[struct {
		Category TreeCategory `json:"category"`
	}](t, chatDo(t, server, http.MethodPost, alice.token, "/v1/trees/"+tree.id+"/categories", map[string]string{"name": "Talk"}, http.StatusCreated)).Category
	nest := chatNewTextNest(t, server, alice.token, tree.id, "general", category.ID)
	message := chatSend(t, server, bob.token, nest.ID, "this will not outlive the tree")
	chatDo(t, server, http.MethodDelete, alice.token, "/v1/chat/conversations/"+nest.ID+"/messages/"+message.ID+"?for=me", nil, http.StatusOK)

	deleteJSONWithBody(t, server, alice.token, "/v1/trees/"+tree.id, map[string]string{"confirmation": "Short lived"}, http.StatusNoContent)

	for _, table := range []string{"chat_conversations", "chat_members", "chat_messages", "chat_message_hides", "tree_categories", "tree_layout_items"} {
		var count int
		if err := server.db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Errorf("%s still has %d rows after the tree was deleted", table, count)
		}
	}
	chatDo(t, server, http.MethodGet, bob.token, "/v1/chat/conversations/"+nest.ID+"/messages", nil, http.StatusNotFound)
	if len(chatList(t, server, bob.token)) != 0 {
		t.Fatal("nothing of the tree should remain in anyone's list")
	}
}

// ---- layout ----------------------------------------------------------------------

type chatLayoutPayload struct {
	Layout TreeLayout `json:"layout"`
}

func chatLayout(t *testing.T, server *Server, token, treeID string) TreeLayout {
	t.Helper()
	return chatDecode[chatLayoutPayload](t, chatDo(t, server, http.MethodGet, token, "/v1/trees/"+treeID+"/layout", nil, http.StatusOK)).Layout
}

func chatLayoutOrder(layout TreeLayout) []string {
	out := []string{}
	for _, item := range layout.Items {
		category := item.CategoryID
		if category == "" {
			category = "-"
		}
		out = append(out, category+"/"+item.Kind+"/"+item.ID)
	}
	return out
}

func TestTreeLayoutOrdersVoiceAndTextNestsInCategories(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	bob := chatNewPerson(t, server, "bob")
	outsider := chatNewPerson(t, server, "outsider")
	tree := chatNewTree(t, server, alice, "Studio", bob)
	otherTree := chatNewTree(t, server, alice, "Elsewhere")
	base := "/v1/trees/" + tree.id

	voiceA := createTestNest(t, server, alice.token, base+"/nests", "Standup")
	voiceB := createTestNest(t, server, alice.token, base+"/nests", "Lounge")
	foreignVoice := createTestNest(t, server, alice.token, "/v1/trees/"+otherTree.id+"/nests", "Not ours")
	newCategory := func(name string) TreeCategory {
		t.Helper()
		return chatDecode[struct {
			Category TreeCategory `json:"category"`
		}](t, chatDo(t, server, http.MethodPost, alice.token, base+"/categories", map[string]string{"name": name}, http.StatusCreated)).Category
	}
	work, social := newCategory("Work"), newCategory("Social")
	general := chatNewTextNest(t, server, alice.token, tree.id, "general", work.ID)
	ideas := chatNewTextNest(t, server, alice.token, tree.id, "ideas", "")

	// Members read the layout; only owners and moderators change it.
	chatDo(t, server, http.MethodGet, outsider.token, base+"/layout", nil, http.StatusNotFound)
	chatDo(t, server, http.MethodPost, bob.token, base+"/categories", map[string]string{"name": "Mine"}, http.StatusForbidden)
	chatDo(t, server, http.MethodPost, bob.token, base+"/layout", map[string]any{"categories": []string{}, "items": []any{}}, http.StatusForbidden)
	initial := chatLayout(t, server, bob.token, tree.id)
	if len(initial.Categories) != 2 || initial.Categories[0].ID != work.ID || len(initial.Items) != 4 {
		t.Fatalf("initial layout: %+v", initial)
	}

	arrange := func(categories []string, items []map[string]string, want int) []byte {
		t.Helper()
		return chatDo(t, server, http.MethodPost, alice.token, base+"/layout", map[string]any{"categories": categories, "items": items}, want)
	}
	item := func(kind, id, category string) map[string]string {
		return map[string]string{"kind": kind, "id": id, "categoryId": category}
	}
	arranged := chatDecode[chatLayoutPayload](t, arrange(
		[]string{social.ID, work.ID},
		[]map[string]string{
			item("text", ideas.ID, ""),
			item("voice", voiceB, social.ID),
			item("text", general.ID, work.ID),
			item("voice", voiceA, work.ID),
		}, http.StatusOK)).Layout
	want := []string{"-/text/" + ideas.ID, social.ID + "/voice/" + voiceB, work.ID + "/text/" + general.ID, work.ID + "/voice/" + voiceA}
	if got := chatLayoutOrder(arranged); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("arranged order:\n got %v\nwant %v", got, want)
	}
	if arranged.Categories[0].ID != social.ID || arranged.Categories[1].ID != work.ID {
		t.Fatalf("categories should be reordered: %+v", arranged.Categories)
	}
	if got := chatLayoutOrder(chatLayout(t, server, bob.token, tree.id)); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("the arrangement should be stored: %v", got)
	}

	// Nothing from another tree, and nothing made up, can be placed here.
	arrange([]string{work.ID}, []map[string]string{item("voice", foreignVoice, "")}, http.StatusBadRequest)
	arrange([]string{work.ID}, []map[string]string{item("text", "no-such-nest", "")}, http.StatusBadRequest)
	arrange([]string{"no-such-category"}, []map[string]string{}, http.StatusBadRequest)
	arrange([]string{}, []map[string]string{item("text", ideas.ID, "no-such-category")}, http.StatusBadRequest)
	arrange([]string{}, []map[string]string{item("text", ideas.ID, ""), item("text", ideas.ID, "")}, http.StatusBadRequest)

	// A nest created while someone was arranging is not lost by their stale request.
	late := chatNewTextNest(t, server, alice.token, tree.id, "late", "")
	stale := chatDecode[chatLayoutPayload](t, arrange([]string{work.ID}, []map[string]string{item("voice", voiceA, ""), item("text", general.ID, work.ID)}, http.StatusOK)).Layout
	if len(stale.Items) != 5 || len(stale.Categories) != 2 {
		t.Fatalf("a stale arrangement must keep everything: %+v", stale)
	}
	found := false
	for _, entry := range stale.Items {
		if entry.ID == late.ID {
			found = true
		}
	}
	if !found {
		t.Fatal("the nest that was left out should still be in the layout")
	}

	// Renaming and deleting a category; what was in it stays, uncategorised.
	chatDo(t, server, http.MethodPost, alice.token, base+"/categories/"+work.ID, map[string]string{"name": "Projects"}, http.StatusOK)
	chatDo(t, server, http.MethodPost, alice.token, "/v1/trees/"+otherTree.id+"/categories/"+work.ID, map[string]string{"name": "Wrong tree"}, http.StatusNotFound)
	chatDo(t, server, http.MethodDelete, alice.token, base+"/categories/"+work.ID, nil, http.StatusNoContent)
	after := chatLayout(t, server, alice.token, tree.id)
	if len(after.Categories) != 1 || after.Categories[0].ID != social.ID || len(after.Items) != 5 {
		t.Fatalf("after deleting a category: %+v", after)
	}
	for _, entry := range after.Items {
		if entry.CategoryID == work.ID {
			t.Fatalf("nothing should still point at the deleted category: %+v", entry)
		}
	}

	// Deleting a text nest takes it out of the layout.
	chatDo(t, server, http.MethodDelete, bob.token, "/v1/chat/conversations/"+general.ID, nil, http.StatusForbidden)
	chatDo(t, server, http.MethodDelete, alice.token, "/v1/chat/conversations/"+general.ID, nil, http.StatusNoContent)
	if final := chatLayout(t, server, alice.token, tree.id); len(final.Items) != 4 {
		t.Fatalf("a deleted text nest should leave the layout: %+v", final.Items)
	}
}
