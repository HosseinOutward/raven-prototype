package http

import (
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"
)

const profileKnockCooldown = 60 * time.Second

// Only the sender receives this state; it is separate from the incoming inbox.
type ProfileKnockState struct {
	UserID    string `json:"userId"`
	State     string `json:"state"`
	Outcome   string `json:"outcome"`
	ExpiresAt string `json:"expiresAt"`
	RetryAt   string `json:"retryAt"`
}

func profileKnockState(knock Knock, now time.Time) *ProfileKnockState {
	if knock.ToUserID == nil || knock.Status == "accepted" {
		return nil
	}
	expires, err := time.Parse(time.RFC3339Nano, knock.ExpiresAt)
	if err != nil {
		return nil
	}
	state := ProfileKnockState{UserID: *knock.ToUserID, State: "cooldown", Outcome: knock.Status, ExpiresAt: knock.ExpiresAt}
	resolved := expires
	if knock.Status == "pending" && now.Before(expires) {
		state.State = "pending"
	} else if knock.Status == "pending" || knock.Status == "expired" {
		state.Outcome = "expired"
	} else if knock.ResolvedAt != nil {
		resolved, err = time.Parse(time.RFC3339Nano, *knock.ResolvedAt)
		if err != nil {
			return nil
		}
	} else {
		return nil
	}
	retry := resolved.Add(profileKnockCooldown)
	if state.State == "cooldown" && !now.Before(retry) {
		return nil
	}
	state.RetryAt = retry.Format(time.RFC3339Nano)
	return &state
}

func profileKnockStates(knocks []Knock, now time.Time) []ProfileKnockState {
	states := []ProfileKnockState{}
	indexes := map[string]int{}
	for _, knock := range knocks {
		state := profileKnockState(knock, now)
		if state == nil {
			continue
		}
		if i, exists := indexes[state.UserID]; exists {
			// Older servers allowed duplicates. Keep waiting while any one is pending.
			if (states[i].State != "pending" && state.State == "pending") || (states[i].State == state.State && state.RetryAt > states[i].RetryAt) {
				states[i] = *state
			}
			continue
		}
		indexes[state.UserID] = len(states)
		states = append(states, *state)
	}
	return states
}

func (s *Server) outgoingProfileKnocks(userID string) ([]ProfileKnockState, error) {
	now := time.Now().UTC()
	rows, err := s.db.Query(knockSelectSQL()+` WHERE k.from_user_id = ? AND k.to_user_id IS NOT NULL
		AND (k.status = 'pending' OR k.resolved_at > ?) ORDER BY k.created_at DESC`, userID, now.Add(-profileKnockCooldown).Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	knocks, err := scanKnocks(rows)
	if err != nil {
		return nil, err
	}
	return profileKnockStates(knocks, now), nil
}

func (s *Server) createProfileKnock(c *fiber.Ctx, fromUserID, toUserID, message string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Serialize sends across API processes too. SQLite transactions already take the write lock.
	if s.db.Driver() == "pgx" {
		var id string
		if err := tx.QueryRow(`SELECT id FROM users WHERE id = ? FOR UPDATE`, fromUserID).Scan(&id); err != nil {
			return err
		}
	}
	now := time.Now().UTC()
	rows, err := tx.Query(knockSelectSQL()+` WHERE k.from_user_id = ? AND k.to_user_id = ?
		AND (k.status = 'pending' OR k.resolved_at > ?) ORDER BY k.created_at DESC`, fromUserID, toUserID, now.Add(-profileKnockCooldown).Format(time.RFC3339Nano))
	if err != nil {
		return err
	}
	knocks, err := scanKnocks(rows)
	if err != nil {
		return err
	}
	if states := profileKnockStates(knocks, now); len(states) > 0 {
		state := states[0]
		if state.State == "pending" {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "Your knock is still waiting for an answer.", "reasonCode": "knock_pending", "profileKnock": state})
		}
		retry, _ := time.Parse(time.RFC3339Nano, state.RetryAt)
		seconds := int(math.Ceil(retry.Sub(now).Seconds()))
		c.Set("Retry-After", strconv.Itoa(seconds))
		return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{"error": fmt.Sprintf("You can knock again in %d seconds.", seconds), "reasonCode": "knock_cooldown", "profileKnock": state})
	}
	id := auth.NewID()
	if _, err := tx.Exec(`INSERT INTO knocks (id, from_user_id, to_user_id, status, message, created_at, expires_at)
		VALUES (?, ?, ?, 'pending', ?, ?, ?)`, id, fromUserID, toUserID, nullableString(message), now.Format(time.RFC3339Nano), now.Add(knockTTL()).Format(time.RFC3339Nano)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	knock, err := s.findKnock(id)
	if err != nil {
		return err
	}
	s.events.publish(LiveUpdate{Type: "knock.created", At: database.Now()})
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"knock": knock, "profileKnock": profileKnockState(knock, now)})
}
