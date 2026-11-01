package database

// knockReplyStatements adds the answer a person gave to a knock on them, and the time
// that answer holds until. Both stay NULL for nest knocks and for knocks nobody answered.
func knockReplyStatements() []string {
	return []string{
		`ALTER TABLE knocks ADD COLUMN reply TEXT CHECK (reply IN ('coming', 'soon', 'not_today', 'later'))`,
		`ALTER TABLE knocks ADD COLUMN reply_until TEXT`,
	}
}
