// Package bot is the conversation: stickers and GIFs in, .ravenpack files out.
package bot

import (
	"context"
	"fmt"
	"log/slog"
	"path"
	"strings"
	"sync"
	"time"

	"raven/services/telegram-bot/internal/botapi"
	"raven/services/telegram-bot/internal/drafts"
	"raven/services/telegram-bot/internal/ravenpack"
)

const (
	maxAnimationSeconds = 10
	maxDownloadBytes    = 20 << 20
	packLimit           = 48 << 20
	downloadSlots       = 4
	maxSkippedLines     = 20
	defaultPackTitle    = "Telegram pack"
)

const startText = `I turn Telegram stickers and GIFs into a Raven pack.

Send me stickers, GIFs and .gif files. For a sticker from a set I can add just that one or the whole set.

/done  send the pack, then import it in Raven
/title <name>  name the pack
/cancel  throw the draft away

Drafts live in memory: a restart or 24 hours of silence clears them.`

type Bot struct {
	API   *botapi.Client
	Store *drafts.Store
	Log   *slog.Logger

	sem    chan struct{}
	qmu    sync.Mutex
	queues map[int64]*[]func()
}

func New(api *botapi.Client, store *drafts.Store, log *slog.Logger) *Bot {
	return &Bot{API: api, Store: store, Log: log, sem: make(chan struct{}, downloadSlots), queues: map[int64]*[]func(){}}
}

// Run long-polls until ctx ends.
func (b *Bot) Run(ctx context.Context) error {
	go b.sweepLoop(ctx)
	var offset int64
	for ctx.Err() == nil {
		ups, err := b.API.GetUpdates(ctx, offset, 30)
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			b.Log.Warn("getUpdates failed", "err", err)
			select {
			case <-ctx.Done():
			case <-time.After(5 * time.Second):
			}
			continue
		}
		for _, u := range ups {
			offset = u.UpdateID + 1
			u := u
			if user, ok := updateUser(u); ok {
				b.serial(user, func() { b.safeHandle(ctx, u) })
			}
		}
	}
	return nil
}

func updateUser(u botapi.Update) (int64, bool) {
	switch {
	case u.Message != nil && u.Message.From != nil:
		return u.Message.From.ID, true
	case u.CallbackQuery != nil:
		return u.CallbackQuery.From.ID, true
	}
	return 0, false
}

// serial runs fns for one user one after another, in arrival order.
func (b *Bot) serial(user int64, fn func()) {
	b.qmu.Lock()
	if q, ok := b.queues[user]; ok {
		*q = append(*q, fn)
		b.qmu.Unlock()
		return
	}
	q := &[]func(){fn}
	b.queues[user] = q
	b.qmu.Unlock()
	go func() {
		for {
			b.qmu.Lock()
			if len(*q) == 0 {
				delete(b.queues, user)
				b.qmu.Unlock()
				return
			}
			f := (*q)[0]
			*q = (*q)[1:]
			b.qmu.Unlock()
			f()
		}
	}()
}

func (b *Bot) safeHandle(ctx context.Context, u botapi.Update) {
	defer func() {
		if r := recover(); r != nil {
			b.Log.Error("handler panic", "panic", fmt.Sprint(r))
		}
	}()
	b.Handle(ctx, u)
}

func (b *Bot) sweepLoop(ctx context.Context) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			for _, user := range b.Store.Expired() {
				user := user
				b.serial(user, func() {
					if b.Store.IsExpired(user) {
						b.Store.Clear(user)
					}
				})
			}
		}
	}
}

// Handle processes one update synchronously.
func (b *Bot) Handle(ctx context.Context, u botapi.Update) {
	if user, ok := updateUser(u); ok && b.Store.IsExpired(user) {
		b.Store.Clear(user)
	}
	switch {
	case u.CallbackQuery != nil:
		b.handleCallback(ctx, u.CallbackQuery)
	case u.Message != nil && u.Message.From != nil:
		b.handleMessage(ctx, u.Message)
	}
}

func (b *Bot) say(ctx context.Context, chatID int64, text string) {
	if _, err := b.API.SendMessage(ctx, chatID, text, 0, nil); err != nil {
		b.Log.Warn("sendMessage failed", "err", err)
	}
}

