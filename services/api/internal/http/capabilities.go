package http

import (
	"database/sql"

	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// UserCapabilities is what the server's administrator lets one account do. It is separate
// from the roles people hold inside a tree: those say what someone may do to a tree,
// these say whether the account may use a part of Raven at all.
//
// Each has a server-wide default and may be overridden for one account. Administrators
// always have all of them.
type UserCapabilities struct {
	CreateSpaces bool `json:"createSpaces"`
	// MaxOwnedSpaces is how many trees the account may own. Nil means no limit.
	MaxOwnedSpaces *int `json:"maxOwnedSpaces"`
	JoinRooms      bool `json:"joinRooms"`
	StartRooms     bool `json:"startRooms"`
	ReadMessages   bool `json:"readMessages"`
	SendMessages   bool `json:"sendMessages"`
	CreateGroups   bool `json:"createGroups"`
}

var (
	errCapabilityCreateSpaces = fiber.NewError(fiber.StatusForbidden, "Your account can’t create Trees.")
	errCapabilitySpaceLimit   = fiber.NewError(fiber.StatusForbidden, "Your account already owns as many Trees as it is allowed.")
	errCapabilityJoinRooms    = fiber.NewError(fiber.StatusForbidden, "Your account can’t join Nests.")
	errCapabilityStartRooms   = fiber.NewError(fiber.StatusForbidden, "Your account can’t start Nests.")
	errCapabilityReadMessages = fiber.NewError(fiber.StatusForbidden, "Messages are turned off for your account.")
	errCapabilitySendMessages = fiber.NewError(fiber.StatusForbidden, "Your account can read messages but not send them.")
	errCapabilityCreateGroups = fiber.NewError(fiber.StatusForbidden, "Your account can’t create groups.")
)

func allCapabilities() UserCapabilities {
	return UserCapabilities{
		CreateSpaces: true,
		JoinRooms:    true,
		StartRooms:   true,
		ReadMessages: true,
		SendMessages: true,
		CreateGroups: true,
	}
}

func (caps *UserCapabilities) set(capability string, allowed bool, limit *int) {
	switch capability {
	case database.CapabilitySpacesCreate:
		caps.CreateSpaces = allowed
		caps.MaxOwnedSpaces = limit
	case database.CapabilityRoomsJoin:
		caps.JoinRooms = allowed
	case database.CapabilityRoomsStartAdhoc:
		caps.StartRooms = allowed
	case database.CapabilityMessagesRead:
		caps.ReadMessages = allowed
	case database.CapabilityMessagesSend:
		caps.SendMessages = allowed
	case database.CapabilityGroupsCreate:
		caps.CreateGroups = allowed
	}
}

// normalize applies the two dependencies between capabilities: nobody sends what they
// cannot read, and nobody starts a Nest they could not then join.
func (caps *UserCapabilities) normalize() {
	if !caps.ReadMessages {
		caps.SendMessages = false
		caps.CreateGroups = false
	}
	if !caps.JoinRooms {
		caps.StartRooms = false
	}
	if !caps.CreateSpaces {
		caps.MaxOwnedSpaces = nil
	}
}

// capabilitiesFor works out what an account may do: its override where it has one, the
// server default otherwise.
func (s *Server) capabilitiesFor(q chatQuerier, userID, role string) (UserCapabilities, error) {
	if role == "admin" {
		return allCapabilities(), nil
	}
	rows, err := q.Query(
		`SELECT d.capability,
		        CASE WHEN (CASE WHEN o.user_id IS NULL THEN d.allowed ELSE o.allowed END) THEN 1 ELSE 0 END,
		        CASE WHEN o.user_id IS NULL THEN d.limit_value ELSE o.limit_value END
		 FROM server_capability_defaults d
		 LEFT JOIN user_capability_overrides o ON o.capability = d.capability AND o.user_id = ?`,
		userID,
	)
	if err != nil {
		return UserCapabilities{}, err
	}
	defer rows.Close()
	caps := UserCapabilities{}
	for rows.Next() {
		var capability string
		var allowed int
		var limit sql.NullInt64
		if err := rows.Scan(&capability, &allowed, &limit); err != nil {
			return UserCapabilities{}, err
		}
		var limitValue *int
		if limit.Valid {
			value := int(limit.Int64)
			limitValue = &value
		}
		caps.set(capability, allowed != 0, limitValue)
	}
	if err := rows.Err(); err != nil {
		return UserCapabilities{}, err
	}
	caps.normalize()
	return caps, nil
}

// capabilitiesForUserID is capabilitiesFor when only the id is at hand.
func (s *Server) capabilitiesForUserID(q chatQuerier, userID string) (UserCapabilities, error) {
	var role string
	if err := q.QueryRow(`SELECT role FROM users WHERE id = ?`, userID).Scan(&role); err != nil {
		return UserCapabilities{}, err
	}
	return s.capabilitiesFor(q, userID, role)
}

// userCapabilities returns the capabilities of a user loaded for a request, looking them
// up when the user value came from somewhere that did not fill them in.
func (s *Server) userCapabilities(user User) (UserCapabilities, error) {
	if user.Capabilities != nil {
		return *user.Capabilities, nil
	}
	return s.capabilitiesFor(s.db, user.ID, user.Role)
}

// requireSpaceCreation checks that the account may own one more tree.
func (s *Server) requireSpaceCreation(user User) error {
	caps, err := s.userCapabilities(user)
	if err != nil {
		return err
	}
	if !caps.CreateSpaces {
		return errCapabilityCreateSpaces
	}
	if caps.MaxOwnedSpaces == nil {
		return nil
	}
	owned, err := s.ownedTreeCount(user.ID)
	if err != nil {
		return err
	}
	if owned >= *caps.MaxOwnedSpaces {
		return errCapabilitySpaceLimit
	}
	return nil
}

func (s *Server) ownedTreeCount(userID string) (int, error) {
	var count int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM tree_members tm
		 JOIN trees t ON t.id = tm.tree_id
		 WHERE tm.user_id = ? AND tm.role = 'owner' AND tm.state = 'joined' AND t.status = 'active'`,
		userID,
	).Scan(&count)
	return count, err
}

func (s *Server) requireJoinRooms(user User) error {
	caps, err := s.userCapabilities(user)
	if err != nil {
		return err
	}
	if !caps.JoinRooms {
		return errCapabilityJoinRooms
	}
	return nil
}

func (s *Server) requireStartRooms(user User) error {
	caps, err := s.userCapabilities(user)
	if err != nil {
		return err
	}
	if !caps.JoinRooms {
		return errCapabilityJoinRooms
	}
	if !caps.StartRooms {
		return errCapabilityStartRooms
	}
	return nil
}

func (s *Server) requireCreateGroups(user User) error {
	caps, err := s.userCapabilities(user)
	if err != nil {
		return err
	}
	if !caps.ReadMessages {
		return errCapabilityReadMessages
	}
	if !caps.CreateGroups {
		return errCapabilityCreateGroups
	}
	return nil
}

// requireChatRead keeps an account without messages out of every chat route.
func (s *Server) requireChatRead(c *fiber.Ctx) error {
	caps, err := s.userCapabilities(currentUser(c))
	if err != nil {
		return err
	}
	if !caps.ReadMessages {
		return errCapabilityReadMessages
	}
	return c.Next()
}
