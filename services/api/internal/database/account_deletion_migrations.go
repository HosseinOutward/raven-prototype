package database

// accountDeletionStatements marks the moment an account was deleted. The users row stays
// as a tombstone, because trees, nests, conversations and messages still point at it.
func accountDeletionStatements() []string {
	return []string{
		`ALTER TABLE users ADD COLUMN deleted_at TEXT`,
	}
}
