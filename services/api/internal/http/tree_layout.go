package http

import (
	"database/sql"
	"errors"
	"sort"
	"strings"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// A tree's layout is how its nests are arranged: named categories, and inside each (or
// above them all) voice nests and text nests in an order its owners and moderators
// choose. It is stored beside the nests rather than on them, so a nest nobody has
// arranged simply comes last.

const (
	treeMaxCategories = 50
	treeMaxTextNests  = 100

	layoutKindVoice = "voice"
	layoutKindText  = "text"
)

type TreeCategory struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Position int    `json:"position"`
}

type TreeLayoutItem struct {
	Kind       string `json:"kind"`
	ID         string `json:"id"`
	CategoryID string `json:"categoryId,omitempty"`
	Position   int    `json:"position"`
}

type TreeLayout struct {
	TreeID     string           `json:"treeId"`
	Categories []TreeCategory   `json:"categories"`
	Items      []TreeLayoutItem `json:"items"`
}

func (s *Server) registerTreeLayoutRoutes(service fiber.Router) {
	service.Get("/trees/:id/layout", s.chatRoute("layout", s.getTreeLayout))
	service.Post("/trees/:id/layout", s.chatRoute("arrange", s.updateTreeLayout))
	service.Post("/trees/:id/categories", s.chatRoute("create category", s.createTreeCategory))
	service.Post("/trees/:id/categories/:categoryId", s.chatRoute("rename category", s.renameTreeCategory))
	service.Delete("/trees/:id/categories/:categoryId", s.chatRoute("delete category", s.deleteTreeCategory))
	service.Post("/trees/:id/text-nests", s.chatRoute("create text nest", s.createTextNest))
}

func (s *Server) requireTreeMember(userID, treeID string) error {
	_, err := s.authorizeTree(s.db, userID, treeID, treeActionView)
	return err
}

func (s *Server) requireTreeManager(userID, treeID string) error {
	_, err := s.authorizeTree(s.db, userID, treeID, treeActionManageRooms)
	return err
}

func (s *Server) getTreeLayout(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if err := s.requireTreeMember(user.ID, treeID); err != nil {
		return err
	}
	layout, err := s.treeLayout(s.db, treeID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"layout": layout})
}

// treeLayout returns every nest of the tree in order. Nests that have not been arranged
// come after the arranged ones, oldest first.
func (s *Server) treeLayout(q chatQuerier, treeID string) (TreeLayout, error) {
	layout := TreeLayout{TreeID: treeID, Categories: []TreeCategory{}, Items: []TreeLayoutItem{}}

	rows, err := q.Query(`SELECT id, name FROM tree_categories WHERE tree_id = ? ORDER BY position, created_at, id`, treeID)
	if err != nil {
		return layout, err
	}
	categoryOrder := map[string]int{}
	for rows.Next() {
		var category TreeCategory
		if err := rows.Scan(&category.ID, &category.Name); err != nil {
			rows.Close()
			return layout, err
		}
		category.Position = len(layout.Categories)
		categoryOrder[category.ID] = category.Position
		layout.Categories = append(layout.Categories, category)
	}
	if err := rows.Close(); err != nil {
		return layout, err
	}

	type placed struct {
		item     TreeLayoutItem
		arranged bool
		position int
		created  string
	}
	items := []placed{}
	scan := func(kind, query string) error {
		rows, err := q.Query(query, kind, treeID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var entry placed
			var categoryID sql.NullString
			var position sql.NullInt64
			if err := rows.Scan(&entry.item.ID, &entry.created, &categoryID, &position); err != nil {
				return err
			}
			entry.item.Kind = kind
			if _, known := categoryOrder[categoryID.String]; known {
				entry.item.CategoryID = categoryID.String
			}
			entry.arranged = position.Valid
			entry.position = int(position.Int64)
			items = append(items, entry)
		}
		return rows.Err()
	}
	if err := scan(layoutKindVoice,
		`SELECT n.id, n.created_at, l.category_id, l.position
		 FROM nests n
		 LEFT JOIN tree_layout_items l ON l.tree_id = n.tree_id AND l.kind = ? AND l.item_id = n.id
		 WHERE n.tree_id = ? AND n.status = 'active'`); err != nil {
		return layout, err
	}
	if err := scan(layoutKindText,
		`SELECT c.id, c.created_at, l.category_id, l.position
		 FROM chat_conversations c
		 LEFT JOIN tree_layout_items l ON l.tree_id = c.tree_id AND l.kind = ? AND l.item_id = c.id
		 WHERE c.tree_id = ? AND c.kind = 'nest' AND c.status = 'active'`); err != nil {
		return layout, err
	}

	sort.SliceStable(items, func(a, b int) bool {
		left, right := items[a], items[b]
		if left.arranged != right.arranged {
			return left.arranged
		}
		if left.arranged && left.position != right.position {
			return left.position < right.position
		}
		if left.created != right.created {
			return left.created < right.created
		}
		return left.item.ID < right.item.ID
	})
	// Positions are renumbered per category so a client can rely on them being dense.
	next := map[string]int{}
	for _, entry := range items {
		entry.item.Position = next[entry.item.CategoryID]
		next[entry.item.CategoryID]++
		layout.Items = append(layout.Items, entry.item)
	}
	return layout, nil
}