func (b *Bot) handleMessage(ctx context.Context, m *botapi.Message) {
	user, chat := m.From.ID, m.Chat.ID
	switch {
	case m.Sticker != nil:
		b.handleSticker(ctx, m, user)
	case m.Animation != nil:
		a := m.Animation
		b.addCandidates(ctx, user, chat, []cand{{label: "animation", fileID: a.FileID, uniqueID: a.FileUniqueID,
			extHint: ".mp4", kind: "gif", size: a.FileSize, skip: animationSkip(*a)}}, "")
	case m.Document != nil && isGIFDocument(*m.Document):
		d := m.Document
		b.addCandidates(ctx, user, chat, []cand{{label: "GIF", fileID: d.FileID, uniqueID: d.FileUniqueID,
			extHint: ".gif", kind: "gif", size: d.FileSize, skip: sizeSkip(d.FileSize)}}, "")
	case m.Document != nil:
		b.say(ctx, chat, "I only take stickers, GIFs and .gif files.")
	case strings.HasPrefix(m.Text, "/"):
		b.handleCommand(ctx, m)
	default:
		b.say(ctx, chat, "Send me stickers or GIFs, then /done. /start lists what I can do.")
	}
}

func (b *Bot) handleCommand(ctx context.Context, m *botapi.Message) {
	user, chat := m.From.ID, m.Chat.ID
	cmd, rest, _ := strings.Cut(strings.TrimSpace(m.Text), " ")
	cmd, _, _ = strings.Cut(strings.ToLower(cmd), "@")
	rest = strings.TrimSpace(rest)
	switch cmd {
	case "/start", "/help":
		b.say(ctx, chat, startText)
	case "/cancel":
		if b.Store.Get(user) == nil {
			b.say(ctx, chat, "Nothing to cancel.")
			return
		}
		b.Store.Clear(user)
		b.say(ctx, chat, "Draft cleared.")
	case "/title":
		d, err := b.Store.Ensure(user)
		if err != nil {
			b.Log.Error("draft failed", "err", err)
			b.say(ctx, chat, "Something went wrong. Try again.")
			return
		}
		if rest == "" {
			b.say(ctx, chat, "Pack title: "+packTitle(d)+". Change it with /title <name>.")
			return
		}
		if r := []rune(rest); len(r) > 80 {
			rest = string(r[:80])
		}
		d.Title = rest
		b.say(ctx, chat, "Pack title: "+rest)
	case "/done":
		b.done(ctx, user, chat)
	default:
		b.say(ctx, chat, "I don't know that command. /start lists what I can do.")
	}
}

func packTitle(d *drafts.Draft) string {
	switch {
	case d.Title != "":
		return d.Title
	case d.DefaultTitle != "":
		return d.DefaultTitle
	}
	return defaultPackTitle
}

func (b *Bot) handleSticker(ctx context.Context, m *botapi.Message, user int64) {
	st := m.Sticker
	chat := m.Chat.ID
	c := stickerCand(*st, "")
	if c.skip == "" && st.SetName != "" {
		d, err := b.Store.Ensure(user)
		if err == nil {
			if set, err := b.API.GetStickerSet(ctx, st.SetName); err == nil && len(set.Stickers) > 0 {
				d.SetTitles[st.SetName] = set.Title
				_, err := b.API.SendMessage(ctx, chat, "Add just this sticker, or the whole pack?", m.MessageID, []botapi.Button{
					{Text: "Add this sticker", CallbackData: "add"},
					{Text: fmt.Sprintf("Add the whole pack (%d)", len(set.Stickers)), CallbackData: "pack"},
				})
				if err != nil {
					b.Log.Warn("sendMessage failed", "err", err)
				}
				return
			}
		}
	}
	var title string
	if d := b.Store.Get(user); d != nil {
		title = d.SetTitles[st.SetName]
	}
	c.title = title
	b.addCandidates(ctx, user, chat, []cand{c}, "")
}

