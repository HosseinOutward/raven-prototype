package http

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/updates"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/limiter"
)

func (s *Server) registerPublicUpdateRoutes(v1 fiber.Router) {
	updateRoutes := v1.Group("/updates")
	updateRoutes.Get("/policy", s.updateEnrollmentPolicy)
	updateRoutes.Post("/decision", s.updateDecision)
	updateRoutes.Get("/check/:target/:arch/:currentVersion", s.tauriUpdateCheck)
	updateRoutes.Post("/releases/:id/revalidate", s.revalidateUpdate)
	updateRoutes.Post("/releases/:id/rollback", s.rollbackUpdate)
	updateRoutes.Get("/releases/:id/rollback-check/:target/:arch/:currentVersion", s.tauriRollbackCheck)
	updateRoutes.Post("/outcomes", limiter.New(limiter.Config{Max: 120, Expiration: time.Hour, KeyGenerator: remoteAddressKey}), s.recordUpdateOutcome)
	updateRoutes.Post("/diagnostics", limiter.New(limiter.Config{Max: 20, Expiration: time.Hour, KeyGenerator: remoteAddressKey}), s.recordUpdateDiagnostic)
	updateRoutes.Get("/artifacts/:id/download", s.downloadUpdateArtifact)
}

func (s *Server) updateEnrollmentPolicy(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(fiber.Map{
		"consentVersion":                s.updates.ConsentVersion(),
		"requiredDeliveryData":          []string{"currentVersion", "platform", "architecture", "channel", "cohort", "anonymousInstallationDigest", "rolloutBucket", "protocolVersion", "capabilities", "requestTimestamp", "networkAddressVisibleToServer"},
		"aggregateOutcomesOptional":     true,
		"detailedDiagnosticsOptional":   true,
		"diagnosticRetentionDays":       14,
		"outcomeEventDeduplicationDays": 30,
	})
}

func (s *Server) registerOpsRoutes(authenticated fiber.Router) {
	sessionLimiter := limiter.New(limiter.Config{
		Max:        5,
		Expiration: 10 * time.Minute,
		KeyGenerator: func(c *fiber.Ctx) string {
			return c.IP() + ":" + currentUser(c).ID
		},
		LimitReached: func(c *fiber.Ctx) error {
			return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{"error": "Too many release-operations authentication attempts. Try again later."})
		},
	})
	actionLimiter := limiter.New(limiter.Config{
		Max:        5,
		Expiration: 10 * time.Minute,
		KeyGenerator: func(c *fiber.Ctx) string {
			return c.IP() + ":" + currentUser(c).ID
		},
		LimitReached: func(c *fiber.Ctx) error {
			return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{"error": "Too many high-risk action authorization attempts. Try again later."})
		},
	})
	authenticated.Post("/ops/session", sessionLimiter, s.createOpsSession)
	ops := authenticated.Group("/ops", s.requireOpsSession)
	ops.Post("/authorize-action", actionLimiter, s.authorizeOpsAction)
	ops.Get("/releases", s.opsListReleases)
	ops.Post("/releases", s.opsCreateRelease)
	ops.Get("/releases/:id", s.opsGetRelease)
	ops.Post("/releases/:id/validate", s.opsValidateRelease)
	ops.Post("/releases/:id/publish", s.opsPublishRelease)
	ops.Post("/releases/:id/pause", s.opsPauseRelease)
	ops.Post("/releases/:id/resume", s.opsResumeRelease)
	ops.Post("/releases/:id/withdraw", s.opsWithdrawRelease)
	ops.Post("/releases/:id/supersede", s.opsSupersedeRelease)
	ops.Post("/releases/:id/required", s.opsRequireRelease)
	ops.Post("/releases/:id/rollback-target", s.opsSetRollbackTarget)
	ops.Post("/releases/:id/rollouts", s.opsSetRollouts)
	ops.Get("/channels", s.opsListChannels)
	ops.Post("/channels/:name/enable", s.opsEnableChannel)
	ops.Post("/channels/:name/disable", s.opsDisableChannel)
	ops.Get("/cohorts", s.opsListCohorts)
	ops.Get("/version-blocks", s.opsListVersionBlocks)
	ops.Post("/version-blocks", s.opsCreateVersionBlock)
	ops.Post("/version-blocks/:id/deactivate", s.opsDeactivateVersionBlock)
	ops.Get("/audit", s.opsListAudit)
	ops.Get("/outcomes", s.opsListOutcomes)
	ops.Get("/diagnostics", s.opsListDiagnostics)
}

