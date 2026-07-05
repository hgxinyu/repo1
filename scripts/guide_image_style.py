from PIL import Image, ImageDraw


FOOTNOTE_EXTRA_HEIGHT = 108
FOOTNOTE_CARD_HEIGHT = 72
FOOTNOTE_BOTTOM = 36
FOOTNOTE_TEXT = (("ShineGame", "#0f172a"), (" · Idle Heroes Guide", "#64748b"))


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
