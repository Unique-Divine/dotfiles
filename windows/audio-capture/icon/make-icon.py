"""Generate audio-capture.ico and icon-preview.png from lion.jpg.

The icon is the lion cropped to a circle with a microphone badge at the
bottom right: a dark circle, a thin light ring, and a white mic glyph.
Sizes 24 px and below crop tighter on the face and enlarge the badge, and
sizes to 32 px draw the mic as a pixel mask so it stays legible.

Run from anywhere:

    uv run --with pillow python windows/audio-capture/icon/make-icon.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "lion.jpg"
ICO = HERE / "audio-capture.ico"
PREVIEW = HERE / "icon-preview.png"
SIZES = [16, 24, 32, 48, 64, 128, 256]
SUPERSAMPLE = 8

BADGE_FILL = (13, 17, 23, 255)  # GitHub dark canvas
BADGE_RING = (230, 237, 243, 255)
GLYPH = (255, 255, 255, 255)

# Source crops (left, top, right, bottom) in lion.jpg pixels.
CROP_FULL = (0, 8, 463, 471)
CROP_FACE = (120, 70, 450, 400)


def is_small(size: int) -> bool:
  return size <= 24


def avatar(size: int) -> Image.Image:
  """The lion, cropped to a circle, at size x size."""
  big = size * SUPERSAMPLE
  crop = CROP_FACE if is_small(size) else CROP_FULL
  photo = Image.open(SOURCE).convert("RGB").crop(crop)
  photo = photo.resize((big, big), Image.LANCZOS).convert("RGBA")
  mask = Image.new("L", (big, big), 0)
  ImageDraw.Draw(mask).ellipse((0, 0, big - 1, big - 1), fill=255)
  photo.putalpha(mask)
  return photo


def draw_mic(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: float,
             cradle: bool) -> None:
  """A mic glyph centered on (cx, cy), scaled to badge radius r."""
  w = r * (0.42 if cradle else 0.5)
  top = cy - r * (0.58 if cradle else 0.6)
  bottom = cy + r * (0.12 if cradle else 0.18)
  draw.rounded_rectangle((cx - w / 2, top, cx + w / 2, bottom),
                         radius=w / 2, fill=GLYPH)
  stroke = r * (0.11 if cradle else 0.16)
  if cradle:
    arc_r = r * 0.38
    arc_cy = cy - r * 0.08
    draw.arc((cx - arc_r, arc_cy - arc_r, cx + arc_r, arc_cy + arc_r),
             start=0, end=180, fill=GLYPH, width=round(stroke))
    stem_top = arc_cy + arc_r
  else:
    stem_top = bottom
  stem_bottom = cy + r * 0.52
  draw.rectangle((cx - stroke / 2, stem_top - stroke / 2, cx + stroke / 2,
                  stem_bottom), fill=GLYPH)
  base_w = r * (0.5 if cradle else 0.6)
  draw.rounded_rectangle((cx - base_w / 2, stem_bottom - stroke / 2,
                          cx + base_w / 2, stem_bottom + stroke / 2),
                         radius=stroke / 2, fill=GLYPH)


# Pixel masks for the mic at small sizes, where a drawn glyph blurs.
# Each is centered in the badge; "#" is a white pixel.
SMALL_GLYPHS = {
  16: [
    ".###.",
    ".###.",
    ".###.",
    ".###.",
    "..#..",
    ".###.",
  ],
  24: [
    "..###..",
    "..###..",
    "#.###.#",
    "#.###.#",
    ".#...#.",
    "..###..",
    "...#...",
    ".#####.",
  ],
}
SMALL_GLYPHS[32] = SMALL_GLYPHS[24]
# Badge diameter in output pixels where the glyph is a pixel mask.
SMALL_BADGE = {16: 10, 24: 13, 32: 14}


def badge_circle(img: Image.Image, box: tuple[float, float, float, float],
                 ring: float) -> None:
  """A dark disc with a light ring, in supersampled pixels."""
  draw = ImageDraw.Draw(img)
  left, top, right, bottom = box
  draw.ellipse(box, fill=BADGE_RING)
  draw.ellipse((left + ring, top + ring, right - ring, bottom - ring),
               fill=BADGE_FILL)


def badge(img: Image.Image, size: int) -> None:
  """Draws the mic badge onto the supersampled image (48 px and up)."""
  big = img.width
  diameter = big * 0.42
  r = diameter / 2
  inset = big * 0.005
  cx = cy = big - r - inset
  ring = big * 0.018
  badge_circle(img, (cx - r, cy - r, cx + r, cy + r), ring)
  draw_mic(ImageDraw.Draw(img), cx, cy, r - ring, cradle=True)


def small_badge(img: Image.Image, size: int) -> None:
  """Draws the badge at output resolution with a pixel-mask glyph."""
  d = SMALL_BADGE[size]
  ss = SUPERSAMPLE
  layer = Image.new("RGBA", (d * ss, d * ss), (0, 0, 0, 0))
  badge_circle(layer, (0, 0, d * ss - 1, d * ss - 1), ss)
  layer = layer.resize((d, d), Image.LANCZOS)
  glyph = SMALL_GLYPHS[size]
  gx = (d - len(glyph[0])) // 2
  gy = (d - len(glyph)) // 2
  for y, row in enumerate(glyph):
    for x, c in enumerate(row):
      if c == "#":
        layer.putpixel((gx + x, gy + y), GLYPH)
  img.alpha_composite(layer, (size - d, size - d))


def render(size: int) -> Image.Image:
  img = avatar(size)
  if size in SMALL_BADGE:
    img = img.resize((size, size), Image.LANCZOS)
    small_badge(img, size)
    return img
  badge(img, size)
  return img.resize((size, size), Image.LANCZOS)


def main() -> None:
  frames = [render(s) for s in SIZES]
  frames[-1].save(PREVIEW)
  # Pillow writes each size from its own frame when given append_images.
  frames[-1].save(ICO, format="ICO", sizes=[(s, s) for s in SIZES],
                  append_images=frames[:-1])
  print(f"wrote {ICO.name} ({', '.join(map(str, SIZES))}) and {PREVIEW.name}")


if __name__ == "__main__":
  main()
