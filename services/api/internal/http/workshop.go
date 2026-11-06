package http

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"unicode"

	"raven/services/api/internal/database"
	"raven/services/api/internal/relay"

	"github.com/gofiber/fiber/v2"
)

// The Workshop's port sharing: this file is the control plane. It decides who may share a
// port, in which place and for whom, and keeps the registry in internal/relay in step
// with who is in a call or a room. The bytes themselves move through the QUIC relay in
// internal/relay, which never dials out: it only joins two Raven clients.

const (
	workshopPlaceNest = "nest"
	workshopPlaceRoom = "room"
)

var (
	errWorkshopOff        = fiber.NewError(fiber.StatusForbidden, "Port sharing is turned off on this server.")
	errWorkshopShareCap   = fiber.NewError(fiber.StatusForbidden, "Your account can’t share ports.")
	errWorkshopUseCap     = fiber.NewError(fiber.StatusForbidden, "Your account can’t connect to shared ports.")
	errWorkshopNotInCall  = fiber.NewError(fiber.StatusForbidden, "Join the call to share or use a port in it.")
	errWorkshopPlace      = fiber.NewError(fiber.StatusNotFound, "That place isn’t available.")
	errWorkshopDailyLimit = fiber.NewError(fiber.StatusTooManyRequests, "You have used the day’s port sharing traffic this server allows. It resets at midnight UTC.")
)

// workshopRelayEndpoints are the routes clients may try, from RAVEN_RELAY_ENDPOINTS, for
// example "quic://relay.example:7443,wss://example/relay".
func workshopRelayEndpoints() []string {
	return splitCSV(os.Getenv("RAVEN_RELAY_ENDPOINTS"))
}

func (s *Server) registerWorkshopRoutes(r fiber.Router) {
	r.Get("/workshop/config", s.workshopConfig)
	r.Post("/workshop/shares", s.createWorkshopShare)
	r.Post("/workshop/shares/:id/extend", s.extendWorkshopShare)
	r.Delete("/workshop/shares/:id", s.deleteWorkshopShare)
	r.Get("/workshop/places/:kind/:id/shares", s.listWorkshopShares)
}

func (s *Server) workshopConfig(c *fiber.Ctx) error {
	limits := s.workshop.Limits()
	return c.JSON(fiber.Map{
		"enabled":   limits.Enabled,
		"endpoints": workshopRelayEndpoints(),
		"limits": fiber.Map{
			"maxShares":      limits.MaxShares,
			"maxConsumers":   limits.MaxConsumers,
			"maxFlows":       limits.MaxFlows,
			"shareMbps":      limits.ShareMbps,
			"dailyBytes":     limits.DailyBytes,
			"defaultMinutes": limits.DefaultMinutes,
			"maxMinutes":     limits.MaxMinutes,
		},
	})
}

// workshopPlace is a place a share can live in, resolved.
type workshopPlace struct {
	kind string
	id   string
	// members is everyone who belongs to the place, in or out of the call.
	members []string
}

// workshopAccess decides whether a person may use a place for port sharing: in a voice
// nest they must be in the call, in a text room they must be a member. It returns the
// place's members. It is called when a share is made, when a connection opens and again
// whenever someone leaves, so being let in once is never enough.
func (s *Server) workshopAccess(user User, kind, placeID string) (workshopPlace, error) {
	place := workshopPlace{kind: kind, id: placeID}
	switch kind {
	case workshopPlaceNest:
		nest, err := s.findNest(placeID)
		if errors.Is(err, sql.ErrNoRows) {
			return place, errWorkshopPlace
		}
		if err != nil {
			return place, err
		}
		if err := s.requireNestEntry(user, nest); err != nil {
			return place, err
		}
		inCall, err := s.inNestCall(user.ID, nest.ID)
		if err != nil {
			return place, err
		}
		if !inCall {
			return place, errWorkshopNotInCall
		}
		_, place.members, err = s.nestAudience(nest.ID)
		return place, err
	case workshopPlaceRoom:
		access, err := s.chatAccessFor(s.db, placeID, user.ID)
		if err != nil {
			return place, err
		}
		if access.Kind != chatKindNest {
			return place, errWorkshopPlace
		}
		place.members, err = s.treeMemberIDs(access.TreeID)
		return place, err
	}
	return place, errWorkshopPlace
}

