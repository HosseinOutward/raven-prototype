package http

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"
	profilemedia "raven/services/api/internal/media"
	"raven/services/api/internal/updates"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/session"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

type Server struct {
	app               *fiber.App
	db                *database.DB
	sessions          *session.Store
	serverName        string
	serverDescription string
	serverAvatar      string
	profileMedia      profilemedia.Store
	liveKitURL        string
	liveKitAPIKey     string
	liveKitAPISecret  string
	liveKitRooms      *lksdk.RoomServiceClient
	events            *eventBroker
	updates           *updates.Service
	updatePublicURL   string
}

type ServerProperties struct {
	Name         string         `json:"name"`
	Description  string         `json:"description"`
	Avatar       string         `json:"avatar"`
	RTCServerURL string         `json:"rtcServerUrl"`
	Properties   map[string]any `json:"properties"`
}

type User struct {
	ID          string          `json:"id"`
	Username    string          `json:"username"`
	DisplayName string          `json:"displayName"`
	Role        string          `json:"role"`
	Preferences UserPreferences `json:"preferences"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
}

type UserPreferences struct {
	DisplayName              string `json:"displayName"`
	UILabels                 string `json:"uiLabels"`
	ColorPalette             string `json:"colorPalette"`
	ColorPaletteEnabled      bool   `json:"colorPaletteEnabled"`
	AlwaysJoinMuted          bool   `json:"alwaysJoinMuted"`
	JoinWithCameraOff        bool   `json:"joinWithCameraOff"`
	JoinWithoutScreenSharing bool   `json:"joinWithoutScreenSharing"`
	FollowScreenShares       bool   `json:"followScreenShares"`
	UpdatedAt                string `json:"updatedAt"`
}

type Nest struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	JoinCode       string  `json:"joinCode"`
	CreatorUserID  string  `json:"creatorUserId"`
	TreeID         *string `json:"treeId,omitempty"`
	Type           string  `json:"type"`
	Status         string  `json:"status"`
	LifecycleState string  `json:"lifecycleState"`
	CreatedAt      string  `json:"createdAt"`
	UpdatedAt      string  `json:"updatedAt"`
	ArchivedAt     *string `json:"archivedAt,omitempty"`
	EndedAt        *string `json:"endedAt,omitempty"`
	EmptySince     *string `json:"emptySince,omitempty"`
	ExpiresAt      *string `json:"expiresAt,omitempty"`
	LastActivityAt string  `json:"lastActivityAt"`
	ShareableLink  string  `json:"shareableLink"`
	HTTPLink       string  `json:"httpLink"`
}

type Invitation struct {
	ID          string `json:"id"`
	NestID      string `json:"nestId"`
	UserID      string `json:"userId"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	CreatedAt   string `json:"createdAt"`
}

type JoinRequest struct {
	ID          string  `json:"id"`
	NestID      string  `json:"nestId"`
	NestName    string  `json:"nestName"`
	UserID      string  `json:"userId"`
	Username    string  `json:"username"`
	DisplayName string  `json:"displayName"`
	Status      string  `json:"status"`
	CreatedAt   string  `json:"createdAt"`
	ResolvedAt  *string `json:"resolvedAt"`
}

type Member struct {
	NestID      string  `json:"nestId"`
	UserID      string  `json:"userId"`
	Username    string  `json:"username"`
	DisplayName string  `json:"displayName"`
	Role        string  `json:"role"`
	State       string  `json:"state"`
	JoinedAt    *string `json:"joinedAt"`
	LeftAt      *string `json:"leftAt"`
}

type NestDetails struct {
	Nest         Nest          `json:"nest"`
	Members      []Member      `json:"members"`
	Invitations  []Invitation  `json:"invitations"`
	JoinRequests []JoinRequest `json:"joinRequests"`
}

type Dashboard struct {
	Created          []Nest        `json:"created"`
	Invited          []Nest        `json:"invited"`
	Joined           []Nest        `json:"joined"`
	PendingAdmission []JoinRequest `json:"pendingAdmission"`
}

type ctxKey string

const currentUserKey ctxKey = "currentUser"

func New(db *database.DB) *Server {
	liveKitURL := os.Getenv("LIVEKIT_URL")
	if liveKitURL == "" {
		liveKitURL = "ws://127.0.0.1:7880"
	}
	liveKitAPIKey := os.Getenv("LIVEKIT_API_KEY")
	if liveKitAPIKey == "" {
		liveKitAPIKey = "devkey"
	}
	liveKitAPISecret := os.Getenv("LIVEKIT_API_SECRET")
	if liveKitAPISecret == "" {
		liveKitAPISecret = "secret"
	}
	serverName := strings.TrimSpace(os.Getenv("RAVEN_SERVER_NAME"))
	if serverName == "" {
		serverName = "Raven"
	}
	serverDescription := strings.TrimSpace(os.Getenv("RAVEN_SERVER_DESCRIPTION"))
	if serverDescription == "" {
		serverDescription = "Desktop RTC for private Nests"
	}
	serverAvatar := strings.TrimSpace(os.Getenv("RAVEN_SERVER_AVATAR"))
	s := &Server{
		app: fiber.New(fiber.Config{
			AppName:      "Raven API",
			BodyLimit:    maxProfileImageBytes + 64*1024,
			ErrorHandler: errorHandler,
		}),
		db: db,
		sessions: session.New(session.Config{
			Expiration: 30 * 24 * time.Hour,
			KeyLookup:  "header:X-Session-ID",
			Storage:    database.NewSessionStorage(db),
		}),
		serverName:        serverName,
		serverDescription: serverDescription,
		serverAvatar:      serverAvatar,
		profileMedia:      profilemedia.NewStoreFromEnv(),
		liveKitURL:        liveKitURL,
		liveKitAPIKey:     liveKitAPIKey,
		liveKitAPISecret:  liveKitAPISecret,
		liveKitRooms:      lksdk.NewRoomServiceClient(liveKitURL, liveKitAPIKey, liveKitAPISecret),
		events:            newEventBroker(),
		updatePublicURL:   strings.TrimRight(fallbackString(os.Getenv("RAVEN_UPDATE_PUBLIC_URL"), "https://downloads.rvn.bluehour.cloud"), "/"),
	}
	s.updates = updates.NewService(db, updates.Options{
		Artifacts: updates.NewArtifactStoreFromEnv(),
		ServerPolicy: updates.ServerPolicy{
			ServerVersion:            fallbackString(os.Getenv("RAVEN_VERSION"), "0.1.0"),
			ProtocolVersion:          envInt("RAVEN_PROTOCOL_VERSION", 1),
			MinimumClientVersion:     fallbackString(os.Getenv("RAVEN_MINIMUM_CLIENT_VERSION"), "0.1.0"),
			RecommendedClientVersion: fallbackString(os.Getenv("RAVEN_RECOMMENDED_CLIENT_VERSION"), "0.1.0"),
			RequiredCapabilities:     splitCSV(os.Getenv("RAVEN_REQUIRED_CLIENT_CAPABILITIES")),
		},
		PresignExpiry:  time.Duration(envInt("RAVEN_UPDATE_PRESIGN_SECONDS", 600)) * time.Second,
		ConsentVersion: fallbackString(os.Getenv("RAVEN_UPDATE_CONSENT_VERSION"), "closed-alpha-2026-07-12"),
	})
	s.routes()
	return s
}

