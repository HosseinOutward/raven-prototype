package http

import (
	"database/sql"
	"errors"
	"os"
	"strconv"
	"strings"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

type Tree struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Description   string `json:"description"`
	JoinPolicy    string `json:"joinPolicy"`
	Visibility    string `json:"visibility"`
	CreatorUserID string `json:"creatorUserId"`
	Status        string `json:"status"`
	CreatedAt     string `json:"createdAt"`
	UpdatedAt     string `json:"updatedAt"`
}

type TreeMember struct {
	TreeID        string  `json:"treeId"`
	UserID        string  `json:"userId"`
	Username      string  `json:"username"`
	DisplayName   string  `json:"displayName"`
	Role          string  `json:"role"`
	State         string  `json:"state"`
	JoinedAt      *string `json:"joinedAt"`
	LeftAt        *string `json:"leftAt"`
	PresenceState string  `json:"presenceState"`
	Reachability  string  `json:"reachability"`
	ActiveNestID  *string `json:"activeNestId,omitempty"`
}

type UserPresence struct {
	UserID       string  `json:"userId"`
	Username     string  `json:"username"`
	DisplayName  string  `json:"displayName"`
	State        string  `json:"state"`
	Reachability string  `json:"reachability"`
	ActiveNestID *string `json:"activeNestId,omitempty"`
	UpdatedAt    string  `json:"updatedAt"`
}

type Knock struct {
	ID               string  `json:"id"`
	FromUserID       string  `json:"fromUserId"`
	FromUsername     string  `json:"fromUsername"`
	FromDisplayName  string  `json:"fromDisplayName"`
	ToUserID         *string `json:"toUserId,omitempty"`
	ToUsername       *string `json:"toUsername,omitempty"`
	ToDisplayName    *string `json:"toDisplayName,omitempty"`
	NestID           *string `json:"nestId,omitempty"`
	NestName         *string `json:"nestName,omitempty"`
	Status           string  `json:"status"`
	Message          *string `json:"message,omitempty"`
	CreatedAt        string  `json:"createdAt"`
	ExpiresAt        string  `json:"expiresAt"`
	ResolvedAt       *string `json:"resolvedAt,omitempty"`
	ResolvedByUserID *string `json:"resolvedByUserId,omitempty"`
}

type PublicUser struct {
	ID              string `json:"id"`
	Username        string `json:"username"`
	DisplayName     string `json:"displayName"`
	Relationship    string `json:"relationship"`
	FriendRequestID string `json:"friendRequestId,omitempty"`
}

type Friend struct {
	UserID      string `json:"userId"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	CreatedAt   string `json:"createdAt"`
}

type FriendRequest struct {
	ID              string  `json:"id"`
	FromUserID      string  `json:"fromUserId"`
	FromUsername    string  `json:"fromUsername"`
	FromDisplayName string  `json:"fromDisplayName"`
	ToUserID        string  `json:"toUserId"`
	ToUsername      string  `json:"toUsername"`
	ToDisplayName   string  `json:"toDisplayName"`
	Status          string  `json:"status"`
	CreatedAt       string  `json:"createdAt"`
	ResolvedAt      *string `json:"resolvedAt,omitempty"`
}

type TreeJoinRequest struct {
	ID          string  `json:"id"`
	TreeID      string  `json:"treeId"`
	TreeName    string  `json:"treeName"`
	UserID      string  `json:"userId"`
	Username    string  `json:"username"`
	DisplayName string  `json:"displayName"`
	Status      string  `json:"status"`
	CreatedAt   string  `json:"createdAt"`
	ResolvedAt  *string `json:"resolvedAt,omitempty"`
}

type TreeSearchResult struct {
	Tree        Tree   `json:"tree"`
	MemberRole  string `json:"memberRole,omitempty"`
	RequestID   string `json:"requestId,omitempty"`
	AccessState string `json:"accessState"`
}

type TreeDetails struct {
	Tree          Tree              `json:"tree"`
	Members       []TreeMember      `json:"members"`
	ActiveNests   []Nest            `json:"activeNests"`
	InactiveNests []Nest            `json:"inactiveNests"`
	JoinRequests  []TreeJoinRequest `json:"joinRequests"`
}

type HomeState struct {
	User                   User            `json:"user"`
	Presence               UserPresence    `json:"presence"`
	Trees                  []Tree          `json:"trees"`
	ActiveNests            []LauncherNest  `json:"activeNests"`
	TemporaryNests         []LauncherNest  `json:"temporaryNests"`
	PendingKnocks          []Knock         `json:"pendingKnocks"`
	PendingInvites         []Invitation    `json:"pendingInvites"`
	PendingRequests        []JoinRequest   `json:"pendingRequests"`
	Friends                []Friend        `json:"friends"`
	IncomingFriendRequests []FriendRequest `json:"incomingFriendRequests"`
	OutgoingFriendRequests []FriendRequest `json:"outgoingFriendRequests"`
}

func (s *Server) home(c *fiber.Ctx) error {
	user := currentUser(c)
	if err := s.expireStaleKnocks(); err != nil {
		return err
	}
	if err := s.expireEmptyTemporaryNests(); err != nil {
		return err
	}
	if err := s.expireStaleNestActivity(); err != nil {
		return err
	}
	presence, err := s.presenceForUser(user)
	if err != nil {
		return err
	}
	trees, err := s.treesForUser(user.ID)
	if err != nil {
		return err
	}
	nests, err := s.launcherNestsForUser(user.ID)
	if err != nil {
		return err
	}
	active := []LauncherNest{}
	temporary := []LauncherNest{}
	for _, nest := range nests {
		if nest.Type == "temporary" {
			temporary = append(temporary, nest)
		}
		if nest.Active {
			active = append(active, nest)
		}
	}
	knocks, err := s.knocksForUser(user.ID, true)
	if err != nil {
		return err
	}
	invites, err := s.pendingInvitesForUser(user.ID)
	if err != nil {
		return err
	}
	requests, err := s.pendingAdmissionForCreator(user.ID)
	if err != nil {
		return err
	}
	friends, err := s.friendsForUser(user.ID)
	if err != nil {
		return err
	}
	incomingFriends, outgoingFriends, err := s.friendRequestsForUser(user.ID, true)
	if err != nil {
		return err
	}
	return c.JSON(HomeState{
		User:                   user,
		Presence:               presence,
		Trees:                  trees,
		ActiveNests:            active,
		TemporaryNests:         temporary,
		PendingKnocks:          knocks,
		PendingInvites:         invites,
		PendingRequests:        requests,
		Friends:                friends,
		IncomingFriendRequests: incomingFriends,
		OutgoingFriendRequests: outgoingFriends,
	})
}

func (s *Server) listTrees(c *fiber.Ctx) error {
	trees, err := s.treesForUser(currentUser(c).ID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"trees": trees})
}

func (s *Server) createTree(c *fiber.Ctx) error {
	user := currentUser(c)
	var body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		JoinPolicy  string `json:"joinPolicy"`
		Visibility  string `json:"visibility"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid Tree payload")
	}
	settings, err := normalizeTreeSettings(body.Name, body.Description, body.JoinPolicy, body.Visibility)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	tree, err := s.createTreeForUser(user, settings)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"tree": tree})
}