// workshopMayView is workshopAccess without the call requirement: someone in a nest's
// tree or a room may see what is shared there before joining the call.
func (s *Server) workshopMayView(user User, kind, placeID string) error {
	switch kind {
	case workshopPlaceNest:
		ok, err := s.canSeeInsideNest(user.ID, placeID)
		if err != nil {
			return err
		}
		if !ok {
			return errWorkshopPlace
		}
		return nil
	case workshopPlaceRoom:
		access, err := s.chatAccessFor(s.db, placeID, user.ID)
		if err != nil {
			return err
		}
		if access.Kind != chatKindNest {
			return errWorkshopPlace
		}
		return nil
	}
	return errWorkshopPlace
}

func (s *Server) inNestCall(userID, nestID string) (bool, error) {
	var count int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM session_participants sp
		 JOIN nest_sessions ns ON ns.id = sp.session_id
		 WHERE sp.nest_id = ? AND sp.user_id = ? AND sp.left_at IS NULL AND ns.ended_at IS NULL`,
		nestID, userID,
	).Scan(&count)
	return count > 0, err
}

func (s *Server) requireWorkshopOn() error {
	if !s.workshop.Limits().Enabled {
		return errWorkshopOff
	}
	return nil
}

type createShareBody struct {
	PlaceKind string          `json:"placeKind"`
	PlaceID   string          `json:"placeId"`
	Name      string          `json:"name"`
	Protocol  string          `json:"protocol"`
	Port      int             `json:"port"`
	Audience  json.RawMessage `json:"audience"`
	Minutes   int             `json:"minutes"`
}

func cleanShareName(name string, protocol string, port int) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(name) {
		if unicode.IsControl(r) {
			continue
		}
		b.WriteRune(r)
	}
	out := strings.TrimSpace(b.String())
	if runes := []rune(out); len(runes) > 40 {
		out = string(runes[:40])
	}
	if out == "" {
		out = fmt.Sprintf("Port %d", port)
	}
	return out
}

func (s *Server) createWorkshopShare(c *fiber.Ctx) error {
	if err := s.requireWorkshopOn(); err != nil {
		return err
	}
	user := currentUser(c)
	caps, err := s.userCapabilities(user)
	if err != nil {
		return err
	}
	if !caps.SharePorts {
		return errWorkshopShareCap
	}
	var body createShareBody
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "That isn’t a valid share.")
	}
	limits := s.workshop.Limits()
	switch body.Protocol {
	case "tcp", "udp", "both":
	default:
		return fiber.NewError(fiber.StatusBadRequest, "Choose TCP, UDP or both.")
	}
	if body.Port < 1 || body.Port > 65535 {
		return fiber.NewError(fiber.StatusBadRequest, "A port number is between 1 and 65535.")
	}
	if body.Minutes < 0 || body.Minutes > limits.MaxMinutes {
		return fiber.NewError(fiber.StatusBadRequest, fmt.Sprintf("A share can last at most %d minutes on this server.", limits.MaxMinutes))
	}
	if s.workshop.Usage.Exhausted(user.ID) {
		return errWorkshopDailyLimit
	}
	place, err := s.workshopAccess(user, body.PlaceKind, body.PlaceID)
	if err != nil {
		return err
	}
	spec := relay.Spec{
		PublisherID: user.ID,
		PlaceKind:   body.PlaceKind,
		PlaceID:     body.PlaceID,
		Protocol:    body.Protocol,
		Port:        body.Port,
		Name:        cleanShareName(body.Name, body.Protocol, body.Port),
	}
	var all string
	var picked []string
	switch {
	case len(body.Audience) == 0 || json.Unmarshal(body.Audience, &all) == nil && all == "all":
		spec.Everyone = true
	case json.Unmarshal(body.Audience, &picked) == nil && len(picked) > 0:
		members := map[string]bool{}
		for _, id := range place.members {
			members[id] = true
		}
		for _, id := range picked {
			if id == user.ID {
				continue
			}
			if !members[id] {
				return fiber.NewError(fiber.StatusBadRequest, "You can only share with people who are in this place.")
			}
			spec.Audience = append(spec.Audience, id)
		}
		if len(spec.Audience) == 0 {
			return fiber.NewError(fiber.StatusBadRequest, "Pick at least one person, or share with everyone.")
		}
	default:
		return fiber.NewError(fiber.StatusBadRequest, "Share with everyone or pick people.")
	}
	share, err := s.workshop.Create(spec, body.Minutes)
	if err != nil {
		return workshopHTTPError(err)
	}
	info, _ := s.workshop.Info(share.ID)
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"share": info})
}

// workshopHTTPError turns a registry error into the response the client shows.
func workshopHTTPError(err error) error {
	var limit *relay.LimitError
	switch {
	case errors.As(err, &limit):
		return fiber.NewError(fiber.StatusTooManyRequests, limit.Message)
	case errors.Is(err, relay.ErrNotFound):
		return fiber.NewError(fiber.StatusNotFound, err.Error())
	case errors.Is(err, relay.ErrNotYours):
		return fiber.NewError(fiber.StatusForbidden, err.Error())
	}
	return err
}

func (s *Server) extendWorkshopShare(c *fiber.Ctx) error {
	if err := s.requireWorkshopOn(); err != nil {
		return err
	}
	var body struct {
		Minutes int `json:"minutes"`
	}
	if err := c.BodyParser(&body); err != nil || body.Minutes < 1 {
		return fiber.NewError(fiber.StatusBadRequest, "Say how many minutes to extend by.")
	}
	if max := s.workshop.Limits().MaxMinutes; body.Minutes > max {
		return fiber.NewError(fiber.StatusBadRequest, fmt.Sprintf("A share can last at most %d minutes on this server.", max))
	}
	info, err := s.workshop.Extend(c.Params("id"), currentUser(c).ID, body.Minutes)
	if err != nil {
		return workshopHTTPError(err)
	}
	return c.JSON(fiber.Map{"share": info})
}

func (s *Server) deleteWorkshopShare(c *fiber.Ctx) error {
	if err := s.workshop.Stop(c.Params("id"), currentUser(c).ID); err != nil {
		return workshopHTTPError(err)
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) listWorkshopShares(c *fiber.Ctx) error {
	user := currentUser(c)
	kind, id := c.Params("kind"), c.Params("id")
	if !s.workshop.Limits().Enabled {
		return c.JSON(fiber.Map{"shares": []relay.ShareInfo{}})
	}
	if err := s.workshopMayView(user, kind, id); err != nil {
		return err
	}
	return c.JSON(fiber.Map{"shares": s.workshop.ListPlace(kind, id, user.ID)})
}

// workshopAuthenticate is the relay's Hello check. It accepts what requireAuth accepts:
// a live, unexpired session of an active account that is not stuck on a temporary password.
func (s *Server) workshopAuthenticate(token string) (User, error) {
	var userID, expiresAt string
	err := s.db.QueryRow(
		`SELECT user_id, expires_at FROM auth_sessions WHERE id = ? AND revoked_at IS NULL`, token,
	).Scan(&userID, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && sessionExpired(expiresAt)) {
		return User{}, fiber.NewError(fiber.StatusUnauthorized, "Sign in again to use port sharing.")
	}
	if err != nil {
		return User{}, err
	}
	user, err := s.findUserByID(userID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && (user.Status != userStatusActive || user.MustChangePassword)) {
		return User{}, fiber.NewError(fiber.StatusUnauthorized, "Sign in again to use port sharing.")
	}
	if err != nil {
		return User{}, err
	}
	caps, err := s.capabilitiesFor(s.db, user.ID, user.Role)
	if err != nil {
		return User{}, err
	}
	user.Capabilities = &caps
	return user, nil
}

// workshopMayPublish and workshopMayConsume re-check a person's place access and
// capability. They are what the relay asks when a connection opens and what the sweep
// asks afterwards.
func (s *Server) workshopMayPublish(userID, kind, placeID string) error {
	return s.workshopMay(userID, kind, placeID, true)
}

func (s *Server) workshopMayConsume(userID, kind, placeID string) error {
	return s.workshopMay(userID, kind, placeID, false)
}

func (s *Server) workshopMay(userID, kind, placeID string, publishing bool) error {
	if !s.workshop.Limits().Enabled {
		return errWorkshopOff
	}
	user, err := s.findUserByID(userID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && user.Status != userStatusActive) {
		return errWorkshopPlace
	}
	if err != nil {
		return err
	}
	caps, err := s.capabilitiesFor(s.db, user.ID, user.Role)
	if err != nil {
		return err
	}
	if publishing && !caps.SharePorts {
		return errWorkshopShareCap
	}
	if !publishing && !caps.UsePorts {
		return errWorkshopUseCap
	}
	if s.workshop.Usage.Exhausted(userID) {
		return errWorkshopDailyLimit
	}
	_, err = s.workshopAccess(user, kind, placeID)
	return err
}

// workshopAccessLost reports whether an error means the person no longer has access, as
// opposed to a database hiccup that says nothing about it.
func workshopAccessLost(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, sql.ErrNoRows) {
		return true
	}
	var fe *fiber.Error
	// The daily cap says nothing about whether the person is still in the place.
	return errors.As(err, &fe) && fe.Code < 500 && fe.Code != fiber.StatusTooManyRequests
}

// revalidateWorkshop ends every share or consumer whose person no longer has access. It
// runs from the places someone loses access (leaving a call, being removed from a tree
// or a room, an archived nest) and from the maintenance sweep, which catches the rest.
func (s *Server) revalidateWorkshop() {
	if s.workshop == nil || !s.workshop.Limits().Enabled {
		return
	}
	for _, share := range s.workshop.Snapshot() {
		if err := s.workshopMayPublish(share.PublisherID, share.PlaceKind, share.PlaceID); workshopAccessLost(err) {
			s.workshop.End(share.ID, relay.ReasonLeftPlace)
			continue
		}
		for _, consumerID := range share.Consumers {
			if err := s.workshopMayConsume(consumerID, share.PlaceKind, share.PlaceID); workshopAccessLost(err) {
				s.workshop.EndConsumer(share.ID, consumerID, relay.ReasonLeftPlace)
			}
		}
	}
}

// publishWorkshopEvent tells the people who may see a share about a change to it: the
// publisher and the members of its place who are in its audience.
func (s *Server) publishWorkshopEvent(kind string, info relay.ShareInfo, reason relay.EndReason) {
	recipients := []string{info.PublisherID}
	var members []string
	switch info.PlaceKind {
	case workshopPlaceNest:
		_, members, _ = s.nestAudience(info.PlaceID)
	case workshopPlaceRoom:
		var treeID sql.NullString
		if err := s.db.QueryRow(`SELECT tree_id FROM chat_conversations WHERE id = ?`, info.PlaceID).Scan(&treeID); err == nil && treeID.Valid {
			members, _ = s.treeMemberIDs(treeID.String)
		}
	}
	allowed := map[string]bool{}
	for _, id := range info.Audience {
		allowed[id] = true
	}
	for _, id := range members {
		if id != info.PublisherID && (info.Everyone || allowed[id]) {
			recipients = append(recipients, id)
		}
	}
	update := LiveUpdate{
		Type:   "workshop.share." + kind,
		Share:  &info,
		Reason: string(reason),
		At:     database.Now(),
	}
	if info.PlaceKind == workshopPlaceNest {
		update.NestID = info.PlaceID
	}
	s.events.publishTo(update, recipients)
}

// relayPolicy is what the QUIC relay asks the API.
type relayPolicy struct{ s *Server }

// relayError keeps a database failure out of what a client is told.
func relayError(err error) error {
	if err == nil {
		return nil
	}
	var fe *fiber.Error
	if errors.As(err, &fe) {
		return err
	}
	log.Printf("workshop: %v", err)
	return errors.New("Port sharing isn’t available right now.")
}

func (p relayPolicy) Authenticate(token string) (string, error) {
	user, err := p.s.workshopAuthenticate(token)
	if err != nil {
		return "", relayError(err)
	}
	return user.ID, nil
}

func (p relayPolicy) MayPublish(userID string, share relay.ShareInfo) error {
	return relayError(p.s.workshopMayPublish(userID, share.PlaceKind, share.PlaceID))
}

func (p relayPolicy) MayConsume(userID string, share relay.ShareInfo) error {
	return relayError(p.s.workshopMayConsume(userID, share.PlaceKind, share.PlaceID))
}

// StartRelay opens the QUIC listener for port sharing. addr is a UDP address such as
// ":7443"; the certificate must be publicly trusted because clients verify it.
func (s *Server) StartRelay(addr, certFile, keyFile string) error {
	s.relayServer = relay.NewServer(s.workshop, relayPolicy{s})
	return s.relayServer.Listen(addr, certFile, keyFile)
}

// WorkshopEnabled reports the server's port sharing switch, for the startup log.
func (s *Server) WorkshopEnabled() bool { return s.workshop.Limits().Enabled }
