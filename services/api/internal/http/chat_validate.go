package http

import (
	"strings"
	"unicode/utf8"

	"github.com/gofiber/fiber/v2"
)

// normalizeChatBody checks message text and returns it as it will be stored.
//
// Text is kept as typed. In particular the invisible characters that Persian and Arabic
// need (the zero-width non-joiner and joiner, and the direction marks) are left alone,
// and so are the bidirectional embedding and override characters: the client isolates
// each paragraph when it draws it, so they cannot reach outside their own message.
// What is refused is text the database or a terminal would mishandle.
func normalizeChatBody(raw string) (string, error) {
	if len(raw) > chatMaxBodyBytes {
		return "", fiber.NewError(fiber.StatusRequestEntityTooLarge, "That message is too long.")
	}
	if !utf8.ValidString(raw) {
		return "", fiber.NewError(fiber.StatusBadRequest, "That message contains text Raven cannot store.")
	}
	body := strings.ReplaceAll(raw, "\r\n", "\n")
	body = strings.ReplaceAll(body, "\r", "\n")
	for _, r := range body {
		// C0 controls other than newline and tab, and DEL. NUL in particular cannot be
		// stored in a PostgreSQL text column at all.
		if (r < 0x20 && r != '\n' && r != '\t') || r == 0x7f {
			return "", fiber.NewError(fiber.StatusBadRequest, "That message contains text Raven cannot store.")
		}
	}
	body = strings.TrimSpace(body)
	if body == "" {
		return "", fiber.NewError(fiber.StatusBadRequest, "Write a message first.")
	}
	if utf8.RuneCountInString(body) > chatMaxBodyRunes {
		return "", fiber.NewError(fiber.StatusRequestEntityTooLarge, "That message is too long.")
	}
	return body, nil
}

// validClientMessageID accepts the identifier a client makes up for a message it is
// sending, which is what makes a retry safe. It is stored and echoed back, so its shape
// is kept tight.
func validClientMessageID(value string) bool {
	if len(value) < 8 || len(value) > 64 {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

// normalizeChatName checks the name of a group or text nest.
func normalizeChatName(raw string) (string, error) {
	name := strings.Join(strings.Fields(raw), " ")
	if name == "" {
		return "", fiber.NewError(fiber.StatusBadRequest, "A name is required.")
	}
	if !utf8.ValidString(name) || strings.ContainsRune(name, 0) {
		return "", fiber.NewError(fiber.StatusBadRequest, "That name contains text Raven cannot store.")
	}
	if utf8.RuneCountInString(name) > chatMaxNameRunes {
		return "", fiber.NewError(fiber.StatusBadRequest, "That name is too long.")
	}
	return name, nil
}

func normalizeChatTopic(raw string) (string, error) {
	topic := strings.Join(strings.Fields(raw), " ")
	if !utf8.ValidString(topic) || strings.ContainsRune(topic, 0) {
		return "", fiber.NewError(fiber.StatusBadRequest, "That description contains text Raven cannot store.")
	}
	if utf8.RuneCountInString(topic) > chatMaxTopicRunes {
		return "", fiber.NewError(fiber.StatusBadRequest, "That description is too long.")
	}
	return topic, nil
}

// chatExcerpt is the short single-line form of a message used in previews and in the
// quoted line above a reply.
func chatExcerpt(body string) string {
	flat := strings.Join(strings.Fields(body), " ")
	if utf8.RuneCountInString(flat) <= chatExcerptRunes {
		return flat
	}
	runes := []rune(flat)
	return string(runes[:chatExcerptRunes]) + "…"
}
