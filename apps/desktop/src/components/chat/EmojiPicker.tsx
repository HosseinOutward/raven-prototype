import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Clock, Smile, Leaf, Coffee, Plane, Trophy, Lightbulb, Heart, Flag } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { loadEmoji, searchEmoji, withTone, type EmojiData, type EmojiEntry } from "@/lib/emoji/data";
import { recentEmoji, recordEmoji, setSkinTone, skinTone } from "@/lib/emoji/prefs";
import { cn } from "@/lib/utils";

const categories = [
  { name: "Recent", icon: Clock, groups: [] },
  { name: "Smileys and people", icon: Smile, groups: [0, 1] },
  { name: "Animals and nature", icon: Leaf, groups: [3] },
  { name: "Food and drink", icon: Coffee, groups: [4] },
  { name: "Travel and places", icon: Plane, groups: [5] },
  { name: "Activities", icon: Trophy, groups: [6] },
  { name: "Objects", icon: Lightbulb, groups: [7] },
  { name: "Symbols", icon: Heart, groups: [8] },
  { name: "Flags", icon: Flag, groups: [9] },
];
const hands = ["✋", "✋🏻", "✋🏼", "✋🏽", "✋🏾", "✋🏿"];

/** A reusable picker; its caller owns the floating surface and dismissal. */
export function EmojiPicker({ onPick, autoFocus = false }: { onPick: (emoji: string) => void; autoFocus?: boolean }) {
  const [data, setData] = useState<EmojiData>();
  const [query, setQuery] = useState("");
  const [tone, updateTone] = useState(skinTone);
  const [tonesOpen, setTonesOpen] = useState(false);
  const [recent, setRecent] = useState(recentEmoji);
  const [preview, setPreview] = useState<{ entry: EmojiEntry; emoji: string }>();
  const [current, setCurrent] = useState("Smileys and people");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    void loadEmoji().then((value) => { if (alive) setData(value); });
    if (autoFocus) input.current?.focus();
    return () => { alive = false; };
  }, [autoFocus]);
  const recentEntries = recent.flatMap((emoji) => {
    const entry = data?.list.find((item) => item.emoji === emoji || item.skins?.includes(emoji));
    return entry ? [{ entry, emoji: withTone(entry, tone) }] : [];
  }).filter((item, index, items) => items.findIndex((other) => other.emoji === item.emoji) === index);
  const sections = query.trim()
    ? [{ name: "Search", items: data ? searchEmoji(data, query).map((entry) => ({ entry, emoji: withTone(entry, tone) })) : [] }]
    : categories.filter((category) => category.name !== "Recent" || recentEntries.length > 0).map((category) => ({
      name: category.name,
      items: category.name === "Recent" ? recentEntries : (data?.list ?? []).filter((entry) => category.groups.includes(entry.group)).map((entry) => ({ entry, emoji: withTone(entry, tone) })),
    }));
  const pick = (emoji: string) => { recordEmoji(emoji); setRecent(recentEmoji()); onPick(emoji); };
  const cells = () => Array.from(grid.current?.querySelectorAll<HTMLButtonElement>("button[data-emoji]") ?? []);
  const gridKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8 };
    if (event.key in offsets) {
      event.preventDefault();
      const buttons = cells();
      const next = Math.max(0, Math.min(buttons.length - 1, index + offsets[event.key]));
      setActive(next); buttons[next]?.focus();
    } else if (event.key.length === 1 && /\p{L}/u.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); setQuery((value) => value + event.key); setActive(0); input.current?.focus();
    }
  };
  let index = 0;
  return (
    <div className="w-[344px] p-3">
      <div className="flex items-center gap-2">
        <Input ref={input} placeholder="Search emoji" aria-label="Search emoji" value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setActive(0); cells()[0]?.focus(); }
        }} />
        <button type="button" aria-label="Skin tone" aria-expanded={tonesOpen} onClick={() => setTonesOpen(!tonesOpen)} className="h-8 w-8 shrink-0 rounded-control hover:bg-secondary">{hands[tone]}</button>
      </div>
      {tonesOpen ? <div className="mt-1 flex">{hands.map((hand, value) => <button key={hand} type="button" aria-label={value === 0 ? "No skin tone" : `Skin tone ${value}`} aria-pressed={tone === value} className="h-8 w-8 rounded-control hover:bg-secondary" onClick={() => { setSkinTone(value); updateTone(value); setTonesOpen(false); }}>{hand}</button>)}</div> : null}
      <div className="my-1 flex justify-between">
        {categories.filter((category) => category.name !== "Recent" || recentEntries.length > 0).map(({ name, icon: Icon }) => <Tooltip key={name} label={name}><button type="button" aria-label={name} aria-pressed={!query.trim() && current === name} className={cn("flex h-8 w-8 items-center justify-center rounded-control hover:bg-secondary", current === name && !query.trim() ? "text-foreground" : "text-subtle")} onClick={() => {
          setQuery(""); setCurrent(name);
          requestAnimationFrame(() => {
            const section = Array.from(grid.current?.querySelectorAll<HTMLElement>("section") ?? []).find((item) => item.dataset.section === name);
            section?.scrollIntoView({ block: "start" });
          });
        }}><Icon className="h-4 w-4" /></button></Tooltip>)}
      </div>
      <div ref={grid} className="h-[320px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" onScroll={() => {
        const top = grid.current?.getBoundingClientRect().top ?? 0;
        const sections = Array.from(grid.current?.querySelectorAll<HTMLElement>("section") ?? []);
        const visible = sections.find((section) => section.getBoundingClientRect().bottom > top + 24);
        if (visible?.dataset.section) setCurrent(visible.dataset.section);
      }}>
        {sections.map((section) => <section key={section.name} data-section={section.name} style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${Math.ceil(section.items.length / 8) * 40 + 24}px` }}>
          {section.name !== "Search" ? <h3 className="py-1 text-caption text-muted-foreground">{section.name}</h3> : null}
          <div className="grid grid-cols-[repeat(8,40px)]">{section.items.map(({ entry, emoji }) => {
            const cellIndex = index++;
            return <button key={emoji} data-emoji type="button" aria-label={entry.label} tabIndex={active === cellIndex ? 0 : -1} className="h-10 w-10 rounded-control text-[26px] leading-none hover:bg-secondary" onClick={() => pick(emoji)} onMouseEnter={() => setPreview({ entry, emoji })} onMouseLeave={() => setPreview(undefined)} onFocus={() => { setActive(cellIndex); setPreview({ entry, emoji }); }} onBlur={() => setPreview(undefined)} onKeyDown={(event) => gridKey(event, cellIndex)}>{emoji}</button>;
          })}</div>
        </section>)}
        {data && query.trim() && sections[0].items.length === 0 ? <p className="py-8 text-center text-small text-muted-foreground">No emoji found</p> : null}
      </div>
      <div className="flex h-8 items-center gap-2 overflow-hidden text-caption text-muted-foreground">
        {preview ? <><span className="text-[20px] leading-none">{preview.emoji}</span><span className="truncate">{preview.entry.label}</span><span className="ml-auto">{preview.entry.shortcodes[0] ? `:${preview.entry.shortcodes[0]}:` : ""}</span></> : null}
      </div>
    </div>
  );
}