func (s *Server) Listen(addr string) error {
	if addr == "" {
		addr = "127.0.0.1:6977"
	}
	return s.app.Listen(addr)
}

func (s *Server) routes() {
	s.app.Use(cors.New(cors.Config{
		AllowOriginsFunc: func(origin string) bool {
			return allowedCORSOrigin(origin)
		},
		AllowHeaders:  "Origin, Content-Type, Accept, X-Session-ID, X-Raven-OS, X-Raven-Device, X-Raven-Client-Version, X-Raven-Protocol-Version, X-Raven-Capabilities, X-Raven-Update-Channel, X-Raven-Update-Cohort, X-Raven-Installation-ID, X-Raven-Consent-Version, X-Raven-Ops-Session, X-Raven-Action-Authorization, X-Request-ID, X-Idempotency-Key",
		ExposeHeaders: "X-Session-ID, X-Request-ID",
		AllowMethods:  "GET,POST,DELETE,OPTIONS",
	}))
	s.app.Get("/healthz", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"ok":           true,
			"rtcServerUrl": s.liveKitURL,
			"liveKitURL":   s.liveKitURL,
		})
	})

	v1 := s.app.Group("/v1")
	v1.Get("/server/properties", s.getServerProperties)
	v1.Get("/media/users/:id/avatar", s.getUserAvatar)
	v1.Get("/media/trees/:id/avatar", s.getTreeAvatar)
	v1.Get("/media/server/avatar", s.getStoredServerAvatar)
	v1.Get("/server/compatibility", s.getServerCompatibility)
	v1.Post("/auth/login", s.login)
	s.registerPublicUpdateRoutes(v1)

	authenticated := v1.Use(s.requireAuth)
	authenticated.Get("/auth/me", s.me)
	authenticated.Post("/auth/logout", s.logout)
	authenticated.Get("/auth/sessions", s.listAuthSessions)
	authenticated.Delete("/auth/sessions/:id", s.revokeAuthSession)
	authenticated.Get("/preferences", s.getPreferences)
	authenticated.Post("/preferences", s.updatePreferences)
	authenticated.Post("/profile/avatar", s.uploadUserAvatar)
	authenticated.Post("/admin/users", s.requireAdmin, s.adminCreateUser)
	authenticated.Get("/admin/users", s.requireAdmin, s.adminListUsers)
	authenticated.Post("/admin/server/avatar", s.requireAdmin, s.uploadServerAvatar)
	s.registerOpsRoutes(authenticated)
	service := authenticated.Use(s.requireCompatibleClient)
	service.Get("/users/search", s.searchUsers)
	service.Get("/friends", s.listFriends)
	service.Post("/friend-requests", s.createFriendRequest)
	service.Get("/friend-requests", s.listFriendRequests)
	service.Post("/friend-requests/:id/accept", s.acceptFriendRequest)
	service.Post("/friend-requests/:id/decline", s.declineFriendRequest)
	service.Post("/friend-requests/:id/cancel", s.cancelFriendRequest)
	service.Delete("/friends/:userId", s.removeFriend)
	service.Get("/home", s.home)
	service.Get("/trees", s.listTrees)
	service.Get("/trees/search", s.searchTrees)
	service.Post("/trees", s.createTree)
	service.Get("/trees/:id", s.getTree)
	service.Post("/trees/:id/settings", s.updateTreeSettings)
	service.Post("/trees/:id/avatar", s.uploadTreeAvatar)
	service.Delete("/trees/:id", s.deleteTree)
	service.Post("/trees/:id/join", s.joinTree)
	service.Post("/trees/:id/members", s.addTreeMember)
	service.Post("/trees/:id/members/:userId/role", s.updateTreeMemberRole)
	service.Delete("/trees/:id/members/:userId", s.removeTreeMember)
	service.Get("/trees/:id/join-requests", s.listTreeJoinRequests)
	service.Post("/trees/:id/join-requests/:requestId/accept", s.acceptTreeJoinRequest)
	service.Post("/trees/:id/join-requests/:requestId/reject", s.rejectTreeJoinRequest)
	service.Post("/trees/:id/nests", s.createTreeNest)
	service.Post("/presence", s.updatePresence)
	service.Post("/presence/heartbeat", s.presenceHeartbeat)
	service.Post("/knocks", s.createKnock)
	service.Get("/knocks", s.listKnocks)
	service.Post("/knocks/:id/accept", s.acceptKnock)
	service.Post("/knocks/:id/decline", s.declineKnock)
	service.Post("/knocks/:id/dismiss", s.dismissKnock)
	service.Post("/nests", s.createNest)
	service.Get("/nests", s.listNests)
	service.Get("/nests/launcher", s.listLauncherNests)
	service.Post("/nests/persistent", s.createPersistentNest)
	service.Post("/nests/temporary", s.createTemporaryNest)
	service.Get("/nest-events", s.nestEvents)
	service.Get("/nests/:id", s.getNest)
	service.Get("/nests/:id/session", s.activeSessionSummary)
	service.Get("/nests/:id/history", s.nestHistory)
	service.Post("/nests/:id/livekit-token", s.liveKitToken)
	service.Post("/nests/:id/join", s.joinNest)
	service.Post("/nests/:id/leave", s.leaveNest)
	service.Post("/nests/:id/archive", s.archiveNest)
	service.Post("/nests/:id/presence/join", s.joinNestPresence)
	service.Post("/nests/:id/presence/leave", s.leaveNestPresence)
	service.Post("/nests/:id/session/join", s.joinCallSession)
	service.Post("/nests/:id/session/leave", s.leaveCallSession)
	service.Post("/nests/:id/session/disconnect", s.disconnectFromNest)
	service.Post("/nests/join-by-code", s.joinByCode)
	service.Post("/nests/:id/invitations", s.inviteUser)
	service.Get("/nests/:id/invitations", s.listInvitations)
	service.Delete("/nests/:id/invitations/:invitationId", s.deleteInvitation)
	service.Get("/nests/:id/join-requests", s.listJoinRequests)
	service.Post("/nests/:id/join-requests/:requestId/accept", s.acceptJoinRequest)
	service.Post("/nests/:id/join-requests/:requestId/reject", s.rejectJoinRequest)
}