func (b *Bot) handleCallback(ctx context.Context, cq *botapi.CallbackQuery) {
	answer := func(text string) {
		if err := b.API.AnswerCallbackQuery(ctx, cq.ID, text); err != nil {
			b.Log.Warn("answerCallbackQuery failed", "err", err)
		}
	}
	if cq.Message == nil || cq.Message.ReplyToMessage == nil || cq.Message.ReplyToMessage.Sticker == nil {
		answer("Send the sticker again.")
		return
	}
	user, chat, promptID := cq.From.ID, cq.Message.Chat.ID, cq.Message.MessageID
	st := cq.Message.ReplyToMessage.Sticker
	var cands []cand
	var setTitle string
	switch cq.Data {
	case "add":
		if d := b.Store.Get(user); d != nil {
			setTitle = d.SetTitles[st.SetName]
		}
		cands = []cand{stickerCand(*st, setTitle)}
		setTitle = ""
	case "pack":
		set, err := b.API.GetStickerSet(ctx, st.SetName)
		if err != nil {
			b.Log.Warn("getStickerSet failed", "err", err)
			answer("Couldn't read the pack.")
			return
		}
		for _, s := range set.Stickers {
			cands = append(cands, stickerCand(s, set.Title))
		}
		setTitle = set.Title
	default:
		answer("")
		return
	}
	answer("")
	if err := b.API.EditMessageText(ctx, chat, promptID, "Adding..."); err != nil {
		b.Log.Warn("editMessageText failed", "err", err)
	}
	b.addCandidates(ctx, user, chat, cands, setTitle)
	if err := b.API.EditMessageText(ctx, chat, promptID, "Added."); err != nil {
		b.Log.Warn("editMessageText failed", "err", err)
	}
}

// cand is one Telegram file that may become an item.
type cand struct {
	label, fileID, uniqueID, extHint, kind, title, emoji string
	size                                                 int64
	skip                                                 string // reason, when it must be skipped
}

func stickerCand(st botapi.Sticker, setTitle string) cand {
	ext := ".webp"
	switch {
	case st.IsAnimated:
		ext = ".tgs"
	case st.IsVideo:
		ext = ".webm"
	}
	label := "sticker"
	if st.Emoji != "" {
		label += " " + st.Emoji
	}
	return cand{label: label, fileID: st.FileID, uniqueID: st.FileUniqueID, extHint: ext, kind: "sticker",
		title: setTitle, emoji: st.Emoji, size: st.FileSize, skip: stickerSkip(st)}
}

func stickerSkip(st botapi.Sticker) string {
	if st.Type == "custom_emoji" {
		return "custom emoji aren't supported"
	}
	return sizeSkip(st.FileSize)
}

func animationSkip(a botapi.Animation) string {
	if a.Duration > maxAnimationSeconds {
		return "longer than 10 seconds"
	}
	return sizeSkip(a.FileSize)
}

func sizeSkip(size int64) string {
	if size > maxDownloadBytes {
		return "bigger than 20 MB"
	}
	return ""
}

func isGIFDocument(d botapi.Document) bool {
	return d.MimeType == "image/gif" || strings.HasSuffix(strings.ToLower(d.FileName), ".gif")
}

type fetched struct {
	item   ravenpack.Item
	reason string // set when the item was skipped
	ok     bool
}

// addCandidates downloads what can be added and reports the new status.
// wholeSetTitle is set when candidates are a whole sticker set.
func (b *Bot) addCandidates(ctx context.Context, user, chat int64, cands []cand, wholeSetTitle string) {
	d, err := b.Store.Ensure(user)
	if err != nil {
		b.Log.Error("draft failed", "err", err)
		b.say(ctx, chat, "Something went wrong. Try again.")
		return
	}
	type job struct {
		c    cand
		base string
	}
	var jobs []job
	inBatch := map[string]bool{}
	for _, c := range cands {
		switch {
		case c.skip != "":
			d.Skipped = append(d.Skipped, c.label+": "+c.skip)
		case d.Seen(c.uniqueID) || (c.uniqueID != "" && inBatch[c.uniqueID]):
			// Already in the draft; adding it twice would only make a duplicate.
		case len(d.Items)+len(jobs) >= drafts.MaxItems:
			d.Skipped = append(d.Skipped, c.label+": over the 500 item limit")
		default:
			inBatch[c.uniqueID] = true
			jobs = append(jobs, job{c, d.NextPath("")})
		}
	}
	results := make([]fetched, len(jobs))
	var wg sync.WaitGroup
	for i := range jobs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = b.fetch(ctx, jobs[i].c, jobs[i].base)
		}(i)
	}
	wg.Wait()
	for i, r := range results {
		if r.ok {
			d.Add(r.item)
		} else {
			d.Skipped = append(d.Skipped, jobs[i].c.label+": "+r.reason)
		}
	}
	if wholeSetTitle != "" && d.DefaultTitle == "" {
		d.DefaultTitle = wholeSetTitle
	}
	b.Store.Touch(d)
	b.status(ctx, chat, d)
}

