"""Draws the tray/app icons (run once; the .ico files are kept in the repo)."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
COLOURS = {"green": "#2e9e44", "yellow": "#e0a800", "red": "#d93025", "grey": "#8a8a8a", "app": "#2563eb"}
SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]


def draw(colour, size=256):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = size // 32
    d.ellipse((pad, pad, size - pad, size - pad), fill=colour)
    try:
        font = ImageFont.truetype("segoeuib.ttf", int(size * 0.62))
    except OSError:
        font = ImageFont.load_default()
    d.text((size / 2, size / 2 + size * 0.02), "A", font=font, fill="white", anchor="mm")
    return img


for name, colour in COLOURS.items():
    draw(colour).save(HERE / f"{name}.ico", sizes=[(s, s) for s in SIZES])
print("icons written to", HERE)
