# Plan 02: Emoji: one bundled set, big emoji messages, a picker, `:shortcode` suggestions

Read `C:\Users\Soroush Taheri\code\raven\docs\plans\messages-and-emoji\README.md` first,
and the three `raven-ui` files it lists. Work in the worktree plan 01 made.

When you're done:
- Every emoji in Raven is drawn from Twemoji, on Windows and Linux alike, including flags
  (Windows draws 🇮🇷 as "IR" today).
- A message of 1 to 3 emoji shows large, with no bubble.
- The composer has an emoji button that opens a picker, and typing `:smi` offers 😄.
- Plan 04 reuses the picker for reactions, so build it as a plain component with an
  `onPick` callback and no popover of its own.

## 1. The font

1. In `apps/desktop`: `bun add twemoji-colr-font@15.0.3 emojibase-data@18.0.0` (exact
   versions).
2. `src/main.tsx`: `import "twemoji-colr-font/twemoji.css";` next to the other font
   imports. It declares the family `Twemoji` (COLR/CPAL tables, which WebView2 and
   WebKitGTK's Skia both draw in color).
3. Put `"Twemoji"` right after `"Vazirmatn Variable"` in the `:root` `font-family` in
   `src/styles.css` and in `fontFamily.sans` in `tailwind.config.ts`, and right after
   `"Geist Mono Variable"` in both mono stacks. Keep `"Segoe UI Emoji", "Noto Color Emoji"`
   at the end: they draw anything newer than Unicode 15. Update the comment above the stack
   in `styles.css` to say why Twemoji is bundled (one look everywhere, flags on Windows).
   Twemoji also has glyphs for digits, `#` and `*` (keycap bases); because it comes after
   Geist, plain digits stay Geist. Don't add a `unicode-range`.
4. Grep `apps/desktop/src` for any other `font-family` or canvas `font` and add Twemoji
   the same way.
5. Run `bun scripts/third-party-notices.ts` in `apps/desktop` so the font's licence lands
   in `src-tauri/THIRD-PARTY-NOTICES.md`. If it fails on the Rust side, leave it and say
   so in your summary.

## 2. Emoji-only messages without a bubble

`emojiOnlyCount(body)` in `src/lib/chat/format.ts` already returns 1 to 3 for a message
that is only emoji, else 0. `MessageText.tsx` makes those `text-display`.

- Add three sizes to `fontSize` in `tailwind.config.ts`, with a comment that they're for
  emoji-only messages and nothing else:
  `"emoji-1": ["48px", { lineHeight: "56px" }]`, `"emoji-2": ["40px", { lineHeight:
  "48px" }]`, `"emoji-3": ["32px", { lineHeight: "40px" }]`.
- `MessageText` uses `text-emoji-1/2/3` by count instead of `text-display`.
- `MessageRow` (`src/components/chat/MessageRow.tsx`): there is already a `bare` layout
  for image-only messages. Add the same for a message that is emoji-only, not deleted, has
  no attachments and no reply: no bubble background and no bubble padding; the sender's
  name above it in groups exactly as the bare image does; `MessageMeta` (time, edited,
  ticks) under it as plain caption (not the over-image pill), aligned to the message's
  side. Highlighting (jump to message) keeps working.
- `PendingRow` gets the same bare emoji layout, with its "Sending…" meta under it.
- An emoji-only message *with* a reply keeps its bubble, with the large emoji inside.
- Text in these stays selectable and copyable.

## 3. Emoji data

`src/lib/emoji/data.ts`:

```ts
export interface EmojiEntry {
  emoji: string;        // fully qualified, e.g. "❤️"
  label: string;        // "red heart"
  group: number;        // emojibase group
  order: number;
  tags: string[];
  shortcodes: string[]; // GitHub set without colons: ["heart"]
  skins?: string[];     // five toned variants, light to dark, when it has them
}
export interface EmojiData { list: EmojiEntry[]; byShortcode: Map<string, EmojiEntry> }
/** Loaded once, lazily, so the data is a separate chunk and not in the main bundle. */
export function loadEmoji(): Promise<EmojiData>;
export function searchEmoji(data: EmojiData, query: string, limit?: number): EmojiEntry[];
export function withTone(entry: EmojiEntry, tone: number): string; // tone 0 = none, 1..5
```

- Source: dynamic `import("emojibase-data/en/data.json")` and
  `import("emojibase-data/en/shortcodes/github.json")` (keyed by hexcode). Use `data.json`,
  not `compact.json`: only `data.json` has `version`.
- Keep entries that have a `group`, are not group 2 (components) and have `version <= 15`
  (what Twemoji 15.0 covers). Skins filtered the same way, ordered by `tone`. Sort by
  `order`.
- `searchEmoji`: case-insensitive, trimmed, a leading `:` ignored. Rank: shortcode starts
  with query, then a label word starts with it, then a tag starts with it, then the label
  contains it; ties by `order`. Default limit 64.
- Tests in `data.test.ts`: `heart` finds ❤️ first, `:+1` finds 👍, `smi` finds 😄 among
  the first results, a component (🏻 alone) never appears, an emoji newer than 15.0 (🐦‍🔥
  phoenix, 15.1) never appears, `withTone` gives 👍🏽 for tone 3.

`src/lib/emoji/prefs.ts`, all `localStorage` access in `try/catch`:
- `recentEmoji(): string[]` and `recordEmoji(emoji)`: most recent first, no duplicates,
  at most 24. Key `raven.emoji.recent`.
- `skinTone(): number` and `setSkinTone(tone)`, 0 to 5. Key `raven.emoji.tone`.
- Tested with a fake storage, like `lib/notifications.test.ts` does.

## 4. The picker

`src/components/chat/EmojiPicker.tsx`:

```ts
export function EmojiPicker(props: { onPick: (emoji: string) => void; autoFocus?: boolean }): JSX.Element
```

Layout (all colours, radii, borders and focus rings from `design-system.md`; these sizes
are deliberate):

- **Width** 344 px: 8 columns of 40 px plus 12 px padding each side.
- **Top**: the search field (`components/ui/input`), placeholder `Search emoji`,
  focused when `autoFocus`. To its right a 32 px tone button showing ✋ in the current tone
  (`aria-label="Skin tone"`). Pressing it shows a row of six hands (✋ and its five tones)
  under the search field; picking one saves it, applies it to every emoji with skins, and
  hides the row.
- **Category bar** under that: 32 px icon buttons from `lucide-react`, in this order, each
  with a `Tooltip` and `aria-label` of its section name: `Clock` Recent, `Smile` Smileys
  and people, `Leaf` Animals and nature, `Coffee` Food and drink, `Plane` Travel and
  places, `Trophy` Activities, `Lightbulb` Objects, `Heart` Symbols, `Flag` Flags. Clicking
  scrolls to the section; scrolling marks the section in view as current (the current
  icon is `text-foreground`, the rest `text-subtle`). Hide Recent while it is empty.
- **Grid**: 320 px tall, scrolls. Sections in that order, emojibase groups 0 and 1 merged
  into "Smileys and people". Each section starts with its name in `text-caption
  text-muted-foreground`, sentence case as written above. Cells are 40 × 40 buttons,
  `rounded-control`, the emoji at 26 px with `leading-none`, `hover:bg-secondary`,
  `aria-label` = the label. Give each section `content-visibility: auto` with a
  `contain-intrinsic-size` so opening stays fast with ~1,800 cells.
- **Search**: while the field has text, the sections give way to one grid of results. No
  results: `No emoji found` in `text-small text-muted-foreground`, centred.
- **Footer**: 32 px, shows the hovered or focused emoji at 20 px, its label, and
  `:shortcode:` in `text-caption text-muted-foreground`. Empty, but the same height, when
  nothing is hovered.
- Until `loadEmoji()` resolves, show the frame with an empty grid; no spinner.
- **Keyboard**: ArrowDown in the search field moves to the first cell; arrow keys move in
  the grid (up and down by 8); Enter or Space picks; typing a letter in the grid goes back
  to the search field with that letter. Use a roving `tabIndex` so Tab leaves the grid in
  one step.
- Picking calls `recordEmoji` then `onPick`.

## 5. The composer

`src/components/chat/Composer.tsx`:

- A `Smile` ghost icon button, same `Button size="icon" variant="ghost"` as the Add images
  button, placed just left of the Send button. `aria-label="Emoji"` and a `Tooltip`
  "Emoji". It opens the picker in a `Popover` (`components/ui/popover`), `side="top"`,
  `align="end"`, styled like the other popovers.
- Picking inserts the emoji at the textarea's caret (replacing a selection) through the
  composer's existing draft state, so drafts are saved and the textarea resizes as usual.
  The picker stays open for more; the caret ends after the inserted emoji. Escape or a
  click outside closes it and returns focus to the textarea.

### `:shortcode` suggestions

Pure functions in `src/lib/emoji/shortcodes.ts`, tested in `shortcodes.test.ts`:

```ts
/** The `:token` being typed before the caret, or null. At least two characters after the colon. */
export function shortcodeQuery(text: string, caret: number): { start: number; query: string } | null;
/** If the text just before the caret is a complete known `:code:`, the replacement. */
export function completedShortcode(text: string, caret: number, data: EmojiData): { start: number; emoji: string } | null;
```

- A token is `:` at the start of the text or after whitespace or `(`, then 2+ of
  `[a-z0-9_+-]`. Never inside code: not when the caret is inside a `` ` `` span on its line
  or inside a ``` fence (an odd number of ``` before the caret).
- Suggestions: up to 6 from `searchEmoji`, shortcode matches only, in a list floating
  above the composer (`absolute bottom-full mb-2 left-0`, width 280 px, popover surface).
  Rows 32 px: the emoji at 20 px and `:shortcode:` in `text-small
  text-muted-foreground`; the active row `bg-secondary`. `role="listbox"` with `option`s,
  and `aria-activedescendant` on the textarea.
- While the list shows: ArrowUp and ArrowDown move, Enter or Tab inserts (Enter does not
  send), Escape hides it until the token changes. A click inserts. Inserting replaces the
  token with the emoji and calls `recordEmoji`.
- Typing the closing `:` of a complete known code (`:smile:`) replaces it with the emoji at
  once.
- Data loads on the first `:` typed (`loadEmoji()`), not when the composer mounts.

## 6. Docs

`docs/chat.md`: in Client, a short paragraph on the bundled Twemoji font (and why), big
emoji messages, the picker and suggestions. Remove "an emoji picker (the system picker
works)" from "Not in this version".

## Done when

- The README's checks pass. New tests cover data filtering and search, prefs, and
  shortcode detection, completion and the code-span rule.
- `MessageText`, `MessageRow` and `PendingRow` changes are covered by any existing
  render tests you can extend (see `Attachments.test.tsx` for how components are tested
  here).
- `vite build` shows the emoji data in its own chunk, not in the main one. Say the sizes
  in your summary.
- Committed on `codex/messages-and-emoji`.
