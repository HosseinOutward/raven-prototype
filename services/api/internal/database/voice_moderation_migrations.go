package database

// voiceModerationStatements adds server mute and server deafen. They belong to the
// membership, not the call, so leaving and rejoining does not clear them: a space's are on
// tree_members and follow the person through its rooms, a temporary room's are on
// nest_members and end with the room.
func voiceModerationStatements() []string {
	return []string{
		`ALTER TABLE tree_members ADD COLUMN server_muted BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE tree_members ADD COLUMN server_deafened BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE nest_members ADD COLUMN server_muted BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE nest_members ADD COLUMN server_deafened BOOLEAN NOT NULL DEFAULT FALSE`,
	}
}