// fetch downloads one candidate to base+ext, 4 at a time.
func (b *Bot) fetch(ctx context.Context, c cand, base string) fetched {
	select {
	case b.sem <- struct{}{}:
		defer func() { <-b.sem }()
	case <-ctx.Done():
		return fetched{reason: "download failed"}
	}
	f, err := b.API.GetFile(ctx, c.fileID)
	if err != nil {
		if strings.Contains(err.Error(), "too big") {
			return fetched{reason: "bigger than 20 MB"}
		}
		b.Log.Warn("getFile failed", "err", err)
		return fetched{reason: "download failed"}
	}
	if f.FileSize > maxDownloadBytes {
		return fetched{reason: "bigger than 20 MB"}
	}
	ext := c.extHint
	if c.kind == "gif" {
		if e := strings.ToLower(path.Ext(f.FilePath)); e == ".gif" || e == ".mp4" {
			ext = e
		}
	}
	dst := base + ext
	if err := b.API.Download(ctx, f.FilePath, dst); err != nil {
		b.Log.Warn("download failed", "err", err)
		return fetched{reason: "download failed"}
	}
	return fetched{ok: true, item: ravenpack.Item{Path: dst, Ext: ext, Kind: c.kind, Title: c.title, Emoji: c.emoji, UniqueID: c.uniqueID}}
}

func statusText(d *drafts.Draft) string {
	st, gif := d.Counts()
	var parts []string
	if st > 0 {
		parts = append(parts, plural(st, "sticker"))
	}
	if gif > 0 {
		parts = append(parts, plural(gif, "GIF"))
	}
	if len(parts) == 0 {
		parts = append(parts, "nothing added yet")
	}
	text := fmt.Sprintf("%s: %s. Send more, or /done.", plural(len(d.Items), "item"), strings.Join(parts, ", "))
	if n := len(d.Skipped); n > 0 {
		text += fmt.Sprintf("\n%d skipped; /done lists them.", n)
	}
	return text
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return fmt.Sprintf("%d %ss", n, word)
}

// status edits the one status message in place, or sends it the first time.
func (b *Bot) status(ctx context.Context, chat int64, d *drafts.Draft) {
	text := statusText(d)
	if d.StatusMsgID != 0 {
		err := b.API.EditMessageText(ctx, chat, d.StatusMsgID, text)
		if err == nil || strings.Contains(err.Error(), "not modified") {
			return
		}
	}
	id, err := b.API.SendMessage(ctx, chat, text, 0, nil)
	if err != nil {
		b.Log.Warn("sendMessage failed", "err", err)
		return
	}
	d.StatusMsgID = id
}

func (b *Bot) done(ctx context.Context, user, chat int64) {
	d := b.Store.Get(user)
	if d == nil || len(d.Items) == 0 {
		b.say(ctx, chat, "Nothing to send yet. Send me stickers or GIFs first.")
		return
	}
	if !b.Store.PackAllowed(user) {
		b.say(ctx, chat, fmt.Sprintf("That's %d packs today, the daily limit. Try again tomorrow.", drafts.MaxPerDay))
		return
	}
	packs, err := ravenpack.Build(d.Dir, packTitle(d), d.Items, packLimit)
	if err != nil {
		b.Log.Error("pack build failed", "err", err)
		b.say(ctx, chat, "Couldn't build the pack. Try /done again.")
		return
	}
	for _, p := range packs {
		if err := b.API.SendDocument(ctx, chat, p.Path, p.Filename); err != nil {
			b.Log.Error("sendDocument failed", "err", err)
			b.say(ctx, chat, "Couldn't send the pack. Your draft is kept: try /done again.")
			return
		}
	}
	b.Store.RecordPacks(user, len(packs))
	msg := fmt.Sprintf("Sent %s with %s. Open it in Raven to import.", plural(len(packs), "pack"), plural(len(d.Items), "item"))
	if len(d.Skipped) > 0 {
		msg += fmt.Sprintf("\n\nSkipped %d:", len(d.Skipped))
		for i, s := range d.Skipped {
			if i == maxSkippedLines {
				msg += fmt.Sprintf("\n...and %d more", len(d.Skipped)-maxSkippedLines)
				break
			}
			msg += "\n- " + s
		}
	}
	b.Log.Info("pack sent", "packs", len(packs), "items", len(d.Items), "skipped", len(d.Skipped))
	b.Store.Clear(user)
	b.say(ctx, chat, msg)
}
