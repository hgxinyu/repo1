from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from guide_image_style import draw_brand_footnote


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "flipgame" / "images" / "breakdown-soulpower-guide.png"
QR = ROOT / "flipgame" / "assets" / "shinegame_pro_qr_logo_real.png"

ROWS = [
    ("C-", 450, 100, "4.50"),
    ("C", 600, 150, "4.00"),
    ("C+", 800, 200, "4.00"),
    ("B-", 1000, 300, "3.33"),
    ("B", 1800, 600, "3.00"),
    ("B+", 6000, 1800, "3.33"),
    ("A-", 30000, 8000, "3.75"),
    ("A", 38000, 15000, "2.53"),
]


def font(size, bold=False):
    candidates = [
        "/System/Library/Fonts/STHeiti Medium.ttc" if bold else "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Supplemental/Songti.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size=size)
    return ImageFont.load_default()


def blend(c1, c2, t):
    return tuple(round(c1[i] * (1 - t) + c2[i] * t) for i in range(3))


def center_text(draw, box, text, fnt, fill):
    x1, y1, x2, y2 = box
    bbox = draw.textbbox((0, 0), text, font=fnt)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    draw.text((x1 + (x2 - x1 - w) / 2 - bbox[0], y1 + (y2 - y1 - h) / 2 - bbox[1]), text, font=fnt, fill=fill)


def left_text(draw, xy, text, fnt, fill):
    draw.text(xy, text, font=fnt, fill=fill)


def rounded(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def tier_style(tier):
    if tier.startswith("A"):
        return "#fef2f2", "#b91c1c"
    if tier.startswith("B"):
        return "#f0fdf4", "#15803d"
    if tier.startswith("C"):
        return "#faf5ff", "#7e22ce"
    return "#fff8dd", "#c81e1e"


def main():
    w, h = 1080, 820
    img = Image.new("RGB", (w, h), "#f7efe0")
    draw = ImageDraw.Draw(img)

    for y in range(h):
        t = y / h
        draw.line((0, y, w, y), fill=blend((253, 245, 226), (230, 241, 238), t))

    margin = 48
    ink = "#20130c"
    red = "#c81e1e"
    green = "#0f766e"
    border = "#2a1b12"

    qr_size = 132
    qr_x = w - margin - qr_size
    qr_y = 28
    rounded(draw, (qr_x - 12, qr_y - 12, qr_x + qr_size + 12, qr_y + qr_size + 12), 22, "#fffdf7", "#e1c684", 2)
    qr = Image.open(QR).convert("RGB").resize((qr_size, qr_size), Image.Resampling.LANCZOS)
    img.paste(qr, (qr_x, qr_y))

    left_text(draw, (margin, 44), "分解资质魂力速览", font(52, True), red)

    summary_y = 122
    summary_right = qr_x - 26
    rounded(draw, (margin, summary_y, summary_right, summary_y + 52), 16, "#ffffff", "#e4d2ab", 2)
    left_text(draw, (margin + 24, summary_y + 13), "最高性价比", font(24, True), "#6f3b12")
    left_text(draw, (margin + 190, summary_y + 6), "C-  4.50", font(34, True), red)
    left_text(draw, (margin + 410, summary_y + 13), "性价比 = 充能进度 / 分解价", font(22, True), green)

    table_x = margin
    table_y = 208
    table_w = w - margin * 2
    header_h = 56
    row_h = 50
    cols = [180, 260, 220, table_w - 180 - 260 - 220]
    headers = ["品质", "充能进度", "分解价", "充能进度 / 分解价"]
    xs = [table_x]
    for cw in cols:
        xs.append(xs[-1] + cw)

    rounded(draw, (table_x, table_y, table_x + table_w, table_y + header_h + row_h * len(ROWS)), 22, "#fff8dd", border, 4)
    draw.rectangle((table_x, table_y, table_x + table_w, table_y + header_h), fill=border)
    for i, header in enumerate(headers):
        center_text(draw, (xs[i], table_y, xs[i + 1], table_y + header_h), header, font(26, True), "#fff8e7")

    for i, row in enumerate(ROWS):
        tier, charge, price, ratio = row
        y1 = table_y + header_h + i * row_h
        y2 = y1 + row_h
        fill, accent = tier_style(tier)
        draw.rectangle((table_x, y1, table_x + table_w, y2), fill=fill)
        for x in xs:
            draw.line((x, y1, x, y2), fill=border, width=2)
        draw.line((table_x, y2, table_x + table_w, y2), fill=border, width=2)
        center_text(draw, (xs[0], y1, xs[1], y2), tier, font(28, True), accent)
        center_text(draw, (xs[1], y1, xs[2], y2), f"{charge:,}", font(28, True), ink)
        center_text(draw, (xs[2], y1, xs[3], y2), f"{price:,}", font(28, True), ink)
        ratio_color = red if ratio == "4.50" else ink
        center_text(draw, (xs[3], y1, xs[4], y2), ratio, font(28, True), ratio_color)

    footer_y = table_y + header_h + row_h * len(ROWS) + 22
    rounded(draw, (margin, footer_y, w - margin, h - 36), 22, "#ffffff", "#e6d5b5", 2)
    left_text(draw, (margin + 24, footer_y + 18), "说明", font(23, True), "#6f3b12")
    left_text(draw, (margin + 96, footer_y + 20), "数值来自原分解资质魂力攻略图；比值越高，单位分解价换到的充能进度越多。", font(21), ink)
    draw_brand_footnote(draw, w - margin - 24, footer_y + 66, font)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, optimize=True)
    print(OUT)


if __name__ == "__main__":
    main()