// updateTreeLayout replaces the tree's arrangement in one step.
//
// The request lists categories in order, and items in order with the category each sits
// in. Anything named that does not belong to this tree is refused. Anything that exists
// but was left out (a nest someone created while this person was arranging) is kept and
// placed last, so a stale request never loses a nest.
func (s *Server) updateTreeLayout(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if err := s.requireTreeManager(user.ID, treeID); err != nil {
		return err
	}
	var input struct {
		Categories []string `json:"categories"`
		Items      []struct {
			Kind       string `json:"kind"`
			ID         string `json:"id"`
			CategoryID string `json:"categoryId"`
		} `json:"items"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}

	unlock := s.chatLocks.lock("tree-layout:" + treeID)
	defer unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	current, err := s.treeLayout(tx, treeID)
	if err != nil {
		return err
	}
	invalid := fiber.NewError(fiber.StatusBadRequest, "That arrangement is out of date. Reload and try again.")

	knownCategories := map[string]struct{}{}
	for _, category := range current.Categories {
		knownCategories[category.ID] = struct{}{}
	}
	categoryOrder := []string{}
	seenCategories := map[string]struct{}{}
	for _, id := range input.Categories {
		if _, ok := knownCategories[id]; !ok {
			return invalid
		}
		if _, dup := seenCategories[id]; dup {
			return invalid
		}
		seenCategories[id] = struct{}{}
		categoryOrder = append(categoryOrder, id)
	}
	for _, category := range current.Categories {
		if _, ok := seenCategories[category.ID]; !ok {
			categoryOrder = append(categoryOrder, category.ID)
		}
	}

	type key struct{ kind, id string }
	existing := map[key]TreeLayoutItem{}
	for _, item := range current.Items {
		existing[key{item.Kind, item.ID}] = item
	}
	ordered := []TreeLayoutItem{}
	seenItems := map[key]struct{}{}
	for _, item := range input.Items {
		itemKey := key{item.Kind, item.ID}
		if _, ok := existing[itemKey]; !ok {
			return invalid
		}
		if _, dup := seenItems[itemKey]; dup {
			return invalid
		}
		if item.CategoryID != "" {
			if _, ok := knownCategories[item.CategoryID]; !ok {
				return invalid
			}
		}
		seenItems[itemKey] = struct{}{}
		ordered = append(ordered, TreeLayoutItem{Kind: item.Kind, ID: item.ID, CategoryID: item.CategoryID})
	}
	for _, item := range current.Items {
		if _, ok := seenItems[key{item.Kind, item.ID}]; !ok {
			ordered = append(ordered, item)
		}
	}

	now := database.Now()
	for position, id := range categoryOrder {
		if _, err := tx.Exec(`UPDATE tree_categories SET position = ?, updated_at = ? WHERE id = ? AND tree_id = ?`, position, now, id, treeID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`DELETE FROM tree_layout_items WHERE tree_id = ?`, treeID); err != nil {
		return err
	}
	for position, item := range ordered {
		if _, err := tx.Exec(
			`INSERT INTO tree_layout_items (tree_id, kind, item_id, category_id, position) VALUES (?, ?, ?, ?, ?)`,
			treeID, item.Kind, item.ID, nullableString(item.CategoryID), position,
		); err != nil {
			return err
		}
	}
	layout, err := s.treeLayout(tx, treeID)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.publishTree(treeID, "tree.layout_updated")
	return c.JSON(fiber.Map{"layout": layout})
}

func (s *Server) createTreeCategory(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if err := s.requireTreeManager(user.ID, treeID); err != nil {
		return err
	}
	var input struct {
		Name string `json:"name"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	name, err := normalizeChatName(input.Name)
	if err != nil {
		return err
	}

	unlock := s.chatLocks.lock("tree-layout:" + treeID)
	defer unlock()

	var count, last int
	if err := s.db.QueryRow(`SELECT COUNT(*), COALESCE(MAX(position), -1) FROM tree_categories WHERE tree_id = ?`, treeID).Scan(&count, &last); err != nil {
		return err
	}
	if count >= treeMaxCategories {
		return fiber.NewError(fiber.StatusBadRequest, "There are already as many categories here as allowed.")
	}
	now := database.Now()
	category := TreeCategory{ID: auth.NewID(), Name: name, Position: last + 1}
	if _, err := s.db.Exec(
		`INSERT INTO tree_categories (id, tree_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		category.ID, treeID, category.Name, category.Position, now, now,
	); err != nil {
		return err
	}
	s.publishTree(treeID, "tree.layout_updated")
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"category": category})
}

func (s *Server) renameTreeCategory(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if err := s.requireTreeManager(user.ID, treeID); err != nil {
		return err
	}
	var input struct {
		Name string `json:"name"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	name, err := normalizeChatName(input.Name)
	if err != nil {
		return err
	}
	renamed, err := s.db.Exec(
		`UPDATE tree_categories SET name = ?, updated_at = ? WHERE id = ? AND tree_id = ?`,
		name, database.Now(), c.Params("categoryId"), treeID,
	)
	if err != nil {
		return err
	}
	if count, err := renamed.RowsAffected(); err != nil {
		return err
	} else if count != 1 {
		return fiber.NewError(fiber.StatusNotFound, "That category isn’t available.")
	}
	s.publishTree(treeID, "tree.layout_updated")
	return c.JSON(fiber.Map{"category": TreeCategory{ID: c.Params("categoryId"), Name: name}})
}

// deleteTreeCategory removes a category. What was in it stays, uncategorised.
func (s *Server) deleteTreeCategory(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if err := s.requireTreeManager(user.ID, treeID); err != nil {
		return err
	}
	categoryID := c.Params("categoryId")

	unlock := s.chatLocks.lock("tree-layout:" + treeID)
	defer unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE tree_layout_items SET category_id = NULL WHERE tree_id = ? AND category_id = ?`, treeID, categoryID); err != nil {
		return err
	}
	deleted, err := tx.Exec(`DELETE FROM tree_categories WHERE id = ? AND tree_id = ?`, categoryID, treeID)
	if err != nil {
		return err
	}
	if count, err := deleted.RowsAffected(); err != nil {
		return err
	} else if count != 1 {
		return fiber.NewError(fiber.StatusNotFound, "That category isn’t available.")
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.publishTree(treeID, "tree.layout_updated")
	return c.SendStatus(fiber.StatusNoContent)
}

// createTextNest adds a text nest to a tree. Everyone in the tree can read and write in
// it, now and for as long as they stay in the tree.
func (s *Server) createTextNest(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if err := s.requireTreeManager(user.ID, treeID); err != nil {
		return err
	}
	var input struct {
		Name       string `json:"name"`
		CategoryID string `json:"categoryId"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	conversationID, err := s.createTextNestCore(treeID, user.ID, input.Name, input.CategoryID)
	if err != nil {
		return err
	}
	conversation, err := s.chatSummary(s.db, user.ID, conversationID)
	if err != nil {
		return err
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"conversation": conversation})
}

// createTextNestCore adds a text nest to a tree in the name of creatorID and returns the
// new conversation's id. Whether the caller may do so is the caller's to have checked.
func (s *Server) createTextNestCore(treeID, creatorID, name, categoryID string) (string, error) {
	name, err := normalizeChatName(name)
	if err != nil {
		return "", err
	}
	categoryID = strings.TrimSpace(categoryID)

	unlock := s.chatLocks.lock("tree-layout:" + treeID)
	defer unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var existing int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM chat_conversations WHERE tree_id = ? AND kind = 'nest' AND status = 'active'`, treeID).Scan(&existing); err != nil {
		return "", err
	}
	if existing >= treeMaxTextNests {
		return "", fiber.NewError(fiber.StatusBadRequest, "There are already as many of these here as allowed.")
	}
	if categoryID != "" {
		var found string
		err := tx.QueryRow(`SELECT id FROM tree_categories WHERE id = ? AND tree_id = ?`, categoryID, treeID).Scan(&found)
		if errors.Is(err, sql.ErrNoRows) {
			return "", fiber.NewError(fiber.StatusNotFound, "That category isn’t available.")
		}
		if err != nil {
			return "", err
		}
	}
	now := database.Now()
	conversationID := auth.NewID()
	if _, err := tx.Exec(
		`INSERT INTO chat_conversations (id, kind, tree_id, name, creator_user_id, last_activity_ms, created_at, updated_at)
		 VALUES (?, 'nest', ?, ?, ?, ?, ?, ?)`,
		conversationID, treeID, name, creatorID, nowMillis(), now, now,
	); err != nil {
		return "", err
	}
	// Everyone in the tree now gets a read position at the start, so what is written
	// here later counts as unread for them even if they have not opened Raven since.
	if _, err := tx.Exec(
		`INSERT INTO chat_members (conversation_id, user_id, role, state, joined_at, created_at, updated_at)
		 SELECT CAST(? AS TEXT), tm.user_id, 'member', 'joined', CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT)
		 FROM tree_members tm WHERE tm.tree_id = ? AND tm.state = 'joined'`,
		conversationID, now, now, now, treeID,
	); err != nil {
		return "", err
	}
	var last int
	if err := tx.QueryRow(`SELECT COALESCE(MAX(position), -1) FROM tree_layout_items WHERE tree_id = ?`, treeID).Scan(&last); err != nil {
		return "", err
	}
	if _, err := tx.Exec(
		`INSERT INTO tree_layout_items (tree_id, kind, item_id, category_id, position) VALUES (?, 'text', ?, ?, ?)`,
		treeID, conversationID, nullableString(categoryID), last+1,
	); err != nil {
		return "", err
	}
	access := chatAccess{ConversationID: conversationID, Kind: chatKindNest, TreeID: treeID}
	recipients, err := s.chatAudience(tx, access, "")
	if err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}

	s.publishChatEvent(ChatEvent{Type: "conversation.changed", ConversationID: conversationID}, chatRecipientIDs(recipients))
	s.publishTree(treeID, "tree.layout_updated")
	return conversationID, nil
}
