#!/usr/bin/env python3
"""Generate the console's icon set from one source glyph.

    python3 scripts/make-icons.py [glyph.svg]

Produces, into public/:

    favicon.svg           vector, any size
    favicon.ico           16 / 32 / 48
    apple-touch-icon.png  180
    icon-192.png          192   (PWA / Android)
    icon-512.png          512   (PWA splash, maskable)

Geometry is measured from the icons this replaces rather than guessed, so the
new set sits identically on a home screen next to the old one:

    background   #08080e   flat, square, no rounded corners — iOS and Android
                           apply their own mask, and baking one in means it
                           gets masked twice and looks pinched
    glyph        #00ffff   centred, 55.6% of the canvas
    margin       22.2%     on every side

That margin is not decoration. iOS crops a home-screen icon to a squircle and
Android's maskable spec can crop to a circle, both of which eat the corners; a
full-bleed glyph loses its extremities. 22% is comfortably inside the 80% safe
zone the maskable spec asks for.

Requires cairosvg and Pillow, both of which are only needed to REGENERATE the
icons — the committed output has no runtime dependency at all.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import cairosvg
    from PIL import Image
except ImportError:
    sys.exit("needs cairosvg and pillow:  pip install cairosvg pillow")

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"

BG = "#08080e"
FG = "#00ffff"
CANVAS = 180          # the reference size everything is expressed against
GLYPH = 100           # 55.6% of CANVAS
OFFSET = (CANVAS - GLYPH) / 2   # 40 → 22.2% margin


def extract_paths(svg_text: str) -> tuple[str, float]:
    """Pull the drawable content out of a source glyph, plus its viewBox size.

    Icon sets ship glyphs with wildly different wrappers — ids, data-*, width
    and height attributes that disagree with the viewBox. Only the geometry and
    the viewBox scale matter here, so take those and drop the rest.
    """
    vb = re.search(r'viewBox="([\d.\s-]+)"', svg_text)
    if not vb:
        raise SystemExit("source svg has no viewBox")
    parts = [float(p) for p in vb.group(1).split()]
    size = parts[2] if len(parts) >= 3 else 24.0

    body = re.sub(r"<\?xml.*?\?>", "", svg_text, flags=re.S)
    body = re.sub(r"<svg[^>]*>", "", body, count=1)
    body = re.sub(r"</svg>", "", body)
    # Strip any hardcoded fill so the whole glyph takes our colour. A source
    # that ships fill="#000" would otherwise render an invisible black icon on
    # a black background — which looks exactly like a broken build.
    body = re.sub(r'\sfill="(?!none)[^"]*"', "", body)
    return body.strip(), size


def build_svg(glyph_body: str, glyph_size: float) -> str:
    scale = GLYPH / glyph_size
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {CANVAS} {CANVAS}"
     width="{CANVAS}" height="{CANVAS}" role="img" aria-label="console">
  <rect width="{CANVAS}" height="{CANVAS}" fill="{BG}"/>
  <g transform="translate({OFFSET} {OFFSET}) scale({scale:.6f})" fill="{FG}">
    {glyph_body}
  </g>
</svg>
'''


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Downloads" / "square-terminal.svg"
    if not src.exists():
        sys.exit(f"no such glyph: {src}")

    body, size = extract_paths(src.read_text())
    svg = build_svg(body, size)

    PUBLIC.mkdir(parents=True, exist_ok=True)
    (PUBLIC / "favicon.svg").write_text(svg)
    print(f"favicon.svg           vector   from {src.name}")

    raw = svg.encode()
    for name, px in [("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)]:
        cairosvg.svg2png(bytestring=raw, write_to=str(PUBLIC / name),
                         output_width=px, output_height=px)
        print(f"{name:<21} {px}px")

    # .ico wants several sizes in one file; browsers pick per context. Render
    # each at its true size rather than downscaling one big bitmap — a 16px
    # icon downscaled from 512 turns this glyph's 1px strokes to mush.
    frames = []
    for px in (16, 32, 48):
        tmp = PUBLIC / f".ico-{px}.png"
        cairosvg.svg2png(bytestring=raw, write_to=str(tmp), output_width=px, output_height=px)
        frames.append(Image.open(tmp).convert("RGBA"))
    frames[0].save(PUBLIC / "favicon.ico", format="ICO",
                   sizes=[(f.width, f.height) for f in frames],
                   append_images=frames[1:])
    for px in (16, 32, 48):
        (PUBLIC / f".ico-{px}.png").unlink(missing_ok=True)
    print("favicon.ico           16/32/48")


if __name__ == "__main__":
    main()
