package http

import (
	"bufio"
	"database/sql"
	"encoding/json"
	"fmt"
	"sync"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

type eventBroker struct {
	mu      sync.Mutex
	clients map[chan []byte]struct{}
}

type LiveUpdate struct {
	Type      string `json:"type"`
	NestID    string `json:"nestId,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	At        string `json:"at"`
}

func newEventBroker() *eventBroker {
	return &eventBroker{clients: map[chan []byte]struct{}{}}
}

func (b *eventBroker) subscribe() chan []byte {
	ch := make(chan []byte, 8)
	b.mu.Lock()
	b.clients[ch] = struct{}{}
	b.mu.Unlock()
	return ch
}

func (b *eventBroker) unsubscribe(ch chan []byte) {
	b.mu.Lock()
	delete(b.clients, ch)
	close(ch)
	b.mu.Unlock()
}

func (b *eventBroker) publish(update LiveUpdate) {
	payload, err := json.Marshal(update)
	if err != nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.clients {
		select {
		case ch <- payload:
		default:
		}
	}
}

func (s *Server) nestEvents(c *fiber.Ctx) error {
	c.Set("Content-Type", "text/event-stream")
	c.Set("Cache-Control", "no-cache")
	c.Set("Connection", "keep-alive")

	ch := s.events.subscribe()
	c.Context().SetBodyStreamWriter(func(w *bufio.Writer) {
		defer s.events.unsubscribe(ch)
		for payload := range ch {
			if _, err := fmt.Fprintf(w, "event: nest-update\ndata: %s\n\n", payload); err != nil {
				return
			}
			if err := w.Flush(); err != nil {
				return
			}
		}
	})
	return nil
}

func (s *Server) appendEvent(nestID, sessionID, userID, eventType string, metadata map[string]any) error {
	now := database.Now()
	var raw *string
	if metadata != nil {
		bytes, err := json.Marshal(metadata)
		if err != nil {
			return err
		}
		value := string(bytes)
		raw = &value
	}
	_, err := s.db.Exec(
		`INSERT INTO nest_event_log (id, nest_id, session_id, user_id, event_type, metadata_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		auth.NewID(), nestID, nullableString(sessionID), nullableString(userID), eventType, raw, now,
	)
	return err
}

func (s *Server) broadcastNestUpdate(nestID, updateType string) {
	s.events.publish(LiveUpdate{Type: updateType, NestID: nestID, At: database.Now()})
}

func (s *Server) broadcastSessionUpdate(nestID, sessionID, updateType string) {
	s.events.publish(LiveUpdate{Type: updateType, NestID: nestID, SessionID: sessionID, At: database.Now()})
}

func nullStringPtr(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func normalizeNestType(value, fallback string) string {
	if value == "" {
		value = fallback
	}
	if value == "permanent" {
		value = "persistent"
	}
	if value != "persistent" && value != "temporary" {
		return ""
	}
	return value
}
