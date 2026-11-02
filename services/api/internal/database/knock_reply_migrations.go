package database

// knockReplyStatements adds the answer a person gave to a knock on them, the time that
// answer holds until, and the note sent with a "message" answer. All stay NULL for nest
// knocks and for knocks nobody answered.
func knockReplyStatements() []string {
	return []string{
		`ALTER TABLE knocks ADD COLUMN reply TEXT CHECK (reply IN ('coming', 'soon', 'not_today', 'later', 'message'))`,
		`ALTER TABLE knocks ADD COLUMN reply_until TEXT`,
		`ALTER TABLE knocks ADD COLUMN reply_message TEXT`,
	}
}
