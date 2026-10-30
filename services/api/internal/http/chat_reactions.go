package http

import (
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
)

// withChatReactions hydrates a page in one query, without adding reactions to quotes.
func withChatReactions(q chatQuerier, messages []ChatMessage) error {
	ids := []any{}
	for i := range messages {
		messages[i].Reactions = nil
		if messages[i].DeletedAt == nil {
			ids = append(ids, messages[i].ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.Query(`SELECT message_id, emoji, user_id FROM chat_reactions
  WHERE message_id IN (`+strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")+`)
  ORDER BY created_at, emoji, user_id`, ids...)
	if err != nil {
		return err
	}
	defer rows.Close()
	grouped := map[string][]ChatReaction{}
	for rows.Next() {
		var id, emoji, userID string
		if err := rows.Scan(&id, &emoji, &userID); err != nil {
			return err
		}
		reactions := grouped[id]
		index := -1
		for i := range reactions {
			if reactions[i].Emoji == emoji {
				index = i
				break
			}
		}
		if index == -1 {
			index = len(reactions)
			reactions = append(reactions, ChatReaction{Emoji: emoji})
		}
		reactions[index].Count++
		reactions[index].UserIDs = append(reactions[index].UserIDs, userID)
		grouped[id] = reactions
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range messages {
		if messages[i].DeletedAt == nil {
			messages[i].Reactions = grouped[messages[i].ID]
		}
	}
	return nil
}

func (s *Server) reactToChatMessage(c *fiber.Ctx) error {
	user := currentUser(c)
	conversationID, messageID := c.Params("id"), c.Params("messageId")
	var input struct {
		Emoji string `json:"emoji"`
		Add   bool   `json:"add"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	unlock := s.chatLocks.lock(conversationID)
	defer unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Fixed-width fractional seconds also sort correctly when one write lands on a second.
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000000000Z")
	seq, err := chatNextSeq(tx, conversationID, false, now)
	if err != nil {
		return err
	}
	access, err := s.chatAccessFor(tx, conversationID, user.ID)
	if err != nil {
		return err
	}
	if !access.CanSend {
		return access.sendError()
	}
	var kind string
	var deletedAt, replyToID sql.NullString
	var messageSeq int64
	err = tx.QueryRow(`SELECT kind, deleted_at, reply_to_message_id, seq FROM chat_messages WHERE id = ? AND conversation_id = ?`, messageID, conversationID).Scan(&kind, &deletedAt, &replyToID, &messageSeq)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && messageSeq < access.VisibleFromSeq) {
		return errChatMessageGone
	}
	if err != nil {
		return err
	}
	hidden, err := chatMessageHiddenBy(tx, messageID, user.ID)
	if err != nil {
		return err
	}
	if hidden {
		return errChatMessageGone
	}
	if kind != chatMessageText || deletedAt.Valid {
		return errChatCannotReact
	}
	if !validChatReaction(input.Emoji) {
		return fiber.NewError(400, "That isn’t an emoji.")
	}
	unchanged := func() error {
		_ = tx.Rollback()
		message, err := s.loadChatMessage(s.db, conversationID, messageID, user.ID, access.VisibleFromSeq)
		if err != nil {
			return err
		}
		return c.JSON(fiber.Map{"message": message})
	}
	if input.Add {
		var exists int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`, messageID, user.ID, input.Emoji).Scan(&exists); err != nil {
			return err
		}
		if exists > 0 {
			return unchanged()
		}
		var count int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM chat_reactions WHERE message_id = ? AND user_id = ?`, messageID, user.ID).Scan(&count); err != nil {
			return err
		}
		if count >= chatMaxReactionsPerPerson {
			if _, err := tx.Exec(`DELETE FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = (
    SELECT emoji FROM chat_reactions WHERE message_id = ? AND user_id = ? ORDER BY created_at, emoji LIMIT 1
   )`, messageID, user.ID, messageID, user.ID); err != nil {
				return err
			}
		}
		var kinds, matching int
		if err := tx.QueryRow(`SELECT COUNT(DISTINCT emoji) FROM chat_reactions WHERE message_id = ?`, messageID).Scan(&kinds); err != nil {
			return err
		}
		if err := tx.QueryRow(`SELECT COUNT(*) FROM chat_reactions WHERE message_id = ? AND emoji = ?`, messageID, input.Emoji).Scan(&matching); err != nil {
			return err
		}
		if kinds >= chatMaxReactionKinds && matching == 0 {
			return fiber.NewError(422, "This message has as many different reactions as it can take.")
		}
		if _, err := tx.Exec(`INSERT INTO chat_reactions (message_id, conversation_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)`, messageID, conversationID, user.ID, input.Emoji, now); err != nil {
			return err
		}
	} else {
		result, err := tx.Exec(`DELETE FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`, messageID, user.ID, input.Emoji)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return unchanged()
		}
	}
	if _, err := tx.Exec(`UPDATE chat_messages SET changed_seq = ? WHERE id = ?`, seq, messageID); err != nil {
		return err
	}
	reply, err := chatReplyTargetFor(tx, conversationID, replyToID.String)
	if err != nil {
		return err
	}
	recipients, err := s.chatAudience(tx, access, messageID)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committedAt := time.Now()
	message, err := s.loadChatMessage(s.db, conversationID, messageID, user.ID, access.VisibleFromSeq)
	if err != nil {
		return err
	}
	event := message
	event.ReplyTo = nil
	s.publishChatMessage("message.updated", event, seq, reply, recipients, committedAt)
	return c.JSON(fiber.Map{"message": message})
}
