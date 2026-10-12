package http

import (
	"strings"

	"github.com/Masterminds/semver/v3"
	"github.com/gofiber/fiber/v2"
)

// Compatibility tells a desktop client whether this server still accepts its version.
// The only rule is RAVEN_MINIMUM_CLIENT_VERSION: raise it when a server change breaks
// older clients, and they are shown an update screen instead of failing in odd ways.
type Compatibility struct {
	Status               string `json:"status"`
	ReasonCode           string `json:"reasonCode"`
	Message              string `json:"message"`
	ClientVersion        string `json:"clientVersion"`
	ServerVersion        string `json:"serverVersion"`
	MinimumClientVersion string `json:"minimumClientVersion"`
}

func (s *Server) compatibility(clientVersion string) Compatibility {
	clientVersion = strings.TrimSpace(clientVersion)
	result := Compatibility{
		Status:               "compatible",
		ReasonCode:           "compatible",
		Message:              "This Raven version works with this server.",
		ClientVersion:        clientVersion,
		ServerVersion:        s.serverVersion,
		MinimumClientVersion: s.minClientVersion,
	}
	if clientVersion == "" {
		result.Status = "unknown"
		result.ReasonCode = "client_version_missing"
		result.Message = "Update Raven to keep using this server."
		return result
	}
	client, err := semver.NewVersion(clientVersion)
	if err != nil {
		result.Status = "upgrade_required"
		result.ReasonCode = "invalid_client_version"
		result.Message = "Update Raven to keep using this server."
		return result
	}
	if minimum, err := semver.NewVersion(s.minClientVersion); err == nil && client.LessThan(minimum) {
		result.Status = "upgrade_required"
		result.ReasonCode = "client_below_minimum"
		result.Message = "This version of Raven is too old for this server. Update to keep going."
	}
	return result
}

func (s *Server) getServerCompatibility(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(fiber.Map{"compatibility": s.compatibility(c.Query("clientVersion"))})
}

// requireCompatibleClient answers 426 for clients older than the server's minimum.
// Sign-in, sign-out, sessions and preferences sit outside it so an old client can still
// reach its settings and update.
func (s *Server) requireCompatibleClient(c *fiber.Ctx) error {
	compatibility := s.compatibility(c.Get("X-Raven-Client-Version"))
	if compatibility.Status == "compatible" {
		return c.Next()
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.Status(fiber.StatusUpgradeRequired).JSON(fiber.Map{
		"error":         compatibility.Message,
		"compatibility": compatibility,
	})
}

func authSessionID(c *fiber.Ctx) string {
	value, _ := c.Locals("authSessionID").(string)
	return value
}