func (s *Server) updateTreeSettings(c *fiber.Ctx) error {
	actor := currentUser(c)
	treeID := c.Params("id")
	if ok, err := s.canManageTree(actor.ID, treeID); err != nil || !ok {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "tree owner or moderator role required")
	}
	var body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		JoinPolicy  string `json:"joinPolicy"`
		Visibility  string `json:"visibility"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid Tree settings payload")
	}
	settings, err := normalizeTreeSettings(body.Name, body.Description, body.JoinPolicy, body.Visibility)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	now := database.Now()
	if _, err := s.db.Exec(
		`UPDATE trees SET name = ?, description = ?, join_policy = ?, visibility = ?, updated_at = ? WHERE id = ? AND status = 'active'`,
		settings.Name, settings.Description, settings.JoinPolicy, settings.Visibility, now, treeID,
	); err != nil {
		return err
	}
	tree, err := s.findTree(treeID)
	if err != nil {
		return err
	}
	s.events.publish(LiveUpdate{Type: "tree.settings_updated", At: database.Now()})
	return c.JSON(fiber.Map{"tree": tree})
}

func (s *Server) deleteTree(c *fiber.Ctx) error {
	actor := currentUser(c)
	treeID := c.Params("id")
	if ok, err := s.isTreeOwner(actor.ID, treeID); err != nil || !ok {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "tree owner role required")
	}
	tree, err := s.findTree(treeID)
	if err != nil {
		return err
	}
	var body struct {
		Confirmation string `json:"confirmation"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid delete confirmation payload")
	}
	if strings.TrimSpace(body.Confirmation) != tree.Name {
		return fiber.NewError(fiber.StatusBadRequest, "type the Tree name to confirm deletion")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM nests WHERE tree_id = ?`, treeID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM tree_join_requests WHERE tree_id = ?`, treeID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM tree_members WHERE tree_id = ?`, treeID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM trees WHERE id = ?`, treeID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.events.publish(LiveUpdate{Type: "tree.deleted", At: database.Now()})
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) getTree(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if ok, err := s.canViewTree(user.ID, treeID); err != nil || !ok {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "not allowed to view this Tree")
	}
	tree, err := s.findTree(treeID)
	if err != nil {
		return err
	}
	members, err := s.treeMembers(treeID)
	if err != nil {
		return err
	}
	nests, err := s.queryNests(`WHERE n.tree_id = ? AND n.status = 'active' ORDER BY n.last_activity_at DESC`, treeID)
	if err != nil {
		return err
	}
	active, inactive := []Nest{}, []Nest{}
	for _, nest := range nests {
		if nest.LifecycleState == "active" {
			active = append(active, nest)
		} else {
			inactive = append(inactive, nest)
		}
	}
	requests := []TreeJoinRequest{}
	if canManage, err := s.canManageTree(user.ID, treeID); err != nil {
		return err
	} else if canManage {
		requests, err = s.treeJoinRequests(treeID)
		if err != nil {
			return err
		}
	}
	return c.JSON(TreeDetails{Tree: tree, Members: members, ActiveNests: active, InactiveNests: inactive, JoinRequests: requests})
}

func (s *Server) searchTrees(c *fiber.Ctx) error {
	actor := currentUser(c)
	query := strings.TrimSpace(c.Query("q"))
	if len(query) < 2 {
		return c.JSON(fiber.Map{"trees": []TreeSearchResult{}})
	}
	rows, err := s.db.Query(
		`SELECT t.id, t.name, t.description, t.join_policy, t.visibility, t.creator_user_id, t.status, t.created_at, t.updated_at,
		 COALESCE(tm.role, ''), COALESCE(tjr.id, '')
		 FROM trees t
		 LEFT JOIN tree_members tm ON tm.tree_id = t.id AND tm.user_id = ? AND tm.state = 'joined'
		 LEFT JOIN tree_join_requests tjr ON tjr.tree_id = t.id AND tjr.user_id = ? AND tjr.status = 'pending'
		 WHERE t.status = 'active' AND t.visibility = 'public'
		   AND (LOWER(t.name) LIKE LOWER(?) OR LOWER(t.description) LIKE LOWER(?))
		 ORDER BY t.name
		 LIMIT 20`,
		actor.ID, actor.ID, "%"+query+"%", "%"+query+"%",
	)
	if err != nil {
		return err
	}
	defer rows.Close()
	results := []TreeSearchResult{}
	for rows.Next() {
		var result TreeSearchResult
		if err := rows.Scan(
			&result.Tree.ID,
			&result.Tree.Name,
			&result.Tree.Description,
			&result.Tree.JoinPolicy,
			&result.Tree.Visibility,
			&result.Tree.CreatorUserID,
			&result.Tree.Status,
			&result.Tree.CreatedAt,
			&result.Tree.UpdatedAt,
			&result.MemberRole,
			&result.RequestID,
		); err != nil {
			return err
		}
		result.AccessState = "none"
		if result.MemberRole != "" {
			result.AccessState = "joined"
		} else if result.RequestID != "" {
			result.AccessState = "pending"
		}
		results = append(results, result)
	}
	return c.JSON(fiber.Map{"trees": results})
}

func (s *Server) joinTree(c *fiber.Ctx) error {
	actor := currentUser(c)
	tree, err := s.findTree(c.Params("id"))
	if err != nil {
		return err
	}
	if tree.Status != "active" {
		return fiber.NewError(fiber.StatusGone, "Tree is no longer active")
	}
	if ok, err := s.canViewTree(actor.ID, tree.ID); err != nil || ok {
		if err != nil {
			return err
		}
		member, err := s.findTreeMember(tree.ID, actor.ID)
		if err != nil {
			return err
		}
		return c.JSON(fiber.Map{"status": "joined", "tree": tree, "member": member})
	}
	if tree.Visibility != "public" {
		return fiber.NewError(fiber.StatusForbidden, "this Tree is private")
	}
	if tree.JoinPolicy == "free" {
		member, err := s.addTreeMemberRecord(tree.ID, actor.ID, "member")
		if err != nil {
			return err
		}
		s.events.publish(LiveUpdate{Type: "tree.member_joined", At: database.Now()})
		return c.JSON(fiber.Map{"status": "joined", "tree": tree, "member": member})
	}
	request, err := s.createTreeJoinRequest(tree.ID, actor.ID)
	if err != nil {
		return err
	}
	s.events.publish(LiveUpdate{Type: "tree.join_requested", At: database.Now()})
	return c.JSON(fiber.Map{"status": "waiting", "tree": tree, "joinRequest": request})
}

func (s *Server) listTreeJoinRequests(c *fiber.Ctx) error {
	actor := currentUser(c)
	treeID := c.Params("id")
	if ok, err := s.canManageTree(actor.ID, treeID); err != nil || !ok {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "tree owner or moderator role required")
	}
	requests, err := s.treeJoinRequests(treeID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"joinRequests": requests})
}

func (s *Server) acceptTreeJoinRequest(c *fiber.Ctx) error {
	return s.resolveTreeJoinRequest(c, "accepted")
}

func (s *Server) rejectTreeJoinRequest(c *fiber.Ctx) error {
	return s.resolveTreeJoinRequest(c, "rejected")
}

func (s *Server) resolveTreeJoinRequest(c *fiber.Ctx, status string) error {
	actor := currentUser(c)
	treeID := c.Params("id")
	if ok, err := s.canManageTree(actor.ID, treeID); err != nil || !ok {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "tree owner or moderator role required")
	}
	request, err := s.findTreeJoinRequest(treeID, c.Params("requestId"))
	if err != nil {
		return err
	}
	now := database.Now()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		`UPDATE tree_join_requests SET status = ?, resolved_at = ?, resolved_by_user_id = ? WHERE id = ? AND status = 'pending'`,
		status, now, actor.ID, request.ID,
	); err != nil {
		return err
	}
	if status == "accepted" {
		if _, err := tx.Exec(
			`INSERT INTO tree_members (tree_id, user_id, role, state, joined_at, created_at, updated_at)
			 VALUES (?, ?, 'member', 'joined', ?, ?, ?)
			 ON CONFLICT(tree_id, user_id) DO UPDATE SET role = CASE WHEN tree_members.role = 'owner' THEN tree_members.role ELSE 'member' END, state = 'joined', joined_at = excluded.joined_at, left_at = NULL, updated_at = excluded.updated_at`,
			treeID, request.UserID, now, now, now,
		); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.events.publish(LiveUpdate{Type: "tree.join_request_" + status, At: database.Now()})
	updated, err := s.findResolvedTreeJoinRequest(request.ID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"joinRequest": updated, "status": status})
}