func (s *Server) getServerCompatibility(c *fiber.Ctx) error {
	protocolVersion, err := parsePositiveInt(c.Query("protocolVersion"))
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "protocolVersion must be a positive integer")
	}
	compatibility, err := s.updates.EffectiveServerCompatibility(c.Query("clientVersion"), protocolVersion, splitCSV(c.Query("capabilities")), c.Query("channel"), c.Query("cohort"))
	if err != nil {
		return updateHTTPError(err)
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(fiber.Map{"compatibility": compatibility})
}

func (s *Server) requireCompatibleClient(c *fiber.Ctx) error {
	clientVersion := strings.TrimSpace(c.Get("X-Raven-Client-Version"))
	protocolVersion, err := parsePositiveInt(c.Get("X-Raven-Protocol-Version"))
	if clientVersion == "" || err != nil {
		return c.Status(fiber.StatusUpgradeRequired).JSON(fiber.Map{
			"error": "Raven client compatibility metadata is required before using communication services.",
			"compatibility": updates.Compatibility{
				Status:     "unknown",
				ReasonCode: "client_metadata_required",
				Message:    "Update Raven or reconnect with a client that reports its version and protocol.",
			},
		})
	}
	channel, err := updates.NormalizeChannel(c.Get("X-Raven-Update-Channel"))
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "X-Raven-Update-Channel must be alpha or stable")
	}
	compatibility, err := s.updates.ServiceAccessCompatibility(clientVersion, protocolVersion, splitCSV(c.Get("X-Raven-Capabilities")), channel, c.Get("X-Raven-Update-Cohort"))
	if err != nil {
		return err
	}
	if compatibility.Status != "compatible" {
		c.Set(fiber.HeaderCacheControl, "no-store")
		return c.Status(fiber.StatusUpgradeRequired).JSON(fiber.Map{
			"error":         compatibility.Message,
			"compatibility": compatibility,
			"serviceAccess": "blocked",
		})
	}
	return c.Next()
}

func (s *Server) updateDecision(c *fiber.Ctx) error {
	var client updates.ClientContext
	if err := c.BodyParser(&client); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid update decision payload")
	}
	if client.ServerVersion == "" {
		client.ServerVersion = s.updates.ServerVersion()
	}
	decision, err := s.updates.Decision(client)
	if err != nil {
		return updateHTTPError(err)
	}
	if err := s.attachDownloadURL(&decision, client.InstallationID); err != nil {
		return updateHTTPError(err)
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(decision)
}

