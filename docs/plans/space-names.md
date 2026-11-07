# Space display names (per-space nicknames)

## Context
Today a person has one global display name (`user_preferences.display_name`), resolved in SQL everywhere as `COALESCE(NULLIF(TRIM(display_name),''), username)`. Soroush wants each person to be able to carry a different name inside each space (tree), visible and editable from the admin dashboard too.

Decisions (settled in chat 2026-11-05):
- **Who sets:** the member themself; owner/moderators may set or clear a lower-ranked member's (same rank rule as server mute, `authorizeTreeTarget`); admin dashboard may set anyone's.
- **Where shown:** everything inside the space — member list, room text chat (sender + reply preview), call tiles/mixer/overlay (LiveKit name), session participants, call event log, knocks into a room of that space. DMs, groups, friends, profile keep the global name.
- **Identity:** `@username` stays visible (member list row already shows it; profile shows global name + username).
- Empty / blank = no nickname (falls back to global name). Same length/normalisation rules as `normalizeDisplayName` (`server.go:1430`).

## Approach — resolve on the server, so clients mostly need no change

### 1. Schema
- New `services/api/internal/database/space_name_migrations.go`: `ALTER TABLE tree_members ADD COLUMN display_name TEXT NOT NULL DEFAULT ''`.
- Register in `update_migrations.go` list (e.g. `2026110501_space_names`), pattern as `voiceModerationStatements()`.
- Kept when someone leaves and rejoins (row is reused) — acceptable; cleared on removal? No: keep simple, the row persists either way.

### 2. One SQL helper for "name in this space"
- In `http/` add `spaceNameSQL(memberAlias, prefAlias, userAlias string) string` →
  `COALESCE(NULLIF(TRIM(tm.display_name),''), NULLIF(TRIM(up.display_name),''), u.username)`.
- Apply it (LEFT JOIN `tree_members` on the tree in context) in:
  - `treeMembers` / `findTreeMember` (`domain.go:1429,1458`) — also return raw `nickname` field.
  - Room chat: `chatMessageSelectSQL` (`chat_messages.go:17`) sender + reply parent; join `chat_conversations c ON c.id = m.conversation_id` then `tree_members` on `(c.tree_id, sender)`. DMs/groups have `tree_id NULL` → falls through to global. Also the seen-by reader list (`chat_conversations.go:1227`) and `chat_conversations.go:265` member list when the conversation is a nest.
  - Session participants `activeParticipants` and event log (`sessions.go:675,706`) via `nests.tree_id`.
  - Nest members (`server.go:1475`) via `nests.tree_id`.
  - `knockSelectSQL` (`domain.go:1985`) via `n.tree_id` for both from/to.
  - Admin space members (`admin_spaces.go:113`) — return both effective name and raw nickname.
- LiveKit token `Name` (`server.go:953`): when `nestBelongsToTree(nest)`, use the member's space name.

### 3. Set / clear endpoint
- `POST /trees/:id/members/:userId/name` `{ "displayName": "" | "…" }` next to the role route (`server.go:324`).
- Core in `tree_ops.go`: `setTreeMemberNameCore(treeID, userID, name)` — normalise, update row, `publishTree(treeID, "tree.member_updated")`, then rename live call participants via LiveKit `UpdateParticipant` (Name) for the person's identities in any active nest of that tree (helper beside `liveKitSetParticipantPermission`, `tree_ops.go:461`).
- Auth: self → `treeActionView`; other → new `treeActionRenameMember` (moderator) in `policy.go:74` + `authorizeTreeTarget` with target role.
- Admin: `POST /admin/spaces/:id/members/:userId/name` in `admin.go` / `admin_spaces.go`, calling the same core, with an admin audit event like `adminSetSpaceMemberRole` (`admin_spaces.go:373`).

### 4. Desktop (`apps/desktop`)
- `lib/api.ts` `TreeMember`: add `nickname?: string`; add `updateTreeMemberName` client call; wire through `shells/ravenv1/state.ts` next to `updateTreeMemberRole`.
- `views/TreeSettingsView.tsx` Members (`:240`): for rows the viewer may rename (self, or `treeOutranks`), a "Set name in this space…" action opening a small dialog (input, placeholder = global name, Clear). Follow the `raven-ui` skill for wording/layout.
- Members already refetch on `tree.member_updated`; chat/call names come from the server. Check that room-chat messages refresh names after a change (cached messages keep the old sender name until reload — acceptable unless a cheap refetch exists).

### 5. Admin (`apps/admin`)
- `types.ts` / `api.ts`: `nickname` on space member, `setSpaceMemberName`.
- `views/SpaceView.tsx` members table (`:89`): show space name with global name + `@username` under it; inline edit/clear.

## Files
Go: `database/space_name_migrations.go` (new), `database/update_migrations.go`, `http/domain.go`, `http/chat_messages.go`, `http/chat_conversations.go` (has uncommitted seen-by edits — commit those first or build on top), `http/sessions.go`, `http/server.go`, `http/tree_ops.go`, `http/policy.go`, `http/admin.go`, `http/admin_spaces.go`.
Desktop: `src/lib/api.ts`, `src/shells/ravenv1/state.ts`, `src/shells/ravenv1/views/TreeSettingsView.tsx`.
Admin: `src/types.ts`, `src/api.ts`, `src/views/SpaceView.tsx`.

Work on branch `claude/space-names`.

## Verification
- Go tests (new `http/space_names_test.go`, using `dbtest_test.go` helpers): self sets/clears; mod renames member; member cannot rename mod (403); outsider 404; tree member list, room message sender, session participants, knock show the nickname; DM message from same person shows global name; admin endpoint sets it and writes audit row. `go test ./...` in `services/api`.
- `bun test` for admin `api.test.ts` if API client changed; `bunx tsc --noEmit` for desktop and admin.
- One live check at the end: set a nickname in a space during a call, confirm call tile + room chat + member list update; open the admin Space view and edit it there.
