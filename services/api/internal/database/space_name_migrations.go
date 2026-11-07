package database

// spaceNameStatements adds the per-space display name (nickname) to tree_members. Empty
// means no nickname, so the person's global display name shows.
func spaceNameStatements() []string {
	return []string{
		`ALTER TABLE tree_members ADD COLUMN display_name TEXT NOT NULL DEFAULT ''`,
	}
}
