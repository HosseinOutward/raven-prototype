package database

// Capability names. Each has a server-wide default and may be overridden per account.
const (
	CapabilitySpacesCreate    = "spaces.create"
	CapabilityRoomsJoin       = "rooms.join"
	CapabilityRoomsStartAdhoc = "rooms.start_adhoc"
	CapabilityMessagesRead    = "messages.read"
	CapabilityMessagesSend    = "messages.send"
	CapabilityGroupsCreate    = "groups.create"
	CapabilityInvitesCreate   = "invites.create"
)

// Capabilities lists every capability in the order they are shown.
var Capabilities = []string{
	CapabilitySpacesCreate,
	CapabilityRoomsJoin,
	CapabilityRoomsStartAdhoc,
	CapabilityMessagesRead,
	CapabilityMessagesSend,
	CapabilityGroupsCreate,
	CapabilityInvitesCreate,
}

// permissionsCapabilities are the capabilities that existed when permissionsStatements
// was first applied. Its text is checksummed, so it seeds exactly these; capabilities
// added later are seeded by their own migrations.
var permissionsCapabilities = []string{
	CapabilitySpacesCreate,
	CapabilityRoomsJoin,
	CapabilityRoomsStartAdhoc,
	CapabilityMessagesRead,
	CapabilityMessagesSend,
	CapabilityGroupsCreate,
}

// permissionsStatements adds account status, per-account capabilities, the admin audit
// log, and the rule that a tree has exactly one owner.
func permissionsStatements(driver string) []string {
	statements := []string{
		`ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended'))`,
		`ALTER TABLE users ADD COLUMN status_reason TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE users ADD COLUMN password_changed_at TEXT`,
		// limit_value is only meaningful for spaces.create: how many trees one person may
		// own. NULL means no limit.
		`CREATE TABLE IF NOT EXISTS server_capability_defaults (
			capability TEXT PRIMARY KEY,
			allowed BOOLEAN NOT NULL,
			limit_value INTEGER,
			updated_at TEXT NOT NULL,
			updated_by_user_id TEXT REFERENCES users(id)
		)`,
		// A row here replaces the default for one account, both the answer and the limit.
		`CREATE TABLE IF NOT EXISTS user_capability_overrides (
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			capability TEXT NOT NULL REFERENCES server_capability_defaults(capability),
			allowed BOOLEAN NOT NULL,
			limit_value INTEGER,
			updated_at TEXT NOT NULL,
			updated_by_user_id TEXT REFERENCES users(id),
			PRIMARY KEY (user_id, capability)
		)`,
		`CREATE TABLE IF NOT EXISTS admin_audit_events (
			id TEXT PRIMARY KEY,
			actor_user_id TEXT REFERENCES users(id),
			actor_label TEXT NOT NULL,
			action TEXT NOT NULL,
			entity_type TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			entity_label TEXT NOT NULL DEFAULT '',
			detail_json TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_events(created_at, id)`,
		`CREATE INDEX IF NOT EXISTS idx_admin_audit_entity ON admin_audit_events(entity_type, entity_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit_events(actor_user_id, created_at)`,
	}
	// Everything is allowed to begin with, so applying this changes nothing for anyone
	// until an administrator tightens it.
	for _, capability := range permissionsCapabilities {
		statements = append(statements,
			`INSERT INTO server_capability_defaults (capability, allowed, limit_value, updated_at)
			 VALUES ('`+capability+`', TRUE, NULL, '2026-10-12T00:00:00Z') ON CONFLICT(capability) DO NOTHING`,
		)
	}
	statements = append(statements, singleOwnerStatements()...)
	if driver == "pgx" {
		statements = append(statements,
			`CREATE OR REPLACE FUNCTION prevent_admin_audit_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'admin audit events are immutable'; END; $$ LANGUAGE plpgsql`,
			`DROP TRIGGER IF EXISTS admin_audit_events_immutable ON admin_audit_events`,
			`CREATE TRIGGER admin_audit_events_immutable BEFORE UPDATE OR DELETE ON admin_audit_events FOR EACH ROW EXECUTE FUNCTION prevent_admin_audit_mutation()`,
		)
	} else {
		statements = append(statements,
			`CREATE TRIGGER IF NOT EXISTS admin_audit_events_no_update BEFORE UPDATE ON admin_audit_events BEGIN SELECT RAISE(ABORT, 'admin audit events are immutable'); END`,
			`CREATE TRIGGER IF NOT EXISTS admin_audit_events_no_delete BEFORE DELETE ON admin_audit_events BEGIN SELECT RAISE(ABORT, 'admin audit events are immutable'); END`,
		)
	}
	return statements
}

// singleOwnerStatements leaves every tree with exactly one owner and then makes the
// database refuse a second.
//
// Where a tree has several, the one who created it stays owner if they are among them,
// otherwise whoever has been in it longest; the others become moderators. A tree left
// with members but no owner gets its longest-standing moderator, or failing that member.
func singleOwnerStatements() []string {
	return []string{
		`UPDATE tree_members SET role = 'member' WHERE role = 'owner' AND state <> 'joined'`,
		`UPDATE tree_members SET role = 'moderator'
		 WHERE role = 'owner' AND state = 'joined' AND user_id <> (
			SELECT o.user_id FROM tree_members o
			JOIN trees t ON t.id = o.tree_id
			WHERE o.tree_id = tree_members.tree_id AND o.role = 'owner' AND o.state = 'joined'
			ORDER BY CASE WHEN o.user_id = t.creator_user_id THEN 0 ELSE 1 END, o.joined_at, o.user_id
			LIMIT 1
		 )`,
		`UPDATE tree_members SET role = 'owner'
		 WHERE state = 'joined'
		   AND NOT EXISTS (
			SELECT 1 FROM tree_members o
			WHERE o.tree_id = tree_members.tree_id AND o.role = 'owner' AND o.state = 'joined'
		   )
		   AND user_id = (
			SELECT c.user_id FROM tree_members c
			WHERE c.tree_id = tree_members.tree_id AND c.state = 'joined'
			ORDER BY CASE WHEN c.role = 'moderator' THEN 0 ELSE 1 END, c.joined_at, c.user_id
			LIMIT 1
		   )`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_tree_members_one_owner ON tree_members(tree_id) WHERE role = 'owner' AND state = 'joined'`,
	}
}