func (s *Server) searchUsers(c *fiber.Ctx) error {
	actor := currentUser(c)
	query := strings.TrimSpace(c.Query("q"))
	if len(query) < 2 {
		return c.JSON(fiber.Map{"users": []PublicUser{}})
	}
	rows, err := s.db.Query(
		`SELECT u.id, u.username, COALESCE(NULLIF(TRIM(up.display_name), ''), u.username)
		 FROM users u
		 LEFT JOIN user_preferences up ON up.user_id = u.id
		 WHERE LOWER(u.username) LIKE LOWER(?)
		 ORDER BY u.username
		 LIMIT 12`,
		"%"+query+"%",
	)
	if err != nil {
		return err
	}
	defer rows.Close()
	users := []PublicUser{}
	for rows.Next() {
		var id, username, displayName string
		if err := rows.Scan(&id, &username, &displayName); err != nil {
			return err
		}
		relationship, requestID, err := s.relationshipToUser(actor.ID, id)
		if err != nil {
			return err
		}
		users = append(users, PublicUser{ID: id, Username: username, DisplayName: displayNameOrUsername(displayName, username), Relationship: relationship, FriendRequestID: requestID})
	}
	return c.JSON(fiber.Map{"users": users})
}

func (s *Server) listFriends(c *fiber.Ctx) error {
	user := currentUser(c)
	friends, err := s.friendsForUser(user.ID)
	if err != nil {
		return err
	}
	incoming, outgoing, err := s.friendRequestsForUser(user.ID, true)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"friends": friends, "incomingFriendRequests": incoming, "outgoingFriendRequests": outgoing})
}

func (s *Server) listFriendRequests(c *fiber.Ctx) error {
	user := currentUser(c)
	incoming, outgoing, err := s.friendRequestsForUser(user.ID, c.Query("all") != "1")
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"incomingFriendRequests": incoming, "outgoingFriendRequests": outgoing})
}

func (s *Server) createFriendRequest(c *fiber.Ctx) error {
	actor := currentUser(c)
	var body struct {
		ToUserID string `json:"toUserId"`
		Username string `json:"username"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid friend request payload")
	}
	target, err := s.findKnockTargetUser(body.ToUserID, body.Username)
	if err != nil {
		return fiber.NewError(fiber.StatusNotFound, "user not found")
	}
	if target.ID == actor.ID {
		return fiber.NewError(fiber.StatusBadRequest, "cannot friend yourself")
	}
	relationship, requestID, err := s.relationshipToUser(actor.ID, target.ID)
	if err != nil {
		return err
	}
	switch relationship {
	case "friends":
		return fiber.NewError(fiber.StatusConflict, "already friends")
	case "outgoing_pending":
		request, err := s.findFriendRequest(requestID)
		if err != nil {
			return err
		}
		return c.JSON(fiber.Map{"friendRequest": request})
	case "incoming_pending":
		return fiber.NewError(fiber.StatusConflict, "incoming friend request already pending")
	}
	now := database.Now()
	id := auth.NewID()
	if _, err := s.db.Exec(
		`INSERT INTO friend_requests (id, from_user_id, to_user_id, status, created_at)
		 VALUES (?, ?, ?, 'pending', ?)`,
		id, actor.ID, target.ID, now,
	); err != nil {
		if database.IsUniqueViolation(err) {
			request, findErr := s.pendingFriendRequest(actor.ID, target.ID)
			if findErr != nil {
				return findErr
			}
			return c.JSON(fiber.Map{"friendRequest": request})
		}
		return err
	}
	request, err := s.findFriendRequest(id)
	if err != nil {
		return err
	}
	s.events.publish(LiveUpdate{Type: "friend_request.created", At: database.Now()})
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"friendRequest": request})
}

func (s *Server) acceptFriendRequest(c *fiber.Ctx) error {
	actor := currentUser(c)
	request, err := s.findFriendRequest(c.Params("id"))
	if err != nil {
		return err
	}
	if request.ToUserID != actor.ID {
		return fiber.NewError(fiber.StatusForbidden, "only the recipient can accept this friend request")
	}
	if request.Status != "pending" {
		return fiber.NewError(fiber.StatusConflict, "friend request is not pending")
	}
	now := database.Now()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		`UPDATE friend_requests SET status = 'accepted', resolved_at = ?, resolved_by_user_id = ? WHERE id = ? AND status = 'pending'`,
		now, actor.ID, request.ID,
	); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT INTO friendships (user_id, friend_user_id, created_at)
		 VALUES (?, ?, ?), (?, ?, ?)
		 ON CONFLICT(user_id, friend_user_id) DO NOTHING`,
		request.FromUserID, request.ToUserID, now, request.ToUserID, request.FromUserID, now,
	); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	updated, err := s.findFriendRequest(request.ID)
	if err != nil {
		return err
	}
	s.events.publish(LiveUpdate{Type: "friend_request.accepted", At: database.Now()})
	return c.JSON(fiber.Map{"friendRequest": updated})
}

func (s *Server) declineFriendRequest(c *fiber.Ctx) error {
	return s.resolveFriendRequest(c, "declined")
}

func (s *Server) cancelFriendRequest(c *fiber.Ctx) error {
	return s.resolveFriendRequest(c, "cancelled")
}

func (s *Server) resolveFriendRequest(c *fiber.Ctx, status string) error {
	actor := currentUser(c)
	request, err := s.findFriendRequest(c.Params("id"))
	if err != nil {
		return err
	}
	if request.Status != "pending" {
		return fiber.NewError(fiber.StatusConflict, "friend request is not pending")
	}
	if status == "declined" && request.ToUserID != actor.ID {
		return fiber.NewError(fiber.StatusForbidden, "only the recipient can decline this friend request")
	}
	if status == "cancelled" && request.FromUserID != actor.ID {
		return fiber.NewError(fiber.StatusForbidden, "only the sender can cancel this friend request")
	}
	now := database.Now()
	if _, err := s.db.Exec(
		`UPDATE friend_requests SET status = ?, resolved_at = ?, resolved_by_user_id = ? WHERE id = ? AND status = 'pending'`,
		status, now, actor.ID, request.ID,
	); err != nil {
		return err
	}
	updated, err := s.findFriendRequest(request.ID)
	if err != nil {
		return err
	}
	s.events.publish(LiveUpdate{Type: "friend_request." + status, At: database.Now()})
	return c.JSON(fiber.Map{"friendRequest": updated})
}

func (s *Server) removeFriend(c *fiber.Ctx) error {
	actor := currentUser(c)
	friendID := strings.TrimSpace(c.Params("userId"))
	if friendID == "" || friendID == actor.ID {
		return fiber.NewError(fiber.StatusBadRequest, "invalid friend")
	}
	relationship, _, err := s.relationshipToUser(actor.ID, friendID)
	if err != nil {
		return err
	}
	if relationship != "friends" {
		return fiber.NewError(fiber.StatusNotFound, "friendship not found")
	}
	if _, err := s.db.Exec(
		`DELETE FROM friendships WHERE (user_id = ? AND friend_user_id = ?) OR (user_id = ? AND friend_user_id = ?)`,
		actor.ID, friendID, friendID, actor.ID,
	); err != nil {
		return err
	}
	s.events.publish(LiveUpdate{Type: "friend.removed", At: database.Now()})
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) addTreeMember(c *fiber.Ctx) error {
	actor := currentUser(c)
	treeID := c.Params("id")
	if ok, err := s.canManageTree(actor.ID, treeID); err != nil || !ok {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "tree owner or moderator role required")
	}
	var body struct {
		Username string `json:"username"`
		Role     string `json:"role"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid Tree member payload")
	}
	user, err := s.findUserByUsername(strings.TrimSpace(body.Username))
	if err != nil {
		return fiber.NewError(fiber.StatusNotFound, "user not found")
	}
	role := normalizeTreeRole(body.Role)
	if role == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Tree role must be owner, moderator, or member")
	}
	if ok, err := s.canAssignTreeRole(actor.ID, treeID, role); err != nil || !ok {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "not allowed to assign this Tree role")
	}
	member, err := s.addTreeMemberRecord(treeID, user.ID, role)
	if err != nil {
		return err
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"member": member})
}

func (s *Server) updateTreeMemberRole(c *fiber.Ctx) error {
	actor := currentUser(c)
	treeID := c.Params("id")
	targetUserID := strings.TrimSpace(c.Params("userId"))
	var body struct {
		Role string `json:"role"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid Tree member payload")
	}
	role := normalizeTreeRole(body.Role)
	if role == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Tree role must be owner, moderator, or member")
	}
	if ok, err := s.canAssignTreeRole(actor.ID, treeID, role); err != nil || !ok {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "not allowed to assign this Tree role")
	}
	current, err := s.findTreeMember(treeID, targetUserID)
	if err != nil {
		return err
	}
	if current.Role == "owner" && role != "owner" {
		if err := s.ensureTreeHasAnotherOwner(treeID, targetUserID); err != nil {
			return err
		}
	}
	now := database.Now()
	if _, err := s.db.Exec(
		`UPDATE tree_members SET role = ?, updated_at = ? WHERE tree_id = ? AND user_id = ? AND state = 'joined'`,
		role, now, treeID, targetUserID,
	); err != nil {
		return err
	}
	member, err := s.findTreeMember(treeID, targetUserID)
	if err != nil {
		return err
	}
	s.events.publish(LiveUpdate{Type: "tree.member_updated", At: database.Now()})
	return c.JSON(fiber.Map{"member": member})
}

