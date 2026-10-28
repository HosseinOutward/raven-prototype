package database

// callStateStatements adds the two markers every person in a call shares with the others:
// "Back in a bit" (away) and deafened. They are plain flags on the participation, with no
// time or duration, and a new participation starts with both off.
func callStateStatements() []string {
	return []string{
		`ALTER TABLE session_participants ADD COLUMN away BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE session_participants ADD COLUMN deafened BOOLEAN NOT NULL DEFAULT FALSE`,
	}
}