func (s *Server) getServerProperties(c *fiber.Ctx) error {
	avatar := s.serverAvatar
	var storedAvatar string
	if err := s.db.QueryRow(`SELECT avatar_object_key FROM server_settings WHERE id = 1`).Scan(&storedAvatar); err == nil && storedAvatar != "" {
		avatar = serverAvatarRoute(storedAvatar)
	}
	return c.JSON(ServerProperties{
		Name:         fallbackString(s.serverName, "Raven"),
		Description:  fallbackString(s.serverDescription, "Desktop RTC for private Nests"),
		Avatar:       avatar,
		RTCServerURL: fallbackString(s.liveKitURL, "ws://127.0.0.1:7880"),
		Properties:   map[string]any{},
	})
}

func errorHandler(c *fiber.Ctx, err error) error {
	code := fiber.StatusInternalServerError
	message := "internal error"
	var fiberErr *fiber.Error
	if errors.As(err, &fiberErr) {
		code = fiberErr.Code
		message = fiberErr.Message
	} else if errors.Is(err, sql.ErrNoRows) {
		code = fiber.StatusNotFound
		message = "not found"
	}
	return c.Status(code).JSON(fiber.Map{"error": message})
}

func fallbackString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return strings.TrimSpace(value)
}

func envInt(name string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))
	if err != nil {
		return fallback
	}
	return value
}

func splitCSV(value string) []string {
	values := []string{}
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			values = append(values, item)
		}
	}
	return values
}

func allowedCORSOrigin(origin string) bool {
	if origin == "" || strings.HasPrefix(origin, "http://localhost:") || strings.HasPrefix(origin, "http://127.0.0.1:") || origin == "tauri://localhost" || origin == "http://tauri.localhost" || origin == "https://tauri.localhost" {
		return true
	}
	configured := splitCSV(fallbackString(os.Getenv("RAVEN_CORS_ALLOWED_ORIGINS"), "https://ops.rvn.bluehour.cloud"))
	for _, allowed := range configured {
		if origin == allowed {
			return true
		}
	}
	return false
}

func (s *Server) requireAuth(c *fiber.Ctx) error {
	sess, err := s.sessions.Get(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, "authentication required")
	}
	sessionID := sess.ID()
	userID, _ := sess.Get("user_id").(string)
	if userID == "" {
		_ = sess.Destroy()
		return fiber.NewError(fiber.StatusUnauthorized, "authentication required")
	}
	var expiresAt string
	err = s.db.QueryRow(`SELECT expires_at FROM auth_sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL`, sessionID, userID).Scan(&expiresAt)
	if err != nil || sessionExpired(expiresAt) {
		_ = sess.Destroy()
		return fiber.NewError(fiber.StatusUnauthorized, "authentication required")
	}
	user, err := s.findUserByID(userID)
	if err != nil {
		_ = sess.Destroy()
		return fiber.NewError(fiber.StatusUnauthorized, "authentication required")
	}
	now := database.Now()
	nextExpiry := time.Now().UTC().Add(30 * 24 * time.Hour).Format(time.RFC3339Nano)
	_, _ = s.db.Exec(
		`UPDATE auth_sessions SET latest_ip = ?, user_agent = ?, os = ?, device_name = ?, last_accessed_at = ?, expires_at = ? WHERE id = ?`,
		clientIP(c), limited(c.Get(fiber.HeaderUserAgent), 500), clientOS(c), clientDevice(c), now, nextExpiry, sessionID,
	)
	sess.SetExpiry(30 * 24 * time.Hour)
	if err := sess.Save(); err != nil {
		return err
	}
	c.Locals(string(currentUserKey), user)
	c.Locals("authSessionID", sessionID)
	return c.Next()
}

func (s *Server) requireAdmin(c *fiber.Ctx) error {
	user := currentUser(c)
	if user.Role != "admin" {
		return fiber.NewError(fiber.StatusForbidden, "admin role required")
	}
	return c.Next()
}

func currentUser(c *fiber.Ctx) User {
	user, _ := c.Locals(string(currentUserKey)).(User)
	return user
}

func (s *Server) login(c *fiber.Ctx) error {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid login payload")
	}
	username := strings.TrimSpace(body.Username)
	var user User
	var passwordHash string
	err := scanUser(s.db.QueryRow(userSelectSQL()+` WHERE u.username = ?`, username), &user, &passwordHash)
	if err != nil || !auth.VerifyPassword(passwordHash, body.Password) {
		return fiber.NewError(fiber.StatusUnauthorized, "invalid username or password")
	}
	sess, err := s.sessions.Get(c)
	if err != nil {
		return err
	}
	previousID := sess.ID()
	if err := sess.Regenerate(); err != nil {
		return err
	}
	if previousID != "" {
		_, _ = s.db.Exec(`UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, database.Now(), previousID)
	}
	sessionID := sess.ID()
	now := database.Now()
	expiresAt := time.Now().UTC().Add(30 * 24 * time.Hour).Format(time.RFC3339Nano)
	_, err = s.db.Exec(
		`INSERT INTO auth_sessions (id, user_id, latest_ip, user_agent, os, device_name, created_at, last_accessed_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sessionID, user.ID, clientIP(c), limited(c.Get(fiber.HeaderUserAgent), 500), clientOS(c), clientDevice(c), now, now, expiresAt,
	)
	if err != nil {
		return err
	}
	sess.Set("user_id", user.ID)
	sess.SetExpiry(30 * 24 * time.Hour)
	if err := sess.Save(); err != nil {
		_, _ = s.db.Exec(`DELETE FROM auth_sessions WHERE id = ?`, sessionID)
		return err
	}
	return c.JSON(fiber.Map{"user": user})
}

func (s *Server) me(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{"user": currentUser(c)})
}

func (s *Server) getPreferences(c *fiber.Ctx) error {
	user := currentUser(c)
	return c.JSON(fiber.Map{"preferences": user.Preferences})
}