func (s *Server) removeTreeMember(c *fiber.Ctx) error {
	actor := currentUser(c)
	treeID := c.Params("id")
	targetUserID := strings.TrimSpace(c.Params("userId"))
	member, err := s.findTreeMember(treeID, targetUserID)
	if err != nil {
		return err
	}
	if actor.ID == member.UserID && member.Role == "owner" {
		return fiber.NewError(fiber.StatusBadRequest, "Tree owners cannot remove themselves from their own Tree")
	}
	if ok, err := s.canRemoveTreeMember(actor.ID, treeID, member); err != nil || !ok {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "not allowed to remove this Tree member")
	}
	if member.Role == "owner" {
		if err := s.ensureTreeHasAnotherOwner(treeID, targetUserID); err != nil {
			return err
		}
	}
	now := database.Now()
	if _, err := s.db.Exec(
		`UPDATE tree_members SET state = 'removed', left_at = ?, updated_at = ? WHERE tree_id = ? AND user_id = ? AND state = 'joined'`,
		now, now, treeID, targetUserID,
	); err != nil {
		return err
	}
	s.events.publish(LiveUpdate{Type: "tree.member_removed", At: database.Now()})
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) createTreeNest(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if ok, err := s.canManageTree(user.ID, treeID); err != nil || !ok {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "not allowed to create a Nest in this Tree")
	}
	c.Locals("treeId", treeID)
	return s.createNestWithType(c, "persistent")
}

func (s *Server) updatePresence(c *fiber.Ctx) error {
	user := currentUser(c)
	var body struct {
		State        string  `json:"state"`
		Reachability string  `json:"reachability"`
		ActiveNestID *string `json:"activeNestId"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid presence payload")
	}
	state := normalizePresenceState(body.State)
	reachability := normalizeReachability(body.Reachability, state)
	if state == "" || reachability == "" {
		return fiber.NewError(fiber.StatusBadRequest, "invalid presence state")
	}
	if body.ActiveNestID != nil {
		nestID := strings.TrimSpace(*body.ActiveNestID)
		if nestID == "" {
			body.ActiveNestID = nil
		} else if ok, err := s.canViewNest(user.ID, nestID); err != nil || !ok {
			if err != nil {
				return err
			}
			return fiber.NewError(fiber.StatusForbidden, "not allowed to reference this active Nest")
		} else {
			body.ActiveNestID = &nestID
		}
	}
	presence, err := s.upsertPresence(user, state, reachability, body.ActiveNestID)
	if err != nil {
		return err
	}
	s.events.publish(LiveUpdate{Type: "presence.changed", At: database.Now()})
	return c.JSON(fiber.Map{"presence": presence})
}

func (s *Server) presenceHeartbeat(c *fiber.Ctx) error {
	user := currentUser(c)
	presence, err := s.presenceForUser(user)
	if err != nil {
		return err
	}
	if presence.State == "offline" {
		presence, err = s.upsertPresence(user, "available", "around", nil)
	} else {
		presence, err = s.upsertPresence(user, presence.State, presence.Reachability, presence.ActiveNestID)
	}
	if err != nil {
		return err
	}
	if presence.ActiveNestID != nil {
		if err := s.heartbeatNestActivity(user.ID, *presence.ActiveNestID); err != nil {
			return err
		}
	}
	return c.JSON(fiber.Map{"presence": presence})
}

func (s *Server) createKnock(c *fiber.Ctx) error {
	actor := currentUser(c)
	var body struct {
		ToUserID string `json:"toUserId"`
		Username string `json:"username"`
		NestID   string `json:"nestId"`
		Message  string `json:"message"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid knock payload")
	}
	var toUserID *string
	if body.ToUserID != "" || body.Username != "" {
		target, err := s.findKnockTargetUser(body.ToUserID, body.Username)
		if err != nil {
			return fiber.NewError(fiber.StatusNotFound, "target user not found")
		}
		if target.ID == actor.ID {
			return fiber.NewError(fiber.StatusBadRequest, "cannot knock yourself")
		}
		toUserID = &target.ID
	}
	var nestID *string
	if strings.TrimSpace(body.NestID) != "" {
		nest, err := s.findNest(strings.TrimSpace(body.NestID))
		if err != nil {
			return err
		}
		if ok, err := s.canViewNest(actor.ID, nest.ID); err != nil || !ok {
			if err != nil {
				return err
			}
			return fiber.NewError(fiber.StatusForbidden, "not allowed to knock this Nest")
		}
		nestID = &nest.ID
	}
	if toUserID == nil && nestID == nil {
		return fiber.NewError(fiber.StatusBadRequest, "knock requires a user or Nest target")
	}
	knock, err := s.insertKnock(actor.ID, toUserID, nestID, strings.TrimSpace(body.Message))
	if err != nil {
		return err
	}
	s.events.publish(LiveUpdate{Type: "knock.created", At: database.Now()})
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"knock": knock})
}

func (s *Server) listKnocks(c *fiber.Ctx) error {
	if err := s.expireStaleKnocks(); err != nil {
		return err
	}
	knocks, err := s.knocksForUser(currentUser(c).ID, false)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"knocks": knocks})
}

func (s *Server) acceptKnock(c *fiber.Ctx) error {
	return s.resolveKnock(c, "accepted")
}

func (s *Server) declineKnock(c *fiber.Ctx) error {
	return s.resolveKnock(c, "declined")
}

func (s *Server) dismissKnock(c *fiber.Ctx) error {
	return s.resolveKnock(c, "dismissed")
}

func (s *Server) resolveKnock(c *fiber.Ctx, status string) error {
	actor := currentUser(c)
	knock, err := s.findKnock(c.Params("id"))
	if err != nil {
		return err
	}
	if knock.Status != "pending" {
		return fiber.NewError(fiber.StatusConflict, "knock is not pending")
	}
	if allowed, err := s.canResolveKnock(actor.ID, knock); err != nil || !allowed {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "not allowed to resolve this knock")
	}
	now := database.Now()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		`UPDATE knocks SET status = ?, resolved_at = ?, resolved_by_user_id = ? WHERE id = ? AND status = 'pending'`,
		status, now, actor.ID, knock.ID,
	); err != nil {
		return err
	}
	if status == "accepted" && knock.NestID != nil {
		if _, err := tx.Exec(
			`INSERT INTO nest_members (nest_id, user_id, role, state, joined_at, created_at, updated_at)
			 VALUES (?, ?, 'participant', 'joined', ?, ?, ?)
			 ON CONFLICT(nest_id, user_id) DO UPDATE SET state = 'joined', joined_at = excluded.joined_at, left_at = NULL, updated_at = excluded.updated_at`,
			*knock.NestID, knock.FromUserID, now, now, now,
		); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	updated, err := s.findKnock(knock.ID)
	if err != nil {
		return err
	}
	s.events.publish(LiveUpdate{Type: "knock." + status, At: database.Now()})
	return c.JSON(fiber.Map{"knock": updated})
}

