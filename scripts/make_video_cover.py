#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


WIDTH = 1920
HEIGHT = 1080


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
  candidates = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Helvetica.ttf",
    "/System/Library/Fonts/Supplemental/Avenir Next.ttc",
    "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
  ]
  for candidate in candidates:
    path = Path(candidate)
    if path.exists():
      try:
        return ImageFont.truetype(str(path), size)
      except Exception:
        continue
  return ImageFont.load_default()


def center_text(draw: ImageDraw.ImageDraw, text: str, font, center_y: int, fill: str) -> int:
  bbox = draw.multiline_textbbox((0, 0), text, font=font, spacing=16, align="center")
  text_w = bbox[2] - bbox[0]
  text_h = bbox[3] - bbox[1]
  x = (WIDTH - text_w) // 2
  y = center_y - (text_h // 2)
  draw.multiline_text((x, y), text, font=font, fill=fill, spacing=16, align="center")
  return y + text_h


def main() -> int:
  parser = argparse.ArgumentParser()
  parser.add_argument("--out", required=True)
  parser.add_argument("--title", required=True)
  parser.add_argument("--subtitle", required=True)
  args = parser.parse_args()

  image = Image.new("RGB", (WIDTH, HEIGHT), "#07111f")
  draw = ImageDraw.Draw(image)

  accent_top = (120, 240, 255)
  accent_bottom = (64, 160, 255)
  draw.rounded_rectangle((180, 170, WIDTH - 180, 920), radius=48, outline=accent_bottom, width=4)
  draw.rounded_rectangle((220, 210, WIDTH - 220, 880), radius=36, fill="#0b1729")

  title_font = load_font(78)
  subtitle_font = load_font(38)

  center_text(draw, args.title, title_font, 470, "#F8FAFC")
  center_text(draw, args.subtitle, subtitle_font, 610, "#C7D2FE")

  draw.text((260, 790), "Kyberion", font=load_font(34), fill=accent_top)
  draw.text((260, 832), "source capture -> manual -> design spec -> narrated video", font=load_font(30), fill="#E2E8F0")

  out_path = Path(args.out)
  out_path.parent.mkdir(parents=True, exist_ok=True)
  image.save(out_path)
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