func (s *Server) updatePreferences(c *fiber.Ctx) error {
	user := currentUser(c)
	var body struct {
		DisplayName              *string `json:"displayName"`
		UILabels                 *string `json:"uiLabels"`
		ColorPalette             *string `json:"colorPalette"`
		AlwaysJoinMuted          *bool   `json:"alwaysJoinMuted"`
		JoinWithCameraOff        *bool   `json:"joinWithCameraOff"`
		JoinWithoutScreenSharing *bool   `json:"joinWithoutScreenSharing"`
		FollowScreenShares       *bool   `json:"followScreenShares"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid preferences payload")
	}

	displayName := user.Preferences.DisplayName
	if body.DisplayName != nil {
		next, err := normalizeDisplayName(*body.DisplayName, user.Username)
		if err != nil {
			return fiber.NewError(fiber.StatusBadRequest, err.Error())
		}
		displayName = next
	}
	uiLabels := user.Preferences.UILabels
	if body.UILabels != nil {
		next := normalizeUILabels(*body.UILabels)
		if next == "" {
			return fiber.NewError(fiber.StatusBadRequest, "UI labels must be tree_nest or space_room")
		}
		uiLabels = next
	}
	colorPalette := "raven_dark"
	if body.ColorPalette != nil && strings.TrimSpace(*body.ColorPalette) != "" && strings.TrimSpace(*body.ColorPalette) != colorPalette {
		return fiber.NewError(fiber.StatusBadRequest, "color palette selection is not available yet")
	}
	alwaysJoinMuted := user.Preferences.AlwaysJoinMuted
	if body.AlwaysJoinMuted != nil {
		alwaysJoinMuted = *body.AlwaysJoinMuted
	}
	joinWithCameraOff := user.Preferences.JoinWithCameraOff
	if body.JoinWithCameraOff != nil {
		joinWithCameraOff = *body.JoinWithCameraOff
	}
	joinWithoutScreenSharing := user.Preferences.JoinWithoutScreenSharing
	if body.JoinWithoutScreenSharing != nil {
		joinWithoutScreenSharing = *body.JoinWithoutScreenSharing
	}
	followScreenShares := user.Preferences.FollowScreenShares
	if body.FollowScreenShares != nil {
		followScreenShares = *body.FollowScreenShares
	}

	now := database.Now()
	var persistedDisplayName any
	if displayName != "" && displayName != user.Username {
		persistedDisplayName = displayName
	}
	if _, err := s.db.Exec(
		`INSERT INTO user_preferences (user_id, display_name, ui_labels, color_palette, always_join_muted, join_with_camera_off, join_without_screen_sharing, follow_screen_shares, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
			display_name = excluded.display_name,
			ui_labels = excluded.ui_labels,
			color_palette = excluded.color_palette,
			always_join_muted = excluded.always_join_muted,
			join_with_camera_off = excluded.join_with_camera_off,
			join_without_screen_sharing = excluded.join_without_screen_sharing,
			follow_screen_shares = excluded.follow_screen_shares,
			updated_at = excluded.updated_at`,
		user.ID, persistedDisplayName, uiLabels, colorPalette, alwaysJoinMuted, joinWithCameraOff, joinWithoutScreenSharing, followScreenShares, now, now,
	); err != nil {
		return err
	}
	updated, err := s.findUserByID(user.ID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"preferences": updated.Preferences, "user": updated})
}

func (s *Server) adminCreateUser(c *fiber.Ctx) error {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Role     string `json:"role"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid user payload")
	}
	user, err := s.CreateUser(body.Username, body.Password, body.Role)
	if err != nil {
		if database.IsUniqueViolation(err) {
			return fiber.NewError(fiber.StatusConflict, "username already exists")
		}
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"user": user})
}

func (s *Server) adminListUsers(c *fiber.Ctx) error {
	rows, err := s.db.Query(userSelectSQL() + ` ORDER BY u.username`)
	if err != nil {
		return err
	}
	defer rows.Close()
	users := []User{}
	for rows.Next() {
		var user User
		if err := scanUser(rows, &user, nil); err != nil {
			return err
		}
		users = append(users, user)
	}
	return c.JSON(fiber.Map{"users": users})
}

func (s *Server) CreateUser(username, password, role string) (User, error) {
	return s.CreateUserWithDisplayName(username, "", password, role)
}

func (s *Server) CreateUserWithDisplayName(username, displayName, password, role string) (User, error) {
	username = strings.TrimSpace(username)
	if username == "" || password == "" {
		return User{}, fmt.Errorf("username and password are required")
	}
	normalizedDisplayName, err := normalizeDisplayName(displayName, username)
	if err != nil {
		return User{}, err
	}
	normalizedRole, err := database.NormalizeRole(role)
	if err != nil {
		return User{}, err
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return User{}, err
	}
	now := database.Now()
	user := User{ID: auth.NewID(), Username: username, DisplayName: normalizedDisplayName, Role: normalizedRole, CreatedAt: now, UpdatedAt: now}
	user.Preferences = defaultUserPreferences(user.Username, now)
	user.Preferences.DisplayName = normalizedDisplayName
	tx, err := s.db.Begin()
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		user.ID, user.Username, hash, user.Role, user.CreatedAt, user.UpdatedAt,
	); err != nil {
		return User{}, err
	}
	if _, err = tx.Exec(
		`INSERT INTO user_preferences (user_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
		user.ID, user.DisplayName, now, now,
	); err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return user, nil
}

func (s *Server) createNest(c *fiber.Ctx) error {
	return s.createNestWithType(c, "persistent")
}

func (s *Server) createPersistentNest(c *fiber.Ctx) error {
	return s.createNestWithType(c, "persistent")
}

func (s *Server) createTemporaryNest(c *fiber.Ctx) error {
	return s.createNestWithType(c, "temporary")
}

func (s *Server) createNestWithType(c *fiber.Ctx, defaultType string) error {
	user := currentUser(c)
	var body struct {
		Name   string `json:"name"`
		Type   string `json:"type"`
		TreeID string `json:"treeId"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid Nest payload")
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Nest name is required")
	}
	nestType := normalizeNestType(body.Type, defaultType)
	if nestType == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Nest type must be persistent or temporary")
	}
	var treeID *string
	if nestType == "persistent" {
		requestedTreeID := strings.TrimSpace(body.TreeID)
		if localTreeID, ok := c.Locals("treeId").(string); ok && localTreeID != "" {
			requestedTreeID = localTreeID
		}
		if requestedTreeID != "" {
			if ok, err := s.canManageTree(user.ID, requestedTreeID); err != nil || !ok {
				if err != nil {
					return err
				}
				return fiber.NewError(fiber.StatusForbidden, "not allowed to create a Nest in this Tree")
			}
			treeID = &requestedTreeID
		}
	}
	nest, err := s.createNestForUser(user, name, nestType, treeID)
	if err != nil {
		return err
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"nest": withLinks(nest)})
}

func (s *Server) listNests(c *fiber.Ctx) error {
	if err := s.expireStaleNestActivity(); err != nil {
		return err
	}
	user := currentUser(c)
	created, err := s.queryNests(`WHERE n.creator_user_id = ? ORDER BY n.created_at DESC`, user.ID)
	if err != nil {
		return err
	}
	invited, err := s.queryNests(`JOIN nest_members nm ON nm.nest_id = n.id WHERE nm.user_id = ? AND nm.state = 'invited' ORDER BY n.created_at DESC`, user.ID)
	if err != nil {
		return err
	}
	joined, err := s.queryNests(`JOIN nest_members nm ON nm.nest_id = n.id WHERE nm.user_id = ? AND nm.state = 'joined' ORDER BY n.created_at DESC`, user.ID)
	if err != nil {
		return err
	}
	pending, err := s.pendingAdmissionForCreator(user.ID)
	if err != nil {
		return err
	}
	return c.JSON(Dashboard{Created: created, Invited: invited, Joined: joined, PendingAdmission: pending})
}

