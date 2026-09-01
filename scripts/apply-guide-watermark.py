#!/usr/bin/env python3
"""Apply the shared ShineGame.Pro watermark to a freshly rendered guide image."""

import argparse
from pathlib import Path

from PIL import Image, ImageFont

from guide_image_style import add_guide_watermark


def font(size, bold=False):
    candidates = [
        "/System/Library/Fonts/STHeiti Medium.ttc" if bold else "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial Unicode.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size=size)
    return ImageFont.load_default()


def main():
    parser = argparse.ArgumentParser(
        description="Add the standard central watermark to a freshly rendered ShineGame guide."
    )
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    with Image.open(args.input) as source:
        image = source.convert("RGB")
    watermarked = add_guide_watermark(image, font)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    save_options = {"quality": 94, "optimize": True} if args.output.suffix.lower() in {".jpg", ".jpeg"} else {"optimize": True}
    watermarked.save(args.output, **save_options)
    print(args.output)


if __name__ == "__main__":
    main()