func (s *Server) tauriUpdateCheck(c *fiber.Ctx) error {
	protocolVersion, _ := parsePositiveInt(c.Get("X-Raven-Protocol-Version"))
	consentVersion := strings.TrimSpace(c.Get("X-Raven-Consent-Version"))
	client := updates.ClientContext{
		CurrentVersion:  c.Params("currentVersion"),
		Target:          c.Params("target"),
		Architecture:    c.Params("arch"),
		Channel:         c.Get("X-Raven-Update-Channel"),
		Cohort:          c.Get("X-Raven-Update-Cohort"),
		InstallationID:  c.Get("X-Raven-Installation-ID"),
		ConsentAccepted: consentVersion != "",
		ConsentVersion:  consentVersion,
		ServerVersion:   s.updates.ServerVersion(),
		ProtocolVersion: protocolVersion,
		Capabilities:    splitCSV(c.Get("X-Raven-Capabilities")),
	}
	decision, err := s.updates.Decision(client)
	if err != nil {
		return updateHTTPError(err)
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	if decision.Release == nil || decision.Artifact == nil || !decision.Eligible {
		return c.SendStatus(fiber.StatusNoContent)
	}
	if err := s.attachDownloadURL(&decision, client.InstallationID); err != nil {
		return updateHTTPError(err)
	}
	pubDate := decision.Release.CreatedAt
	if decision.Release.PublishedAt != nil {
		pubDate = *decision.Release.PublishedAt
	}
	return c.JSON(updates.TauriUpdate{
		Version:                   decision.Release.Version,
		Notes:                     decision.Release.Notes,
		PubDate:                   pubDate,
		URL:                       decision.Artifact.DownloadURL,
		Signature:                 decision.Artifact.Signature,
		ReleaseID:                 decision.Release.ID,
		Classification:            decision.Classification,
		Size:                      decision.Artifact.Size,
		SHA256:                    decision.Artifact.SHA256,
		Decision:                  decision.Decision,
		ReasonCode:                decision.ReasonCode,
		Message:                   decision.Message,
		Compatibility:             decision.Compatibility,
		LocalDataSchemaVersion:    decision.Release.LocalDataSchemaVersion,
		LocalMigrationReversible:  decision.Release.LocalMigrationReversible,
		RollbackSafe:              decision.Release.RollbackSafe,
		ApprovedRollbackReleaseID: decision.Release.ApprovedRollbackReleaseID,
	})
}

func (s *Server) tauriRollbackCheck(c *fiber.Ctx) error {
	protocolVersion, _ := parsePositiveInt(c.Get("X-Raven-Protocol-Version"))
	consentVersion := strings.TrimSpace(c.Get("X-Raven-Consent-Version"))
	client := updates.ClientContext{
		CurrentVersion:  c.Params("currentVersion"),
		Target:          c.Params("target"),
		Architecture:    c.Params("arch"),
		Channel:         c.Get("X-Raven-Update-Channel"),
		Cohort:          c.Get("X-Raven-Update-Cohort"),
		InstallationID:  c.Get("X-Raven-Installation-ID"),
		ConsentAccepted: consentVersion != "",
		ConsentVersion:  consentVersion,
		ServerVersion:   s.updates.ServerVersion(),
		ProtocolVersion: protocolVersion,
		Capabilities:    splitCSV(c.Get("X-Raven-Capabilities")),
	}
	decision, err := s.updates.RollbackDecision(c.Params("id"), client)
	if err != nil {
		return updateHTTPError(err)
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	if decision.Decision != "rollback_available" || decision.Release == nil || decision.Artifact == nil || !decision.Eligible {
		return c.SendStatus(fiber.StatusNoContent)
	}
	if err := s.attachDownloadURL(&decision, client.InstallationID); err != nil {
		return updateHTTPError(err)
	}
	source, err := s.updates.Store().GetRelease(c.Params("id"))
	if err != nil {
		return updateHTTPError(err)
	}
	pubDate := decision.Release.CreatedAt
	if decision.Release.PublishedAt != nil {
		pubDate = *decision.Release.PublishedAt
	}
	return c.JSON(updates.TauriUpdate{
		Version:                   decision.Release.Version,
		Notes:                     decision.Release.Notes,
		PubDate:                   pubDate,
		URL:                       decision.Artifact.DownloadURL,
		Signature:                 decision.Artifact.Signature,
		ReleaseID:                 decision.Release.ID,
		Classification:            decision.Classification,
		Size:                      decision.Artifact.Size,
		SHA256:                    decision.Artifact.SHA256,
		Decision:                  decision.Decision,
		ReasonCode:                decision.ReasonCode,
		Message:                   decision.Message,
		Compatibility:             decision.Compatibility,
		LocalDataSchemaVersion:    source.LocalDataSchemaVersion,
		LocalMigrationReversible:  source.LocalMigrationReversible,
		RollbackSafe:              source.RollbackSafe,
		ApprovedRollbackReleaseID: source.ApprovedRollbackReleaseID,
	})
}

func (s *Server) revalidateUpdate(c *fiber.Ctx) error {
	var client updates.ClientContext
	if err := c.BodyParser(&client); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid update revalidation payload")
	}
	if client.ServerVersion == "" {
		client.ServerVersion = s.updates.ServerVersion()
	}
	decision, err := s.updates.Revalidate(c.Params("id"), client)
	if err != nil {
		return updateHTTPError(err)
	}
	if err := s.attachDownloadURL(&decision, client.InstallationID); err != nil {
		return updateHTTPError(err)
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(decision)
}

func (s *Server) rollbackUpdate(c *fiber.Ctx) error {
	var client updates.ClientContext
	if err := c.BodyParser(&client); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid rollback decision payload")
	}
	if client.ServerVersion == "" {
		client.ServerVersion = s.updates.ServerVersion()
	}
	decision, err := s.updates.RollbackDecision(c.Params("id"), client)
	if err != nil {
		return updateHTTPError(err)
	}
	if err := s.attachDownloadURL(&decision, client.InstallationID); err != nil {
		return updateHTTPError(err)
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(decision)
}

func (s *Server) attachDownloadURL(decision *updates.Decision, installationID string) error {
	if decision.Release == nil || decision.Artifact == nil || !decision.Eligible {
		return nil
	}
	token, err := s.updates.IssueDownloadGrant(*decision.Artifact, *decision.Release, installationID)
	if err != nil {
		return err
	}
	decision.Artifact.DownloadURL = fmt.Sprintf("%s/v1/updates/artifacts/%s/download?token=%s", s.updatePublicURL, url.PathEscape(decision.Artifact.ID), url.QueryEscape(token))
	return nil
}

func (s *Server) downloadUpdateArtifact(c *fiber.Ctx) error {
	location, err := s.updates.PresignArtifact(c.UserContext(), c.Params("id"), c.Query("token"))
	if err != nil {
		return updateHTTPError(err)
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.Redirect(location, fiber.StatusTemporaryRedirect)
}

func (s *Server) recordUpdateOutcome(c *fiber.Ctx) error {
	if len(c.Body()) > 32*1024 {
		return fiber.NewError(fiber.StatusRequestEntityTooLarge, "update outcome payload exceeds 32 KiB")
	}
	var input updates.OutcomeInput
	if err := c.BodyParser(&input); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid update outcome payload")
	}
	recorded, err := s.updates.RecordOutcome(input)
	if err != nil {
		return updateHTTPError(err)
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	if !input.Consent {
		return c.SendStatus(fiber.StatusNoContent)
	}
	status := fiber.StatusAccepted
	if !recorded {
		status = fiber.StatusOK
	}
	return c.Status(status).JSON(fiber.Map{"accepted": true, "recorded": recorded})
}

func (s *Server) recordUpdateDiagnostic(c *fiber.Ctx) error {
	if len(c.Body()) > 256*1024 {
		return fiber.NewError(fiber.StatusRequestEntityTooLarge, "update diagnostic payload exceeds 256 KiB")
	}
	var input updates.DiagnosticInput
	if err := c.BodyParser(&input); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid update diagnostic payload")
	}
	report, err := s.updates.RecordDiagnostic(input)
	if err != nil {
		return updateHTTPError(err)
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	if !input.Consent {
		return c.SendStatus(fiber.StatusNoContent)
	}
	return c.Status(fiber.StatusAccepted).JSON(fiber.Map{"accepted": true, "reportId": report.ID, "expiresAt": report.ExpiresAt})
}

func (s *Server) createOpsSession(c *fiber.Ctx) error {
	var body struct {
		Password string `json:"password"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid release-operations session payload")
	}
	user := currentUser(c)
	session, err := s.updates.CreateOpsSession(user.ID, authSessionID(c), body.Password)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, "Release-administrator access and a valid password are required.")
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(fiber.Map{"opsSessionToken": session.Token, "expiresAt": session.ExpiresAt})
}

func (s *Server) requireOpsSession(c *fiber.Ctx) error {
	user := currentUser(c)
	if err := s.updates.ValidateOpsSession(c.Get("X-Raven-Ops-Session"), user.ID, authSessionID(c)); err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, "A current release-operations session is required.")
	}
	return c.Next()
}

func (s *Server) authorizeOpsAction(c *fiber.Ctx) error {
	var body struct {
		Password string `json:"password"`
		Action   string `json:"action"`
		Subject  string `json:"subject"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid action authorization payload")
	}
	user := currentUser(c)
	authorization, err := s.updates.AuthorizeAction(c.Get("X-Raven-Ops-Session"), user.ID, authSessionID(c), body.Password, body.Action, body.Subject)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, "The high-risk action could not be authorized.")
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(fiber.Map{"actionAuthorizationToken": authorization.Token, "expectedConfirmation": authorization.ExpectedConfirmation, "expiresAt": authorization.ExpiresAt})
}

func (s *Server) opsListReleases(c *fiber.Ctx) error {
	releases, err := s.updates.Store().ListReleases()
	if err != nil {
		return updateHTTPError(err)
	}
	return c.JSON(fiber.Map{"releases": releases})
}

func (s *Server) opsCreateRelease(c *fiber.Ctx) error {
	var input updates.CreateReleaseInput
	if err := c.BodyParser(&input); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid release payload")
	}
	release, err := s.updates.CreateRelease(input, s.updateActor(c))
	if err != nil {
		return updateHTTPError(err)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"release": release})
}