type treeSettingsPayload struct {
	Name        string
	Description string
	JoinPolicy  string
	Visibility  string
}

func (s *Server) createTreeForUser(user User, settings treeSettingsPayload) (Tree, error) {
	if settings.Name == "" {
		settings.Name = user.Username + "'s Tree"
	}
	now := database.Now()
	tree := Tree{
		ID:            auth.NewID(),
		Name:          settings.Name,
		Description:   settings.Description,
		JoinPolicy:    settings.JoinPolicy,
		Visibility:    settings.Visibility,
		CreatorUserID: user.ID,
		Status:        "active",
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Tree{}, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		`INSERT INTO trees (id, name, description, join_policy, visibility, creator_user_id, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
		tree.ID, tree.Name, tree.Description, tree.JoinPolicy, tree.Visibility, user.ID, now, now,
	); err != nil {
		return Tree{}, err
	}
	if _, err := tx.Exec(
		`INSERT INTO tree_members (tree_id, user_id, role, state, joined_at, created_at, updated_at)
		 VALUES (?, ?, 'owner', 'joined', ?, ?, ?)`,
		tree.ID, user.ID, now, now, now,
	); err != nil {
		return Tree{}, err
	}
	if err := tx.Commit(); err != nil {
		return Tree{}, err
	}
	return tree, nil
}

func (s *Server) ensureDefaultTreeForUserTx(tx *database.Tx, user User, now string) (string, error) {
	var treeID string
	err := tx.QueryRow(
		`SELECT t.id FROM trees t
		 JOIN tree_members tm ON tm.tree_id = t.id
		 WHERE tm.user_id = ? AND tm.role = 'owner' AND tm.state = 'joined' AND t.status = 'active'
		 ORDER BY t.created_at LIMIT 1`,
		user.ID,
	).Scan(&treeID)
	if err == nil {
		return treeID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	treeID = auth.NewID()
	if _, err := tx.Exec(
		`INSERT INTO trees (id, name, description, join_policy, visibility, creator_user_id, status, created_at, updated_at)
		 VALUES (?, ?, '', 'request', 'private', ?, 'active', ?, ?)`,
		treeID, user.Username+"'s Tree", user.ID, now, now,
	); err != nil {
		return "", err
	}
	_, err = tx.Exec(
		`INSERT INTO tree_members (tree_id, user_id, role, state, joined_at, created_at, updated_at)
		 VALUES (?, ?, 'owner', 'joined', ?, ?, ?)`,
		treeID, user.ID, now, now, now,
	)
	return treeID, err
}

func (s *Server) treesForUser(userID string) ([]Tree, error) {
	rows, err := s.db.Query(
		`SELECT t.id, t.name, t.description, t.join_policy, t.visibility, t.creator_user_id, t.status, t.created_at, t.updated_at
		 FROM trees t
		 JOIN tree_members tm ON tm.tree_id = t.id
		 WHERE tm.user_id = ? AND tm.state = 'joined' AND t.status = 'active'
		 ORDER BY t.name`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	trees := []Tree{}
	for rows.Next() {
		var tree Tree
		if err := rows.Scan(&tree.ID, &tree.Name, &tree.Description, &tree.JoinPolicy, &tree.Visibility, &tree.CreatorUserID, &tree.Status, &tree.CreatedAt, &tree.UpdatedAt); err != nil {
			return nil, err
		}
		trees = append(trees, tree)
	}
	return trees, rows.Err()
}

func (s *Server) findTree(treeID string) (Tree, error) {
	var tree Tree
	err := s.db.QueryRow(`SELECT id, name, description, join_policy, visibility, creator_user_id, status, created_at, updated_at FROM trees WHERE id = ?`, treeID).
		Scan(&tree.ID, &tree.Name, &tree.Description, &tree.JoinPolicy, &tree.Visibility, &tree.CreatorUserID, &tree.Status, &tree.CreatedAt, &tree.UpdatedAt)
	return tree, err
}

func (s *Server) treeMembers(treeID string) ([]TreeMember, error) {
	rows, err := s.db.Query(
		`SELECT tm.tree_id, u.id, u.username, COALESCE(NULLIF(TRIM(pref.display_name), ''), u.username), tm.role, tm.state, tm.joined_at, tm.left_at,
		 COALESCE(pres.state, 'offline'), COALESCE(pres.reachability, 'unavailable'), pres.active_nest_id
		 FROM tree_members tm
		 JOIN users u ON u.id = tm.user_id
		 LEFT JOIN user_preferences pref ON pref.user_id = u.id
		 LEFT JOIN user_presence pres ON pres.user_id = u.id
		 WHERE tm.tree_id = ?
		 ORDER BY tm.role, u.username`,
		treeID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	members := []TreeMember{}
	for rows.Next() {
		var member TreeMember
		if err := rows.Scan(&member.TreeID, &member.UserID, &member.Username, &member.DisplayName, &member.Role, &member.State, &member.JoinedAt, &member.LeftAt, &member.PresenceState, &member.Reachability, &member.ActiveNestID); err != nil {
			return nil, err
		}
		members = append(members, member)
	}
	return members, rows.Err()
}

func (s *Server) findTreeMember(treeID, userID string) (TreeMember, error) {
	var member TreeMember
	err := s.db.QueryRow(
		`SELECT tm.tree_id, u.id, u.username, COALESCE(NULLIF(TRIM(pref.display_name), ''), u.username), tm.role, tm.state, tm.joined_at, tm.left_at,
		 COALESCE(pres.state, 'offline'), COALESCE(pres.reachability, 'unavailable'), pres.active_nest_id
		 FROM tree_members tm
		 JOIN users u ON u.id = tm.user_id
		 LEFT JOIN user_preferences pref ON pref.user_id = u.id
		 LEFT JOIN user_presence pres ON pres.user_id = u.id
		 WHERE tm.tree_id = ? AND tm.user_id = ? AND tm.state = 'joined'`,
		treeID, userID,
	).Scan(&member.TreeID, &member.UserID, &member.Username, &member.DisplayName, &member.Role, &member.State, &member.JoinedAt, &member.LeftAt, &member.PresenceState, &member.Reachability, &member.ActiveNestID)
	return member, err
}

func (s *Server) addTreeMemberRecord(treeID, userID, role string) (TreeMember, error) {
	now := database.Now()
	_, err := s.db.Exec(
		`INSERT INTO tree_members (tree_id, user_id, role, state, joined_at, created_at, updated_at)
		 VALUES (?, ?, ?, 'joined', ?, ?, ?)
		 ON CONFLICT(tree_id, user_id) DO UPDATE SET role = excluded.role, state = 'joined', joined_at = excluded.joined_at, left_at = NULL, updated_at = excluded.updated_at`,
		treeID, userID, role, now, now, now,
	)
	if err != nil {
		return TreeMember{}, err
	}
	var member TreeMember
	err = s.db.QueryRow(
		`SELECT tm.tree_id, u.id, u.username, COALESCE(NULLIF(TRIM(pref.display_name), ''), u.username), tm.role, tm.state, tm.joined_at, tm.left_at,
		 COALESCE(pres.state, 'offline'), COALESCE(pres.reachability, 'unavailable'), pres.active_nest_id
		 FROM tree_members tm
		 JOIN users u ON u.id = tm.user_id
		 LEFT JOIN user_preferences pref ON pref.user_id = u.id
		 LEFT JOIN user_presence pres ON pres.user_id = u.id
		 WHERE tm.tree_id = ? AND tm.user_id = ?`,
		treeID, userID,
	).Scan(&member.TreeID, &member.UserID, &member.Username, &member.DisplayName, &member.Role, &member.State, &member.JoinedAt, &member.LeftAt, &member.PresenceState, &member.Reachability, &member.ActiveNestID)
	return member, err
}

func (s *Server) createTreeJoinRequest(treeID, userID string) (TreeJoinRequest, error) {
	now := database.Now()
	id := auth.NewID()
	if _, err := s.db.Exec(
		`INSERT INTO tree_join_requests (id, tree_id, user_id, status, created_at)
		 VALUES (?, ?, ?, 'pending', ?)
		 ON CONFLICT(tree_id, user_id, status) DO NOTHING`,
		id, treeID, userID, now,
	); err != nil {
		return TreeJoinRequest{}, err
	}
	return s.pendingTreeJoinRequest(treeID, userID)
}

func (s *Server) pendingTreeJoinRequest(treeID, userID string) (TreeJoinRequest, error) {
	rows, err := s.db.Query(treeJoinRequestSelectSQL()+` WHERE tjr.tree_id = ? AND tjr.user_id = ? AND tjr.status = 'pending'`, treeID, userID)
	if err != nil {
		return TreeJoinRequest{}, err
	}
	requests, err := scanTreeJoinRequests(rows)
	if err != nil {
		return TreeJoinRequest{}, err
	}
	if len(requests) == 0 {
		return TreeJoinRequest{}, sql.ErrNoRows
	}
	return requests[0], nil
}

func (s *Server) findTreeJoinRequest(treeID, requestID string) (TreeJoinRequest, error) {
	rows, err := s.db.Query(treeJoinRequestSelectSQL()+` WHERE tjr.tree_id = ? AND tjr.id = ? AND tjr.status = 'pending'`, treeID, requestID)
	if err != nil {
		return TreeJoinRequest{}, err
	}
	requests, err := scanTreeJoinRequests(rows)
	if err != nil {
		return TreeJoinRequest{}, err
	}
	if len(requests) == 0 {
		return TreeJoinRequest{}, sql.ErrNoRows
	}
	return requests[0], nil
}

func (s *Server) findResolvedTreeJoinRequest(requestID string) (TreeJoinRequest, error) {
	rows, err := s.db.Query(treeJoinRequestSelectSQL()+` WHERE tjr.id = ?`, requestID)
	if err != nil {
		return TreeJoinRequest{}, err
	}
	requests, err := scanTreeJoinRequests(rows)
	if err != nil {
		return TreeJoinRequest{}, err
	}
	if len(requests) == 0 {
		return TreeJoinRequest{}, sql.ErrNoRows
	}
	return requests[0], nil
}

func (s *Server) treeJoinRequests(treeID string) ([]TreeJoinRequest, error) {
	rows, err := s.db.Query(treeJoinRequestSelectSQL()+` WHERE tjr.tree_id = ? AND tjr.status = 'pending' ORDER BY tjr.created_at DESC`, treeID)
	if err != nil {
		return nil, err
	}
	return scanTreeJoinRequests(rows)
}

func (s *Server) friendsForUser(userID string) ([]Friend, error) {
	rows, err := s.db.Query(
		`SELECT f.friend_user_id, u.username, COALESCE(NULLIF(TRIM(up.display_name), ''), u.username), f.created_at
		 FROM friendships f
		 JOIN users u ON u.id = f.friend_user_id
		 LEFT JOIN user_preferences up ON up.user_id = u.id
		 WHERE f.user_id = ?
		 ORDER BY u.username`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	friends := []Friend{}
	for rows.Next() {
		var friend Friend
		if err := rows.Scan(&friend.UserID, &friend.Username, &friend.DisplayName, &friend.CreatedAt); err != nil {
			return nil, err
		}
		friends = append(friends, friend)
	}
	return friends, rows.Err()
}

func (s *Server) friendRequestsForUser(userID string, pendingOnly bool) ([]FriendRequest, []FriendRequest, error) {
	statusClause := ""
	if pendingOnly {
		statusClause = " AND fr.status = 'pending'"
	}
	incomingRows, err := s.db.Query(friendRequestSelectSQL()+` WHERE fr.to_user_id = ?`+statusClause+` ORDER BY fr.created_at DESC`, userID)
	if err != nil {
		return nil, nil, err
	}
	incoming, err := scanFriendRequests(incomingRows)
	if err != nil {
		return nil, nil, err
	}
	outgoingRows, err := s.db.Query(friendRequestSelectSQL()+` WHERE fr.from_user_id = ?`+statusClause+` ORDER BY fr.created_at DESC`, userID)
	if err != nil {
		return nil, nil, err
	}
	outgoing, err := scanFriendRequests(outgoingRows)
	if err != nil {
		return nil, nil, err
	}
	return incoming, outgoing, nil
}

func (s *Server) findFriendRequest(id string) (FriendRequest, error) {
	rows, err := s.db.Query(friendRequestSelectSQL()+` WHERE fr.id = ?`, id)
	if err != nil {
		return FriendRequest{}, err
	}
	requests, err := scanFriendRequests(rows)
	if err != nil {
		return FriendRequest{}, err
	}
	if len(requests) == 0 {
		return FriendRequest{}, sql.ErrNoRows
	}
	return requests[0], nil
}

func (s *Server) pendingFriendRequest(fromUserID, toUserID string) (FriendRequest, error) {
	rows, err := s.db.Query(friendRequestSelectSQL()+` WHERE fr.from_user_id = ? AND fr.to_user_id = ? AND fr.status = 'pending'`, fromUserID, toUserID)
	if err != nil {
		return FriendRequest{}, err
	}
	requests, err := scanFriendRequests(rows)
	if err != nil {
		return FriendRequest{}, err
	}
	if len(requests) == 0 {
		return FriendRequest{}, sql.ErrNoRows
	}
	return requests[0], nil
}

func (s *Server) relationshipToUser(userID, targetUserID string) (string, string, error) {
	if userID == targetUserID {
		return "self", "", nil
	}
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM friendships WHERE user_id = ? AND friend_user_id = ?`, userID, targetUserID).Scan(&count); err != nil {
		return "", "", err
	}
	if count > 0 {
		return "friends", "", nil
	}
	var requestID string
	err := s.db.QueryRow(`SELECT id FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, userID, targetUserID).Scan(&requestID)
	if err == nil {
		return "outgoing_pending", requestID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", "", err
	}
	err = s.db.QueryRow(`SELECT id FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, targetUserID, userID).Scan(&requestID)
	if err == nil {
		return "incoming_pending", requestID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", "", err
	}
	return "none", "", nil
}

