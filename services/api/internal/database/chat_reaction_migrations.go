package database

func chatReactionStatements() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS chat_reactions (
   message_id TEXT NOT NULL,
   conversation_id TEXT NOT NULL,
   user_id TEXT NOT NULL,
   emoji TEXT NOT NULL,
   created_at TEXT NOT NULL,
   PRIMARY KEY (message_id, user_id, emoji)
  )`,
		`CREATE INDEX IF NOT EXISTS idx_chat_reactions_conversation ON chat_reactions(conversation_id)`,
	}
}
