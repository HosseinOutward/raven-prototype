package http

import (
	"context"
	"log"
	"strings"

	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
	"github.com/livekit/protocol/livekit"
)

// spaceNameSQL is the name a person goes by inside a space: their nickname there, else
// their global display name, else their username. memberAlias must be a tree_members row
// joined LEFT, so outside a space (no row) it falls through to the global name.
func spaceNameSQL(memberAlias, prefAlias, userAlias string) string {
	return "COALESCE(NULLIF(TRIM(" + memberAlias + ".display_name), ''), NULLIF(TRIM(" + prefAlias + ".display_name), ''), " + userAlias + ".username)"
}

// normalizeSpaceName tidies a nickname. Blank means none: the global name shows again.
func normalizeSpaceName(name string) (string, error) {
	name = strings.Join(strings.Fields(name), " ")
	if len([]rune(name)) > 80 {
		return "", fiber.NewError(fiber.StatusBadRequest, "A name must be 80 characters or fewer.")
	}
	return name, nil
}

// spaceNameOf is the name someone goes by in a space, for places that hold a User rather
// than a query: their nickname there, else their global name.
func (s *Server) spaceNameOf(treeID string, user User) string {
	if treeID == "" {
		return user.DisplayName
	}
	var nickname string
	if err := s.db.QueryRow(
		`SELECT display_name FROM tree_members WHERE tree_id = ? AND user_id = ?`, treeID, user.ID,
	).Scan(&nickname); err != nil || strings.TrimSpace(nickname) == "" {
		return user.DisplayName
	}
	return nickname
}

// setTreeMemberNameCore sets or clears a member's nickname in a space and renames them in
// any call running in that space right now.
func (s *Server) setTreeMemberNameCore(treeID, userID, name string) (TreeMember, error) {
	name, err := normalizeSpaceName(name)
	if err != nil {
		return TreeMember{}, err
	}
	result, err := s.db.Exec(
		`UPDATE tree_members SET display_name = ?, updated_at = ? WHERE tree_id = ? AND user_id = ? AND state = 'joined'`,
		name, database.Now(), treeID, userID,
	)
	if err != nil {
		return TreeMember{}, err
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return TreeMember{}, errTreeMemberNotFound
	}
	member, err := s.findTreeMember(treeID, userID)
	if err != nil {
		return TreeMember{}, err
	}
	s.publishTree(treeID, "tree.member_updated")
	s.renameInCalls(treeID, member)
	return member, nil
}

// renameInCalls updates the name LiveKit shows for someone who is in a call of the space.
func (s *Server) renameInCalls(treeID string, member TreeMember) {
	nestIDs, err := s.stringColumn(
		`SELECT DISTINCT sp.nest_id FROM session_participants sp
		 JOIN nests n ON n.id = sp.nest_id
		 WHERE n.tree_id = ? AND n.type = 'persistent' AND sp.user_id = ? AND sp.left_at IS NULL`,
		treeID, member.UserID,
	)
	if err != nil {
		log.Printf("space names: find calls for %s: %v", member.UserID, err)
		return
	}
	for _, nestID := range nestIDs {
		room := liveKitSessionName(nestID)
		for _, identity := range []string{member.UserID, audioParticipantIdentity(member.UserID), videoParticipantIdentity(member.UserID)} {
			s.setParticipantName(room, identity, member.DisplayName)
		}
	}
}

func (s *Server) liveKitSetParticipantName(room, identity, name string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), liveKitCallTimeout)
		defer cancel()
		_, err := s.liveKitRooms.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{Room: room, Identity: identity, Name: name})
		if err != nil && !liveKitNotFound(err) {
			log.Printf("livekit: rename participant in %s: %v", room, err)
		}
	}()
}

// updateTreeMemberName sets a nickname. Anyone may set their own; a moderator or the owner
// may set or clear the nickname of someone they outrank.
func (s *Server) updateTreeMemberName(c *fiber.Ctx) error {
	actor := currentUser(c)
	treeID := c.Params("id")
	targetUserID := strings.TrimSpace(c.Params("userId"))
	var body struct {
		DisplayName string `json:"displayName"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid name payload")
	}
	if targetUserID == actor.ID {
		if _, err := s.authorizeTree(s.db, actor.ID, treeID, treeActionView); err != nil {
			return err
		}
	} else {
		if _, err := s.authorizeTree(s.db, actor.ID, treeID, treeActionRenameMember); err != nil {
			return err
		}
		targetRole, err := s.treeRoleOf(s.db, targetUserID, treeID)
		if err != nil {
			return err
		}
		if targetRole == "" {
			return errTreeMemberNotFound
		}
		if err := s.authorizeTreeTarget(s.db, actor.ID, treeID, treeActionRenameMember, targetRole); err != nil {
			return err
		}
	}
	member, err := s.setTreeMemberNameCore(treeID, targetUserID, body.DisplayName)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"member": member})
}

// adminSetSpaceMemberName is the dashboard's way to set anyone's nickname in a space.
func (s *Server) adminSetSpaceMemberName(c *fiber.Ctx) error {
	actor := currentUser(c)
	space, err := s.adminSpace(c.Params("id"))
	if err != nil {
		return err
	}
	var body struct {
		DisplayName string `json:"displayName"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid name payload")
	}
	member, err := s.setTreeMemberNameCore(space.ID, c.Params("userId"), body.DisplayName)
	if err != nil {
		return adminError(err)
	}
	s.audit(auditActorFor(actor), "space.member_name_changed", "space", space.ID, space.Name, map[string]any{
		"userId": member.UserID, "username": member.Username, "name": member.Nickname,
	})
	return s.adminSpaceResponse(c, fiber.StatusOK, space.ID)
}