func (s *Server) opsGetRelease(c *fiber.Ctx) error {
	release, err := s.updates.Store().GetRelease(c.Params("id"))
	if err != nil {
		return updateHTTPError(err)
	}
	return c.JSON(fiber.Map{"release": release})
}

func (s *Server) opsValidateRelease(c *fiber.Ctx) error {
	release, err := s.updates.ValidateRelease(c.UserContext(), c.Params("id"), s.updateActor(c))
	if err != nil {
		return updateHTTPError(err)
	}
	return c.JSON(fiber.Map{"release": release})
}

func (s *Server) opsPublishRelease(c *fiber.Ctx) error {
	var body struct {
		State        string                 `json:"state"`
		Rollouts     []updates.RolloutInput `json:"rollouts"`
		Reason       string                 `json:"reason"`
		Confirmation string                 `json:"confirmation"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid publish payload")
	}
	release, err := s.updates.Store().GetRelease(c.Params("id"))
	if err != nil {
		return updateHTTPError(err)
	}
	if err := s.validateRollouts(body.Rollouts); err != nil {
		return updateHTTPError(err)
	}
	if strings.TrimSpace(body.Reason) == "" {
		return fiber.NewError(fiber.StatusBadRequest, "a publish reason is required")
	}
	if release.Classification == updates.ClassificationRequired {
		if err := s.consumeHighRisk(c, "publish_required", release.ID, body.Confirmation, body.Reason); err != nil {
			return err
		}
	}
	target := strings.ToLower(strings.TrimSpace(body.State))
	if target == "" {
		target = updates.StateRollingOut
	}
	release, err = s.updates.Store().Publish(release.ID, target, body.Rollouts, body.Reason, s.updateActor(c), time.Now())
	if err != nil {
		return updateHTTPError(err)
	}
	return c.JSON(fiber.Map{"release": release})
}

func (s *Server) opsPauseRelease(c *fiber.Ctx) error {
	return s.simpleReleaseTransition(c, updates.StatePaused, false)
}

func (s *Server) opsResumeRelease(c *fiber.Ctx) error {
	release, err := s.updates.Store().GetRelease(c.Params("id"))
	if err != nil {
		return updateHTTPError(err)
	}
	if release.PausedFromState == nil {
		return updateHTTPError(updates.ErrConflict)
	}
	return s.simpleReleaseTransition(c, *release.PausedFromState, false)
}

func (s *Server) opsWithdrawRelease(c *fiber.Ctx) error {
	return s.simpleReleaseTransition(c, updates.StateWithdrawn, true)
}

func (s *Server) simpleReleaseTransition(c *fiber.Ctx, target string, highRisk bool) error {
	var body struct {
		Reason       string `json:"reason"`
		Confirmation string `json:"confirmation"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid release action payload")
	}
	if strings.TrimSpace(body.Reason) == "" {
		return fiber.NewError(fiber.StatusBadRequest, "a reason is required")
	}
	if highRisk {
		if err := s.consumeHighRisk(c, "withdraw_release", c.Params("id"), body.Confirmation, body.Reason); err != nil {
			return err
		}
	}
	release, err := s.updates.Store().UpdateReleaseState(c.Params("id"), target, body.Reason, s.updateActor(c), time.Now())
	if err != nil {
		return updateHTTPError(err)
	}
	return c.JSON(fiber.Map{"release": release})
}

