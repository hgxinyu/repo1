from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "flipgame" / "images" / "awakening-rate-guide.png"
QR = ROOT / "flipgame" / "assets" / "shinegame_pro_qr_logo_real.png"

ROWS = [
    ("E-", "4.3%", "3", "0.129"),
    ("E", "19.8%", "4", "0.792"),
    ("E+", "28.8%", "5", "1.44"),
    ("D-", "20%", "6", "1.2"),
    ("D", "9.2%", "7", "0.644"),
    ("D+", "4.8%", "8", "0.384"),
    ("C-", "4.4%", "9", "0.396"),
    ("C", "4.3%", "10", "0.43"),
    ("C+", "2.13%", "11", "0.2343"),
    ("B-", "1.62%", "12", "0.1944"),
    ("B", "0.55%", "13", "0.0715"),
    ("B+", "0.0745%", "14", "0.01043"),
    ("A-", "0.015%", "15", "0.00225"),
    ("A", "0.0065%", "16", "0.00104"),
    ("A+", "0.0025%", "17", "0.000425"),
    ("S及以上", "0.0015%", "19", "0.000285"),
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


def text_bbox(draw, xy, text, fnt):
    return draw.textbbox(xy, text, font=fnt)


def center_text(draw, box, text, fnt, fill, stroke_width=0, stroke_fill=None):
    x1, y1, x2, y2 = box
    bbox = text_bbox(draw, (0, 0), text, fnt)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    x = x1 + (x2 - x1 - w) / 2 - bbox[0]
    y = y1 + (y2 - y1 - h) / 2 - bbox[1]
    draw.text((x, y), text, font=fnt, fill=fill, stroke_width=stroke_width, stroke_fill=stroke_fill)


def left_text(draw, xy, text, fnt, fill):
    draw.text(xy, text, font=fnt, fill=fill)


def rounded(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def blend(c1, c2, t):
    return tuple(round(c1[i] * (1 - t) + c2[i] * t) for i in range(3))


def main():
    w, h = 1080, 1200
    img = Image.new("RGB", (w, h), "#f7efe0")
    draw = ImageDraw.Draw(img)

    for y in range(h):
        t = y / h
        color = blend((253, 245, 226), (230, 241, 238), t)
        draw.line((0, y, w, y), fill=color)

    margin = 48
    ink = "#20130c"
    red = "#c81e1e"
    green = "#0f766e"
    border = "#2a1b12"
    tier_styles = {
        "E": {"bg": "#eff6ff", "fg": "#1d4ed8"},
        "D": {"bg": "#fefce8", "fg": "#a16207"},
        "C": {"bg": "#faf5ff", "fg": "#7e22ce"},
        "B": {"bg": "#f0fdf4", "fg": "#15803d"},
        "A": {"bg": "#fef2f2", "fg": "#b91c1c"},
        "S": {"bg": "#fff7ed", "fg": "#c2410c"},
    }

    qr_size = 145
    qr_x = w - margin - qr_size
    qr_y = 30
    rounded(draw, (qr_x - 12, qr_y - 12, qr_x + qr_size + 12, qr_y + qr_size + 12), 22, "#fffdf7", "#e1c684", 2)
    qr = Image.open(QR).convert("RGB").resize((qr_size, qr_size), Image.Resampling.LANCZOS)
    img.paste(qr, (qr_x, qr_y))

    left_text(draw, (margin, 42), "觉醒概率速览", font(54, True), red)

    summary_y = 122
    summary_right = qr_x - 26
    rounded(draw, (margin, summary_y, summary_right, summary_y + 52), 16, "#ffffff", "#e4d2ab", 2)
    left_text(draw, (margin + 24, summary_y + 13), "单次期望分", font(24, True), "#6f3b12")
    left_text(draw, (margin + 184, summary_y + 5), "5.92963", font(36, True), red)
    left_text(draw, (margin + 404, summary_y + 13), "S 档按 S/SS/SSS 合并展示", font(22, True), green)

    table_x = margin
    table_y = 208
    table_w = w - margin * 2
    header_h = 56
    row_h = 48
    cols = [250, 230, 220, table_w - 250 - 230 - 220]
    col_titles = ["觉醒品质", "概率", "积分详情", "积分期望"]
    xs = [table_x]
    for cw in cols:
        xs.append(xs[-1] + cw)

    rounded(draw, (table_x, table_y, table_x + table_w, table_y + header_h + row_h * len(ROWS)), 24, "#fff8dd", border, 4)
    draw.rectangle((table_x, table_y, table_x + table_w, table_y + header_h), fill="#2a1b12")
    for i, title in enumerate(col_titles):
        center_text(draw, (xs[i], table_y, xs[i + 1], table_y + header_h), title, font(28, True), "#fff8e7")

    for i, row in enumerate(ROWS):
        y1 = table_y + header_h + i * row_h
        y2 = y1 + row_h
        tier = row[0]
        style = tier_styles.get(tier[0], {"bg": "#fff8dd", "fg": red})
        fill = style["bg"]
        draw.rectangle((table_x, y1, table_x + table_w, y2), fill=fill)
        for x in xs:
            draw.line((x, y1, x, y2), fill=border, width=3)
        draw.line((table_x, y2, table_x + table_w, y2), fill=border, width=3)

        tier_font = font(31 if tier != "S及以上" else 27, True)
        center_text(draw, (xs[0], y1, xs[1], y2), tier, tier_font, style["fg"])
        center_text(draw, (xs[1], y1, xs[2], y2), row[1], font(29, True), ink)
        center_text(draw, (xs[2], y1, xs[3], y2), row[2], font(29, True), ink)
        center_text(draw, (xs[3], y1, xs[4], y2), row[3], font(29, True), ink)

    footer_y = table_y + header_h + row_h * len(ROWS) + 20
    rounded(draw, (margin, footer_y, w - margin, h - 36), 22, "#ffffff", "#e6d5b5", 2)
    left_text(draw, (margin + 24, footer_y + 18), "拆分口径", font(23, True), "#6f3b12")
    left_text(draw, (margin + 146, footer_y + 20), "S / SS / SSS 各 0.0005%，积分 18 / 19 / 20；合并展示为 0.0015% / 19 分。", font(21), ink)
    left_text(draw, (margin + 24, footer_y + 58), "概率合计 100%，积分期望合计 5.92963。", font(22, True), green)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, optimize=True)
    print(OUT)


if __name__ == "__main__":
    main()
