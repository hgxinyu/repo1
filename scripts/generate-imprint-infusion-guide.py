from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from guide_image_style import draw_brand_footnote


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "flipgame" / "images" / "imprint-infusion-guide.png"
QR = ROOT / "flipgame" / "assets" / "shinegame_pro_qr_logo_real.png"

LEVEL_POINTS = [
    (16, 2), (17, 2), (18, 2), (19, 2), (20, 2),
    (21, 2), (22, 2), (23, 3), (24, 3), (25, 4),
    (26, 2), (27, 2), (28, 2), (29, 2), (30, 3),
    (31, 3), (32, 3), (33, 3), (34, 3), (35, 4),
    (36, 2), (37, 3), (38, 2), (39, 3), (40, 2),
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


def point_style(points):
    if points == 2:
        return "#eff6ff", "#1d4ed8"
    if points == 3:
        return "#f0fdf4", "#15803d"
    return "#fff7ed", "#c2410c"


def main():
    w, h = 1080, 780
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

    left_text(draw, (margin, 44), "印痕灌注点数速览", font(52, True), red)

    summary_y = 122
    summary_right = qr_x - 26
    rounded(draw, (margin, summary_y, summary_right, summary_y + 52), 16, "#ffffff", "#e4d2ab", 2)
    left_text(draw, (margin + 24, summary_y + 13), "灌注等级", font(24, True), "#6f3b12")
    left_text(draw, (margin + 172, summary_y + 6), "16 - 40", font(34, True), red)
    left_text(draw, (margin + 370, summary_y + 13), "总计 63 点", font(24, True), green)

    table_x = margin
    table_y = 200
    table_w = w - margin * 2
    header_h = 50
    row_h = 38
    group_gap = 16
    group_w = (table_w - group_gap * 2) / 3
    col_w = [group_w * 0.58, group_w * 0.42]
    groups = [LEVEL_POINTS[:10], LEVEL_POINTS[10:20], LEVEL_POINTS[20:]]

    for gi, group in enumerate(groups):
        gx = table_x + gi * (group_w + group_gap)
        gh = header_h + row_h * 10
        rounded(draw, (gx, table_y, gx + group_w, table_y + gh), 20, "#fff8dd", border, 3)
        draw.rectangle((gx, table_y, gx + group_w, table_y + header_h), fill=border)
        center_text(draw, (gx, table_y, gx + col_w[0], table_y + header_h), "灌注等级", font(24, True), "#fff8e7")
        center_text(draw, (gx + col_w[0], table_y, gx + group_w, table_y + header_h), "点数", font(24, True), "#fff8e7")

        for ri in range(10):
            y1 = table_y + header_h + ri * row_h
            y2 = y1 + row_h
            if ri < len(group):
                level, points = group[ri]
                fill, accent = point_style(points)
                draw.rectangle((gx, y1, gx + group_w, y2), fill=fill)
                center_text(draw, (gx, y1, gx + col_w[0], y2), str(level), font(24, True), accent)
                center_text(draw, (gx + col_w[0], y1, gx + group_w, y2), str(points), font(24, True), ink)
            else:
                draw.rectangle((gx, y1, gx + group_w, y2), fill="#fffdf7")
            draw.line((gx, y2, gx + group_w, y2), fill=border, width=2)
            draw.line((gx + col_w[0], y1, gx + col_w[0], y2), fill=border, width=2)

    footer_y = table_y + header_h + row_h * 10 + 22
    rounded(draw, (margin, footer_y, w - margin, h - 36), 22, "#ffffff", "#e6d5b5", 2)
    left_text(draw, (margin + 24, footer_y + 18), "规则", font(23, True), "#6f3b12")
    left_text(draw, (margin + 96, footer_y + 20), "每级需要点数如表；满印痕灌注合计 63 点。", font(22), ink)
    draw_brand_footnote(draw, w - margin - 24, footer_y + 58, font)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, optimize=True)
    print(OUT)


if __name__ == "__main__":
    main()