func (s *Server) getNest(c *fiber.Ctx) error {
	user := currentUser(c)
	nest, err := s.findNest(c.Params("id"))
	if err != nil {
		return err
	}
	allowed, err := s.canViewNest(user.ID, nest.ID)
	if err != nil {
		return err
	}
	if !allowed {
		return fiber.NewError(fiber.StatusForbidden, "not allowed to view this Nest")
	}
	details, err := s.nestDetails(nest)
	if err != nil {
		return err
	}
	if canModerate, err := s.canModerate(user.ID, nest.ID); err != nil {
		return err
	} else if !canModerate {
		filtered := []JoinRequest{}
		for _, request := range details.JoinRequests {
			if request.UserID == user.ID {
				filtered = append(filtered, request)
			}
		}
		details.JoinRequests = filtered
	}
	return c.JSON(details)
}

func (s *Server) joinNest(c *fiber.Ctx) error {
	user := currentUser(c)
	nest, err := s.findNest(c.Params("id"))
	if err != nil {
		return err
	}
	result, err := s.joinOrRequest(nest, user)
	if err != nil {
		return err
	}
	return c.JSON(result)
}

func (s *Server) liveKitToken(c *fiber.Ctx) error {
	user := currentUser(c)
	nest, err := s.findNest(c.Params("id"))
	if err != nil {
		return err
	}
	state, role, err := s.membershipState(nest.ID, user.ID)
	if err != nil {
		return err
	}
	if state != "joined" {
		return fiber.NewError(fiber.StatusForbidden, "admission is required before LiveKit access")
	}
	session := liveKitSessionName(nest.ID)

	// Each desktop client joins the room as up to three participants. `?identity=audio`
	// mints the token for the Rust audio sidecar ("<userId>#audio"); `?identity=video`
	// mints the Rust video/screenshare sidecar ("<userId>#video"); the default mints the
	// main presence participant. All share the same room and grants.
	identity := user.ID
	tokenRole := role
	switch c.Query("identity") {
	case "audio":
		identity = audioParticipantIdentity(user.ID)
		tokenRole = "audio"
	case "video":
		identity = videoParticipantIdentity(user.ID)
		tokenRole = "video"
	}

	token, err := auth.SignLiveKitToken(auth.LiveKitTokenInput{
		APIKey:    s.liveKitAPIKey,
		APISecret: s.liveKitAPISecret,
		Session:   session,
		Identity:  identity,
		Name:      user.DisplayName,
		Role:      tokenRole,
	})
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{
		"url":         s.liveKitURL,
		"token":       token,
		"sessionName": session,
		"identity":    identity,
		"displayName": user.DisplayName,
	})
}

func (s *Server) joinByCode(c *fiber.Ctx) error {
	user := currentUser(c)
	var body struct {
		Code string `json:"code"`
		Link string `json:"link"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid join payload")
	}
	code := extractJoinCode(body.Code)
	if code == "" {
		code = extractJoinCode(body.Link)
	}
	if code == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Nest link or code is required")
	}
	nest, err := s.findNestByCode(code)
	if err != nil {
		return err
	}
	result, err := s.joinOrRequest(nest, user)
	if err != nil {
		return err
	}
	return c.JSON(result)
}

func (s *Server) leaveNest(c *fiber.Ctx) error {
	user := currentUser(c)
	nestID := c.Params("id")
	if ok, err := s.requireJoinedMember(nestID, user.ID); err != nil || !ok {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusNotFound, "joined Nest membership not found")
	}
	_, err := s.disconnectUserFromNest(nestID, user.ID, "left", true)
	if err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) inviteUser(c *fiber.Ctx) error {
	actor := currentUser(c)
	nestID := c.Params("id")
	if ok, err := s.canModerate(actor.ID, nestID); err != nil || !ok {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "creator or moderator role required")
	}
	var body struct {
		Username string `json:"username"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid invitation payload")
	}
	invited, err := s.findUserByUsername(strings.TrimSpace(body.Username))
	if err != nil {
		return fiber.NewError(fiber.StatusNotFound, "user not found")
	}
	now := database.Now()
	invitationID := auth.NewID()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		`INSERT INTO nest_invitations (id, nest_id, invited_user_id, invited_by_user_id, created_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(nest_id, invited_user_id) DO NOTHING`,
		invitationID, nestID, invited.ID, actor.ID, now,
	); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT INTO nest_members (nest_id, user_id, role, state, created_at, updated_at)
		 VALUES (?, ?, 'participant', 'invited', ?, ?)
		 ON CONFLICT(nest_id, user_id) DO UPDATE SET
		 	state = CASE
		 		WHEN state = 'joined' THEN state
		 		WHEN EXISTS (SELECT 1 FROM nest_join_requests WHERE nest_id = excluded.nest_id AND user_id = excluded.user_id AND status = 'pending') THEN 'joined'
		 		ELSE 'invited'
		 	END,
		 	joined_at = CASE
		 		WHEN state = 'joined' THEN joined_at
		 		WHEN EXISTS (SELECT 1 FROM nest_join_requests WHERE nest_id = excluded.nest_id AND user_id = excluded.user_id AND status = 'pending') THEN ?
		 		ELSE joined_at
		 	END,
		 	left_at = CASE
		 		WHEN EXISTS (SELECT 1 FROM nest_join_requests WHERE nest_id = excluded.nest_id AND user_id = excluded.user_id AND status = 'pending') THEN NULL
		 		ELSE left_at
		 	END,
		 	updated_at = excluded.updated_at`,
		nestID, invited.ID, now, now, now,
	); err != nil {
		return err
	}
	resolved, err := tx.Exec(
		`UPDATE nest_join_requests
		 SET status = 'accepted', resolved_at = ?, resolved_by_user_id = ?
		 WHERE nest_id = ? AND user_id = ? AND status = 'pending'`,
		now, actor.ID, nestID, invited.ID,
	)
	if err != nil {
		return err
	}
	if count, _ := resolved.RowsAffected(); count > 0 {
		if _, err := tx.Exec(
			`UPDATE nest_members
			 SET state = 'joined', joined_at = ?, left_at = NULL, updated_at = ?
			 WHERE nest_id = ? AND user_id = ?`,
			now, now, nestID, invited.ID,
		); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"invitation": Invitation{ID: invitationID, NestID: nestID, UserID: invited.ID, Username: invited.Username, DisplayName: invited.DisplayName, CreatedAt: now}})
}

func (s *Server) listInvitations(c *fiber.Ctx) error {
	nestID := c.Params("id")
	if allowed, err := s.canViewNest(currentUser(c).ID, nestID); err != nil || !allowed {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "not allowed to view this Nest")
	}
	invitations, err := s.invitations(nestID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"invitations": invitations})
}

func (s *Server) deleteInvitation(c *fiber.Ctx) error {
	actor := currentUser(c)
	nestID := c.Params("id")
	if ok, err := s.canModerate(actor.ID, nestID); err != nil || !ok {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "creator or moderator role required")
	}
	_, err := s.db.Exec(`DELETE FROM nest_invitations WHERE id = ? AND nest_id = ?`, c.Params("invitationId"), nestID)
	return err
}

func (s *Server) listJoinRequests(c *fiber.Ctx) error {
	actor := currentUser(c)
	nestID := c.Params("id")
	if ok, err := s.canModerate(actor.ID, nestID); err != nil || !ok {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "creator or moderator role required")
	}
	requests, err := s.joinRequests(nestID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"joinRequests": requests})
}

func (s *Server) acceptJoinRequest(c *fiber.Ctx) error {
	return s.resolveJoinRequest(c, "accepted")
}

func (s *Server) rejectJoinRequest(c *fiber.Ctx) error {
	return s.resolveJoinRequest(c, "rejected")
}

func (s *Server) resolveJoinRequest(c *fiber.Ctx, status string) error {
	actor := currentUser(c)
	nestID := c.Params("id")
	if ok, err := s.canModerate(actor.ID, nestID); err != nil || !ok {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "creator or moderator role required")
	}
	request, err := s.findJoinRequest(nestID, c.Params("requestId"))
	if err != nil {
		return err
	}
	now := database.Now()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE nest_join_requests SET status = ?, resolved_at = ?, resolved_by_user_id = ? WHERE id = ?`, status, now, actor.ID, request.ID); err != nil {
		return err
	}
	if status == "accepted" {
		if _, err := tx.Exec(
			`INSERT INTO nest_members (nest_id, user_id, role, state, joined_at, created_at, updated_at)
			 VALUES (?, ?, 'participant', 'joined', ?, ?, ?)
			 ON CONFLICT(nest_id, user_id) DO UPDATE SET state = 'joined', joined_at = excluded.joined_at, left_at = NULL, updated_at = excluded.updated_at`,
			nestID, request.UserID, now, now, now,
		); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return c.JSON(fiber.Map{"joinRequest": request, "status": status})
}

