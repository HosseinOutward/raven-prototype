"""Builds the Raven logo masters from geometry and the Geist font.

Run from the repo root: python docs/brand/logo/build.py
Needs fontTools and brotli (to read the woff2 that ships with the app).
"""
import io
import math
import pathlib

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT = pathlib.Path(__file__).resolve().parent
FONT = ROOT / "apps/desktop/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2"

GRAPHITE = "#0F0E0D"  # --background, hsl(30 6% 5.5%)
AQUA = "#6EC4B8"      # --live, hsl(172 42% 60%)
BONE = "#F0EEEA"      # --foreground, hsl(40 16% 93%)


def fmt(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def circle(x, y, r):
    return f"M{fmt(x - r)} {fmt(y)}a{fmt(r)} {fmt(r)} 0 1 0 {fmt(2 * r)} 0a{fmt(r)} {fmt(r)} 0 1 0 {fmt(-2 * r)} 0Z"


def raven(cx, cy, r, tip, eye, eye_r):
    """A circle (the head) with two tangents meeting at the beak tip: a speech bubble whose tail is the beak."""
    dx, dy = tip[0] - cx, tip[1] - cy
    d = math.hypot(dx, dy)
    a, b = math.atan2(dy, dx), math.acos(r / d)
    t1 = (cx + r * math.cos(a - b), cy + r * math.sin(a - b))
    t2 = (cx + r * math.cos(a + b), cy + r * math.sin(a + b))
    p = lambda q: f"{fmt(q[0])} {fmt(q[1])}"
    head = f"M{p(t1)}L{p(tip)}L{p(t2)}A{fmt(r)} {fmt(r)} 0 1 1 {p(t1)}Z"
    return head + circle(eye[0], eye[1], eye_r)


def grid_geometry(r, upper, lower, eye_at, eye_r, size=256, overshoot=4, lift=4):
    """Places the raven from clean angles: the culmen falls at `upper` degrees, the jaw rises at `lower`.

    The beak tip is where the two tangents meet. The form is centred in the box, then the tip is
    let out by `overshoot` (a point looks shorter than it is) and the whole lifted by `lift`
    (optical centre sits above the geometric one). `eye_at` is (along, above) the centre line, in r.
    """
    # Tangent points relative to the centre (SVG y points down).
    n1 = math.radians(upper - 90)
    n2 = math.radians(-lower + 90)
    t1 = (r * math.cos(n1), r * math.sin(n1))
    t2 = (r * math.cos(n2), r * math.sin(n2))
    d1 = (math.cos(math.radians(upper)), math.sin(math.radians(upper)))
    d2 = (math.cos(math.radians(-lower)), math.sin(math.radians(-lower)))
    # Solve t1 + s*d1 = t2 + u*d2 for the tip.
    det = d1[0] * -d2[1] + d2[0] * d1[1]
    s = ((t2[0] - t1[0]) * -d2[1] + d2[0] * (t2[1] - t1[1])) / det
    tip = (t1[0] + s * d1[0], t1[1] + s * d1[1])
    width = r + tip[0]
    cx = (size - width) / 2 + r + overshoot / 2
    cy = size / 2 - lift
    eye = (cx + eye_at[0] * r, cy - eye_at[1] * r)
    return cx, cy, r, (cx + tip[0], cy + tip[1]), eye, eye_r


# Master: 256 grid. Head r=72, culmen falls 15 deg, jaw rises 45 deg.
GEOMETRY = grid_geometry(72, 15, 45, (0.6, 0.36), 10.5)
# Small-size cut (<= 48 px): bigger head, shorter beak, larger eye so it stays open.
GEOMETRY_SMALL = grid_geometry(76, 15, 45, (0.58, 0.36), 15)
SYMBOL = raven(*GEOMETRY)
SYMBOL_SMALL = raven(*GEOMETRY_SMALL)


def svg(view_w, view_h, body, title="Raven"):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(view_w)} {fmt(view_h)}">'
            f"<title>{title}</title>{body}</svg>\n")


def wordmark_path(text, cap_height, x0, baseline, tracking=-0.01):
    """Outlines `text` in Geist SemiBold so the logo never depends on an installed font."""
    font = TTFont(io.BytesIO(FONT.read_bytes()))
    font = instancer.instantiateVariableFont(font, {"wght": 600})
    upm = font["head"].unitsPerEm
    cap = font["OS/2"].sCapHeight
    scale = cap_height / cap
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    pen = SVGPathPen(glyphs, ntos=fmt)
    x = 0.0
    for ch in text:
        name = cmap[ord(ch)]
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x0 + x * scale, baseline)))
        x += hmtx[name][0] + tracking * upm
    return pen.getCommands(), (x - tracking * upm) * scale


def main():
    OUT.mkdir(exist_ok=True)
    (OUT / "raven-symbol.svg").write_text(svg(256, 256, f'<path fill="{GRAPHITE}" fill-rule="evenodd" d="{SYMBOL}"/>'))
    (OUT / "raven-symbol-small.svg").write_text(svg(256, 256, f'<path fill="{GRAPHITE}" fill-rule="evenodd" d="{SYMBOL_SMALL}"/>'))
    (OUT / "raven-symbol-aqua.svg").write_text(svg(256, 256, f'<path fill="{AQUA}" fill-rule="evenodd" d="{SYMBOL}"/>'))

    # Wordmark alone: cap height 100 on a 140-high canvas.
    d, w = wordmark_path("Raven", 100, 0, 120)
    (OUT / "raven-wordmark.svg").write_text(svg(w, 140, f'<path fill="{GRAPHITE}" d="{d}"/>'))

    # Horizontal lockup, height 256. Symbol box 256 (mark itself spans ~x28-238, y62-214).
    # Cap height = 0.5 x the head diameter; the gap equals the head radius minus the eye (≈ 56).
    sym_left, sym_right = 25, 236
    cap = 76
    gap = 40
    base = 124 + cap / 2  # caps centred on the head
    d, w = wordmark_path("Raven", cap, sym_right + gap, base)
    width = sym_right + gap + w + sym_left
    body = (f'<path fill="{GRAPHITE}" fill-rule="evenodd" d="{SYMBOL}"/>'
            f'<path fill="{GRAPHITE}" d="{d}"/>')
    (OUT / "raven-horizontal.svg").write_text(svg(width, 256, body))
    # Colour lockup is for dark grounds only: aqua on white is too faint (about 2:1).
    body_c = (f'<path fill="{AQUA}" fill-rule="evenodd" d="{SYMBOL}"/>'
              f'<path fill="{BONE}" d="{d}"/>')
    (OUT / "raven-horizontal-on-dark.svg").write_text(svg(width, 256, body_c))

    # Stacked lockup: symbol above, wordmark centred below.
    cap_s = 60
    d, w = wordmark_path("Raven", cap_s, 0, 0)
    stack_w = max(256, w + 56)
    sx = (stack_w - 256) / 2
    wx = (stack_w - w) / 2
    base_s = 256 + 24 + cap_s
    body = (f'<g transform="translate({fmt(sx)} 0)"><path fill="{GRAPHITE}" fill-rule="evenodd" d="{SYMBOL}"/></g>'
            f'<g transform="translate({fmt(wx)} {fmt(base_s)})"><path fill="{GRAPHITE}" d="{d}"/></g>')
    (OUT / "raven-stacked.svg").write_text(svg(stack_w, base_s + 40, body))
    print("wrote masters to", OUT)


if __name__ == "__main__":
    main()
