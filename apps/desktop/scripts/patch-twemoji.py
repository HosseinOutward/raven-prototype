"""Writes src/assets/fonts/twemoji.woff2 from the twemoji-colr-font package.

Chromium (WebView2) shapes emoji without their U+FE0F variation selector, but the
package's ligatures only match sequences that include it, so keycaps (1️⃣) draw blank
and sequences like 🏳️‍🌈 fall apart into their parts. This adds, for every ligature that
contains U+FE0F, a twin without it. Nothing else in the font changes.

Run from apps/desktop after updating the package:

    uv run --with fonttools --with brotli python scripts/patch-twemoji.py
"""
from pathlib import Path

from fontTools.ttLib import TTFont

desktop = Path(__file__).resolve().parent.parent
source = desktop / "node_modules" / "twemoji-colr-font" / "twemoji.woff2"
target = desktop / "src" / "assets" / "fonts" / "twemoji.woff2"

font = TTFont(source)
added = 0
for lookup in font["GSUB"].table.LookupList.Lookup:
    for subtable in lookup.SubTable:
        if lookup.LookupType == 7:
            subtable = subtable.ExtSubTable
        if getattr(subtable, "LookupType", lookup.LookupType) != 4:
            continue
        for ligatures in subtable.ligatures.values():
            known = {tuple(ligature.Component) for ligature in ligatures}
            twins = []
            for ligature in ligatures:
                stripped = tuple(glyph for glyph in ligature.Component if glyph != "ufe0f")
                if stripped not in known:
                    twin = type(ligature)()
                    twin.LigGlyph, twin.Component = ligature.LigGlyph, list(stripped)
                    twins.append(twin)
                    known.add(stripped)
            ligatures.extend(twins)
            # A longer sequence must be tried before a shorter one it starts with.
            ligatures.sort(key=lambda ligature: -len(ligature.Component))
            added += len(twins)
font.flavor = "woff2"
target.parent.mkdir(parents=True, exist_ok=True)
font.save(target)
print(f"{added} ligatures added, written to {target}")
