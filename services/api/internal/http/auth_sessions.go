package http

import (
	"database/sql"
	"errors"
	"runtime"
	"strings"
	"time"

	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

type AuthSession struct {
	ID             string  `json:"id"`
	LatestIP       string  `json:"latestIp"`
	UserAgent      string  `json:"userAgent"`
	OS             string  `json:"os"`
	DeviceName     string  `json:"deviceName"`
	CreatedAt      string  `json:"createdAt"`
	LastAccessedAt string  `json:"lastAccessedAt"`
	ExpiresAt      string  `json:"expiresAt"`
	RevokedAt      *string `json:"revokedAt,omitempty"`
	Current        bool    `json:"current"`
}

func (s *Server) logout(c *fiber.Ctx) error {
	sessionID, _ := c.Locals("authSessionID").(string)
	if sessionID == "" {
		return c.SendStatus(fiber.StatusNoContent)
	}
	now := database.Now()
	if _, err := s.db.Exec(`UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, now, sessionID); err != nil {
		return err
	}
	if err := s.sessions.Delete(sessionID); err != nil {
		return err
	}
	s.endSessionStreams(sessionID)
	// Signing out is also leaving: show the account offline now rather than after the
	// heartbeat window. Another signed-in device restores it with its next heartbeat.
	if user := currentUser(c); user.ID != "" {
		_ = s.markPresenceAway(user.ID)
	}
	c.Set("X-Session-ID", "")
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) listAuthSessions(c *fiber.Ctx) error {
	user := currentUser(c)
	currentID, _ := c.Locals("authSessionID").(string)
	rows, err := s.db.Query(
		`SELECT id, latest_ip, user_agent, os, device_name, created_at, last_accessed_at, expires_at, revoked_at
		 FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_accessed_at DESC`,
		user.ID,
	)
	if err != nil {
		return err
	}
	defer rows.Close()
	sessions := []AuthSession{}
	for rows.Next() {
		var item AuthSession
		var revokedAt sql.NullString
		if err := rows.Scan(&item.ID, &item.LatestIP, &item.UserAgent, &item.OS, &item.DeviceName, &item.CreatedAt, &item.LastAccessedAt, &item.ExpiresAt, &revokedAt); err != nil {
			return err
		}
		if revokedAt.Valid {
			item.RevokedAt = &revokedAt.String
		}
		item.Current = item.ID == currentID
		if !sessionExpired(item.ExpiresAt) {
			sessions = append(sessions, item)
		}
	}
	return c.JSON(fiber.Map{"sessions": sessions})
}

func (s *Server) revokeAuthSession(c *fiber.Ctx) error {
	user := currentUser(c)
	sessionID := c.Params("id")
	var ownerID string
	if err := s.db.QueryRow(`SELECT user_id FROM auth_sessions WHERE id = ? AND revoked_at IS NULL`, sessionID).Scan(&ownerID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fiber.NewError(fiber.StatusNotFound, "session not found")
		}
		return err
	}
	if ownerID != user.ID {
		return fiber.NewError(fiber.StatusNotFound, "session not found")
	}
	now := database.Now()
	if _, err := s.db.Exec(`UPDATE auth_sessions SET revoked_at = ? WHERE id = ?`, now, sessionID); err != nil {
		return err
	}
	if err := s.sessions.Delete(sessionID); err != nil {
		return err
	}
	// A signed-out device must stop receiving at once, not at its next request.
	s.endSessionStreams(sessionID)
	currentID, _ := c.Locals("authSessionID").(string)
	return c.JSON(fiber.Map{"revoked": true, "current": sessionID == currentID})
}

func sessionExpired(value string) bool {
	expiresAt, err := time.Parse(time.RFC3339Nano, value)
	return err != nil || !expiresAt.After(time.Now().UTC())
}

func clientIP(c *fiber.Ctx) string {
	return limited(strings.TrimSpace(c.IP()), 100)
}

func clientOS(c *fiber.Ctx) string {
	if explicit := strings.TrimSpace(c.Get("X-Raven-OS")); explicit != "" {
		return limited(explicit, 100)
	}
	ua := strings.ToLower(c.Get(fiber.HeaderUserAgent))
	switch {
	case strings.Contains(ua, "windows"):
		return "Windows"
	case strings.Contains(ua, "android"):
		return "Android"
	case strings.Contains(ua, "iphone") || strings.Contains(ua, "ipad"):
		return "iOS"
	case strings.Contains(ua, "mac os") || strings.Contains(ua, "macintosh"):
		return "macOS"
	case strings.Contains(ua, "linux"):
		return "Linux"
	default:
		return runtime.GOOS
	}
}

func clientDevice(c *fiber.Ctx) string {
	if explicit := strings.TrimSpace(c.Get("X-Raven-Device")); explicit != "" {
		return limited(explicit, 120)
	}
	return "Raven Desktop"
}

func limited(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) <= max {
		return value
	}
	return value[:max]
}