func (s *Server) opsSupersedeRelease(c *fiber.Ctx) error {
	var body struct {
		NewerReleaseID string `json:"newerReleaseId"`
		Reason         string `json:"reason"`
	}
	if err := c.BodyParser(&body); err != nil || strings.TrimSpace(body.Reason) == "" {
		return fiber.NewError(fiber.StatusBadRequest, "newerReleaseId and reason are required")
	}
	release, err := s.updates.Store().Supersede(c.Params("id"), body.NewerReleaseID, body.Reason, s.updateActor(c), time.Now())
	if err != nil {
		return updateHTTPError(err)
	}
	return c.JSON(fiber.Map{"release": release})
}

func (s *Server) opsRequireRelease(c *fiber.Ctx) error {
	var body struct {
		Reason       string `json:"reason"`
		Confirmation string `json:"confirmation"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid required-release payload")
	}
	if err := s.consumeHighRisk(c, "publish_required", c.Params("id"), body.Confirmation, body.Reason); err != nil {
		return err
	}
	release, err := s.updates.Store().SetRequired(c.Params("id"), body.Reason, s.updateActor(c), time.Now())
	if err != nil {
		return updateHTTPError(err)
	}
	return c.JSON(fiber.Map{"release": release})
}

func (s *Server) opsSetRollbackTarget(c *fiber.Ctx) error {
	var body struct {
		TargetReleaseID *string `json:"targetReleaseId"`
		Reason          string  `json:"reason"`
	}
	if err := c.BodyParser(&body); err != nil || strings.TrimSpace(body.Reason) == "" {
		return fiber.NewError(fiber.StatusBadRequest, "rollback target and reason are required")
	}
	release, err := s.updates.Store().SetRollbackTarget(c.Params("id"), body.TargetReleaseID, body.Reason, s.updateActor(c), time.Now())
	if err != nil {
		return updateHTTPError(err)
	}
	return c.JSON(fiber.Map{"release": release})
}

func (s *Server) opsSetRollouts(c *fiber.Ctx) error {
	var body struct {
		Rollouts []updates.RolloutInput `json:"rollouts"`
		Reason   string                 `json:"reason"`
	}
	if err := c.BodyParser(&body); err != nil || strings.TrimSpace(body.Reason) == "" {
		return fiber.NewError(fiber.StatusBadRequest, "rollouts and reason are required")
	}
	if err := s.validateRollouts(body.Rollouts); err != nil {
		return updateHTTPError(err)
	}
	release, err := s.updates.Store().SetRollouts(c.Params("id"), body.Rollouts, body.Reason, s.updateActor(c), time.Now())
	if err != nil {
		return updateHTTPError(err)
	}
	return c.JSON(fiber.Map{"release": release})
}

func (s *Server) opsListChannels(c *fiber.Ctx) error {
	channels, err := s.updates.Store().ListChannels()
	if err != nil {
		return updateHTTPError(err)
	}
	return c.JSON(fiber.Map{"channels": channels})
}

func (s *Server) opsEnableChannel(c *fiber.Ctx) error {
	return s.setOpsChannel(c, true)
}

func (s *Server) opsDisableChannel(c *fiber.Ctx) error {
	return s.setOpsChannel(c, false)
}

func (s *Server) setOpsChannel(c *fiber.Ctx, enabled bool) error {
	var body struct {
		Reason       string `json:"reason"`
		Confirmation string `json:"confirmation"`
	}
	if err := c.BodyParser(&body); err != nil || strings.TrimSpace(body.Reason) == "" {
		return fiber.NewError(fiber.StatusBadRequest, "a channel action reason is required")
	}
	name, err := updates.NormalizeChannel(c.Params("name"))
	if err != nil {
		return updateHTTPError(err)
	}
	if !enabled {
		if err := s.consumeHighRisk(c, "disable_channel", name, body.Confirmation, body.Reason); err != nil {
			return err
		}
	}
	channel, err := s.updates.Store().SetChannel(name, enabled, body.Reason, s.updateActor(c), time.Now())
	if err != nil {
		return updateHTTPError(err)
	}
	return c.JSON(fiber.Map{"channel": channel})
}

func (s *Server) opsListCohorts(c *fiber.Ctx) error {
	cohorts, err := s.updates.Store().ListCohorts()
	if err != nil {
		return updateHTTPError(err)
	}
	return c.JSON(fiber.Map{"cohorts": cohorts})
}

func (s *Server) opsListVersionBlocks(c *fiber.Ctx) error {
	blocks, err := s.updates.Store().ListVersionBlocks(false)
	if err != nil {
		return updateHTTPError(err)
	}
	return c.JSON(fiber.Map{"versionBlocks": blocks})
}

func (s *Server) opsCreateVersionBlock(c *fiber.Ctx) error {
	var body struct {
		Range           string  `json:"range"`
		Channel         *string `json:"channel"`
		Reason          string  `json:"reason"`
		TargetReleaseID *string `json:"targetReleaseId"`
		Confirmation    string  `json:"confirmation"`
	}
	if err := c.BodyParser(&body); err != nil || strings.TrimSpace(body.Reason) == "" {
		return fiber.NewError(fiber.StatusBadRequest, "version range and reason are required")
	}
	if err := updates.ValidateVersionRange(body.Range); err != nil {
		return updateHTTPError(err)
	}
	if body.Channel != nil {
		channel, err := updates.NormalizeChannel(*body.Channel)
		if err != nil {
			return updateHTTPError(err)
		}
		body.Channel = &channel
	}
	if err := s.consumeHighRisk(c, "block_version", body.Range, body.Confirmation, body.Reason); err != nil {
		return err
	}
	block, err := s.updates.CreateVersionBlock(updates.VersionBlock{VersionRange: body.Range, Channel: body.Channel, Reason: body.Reason, TargetReleaseID: body.TargetReleaseID}, s.updateActor(c))
	if err != nil {
		return updateHTTPError(err)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"versionBlock": block})
}

func (s *Server) opsDeactivateVersionBlock(c *fiber.Ctx) error {
	var body struct {
		Reason       string `json:"reason"`
		Confirmation string `json:"confirmation"`
	}
	if err := c.BodyParser(&body); err != nil || strings.TrimSpace(body.Reason) == "" {
		return fiber.NewError(fiber.StatusBadRequest, "a version-block deactivation reason is required")
	}
	block, err := s.updates.Store().GetVersionBlock(c.Params("id"))
	if err != nil {
		return updateHTTPError(err)
	}
	if err := s.consumeHighRisk(c, "unblock_version", block.VersionRange, body.Confirmation, body.Reason); err != nil {
		return err
	}
	block, err = s.updates.Store().DeactivateVersionBlock(block.ID, body.Reason, s.updateActor(c), time.Now())
	if err != nil {
		return updateHTTPError(err)
	}
	return c.JSON(fiber.Map{"versionBlock": block})
}

func (s *Server) opsListAudit(c *fiber.Ctx) error {
	events, err := s.updates.Store().ListAudit(queryLimit(c, 200))
	if err != nil {
		return updateHTTPError(err)
	}
	return c.JSON(fiber.Map{"audit": events})
}

func (s *Server) opsListOutcomes(c *fiber.Ctx) error {
	outcomes, err := s.updates.Store().ListOutcomes(queryLimit(c, 1000))
	if err != nil {
		return updateHTTPError(err)
	}
	return c.JSON(fiber.Map{"outcomes": outcomes})
}

func (s *Server) opsListDiagnostics(c *fiber.Ctx) error {
	reports, err := s.updates.Store().ListDiagnostics(queryLimit(c, 200), time.Now())
	if err != nil {
		return updateHTTPError(err)
	}
	return c.JSON(fiber.Map{"diagnostics": reports})
}

func (s *Server) consumeHighRisk(c *fiber.Ctx, action, subject, confirmation, reason string) error {
	user := currentUser(c)
	if err := s.updates.ConsumeAction(c.Get("X-Raven-Ops-Session"), c.Get("X-Raven-Action-Authorization"), user.ID, action, subject, confirmation, reason); err != nil {
		return fiber.NewError(fiber.StatusForbidden, "A matching unexpired action authorization, exact confirmation phrase, and reason are required.")
	}
	return nil
}

func (s *Server) updateActor(c *fiber.Ctx) updates.Actor {
	user := currentUser(c)
	userID := user.ID
	correlationID := strings.TrimSpace(c.Get("X-Request-ID"))
	if correlationID == "" || len(correlationID) > 128 {
		correlationID = auth.NewID()
	}
	c.Set("X-Request-ID", correlationID)
	return updates.Actor{UserID: &userID, Label: user.Username, CorrelationID: correlationID, IdempotencyKey: limited(c.Get("X-Idempotency-Key"), 128)}
}

func (s *Server) validateRollouts(inputs []updates.RolloutInput) error {
	if len(inputs) == 0 {
		return errors.New("at least one rollout is required")
	}
	seen := map[string]bool{}
	for index := range inputs {
		inputs[index].Cohort = strings.ToLower(strings.TrimSpace(inputs[index].Cohort))
		if inputs[index].Percentage < 0 || inputs[index].Percentage > 100 || seen[inputs[index].Cohort] {
			return errors.New("rollout cohorts must be unique and percentages must be between 0 and 100")
		}
		active, err := s.updates.Store().CohortActive(inputs[index].Cohort)
		if err != nil || !active {
			return errors.New("rollout cohort is unavailable")
		}
		seen[inputs[index].Cohort] = true
	}
	return nil
}

func authSessionID(c *fiber.Ctx) string {
	value, _ := c.Locals("authSessionID").(string)
	return value
}

func parsePositiveInt(value string) (int, error) {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed < 1 {
		return 0, errors.New("positive integer required")
	}
	return parsed, nil
}

func queryLimit(c *fiber.Ctx, fallback int) int {
	value, err := strconv.Atoi(c.Query("limit"))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func updateHTTPError(err error) error {
	switch {
	case errors.Is(err, updates.ErrNotFound):
		return fiber.NewError(fiber.StatusNotFound, "update resource not found")
	case errors.Is(err, updates.ErrConflict):
		return fiber.NewError(fiber.StatusConflict, strings.TrimSpace(err.Error()))
	default:
		return fiber.NewError(fiber.StatusBadRequest, strings.TrimSpace(err.Error()))
	}
}

func remoteAddressKey(c *fiber.Ctx) string {
	return c.IP()
}