func (s *Server) presenceForUser(user User) (UserPresence, error) {
	var presence UserPresence
	err := s.db.QueryRow(
		`SELECT u.id, u.username, COALESCE(NULLIF(TRIM(pref.display_name), ''), u.username), COALESCE(up.state, 'offline'), COALESCE(up.reachability, 'unavailable'), up.active_nest_id, COALESCE(up.updated_at, u.updated_at)
		 FROM users u
		 LEFT JOIN user_presence up ON up.user_id = u.id
		 LEFT JOIN user_preferences pref ON pref.user_id = u.id
		 WHERE u.id = ?`,
		user.ID,
	).Scan(&presence.UserID, &presence.Username, &presence.DisplayName, &presence.State, &presence.Reachability, &presence.ActiveNestID, &presence.UpdatedAt)
	return presence, err
}

func (s *Server) upsertPresence(user User, state, reachability string, activeNestID *string) (UserPresence, error) {
	now := database.Now()
	_, err := s.db.Exec(
		`INSERT INTO user_presence (user_id, state, reachability, active_nest_id, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, reachability = excluded.reachability, active_nest_id = excluded.active_nest_id, updated_at = excluded.updated_at`,
		user.ID, state, reachability, nullableStringPtr(activeNestID), now,
	)
	if err != nil {
		return UserPresence{}, err
	}
	return s.presenceForUser(user)
}

