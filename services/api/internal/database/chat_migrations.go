package database

// chatStatements creates the text chat schema: conversations (direct messages, groups and
// a tree's text nests), their members, messages, and the tree layout that orders voice and
// text nests into categories.
//
// It only creates tables, so it is safe on a database that predates chat, and the same SQL
// runs on PostgreSQL and SQLite.
func chatStatements() []string {
	return []string{
		// last_seq counts every change to a conversation's content without gaps. It gives
		// messages their order and lets a client tell that it missed something.
		// last_message_seq is the seq of the newest message; last_activity_ms sorts the
		// conversation list (timestamps here are text and do not sort).
		`CREATE TABLE IF NOT EXISTS chat_conversations (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL CHECK (kind IN ('dm', 'group', 'nest')),
			tree_id TEXT REFERENCES trees(id) ON DELETE CASCADE,
			dm_key TEXT UNIQUE,
			name TEXT NOT NULL DEFAULT '',
			topic TEXT NOT NULL DEFAULT '',
			creator_user_id TEXT NOT NULL REFERENCES users(id),
			last_seq BIGINT NOT NULL DEFAULT 0,
			last_message_seq BIGINT NOT NULL DEFAULT 0,
			last_activity_ms BIGINT NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_conversations_tree ON chat_conversations(tree_id, status)`,

		// For direct messages and groups this row is the membership. For a text nest,
		// access comes from tree_members and the row only keeps the person's own state.
		//   visible_from_seq  the first seq this person may read
		//   read_seq          how far they have read
		//   shared_read_seq   how far the other person in a direct message may see they read
		//   hide_rev          bumped whenever they hide a message for themselves
		`CREATE TABLE IF NOT EXISTS chat_members (
			conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
			state TEXT NOT NULL DEFAULT 'joined' CHECK (state IN ('joined', 'left', 'removed')),
			visible_from_seq BIGINT NOT NULL DEFAULT 0,
			read_seq BIGINT NOT NULL DEFAULT 0,
			shared_read_seq BIGINT NOT NULL DEFAULT 0,
			hide_rev BIGINT NOT NULL DEFAULT 0,
			listed BOOLEAN NOT NULL DEFAULT TRUE,
			archived_at TEXT,
			joined_at TEXT NOT NULL,
			left_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (conversation_id, user_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id, state)`,

		// seq is when the message was created and never changes; changed_seq is its last
		// change (an edit or a delete), which is what a catching-up client asks for.
		// kind has no CHECK so that a later message kind does not need a table rebuild.
		// reply_to_message_id is deliberately not a foreign key: it would make deleting a
		// conversation's messages in bulk depend on their order.
		`CREATE TABLE IF NOT EXISTS chat_messages (
			id TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
			seq BIGINT NOT NULL,
			changed_seq BIGINT NOT NULL,
			sender_id TEXT NOT NULL REFERENCES users(id),
			client_message_id TEXT NOT NULL,
			kind TEXT NOT NULL DEFAULT 'text',
			body TEXT NOT NULL DEFAULT '',
			reply_to_message_id TEXT,
			system_json TEXT,
			created_at TEXT NOT NULL,
			edited_at TEXT,
			deleted_at TEXT,
			deleted_by_user_id TEXT,
			UNIQUE (conversation_id, seq),
			UNIQUE (conversation_id, sender_id, client_message_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_messages_changed ON chat_messages(conversation_id, changed_seq)`,

		`CREATE TABLE IF NOT EXISTS chat_message_hides (
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
			conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
			created_at TEXT NOT NULL,
			PRIMARY KEY (user_id, message_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_message_hides_conversation ON chat_message_hides(conversation_id, user_id)`,

		`CREATE TABLE IF NOT EXISTS chat_user_settings (
			user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
			share_read_status BOOLEAN NOT NULL DEFAULT TRUE,
			updated_at TEXT NOT NULL
		)`,

		`CREATE TABLE IF NOT EXISTS tree_categories (
			id TEXT PRIMARY KEY,
			tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			position INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_tree_categories_tree ON tree_categories(tree_id, position)`,

		// Where each voice nest (nests.id) and text nest (chat_conversations.id) sits in
		// its tree. It is an overlay: a nest without a row is simply listed last.
		`CREATE TABLE IF NOT EXISTS tree_layout_items (
			tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
			kind TEXT NOT NULL CHECK (kind IN ('voice', 'text')),
			item_id TEXT NOT NULL,
			category_id TEXT REFERENCES tree_categories(id) ON DELETE SET NULL,
			position INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (tree_id, kind, item_id)
		)`,
	}
}