func (s *Server) joinOrRequest(nest Nest, user User) (fiber.Map, error) {
	if nest.Status != "active" || nest.LifecycleState == "closed" || nest.LifecycleState == "expired" {
		return nil, fiber.NewError(fiber.StatusGone, "Nest is no longer active")
	}
	state, role, err := s.membershipState(nest.ID, user.ID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	now := database.Now()
	if state == "joined" {
		return fiber.Map{"status": "joined", "nest": withLinks(nest)}, nil
	}
	if direct, err := s.canJoinDirectly(user.ID, nest); err != nil {
		return nil, err
	} else if direct || state == "invited" || role == "creator" {
		_, err := s.db.Exec(
			`INSERT INTO nest_members (nest_id, user_id, role, state, joined_at, created_at, updated_at)
			 VALUES (?, ?, 'participant', 'joined', ?, ?, ?)
			 ON CONFLICT(nest_id, user_id) DO UPDATE SET state = 'joined', joined_at = excluded.joined_at, left_at = NULL, updated_at = excluded.updated_at`,
			nest.ID, user.ID, now, now, now,
		)
		return fiber.Map{"status": "joined", "nest": withLinks(nest)}, err
	}
	requestID := auth.NewID()
	_, err = s.db.Exec(
		`INSERT INTO nest_join_requests (id, nest_id, user_id, status, created_at)
		 VALUES (?, ?, ?, 'pending', ?)
		 ON CONFLICT(nest_id, user_id, status) DO NOTHING`,
		requestID, nest.ID, user.ID, now,
	)
	if err != nil {
		return nil, err
	}
	request, err := s.pendingRequest(nest.ID, user.ID)
	if err != nil {
		return nil, err
	}
	return fiber.Map{"status": "waiting", "nest": withLinks(nest), "joinRequest": request}, nil
}

func (s *Server) queryNests(clause string, args ...any) ([]Nest, error) {
	query := `SELECT n.id, n.name, n.join_code, n.creator_user_id, n.tree_id, n.type, n.status, n.lifecycle_state, n.created_at, n.updated_at, n.archived_at, n.ended_at, n.empty_since, n.expires_at, n.last_activity_at FROM nests n ` + clause
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	nests := []Nest{}
	for rows.Next() {
		var nest Nest
		var treeID, archivedAt, endedAt, emptySince, expiresAt sql.NullString
		if err := rows.Scan(&nest.ID, &nest.Name, &nest.JoinCode, &nest.CreatorUserID, &treeID, &nest.Type, &nest.Status, &nest.LifecycleState, &nest.CreatedAt, &nest.UpdatedAt, &archivedAt, &endedAt, &emptySince, &expiresAt, &nest.LastActivityAt); err != nil {
			return nil, err
		}
		nest.TreeID = nullStringPtr(treeID)
		nest.ArchivedAt = nullStringPtr(archivedAt)
		nest.EndedAt = nullStringPtr(endedAt)
		nest.EmptySince = nullStringPtr(emptySince)
		nest.ExpiresAt = nullStringPtr(expiresAt)
		nests = append(nests, withLinks(nest))
	}
	return nests, rows.Err()
}

func (s *Server) findNest(id string) (Nest, error) {
	var nest Nest
	var treeID, archivedAt, endedAt, emptySince, expiresAt sql.NullString
	err := s.db.QueryRow(`SELECT id, name, join_code, creator_user_id, tree_id, type, status, lifecycle_state, created_at, updated_at, archived_at, ended_at, empty_since, expires_at, last_activity_at FROM nests WHERE id = ?`, id).
		Scan(&nest.ID, &nest.Name, &nest.JoinCode, &nest.CreatorUserID, &treeID, &nest.Type, &nest.Status, &nest.LifecycleState, &nest.CreatedAt, &nest.UpdatedAt, &archivedAt, &endedAt, &emptySince, &expiresAt, &nest.LastActivityAt)
	nest.TreeID = nullStringPtr(treeID)
	nest.ArchivedAt = nullStringPtr(archivedAt)
	nest.EndedAt = nullStringPtr(endedAt)
	nest.EmptySince = nullStringPtr(emptySince)
	nest.ExpiresAt = nullStringPtr(expiresAt)
	return withLinks(nest), err
}

func (s *Server) findNestByCode(code string) (Nest, error) {
	var nest Nest
	var treeID, archivedAt, endedAt, emptySince, expiresAt sql.NullString
	err := s.db.QueryRow(`SELECT id, name, join_code, creator_user_id, tree_id, type, status, lifecycle_state, created_at, updated_at, archived_at, ended_at, empty_since, expires_at, last_activity_at FROM nests WHERE join_code = ?`, code).
		Scan(&nest.ID, &nest.Name, &nest.JoinCode, &nest.CreatorUserID, &treeID, &nest.Type, &nest.Status, &nest.LifecycleState, &nest.CreatedAt, &nest.UpdatedAt, &archivedAt, &endedAt, &emptySince, &expiresAt, &nest.LastActivityAt)
	nest.TreeID = nullStringPtr(treeID)
	nest.ArchivedAt = nullStringPtr(archivedAt)
	nest.EndedAt = nullStringPtr(endedAt)
	nest.EmptySince = nullStringPtr(emptySince)
	nest.ExpiresAt = nullStringPtr(expiresAt)
	return withLinks(nest), err
}

func (s *Server) findUserByID(id string) (User, error) {
	var user User
	err := scanUser(s.db.QueryRow(userSelectSQL()+` WHERE u.id = ?`, id), &user, nil)
	return user, err
}

func (s *Server) findUserByUsername(username string) (User, error) {
	var user User
	err := scanUser(s.db.QueryRow(userSelectSQL()+` WHERE u.username = ?`, username), &user, nil)
	return user, err
}

type rowScanner interface {
	Scan(dest ...any) error
}

func userSelectSQL() string {
	return `SELECT u.id, u.username, COALESCE(NULLIF(TRIM(up.display_name), ''), u.username), u.password_hash, u.role,
		COALESCE(up.ui_labels, 'tree_nest'), COALESCE(up.color_palette, 'raven_dark'),
		CASE WHEN COALESCE(up.always_join_muted, FALSE) THEN 'true' ELSE 'false' END,
		CASE WHEN COALESCE(up.join_with_camera_off, FALSE) THEN 'true' ELSE 'false' END,
		CASE WHEN COALESCE(up.join_without_screen_sharing, FALSE) THEN 'true' ELSE 'false' END,
		CASE WHEN COALESCE(up.follow_screen_shares, TRUE) THEN 'true' ELSE 'false' END,
		COALESCE(up.updated_at, u.updated_at), u.created_at, u.updated_at
		FROM users u
		LEFT JOIN user_preferences up ON up.user_id = u.id`
}

func scanUser(scanner rowScanner, user *User, passwordHash *string) error {
	var ignoredHash string
	if passwordHash == nil {
		passwordHash = &ignoredHash
	}
	if err := scanner.Scan(
		&user.ID,
		&user.Username,
		&user.DisplayName,
		passwordHash,
		&user.Role,
		&user.Preferences.UILabels,
		&user.Preferences.ColorPalette,
		&user.Preferences.AlwaysJoinMuted,
		&user.Preferences.JoinWithCameraOff,
		&user.Preferences.JoinWithoutScreenSharing,
		&user.Preferences.FollowScreenShares,
		&user.Preferences.UpdatedAt,
		&user.CreatedAt,
		&user.UpdatedAt,
	); err != nil {
		return err
	}
	user.DisplayName = displayNameOrUsername(user.DisplayName, user.Username)
	user.Preferences.DisplayName = user.DisplayName
	user.Preferences.ColorPalette = "raven_dark"
	user.Preferences.ColorPaletteEnabled = false
	if user.Preferences.UILabels == "" {
		user.Preferences.UILabels = "tree_nest"
	}
	if user.Preferences.UpdatedAt == "" {
		user.Preferences.UpdatedAt = user.UpdatedAt
	}
	return nil
}

func defaultUserPreferences(username, updatedAt string) UserPreferences {
	return UserPreferences{
		DisplayName:              username,
		UILabels:                 "tree_nest",
		ColorPalette:             "raven_dark",
		ColorPaletteEnabled:      false,
		AlwaysJoinMuted:          false,
		JoinWithCameraOff:        false,
		JoinWithoutScreenSharing: false,
		FollowScreenShares:       true,
		UpdatedAt:                updatedAt,
	}
}

func displayNameOrUsername(displayName, username string) string {
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		return username
	}
	return displayName
}