func (s *Server) insertKnock(fromUserID string, toUserID, nestID *string, message string) (Knock, error) {
	now := database.Now()
	expiresAt := time.Now().UTC().Add(knockTTL()).Format(time.RFC3339Nano)
	var messageValue any
	if message != "" {
		messageValue = message
	}
	id := auth.NewID()
	if _, err := s.db.Exec(
		`INSERT INTO knocks (id, from_user_id, to_user_id, nest_id, status, message, created_at, expires_at)
		 VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
		id, fromUserID, nullableStringPtr(toUserID), nullableStringPtr(nestID), messageValue, now, expiresAt,
	); err != nil {
		return Knock{}, err
	}
	return s.findKnock(id)
}

func (s *Server) findKnock(id string) (Knock, error) {
	rows, err := s.db.Query(knockSelectSQL()+` WHERE k.id = ?`, id)
	if err != nil {
		return Knock{}, err
	}
	defer rows.Close()
	knocks, err := scanKnocks(rows)
	if err != nil {
		return Knock{}, err
	}
	if len(knocks) == 0 {
		return Knock{}, sql.ErrNoRows
	}
	return knocks[0], nil
}

func (s *Server) knocksForUser(userID string, pendingOnly bool) ([]Knock, error) {
	statusClause := ""
	if pendingOnly {
		statusClause = " AND k.status = 'pending'"
	}
	rows, err := s.db.Query(
		knockSelectSQL()+`
		 WHERE (k.from_user_id = ?
		 	OR k.to_user_id = ?
		 	OR EXISTS (
		 		SELECT 1 FROM nest_members nm
		 		WHERE nm.nest_id = k.nest_id AND nm.user_id = ? AND nm.role IN ('creator', 'moderator') AND nm.state = 'joined'
		 	)
		 	OR EXISTS (
		 		SELECT 1 FROM nests n JOIN tree_members tm ON tm.tree_id = n.tree_id
		 		WHERE n.id = k.nest_id AND tm.user_id = ? AND tm.role IN ('owner', 'moderator') AND tm.state = 'joined'
		 	))`+statusClause+`
		 ORDER BY k.created_at DESC`,
		userID, userID, userID, userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanKnocks(rows)
}

func (s *Server) pendingInvitesForUser(userID string) ([]Invitation, error) {
	rows, err := s.db.Query(
		`SELECT ni.id, ni.nest_id, u.id, u.username, COALESCE(NULLIF(TRIM(up.display_name), ''), u.username), ni.created_at
		 FROM nest_invitations ni
		 JOIN users u ON u.id = ni.invited_user_id
		 LEFT JOIN user_preferences up ON up.user_id = u.id
		 JOIN nests n ON n.id = ni.nest_id
		 LEFT JOIN nest_members nm ON nm.nest_id = ni.nest_id AND nm.user_id = ni.invited_user_id
		 WHERE ni.invited_user_id = ? AND n.status = 'active' AND COALESCE(nm.state, 'invited') = 'invited'
		 ORDER BY ni.created_at DESC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	invitations := []Invitation{}
	for rows.Next() {
		var invitation Invitation
		if err := rows.Scan(&invitation.ID, &invitation.NestID, &invitation.UserID, &invitation.Username, &invitation.DisplayName, &invitation.CreatedAt); err != nil {
			return nil, err
		}
		invitations = append(invitations, invitation)
	}
	return invitations, rows.Err()
}

func (s *Server) expireStaleKnocks() error {
	now := database.Now()
	_, err := s.db.Exec(`UPDATE knocks SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND expires_at <= ?`, now, now)
	return err
}

func (s *Server) expireEmptyTemporaryNests() error {
	now := database.Now()
	rows, err := s.db.Query(`SELECT id FROM nests WHERE type = 'temporary' AND status = 'active' AND lifecycle_state = 'empty' AND expires_at IS NOT NULL AND expires_at <= ?`, now)
	if err != nil {
		return err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := s.db.Exec(
			`UPDATE nests SET status = 'ended', lifecycle_state = 'expired', ended_at = ?, archived_at = ?, updated_at = ?, last_activity_at = ? WHERE id = ? AND status = 'active'`,
			now, now, now, now, id,
		); err != nil {
			return err
		}
		_ = s.appendEvent(id, "", "", "nest.expired", map[string]any{"reason": "temporary_empty_ttl"})
		s.broadcastNestUpdate(id, "nest.expired")
	}
	return nil
}

func (s *Server) canViewTree(userID, treeID string) (bool, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM tree_members WHERE tree_id = ? AND user_id = ? AND state = 'joined'`, treeID, userID).Scan(&count)
	return count > 0, err
}

func (s *Server) canManageTree(userID, treeID string) (bool, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM tree_members WHERE tree_id = ? AND user_id = ? AND role IN ('owner', 'moderator') AND state = 'joined'`, treeID, userID).Scan(&count)
	return count > 0, err
}

func (s *Server) treeRole(userID, treeID string) (string, error) {
	var role string
	err := s.db.QueryRow(`SELECT role FROM tree_members WHERE tree_id = ? AND user_id = ? AND state = 'joined'`, treeID, userID).Scan(&role)
	return role, err
}

