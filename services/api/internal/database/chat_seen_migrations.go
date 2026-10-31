package database

// chatSeenStatements adds the four read-receipt switches and the time a shared read
// position last moved. share_read_status stays for now; read_dm starts as a copy of it.
func chatSeenStatements() []string {
	return []string{
		`ALTER TABLE chat_user_settings ADD COLUMN read_dm BOOLEAN NOT NULL DEFAULT TRUE`,
		`ALTER TABLE chat_user_settings ADD COLUMN read_group BOOLEAN NOT NULL DEFAULT TRUE`,
		`ALTER TABLE chat_user_settings ADD COLUMN read_private_space BOOLEAN NOT NULL DEFAULT TRUE`,
		`ALTER TABLE chat_user_settings ADD COLUMN read_public_space BOOLEAN NOT NULL DEFAULT FALSE`,
		`UPDATE chat_user_settings SET read_dm = share_read_status`,
		`ALTER TABLE chat_members ADD COLUMN shared_read_at TEXT NULL`,
	}
}
