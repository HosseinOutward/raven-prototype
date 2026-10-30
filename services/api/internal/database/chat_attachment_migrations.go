package database

// chatAttachmentStatements adds what a chat message can carry besides its text: an
// attachment's description, the variants of it that are stored, and the queue of stored
// objects waiting to be deleted. docs/chat.md explains the model.
//
// The SQL text is part of the migration's checksum: once a database has applied it, any
// change to these strings, whitespace included, stops the API from starting.
func chatAttachmentStatements() []string {
	return []string{
		// Attachments describe content independently of its source. message_id is not a
		// foreign key so bulk message deletion never depends on deletion order.
		`CREATE TABLE IF NOT EXISTS chat_attachments (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
 message_id TEXT,
 uploader_id TEXT NOT NULL REFERENCES users(id),
 client_upload_id TEXT NOT NULL,
 position INTEGER NOT NULL DEFAULT 0,
 kind TEXT NOT NULL, source TEXT NOT NULL,
 content_type TEXT NOT NULL DEFAULT '', size_bytes BIGINT NOT NULL DEFAULT 0,
 name TEXT NOT NULL DEFAULT '', width INTEGER, height INTEGER, duration_ms BIGINT,
 placeholder TEXT NOT NULL DEFAULT '', meta_json TEXT,
 created_at TEXT NOT NULL, attached_at TEXT,
 UNIQUE (uploader_id, client_upload_id)
 )`,
		`CREATE INDEX IF NOT EXISTS idx_chat_attachments_message ON chat_attachments(message_id)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_attachments_pending ON chat_attachments(conversation_id, attached_at)`,
		// Variants are declared at create time, then filled by immutable uploads.
		`CREATE TABLE IF NOT EXISTS chat_attachment_variants (
 attachment_id TEXT NOT NULL REFERENCES chat_attachments(id) ON DELETE CASCADE,
 variant TEXT NOT NULL, content_type TEXT NOT NULL, size_bytes BIGINT NOT NULL,
 object_key TEXT, uploaded_at TEXT, PRIMARY KEY (attachment_id, variant)
 )`,
		// Object storage cannot join a database transaction. This durable queue retains
		// keys before their attachment rows disappear, and maintenance retries deletion.
		`CREATE TABLE IF NOT EXISTS chat_object_purges (
 object_key TEXT PRIMARY KEY, queued_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
 )`,
	}
}