func normalizeDisplayName(displayName, username string) (string, error) {
	displayName = strings.Join(strings.Fields(displayName), " ")
	if displayName == "" {
		return username, nil
	}
	if len([]rune(displayName)) > 80 {
		return "", fmt.Errorf("display name must be 80 characters or fewer")
	}
	return displayName, nil
}

func normalizeUILabels(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "tree_nest", "tree/nest":
		return "tree_nest"
	case "space_room", "space/room":
		return "space_room"
	default:
		return ""
	}
}

func (s *Server) canViewNest(userID, nestID string) (bool, error) {
	var count int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM nests n
		 LEFT JOIN nest_members nm ON nm.nest_id = n.id AND nm.user_id = ?
		 LEFT JOIN nest_join_requests jr ON jr.nest_id = n.id AND jr.user_id = ? AND jr.status = 'pending'
		 LEFT JOIN tree_members tm ON tm.tree_id = n.tree_id AND tm.user_id = ? AND tm.state = 'joined'
		 WHERE n.id = ? AND n.status = 'active' AND (n.creator_user_id = ? OR nm.user_id IS NOT NULL OR jr.user_id IS NOT NULL OR (n.type = 'persistent' AND tm.user_id IS NOT NULL))`,
		userID, userID, userID, nestID, userID,
	).Scan(&count)
	return count > 0, err
}

func (s *Server) canModerate(userID, nestID string) (bool, error) {
	var count int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM nests n
		 LEFT JOIN nest_members nm ON nm.nest_id = n.id AND nm.user_id = ? AND nm.role IN ('creator', 'moderator') AND nm.state = 'joined'
		 LEFT JOIN tree_members tm ON tm.tree_id = n.tree_id AND tm.user_id = ? AND tm.role IN ('owner', 'moderator') AND tm.state = 'joined'
		 WHERE n.id = ? AND (n.creator_user_id = ? OR nm.user_id IS NOT NULL OR tm.user_id IS NOT NULL)`,
		userID, userID, nestID, userID,
	).Scan(&count)
	return count > 0, err
}

func (s *Server) membershipState(nestID, userID string) (state string, role string, err error) {
	err = s.db.QueryRow(`SELECT state, role FROM nest_members WHERE nest_id = ? AND user_id = ?`, nestID, userID).Scan(&state, &role)
	return state, role, err
}

func (s *Server) nestDetails(nest Nest) (NestDetails, error) {
	members, err := s.members(nest.ID)
	if err != nil {
		return NestDetails{}, err
	}
	invitations, err := s.invitations(nest.ID)
	if err != nil {
		return NestDetails{}, err
	}
	requests, err := s.joinRequests(nest.ID)
	if err != nil {
		return NestDetails{}, err
	}
	return NestDetails{Nest: withLinks(nest), Members: members, Invitations: invitations, JoinRequests: requests}, nil
}

