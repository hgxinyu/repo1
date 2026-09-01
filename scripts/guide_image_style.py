from PIL import Image, ImageDraw


FOOTNOTE_EXTRA_HEIGHT = 108
FOOTNOTE_CARD_HEIGHT = 72
FOOTNOTE_BOTTOM = 36
FOOTNOTE_TEXT = (("ShineGame.Pro", "#0f172a"), ("  ·  Idle Heroes Guide", "#64748b"))
WATERMARK_TEXT = "ShineGame.Pro"


def _text_size(draw, text, fnt):
    bbox = draw.textbbox((0, 0), text, font=fnt)
    return bbox[2] - bbox[0], bbox[3] - bbox[1], bbox


def draw_guide_footnote(draw, width, height, margin, font_func, rounded_func, bottom=FOOTNOTE_BOTTOM, card_height=FOOTNOTE_CARD_HEIGHT):
    y1 = height - bottom - card_height
    y2 = height - bottom
    rounded_func(draw, (margin, y1, width - margin, y2), 24, "#ffffff", "#cbd5e1", 2)

    label_font = font_func(23, True)
    parts = []
    total_w = 0
    max_h = 0
    for text, fill in FOOTNOTE_TEXT:
        tw, th, bbox = _text_size(draw, text, label_font)
        parts.append((text, fill, tw, th, bbox))
        total_w += tw
        max_h = max(max_h, th)

    x = width - margin - 28 - total_w
    y = y1 + (card_height - max_h) / 2 - 2
    for text, fill, tw, _, bbox in parts:
        draw.text((x - bbox[0], y - bbox[1]), text, font=label_font, fill=fill)
        x += tw


def draw_brand_footnote(draw, right, y, font_func, size=18):
    label_font = font_func(size, True)
    parts = []
    total_w = 0
    for text, fill in FOOTNOTE_TEXT:
        tw, _, bbox = _text_size(draw, text, label_font)
        parts.append((text, fill, tw, bbox))
        total_w += tw

    x = right - total_w
    for text, fill, tw, bbox in parts:
        draw.text((x - bbox[0], y - bbox[1]), text, font=label_font, fill=fill)
        x += tw


def add_guide_footnote(img, margin, font_func, rounded_func):
    width, height = img.size
    bg = img.getpixel((width // 2, max(0, height - 1)))
    canvas = Image.new(img.mode, (width, height + FOOTNOTE_EXTRA_HEIGHT), bg)
    canvas.paste(img, (0, 0))
    draw = ImageDraw.Draw(canvas)
    draw_guide_footnote(draw, width, height + FOOTNOTE_EXTRA_HEIGHT, margin, font_func, rounded_func)
    return canvas


def add_guide_watermark(img, font_func, safe_boxes=()):
    """Add one subtle, centered watermark while keeping headers and safe areas clean."""
    width, height = img.size
    original_mode = img.mode
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))

    font_size = max(24, round(width * 0.09))
    label_font = font_func(font_size, True)
    measure = ImageDraw.Draw(overlay)
    bbox = measure.textbbox((0, 0), WATERMARK_TEXT, font=label_font)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]

    padding = max(12, round(font_size * 0.25))
    label = Image.new(
        "RGBA",
        (text_width + padding * 2, text_height + padding * 2),
        (0, 0, 0, 0),
    )
    label_draw = ImageDraw.Draw(label)
    label_draw.text(
        (padding - bbox[0], padding - bbox[1]),
        WATERMARK_TEXT,
        font=label_font,
        fill=(51, 65, 85, 14),
    )
    rotated = label.rotate(28, expand=True, resample=Image.Resampling.BICUBIC)
    position = (
        round((width - rotated.width) / 2),
        round(height * 0.56 - rotated.height / 2),
    )
    overlay.alpha_composite(rotated, position)

    if safe_boxes:
        overlay_draw = ImageDraw.Draw(overlay)
        for box in safe_boxes:
            overlay_draw.rectangle(box, fill=(0, 0, 0, 0))

    result = Image.alpha_composite(img.convert("RGBA"), overlay)
    return result if original_mode == "RGBA" else result.convert(original_mode)