func (s *Server) isTreeOwner(userID, treeID string) (bool, error) {
	role, err := s.treeRole(userID, treeID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return role == "owner", err
}

func (s *Server) canAssignTreeRole(userID, treeID, role string) (bool, error) {
	if role == "owner" {
		return s.isTreeOwner(userID, treeID)
	}
	return s.canManageTree(userID, treeID)
}

func (s *Server) canRemoveTreeMember(userID, treeID string, member TreeMember) (bool, error) {
	if userID == member.UserID || member.Role == "owner" {
		return s.isTreeOwner(userID, treeID)
	}
	return s.canManageTree(userID, treeID)
}

func (s *Server) ensureTreeHasAnotherOwner(treeID, userID string) error {
	var count int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM tree_members WHERE tree_id = ? AND user_id <> ? AND role = 'owner' AND state = 'joined'`,
		treeID, userID,
	).Scan(&count)
	if err != nil {
		return err
	}
	if count == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "Tree must keep at least one owner")
	}
	return nil
}

func (s *Server) canSeeNestOccupancy(userID, nestID string) (bool, error) {
	return s.canViewNest(userID, nestID)
}

func (s *Server) canJoinDirectly(userID string, nest Nest) (bool, error) {
	state, role, err := s.membershipState(nest.ID, userID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	if state == "joined" || state == "invited" || role == "creator" {
		return true, nil
	}
	if nest.Type == "persistent" && nest.TreeID != nil {
		return s.canViewTree(userID, *nest.TreeID)
	}
	return false, nil
}

func (s *Server) mustKnock(userID string, nest Nest) (bool, error) {
	canJoin, err := s.canJoinDirectly(userID, nest)
	return !canJoin, err
}

func (s *Server) canInvite(userID, nestID string) (bool, error) {
	return s.canModerate(userID, nestID)
}

func (s *Server) canRemove(userID, nestID string) (bool, error) {
	return s.canModerate(userID, nestID)
}

func (s *Server) canCloseTemporaryNest(userID, nestID string) (bool, error) {
	nest, err := s.findNest(nestID)
	if err != nil {
		return false, err
	}
	if nest.Type != "temporary" {
		return false, nil
	}
	return s.canModerate(userID, nestID)
}

func (s *Server) canManagePermanentNest(userID, nestID string) (bool, error) {
	nest, err := s.findNest(nestID)
	if err != nil {
		return false, err
	}
	if nest.Type != "persistent" {
		return false, nil
	}
	return s.canModerate(userID, nestID)
}

func (s *Server) canResolveKnock(userID string, knock Knock) (bool, error) {
	if knock.ToUserID != nil && *knock.ToUserID == userID {
		return true, nil
	}
	if knock.NestID != nil {
		return s.canModerate(userID, *knock.NestID)
	}
	return false, nil
}

func (s *Server) findKnockTargetUser(userID, username string) (User, error) {
	if strings.TrimSpace(userID) != "" {
		return s.findUserByID(strings.TrimSpace(userID))
	}
	return s.findUserByUsername(strings.TrimSpace(username))
}

func normalizeTreeRole(role string) string {
	role = strings.ToLower(strings.TrimSpace(role))
	if role == "" {
		return "member"
	}
	if role == "owner" || role == "moderator" || role == "member" {
		return role
	}
	return ""
}

func normalizeTreeSettings(name, description, joinPolicy, visibility string) (treeSettingsPayload, error) {
	name = strings.Join(strings.Fields(name), " ")
	if name == "" {
		return treeSettingsPayload{}, errors.New("Tree name is required")
	}
	if len([]rune(name)) > 80 {
		return treeSettingsPayload{}, errors.New("Tree name must be 80 characters or fewer")
	}
	description = strings.Join(strings.Fields(description), " ")
	if len([]rune(description)) > 240 {
		return treeSettingsPayload{}, errors.New("Tree description must be 240 characters or fewer")
	}
	joinPolicy = strings.ToLower(strings.TrimSpace(joinPolicy))
	switch joinPolicy {
	case "", "request", "request_required", "join_request":
		joinPolicy = "request"
	case "free", "free_join":
		joinPolicy = "free"
	default:
		return treeSettingsPayload{}, errors.New("Tree join policy must be free or request")
	}
	visibility = strings.ToLower(strings.TrimSpace(visibility))
	switch visibility {
	case "", "private":
		visibility = "private"
	case "public":
		visibility = "public"
	default:
		return treeSettingsPayload{}, errors.New("Tree visibility must be public or private")
	}
	return treeSettingsPayload{Name: name, Description: description, JoinPolicy: joinPolicy, Visibility: visibility}, nil
}

func normalizePresenceState(state string) string {
	state = strings.ToLower(strings.TrimSpace(state))
	switch state {
	case "", "available":
		return "available"
	case "offline", "dnd", "in_nest", "invisible":
		return state
	case "do_not_disturb":
		return "dnd"
	}
	return ""
}

func normalizeReachability(reachability, state string) string {
	reachability = strings.ToLower(strings.TrimSpace(reachability))
	if reachability == "" {
		switch state {
		case "available":
			return "open"
		case "dnd", "invisible", "offline":
			return "unavailable"
		default:
			return "around"
		}
	}
	if reachability == "open" || reachability == "around" || reachability == "focused" || reachability == "unavailable" {
		return reachability
	}
	return ""
}

func normalizeLifecycleState(nestType string) string {
	if nestType == "temporary" {
		return "waiting"
	}
	return "created"
}

func temporaryNestExpiryFrom(now string) string {
	parsed, err := time.Parse(time.RFC3339Nano, now)
	if err != nil {
		parsed = time.Now().UTC()
	}
	return parsed.Add(temporaryNestEmptyTTL()).Format(time.RFC3339Nano)
}

func temporaryNestEmptyTTL() time.Duration {
	return envDurationSeconds("RAVEN_TEMP_NEST_EMPTY_TTL_SECONDS", 600)
}

func knockTTL() time.Duration {
	return envDurationSeconds("RAVEN_KNOCK_TTL_SECONDS", 900)
}

func envDurationSeconds(name string, fallback int) time.Duration {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))
	if err != nil || value <= 0 {
		value = fallback
	}
	return time.Duration(value) * time.Second
}

func nullableStringPtr(value *string) any {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	return strings.TrimSpace(*value)
}

func knockSelectSQL() string {
	return `SELECT k.id, k.from_user_id, fu.username, COALESCE(NULLIF(TRIM(fup.display_name), ''), fu.username),
		k.to_user_id, tu.username, COALESCE(NULLIF(TRIM(tup.display_name), ''), tu.username), k.nest_id, n.name,
		k.status, k.message, k.created_at, k.expires_at, k.resolved_at, k.resolved_by_user_id
		FROM knocks k
		JOIN users fu ON fu.id = k.from_user_id
		LEFT JOIN user_preferences fup ON fup.user_id = fu.id
		LEFT JOIN users tu ON tu.id = k.to_user_id
		LEFT JOIN user_preferences tup ON tup.user_id = tu.id
		LEFT JOIN nests n ON n.id = k.nest_id`
}

func scanKnocks(rows *sql.Rows) ([]Knock, error) {
	defer rows.Close()
	knocks := []Knock{}
	for rows.Next() {
		var knock Knock
		var toUserID, toUsername, toDisplayName, nestID, nestName, message, resolvedAt, resolvedBy sql.NullString
		if err := rows.Scan(
			&knock.ID,
			&knock.FromUserID,
			&knock.FromUsername,
			&knock.FromDisplayName,
			&toUserID,
			&toUsername,
			&toDisplayName,
			&nestID,
			&nestName,
			&knock.Status,
			&message,
			&knock.CreatedAt,
			&knock.ExpiresAt,
			&resolvedAt,
			&resolvedBy,
		); err != nil {
			return nil, err
		}
		knock.ToUserID = nullStringPtr(toUserID)
		knock.ToUsername = nullStringPtr(toUsername)
		knock.ToDisplayName = nullStringPtr(toDisplayName)
		knock.NestID = nullStringPtr(nestID)
		knock.NestName = nullStringPtr(nestName)
		knock.Message = nullStringPtr(message)
		knock.ResolvedAt = nullStringPtr(resolvedAt)
		knock.ResolvedByUserID = nullStringPtr(resolvedBy)
		knocks = append(knocks, knock)
	}
	return knocks, rows.Err()
}

func friendRequestSelectSQL() string {
	return `SELECT fr.id, fr.from_user_id, fu.username, COALESCE(NULLIF(TRIM(fup.display_name), ''), fu.username),
		fr.to_user_id, tu.username, COALESCE(NULLIF(TRIM(tup.display_name), ''), tu.username),
		fr.status, fr.created_at, fr.resolved_at
		FROM friend_requests fr
		JOIN users fu ON fu.id = fr.from_user_id
		LEFT JOIN user_preferences fup ON fup.user_id = fu.id
		JOIN users tu ON tu.id = fr.to_user_id
		LEFT JOIN user_preferences tup ON tup.user_id = tu.id`
}

func treeJoinRequestSelectSQL() string {
	return `SELECT tjr.id, tjr.tree_id, t.name, u.id, u.username, COALESCE(NULLIF(TRIM(up.display_name), ''), u.username),
		tjr.status, tjr.created_at, tjr.resolved_at
		FROM tree_join_requests tjr
		JOIN trees t ON t.id = tjr.tree_id
		JOIN users u ON u.id = tjr.user_id
		LEFT JOIN user_preferences up ON up.user_id = u.id`
}

func scanTreeJoinRequests(rows *sql.Rows) ([]TreeJoinRequest, error) {
	defer rows.Close()
	requests := []TreeJoinRequest{}
	for rows.Next() {
		var request TreeJoinRequest
		var resolvedAt sql.NullString
		if err := rows.Scan(
			&request.ID,
			&request.TreeID,
			&request.TreeName,
			&request.UserID,
			&request.Username,
			&request.DisplayName,
			&request.Status,
			&request.CreatedAt,
			&resolvedAt,
		); err != nil {
			return nil, err
		}
		request.ResolvedAt = nullStringPtr(resolvedAt)
		requests = append(requests, request)
	}
	return requests, rows.Err()
}

func scanFriendRequests(rows *sql.Rows) ([]FriendRequest, error) {
	defer rows.Close()
	requests := []FriendRequest{}
	for rows.Next() {
		var request FriendRequest
		var resolvedAt sql.NullString
		if err := rows.Scan(
			&request.ID,
			&request.FromUserID,
			&request.FromUsername,
			&request.FromDisplayName,
			&request.ToUserID,
			&request.ToUsername,
			&request.ToDisplayName,
			&request.Status,
			&request.CreatedAt,
			&resolvedAt,
		); err != nil {
			return nil, err
		}
		request.ResolvedAt = nullStringPtr(resolvedAt)
		requests = append(requests, request)
	}
	return requests, rows.Err()
}
