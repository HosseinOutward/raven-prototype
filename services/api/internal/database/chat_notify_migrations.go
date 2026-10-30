package database

func chatNotifyStatements() []string {
	return []string{`ALTER TABLE chat_members ADD COLUMN notify TEXT NOT NULL DEFAULT ''`}
}
