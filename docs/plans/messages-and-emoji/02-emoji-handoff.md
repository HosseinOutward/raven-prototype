# Plan 02: Emoji handoff

Implemented on `codex/messages-and-emoji`, following plan 01.

- Bundled Twemoji 15.0.3 and lazy emojibase-data 18.0.0, filtered to Unicode 15.
- One-to-three emoji messages use dedicated sizes and bare layouts, including pending
  messages. Replies and attachments retain their bubbles.
- Reusable EmojiPicker with search, categories, recents, skin tones and keyboard navigation.
- Composer caret insertion, shortcode suggestions and immediate completion outside code.
- Updated chat docs and generated third-party notices. The notice generator now includes
  CSS-only font packages, which it previously skipped.

Exact shortcode matches rank ahead of prefixes so `heart` returns red heart first,
as required by the plan's acceptance test; other ties retain emojibase order. Skin
variants with mixed tones are omitted because the picker has one tone setting.

## Validation

- `bun test`: 503 passed, zero failures (including 13 new tests).
- `bun run build`: passed. Lazy chunks: emoji data 785.62 kB (99.20 kB gzip),
  GitHub shortcodes 45.20 kB (15.73 kB gzip). Main chunk 1,077.46 kB
  (322.79 kB gzip). Twemoji font 476.46 kB. Vite's large-chunk advisory remains.
- UI sweep: no new findings. Four existing warnings in unchanged `WatcherStack.tsx`
  (lines 25, 29, 40, 60).
- Third-party notices regenerated successfully; Twemoji OFL licence included.
- `cargo test --lib cues`: could not finish. Dependency compilation exhausted disk
  space (Windows error 112). `cargo clean` recovered the generated build space;
  no build settings changed.
- `git diff --check`: passed.

Per the plan, the desktop app was not launched. Review should check color emoji and
flags in Windows/Linux, picker dimensions, category scrolling, keyboard navigation,
repeated insertion at a selection, closing focus, and shortcode completion in the app.
No push, merge, deployment or release.
