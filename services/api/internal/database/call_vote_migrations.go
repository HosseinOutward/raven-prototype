package database

// callVoteStatements adds the time until which someone voted out of a call cannot come
// back to that room. NULL for everyone else. It is the only trace a vote leaves.
func callVoteStatements() []string {
	return []string{
		`ALTER TABLE nest_members ADD COLUMN removed_until TEXT`,
	}
}