func (s *Server) members(nestID string) ([]Member, error) {
	rows, err := s.db.Query(
		`SELECT nm.nest_id, u.id, u.username, COALESCE(NULLIF(TRIM(up.display_name), ''), u.username), nm.role, nm.state, nm.joined_at, nm.left_at
		 FROM nest_members nm
		 JOIN users u ON u.id = nm.user_id
		 LEFT JOIN user_preferences up ON up.user_id = u.id
		 WHERE nm.nest_id = ?
		 ORDER BY nm.role, u.username`, nestID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	members := []Member{}
	for rows.Next() {
		var member Member
		if err := rows.Scan(&member.NestID, &member.UserID, &member.Username, &member.DisplayName, &member.Role, &member.State, &member.JoinedAt, &member.LeftAt); err != nil {
			return nil, err
		}
		members = append(members, member)
	}
	return members, rows.Err()
}

func (s *Server) invitations(nestID string) ([]Invitation, error) {
	rows, err := s.db.Query(
		`SELECT ni.id, ni.nest_id, u.id, u.username, COALESCE(NULLIF(TRIM(up.display_name), ''), u.username), ni.created_at
		 FROM nest_invitations ni
		 JOIN users u ON u.id = ni.invited_user_id
		 LEFT JOIN user_preferences up ON up.user_id = u.id
		 WHERE ni.nest_id = ?
		 ORDER BY ni.created_at DESC`, nestID,
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

func (s *Server) joinRequests(nestID string) ([]JoinRequest, error) {
	rows, err := s.db.Query(
		`SELECT jr.id, jr.nest_id, n.name, u.id, u.username, COALESCE(NULLIF(TRIM(up.display_name), ''), u.username), jr.status, jr.created_at, jr.resolved_at
		 FROM nest_join_requests jr
		 JOIN users u ON u.id = jr.user_id
		 LEFT JOIN user_preferences up ON up.user_id = u.id
		 JOIN nests n ON n.id = jr.nest_id
		 WHERE jr.nest_id = ?
		 ORDER BY jr.created_at DESC`, nestID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	requests := []JoinRequest{}
	for rows.Next() {
		var request JoinRequest
		if err := rows.Scan(&request.ID, &request.NestID, &request.NestName, &request.UserID, &request.Username, &request.DisplayName, &request.Status, &request.CreatedAt, &request.ResolvedAt); err != nil {
			return nil, err
		}
		requests = append(requests, request)
	}
	return requests, rows.Err()
}

func (s *Server) pendingAdmissionForCreator(userID string) ([]JoinRequest, error) {
	rows, err := s.db.Query(
		`SELECT jr.id, jr.nest_id, n.name, u.id, u.username, COALESCE(NULLIF(TRIM(up.display_name), ''), u.username), jr.status, jr.created_at, jr.resolved_at
		 FROM nest_join_requests jr
		 JOIN nests n ON n.id = jr.nest_id
		 JOIN users u ON u.id = jr.user_id
		 LEFT JOIN user_preferences up ON up.user_id = u.id
		 LEFT JOIN nest_members nm ON nm.nest_id = n.id AND nm.user_id = ? AND nm.role IN ('creator', 'moderator') AND nm.state = 'joined'
		 LEFT JOIN tree_members tm ON tm.tree_id = n.tree_id AND tm.user_id = ? AND tm.role IN ('owner', 'moderator') AND tm.state = 'joined'
		 WHERE (n.creator_user_id = ? OR nm.user_id IS NOT NULL OR tm.user_id IS NOT NULL) AND jr.status = 'pending'
		 ORDER BY jr.created_at DESC`, userID, userID, userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	requests := []JoinRequest{}
	for rows.Next() {
		var request JoinRequest
		if err := rows.Scan(&request.ID, &request.NestID, &request.NestName, &request.UserID, &request.Username, &request.DisplayName, &request.Status, &request.CreatedAt, &request.ResolvedAt); err != nil {
			return nil, err
		}
		requests = append(requests, request)
	}
	return requests, rows.Err()
}

func (s *Server) pendingRequest(nestID, userID string) (JoinRequest, error) {
	var request JoinRequest
	err := s.db.QueryRow(
		`SELECT jr.id, jr.nest_id, n.name, u.id, u.username, COALESCE(NULLIF(TRIM(up.display_name), ''), u.username), jr.status, jr.created_at, jr.resolved_at
		 FROM nest_join_requests jr
		 JOIN users u ON u.id = jr.user_id
		 LEFT JOIN user_preferences up ON up.user_id = u.id
		 JOIN nests n ON n.id = jr.nest_id
		 WHERE jr.nest_id = ? AND jr.user_id = ? AND jr.status = 'pending'`,
		nestID, userID,
	).Scan(&request.ID, &request.NestID, &request.NestName, &request.UserID, &request.Username, &request.DisplayName, &request.Status, &request.CreatedAt, &request.ResolvedAt)
	return request, err
}

func (s *Server) findJoinRequest(nestID, requestID string) (JoinRequest, error) {
	var request JoinRequest
	err := s.db.QueryRow(
		`SELECT jr.id, jr.nest_id, n.name, u.id, u.username, COALESCE(NULLIF(TRIM(up.display_name), ''), u.username), jr.status, jr.created_at, jr.resolved_at
		 FROM nest_join_requests jr
		 JOIN users u ON u.id = jr.user_id
		 LEFT JOIN user_preferences up ON up.user_id = u.id
		 JOIN nests n ON n.id = jr.nest_id
		 WHERE jr.nest_id = ? AND jr.id = ? AND jr.status = 'pending'`,
		nestID, requestID,
	).Scan(&request.ID, &request.NestID, &request.NestName, &request.UserID, &request.Username, &request.DisplayName, &request.Status, &request.CreatedAt, &request.ResolvedAt)
	return request, err
}

func extractJoinCode(input string) string {
	input = strings.TrimSpace(input)
	input = strings.TrimSuffix(input, "/")
	if input == "" {
		return ""
	}
	if idx := strings.LastIndex(input, "/"); idx >= 0 {
		return strings.TrimSpace(input[idx+1:])
	}
	return input
}

func withLinks(nest Nest) Nest {
	nest.ShareableLink = "raven://nest/" + nest.JoinCode
	nest.HTTPLink = "https://raven.local/nest/" + nest.JoinCode
	return nest
}

func liveKitSessionName(nestID string) string {
	return "raven-nest-" + nestID
}

// audioParticipantIdentity is the LiveKit identity of a user's Rust-owned "audio
// sidecar" participant. The desktop client joins each nest room twice: the main
// participant (video/screenshare/presence) under the bare user id, and this sidecar
// under "<userId>#audio" which publishes and plays the processed audio. The UI folds
// the sidecar back into its owner by stripping this suffix.
func audioParticipantIdentity(userID string) string {
	return userID + "#audio"
}

// videoParticipantIdentity is the LiveKit identity of a user's Rust-owned "video
// sidecar" participant. It publishes the camera and screen-share tracks captured
// natively by the desktop client. The UI folds the sidecar back into its owner by
// stripping this suffix, exactly like the audio sidecar.
func videoParticipantIdentity(userID string) string {
	return userID + "#video"
}
