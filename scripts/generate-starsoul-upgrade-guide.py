from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from guide_image_style import draw_brand_footnote


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "flipgame" / "images" / "starsoul-upgrade-guide.png"
QR = ROOT / "flipgame" / "assets" / "shinegame_pro_qr_logo_real.png"

STARSOUL_ROWS = [
    (1, 1, None),
    (2, None, 11_100),
    (3, None, 13_300),
    (4, None, 15_600),
    (5, 1, None),
    (6, None, 21_300),
    (7, None, 24_600),
    (8, None, 26_700),
    (9, 2, None),
    (10, None, 28_100),
    (11, None, 30_700),
    (12, None, 33_200),
    (13, 2, None),
    (14, None, 34_800),
    (15, None, 37_300),
    (16, None, 39_800),
    (17, 3, None),
    (18, None, 41_600),
    (19, None, 44_000),
    (20, None, 46_400),
    (21, 3, None),
    (22, None, 48_300),
    (23, None, 50_700),
    (24, None, 53_100),
]

TRAIL_ROWS = [
    (2, 1_624_600),
    (3, 1_772_300),
    (4, 1_920_000),
    (5, 2_067_700),
    (6, 2_215_400),
    (7, 2_490_800),
    (8, 2_646_500),
    (9, 2_802_200),
    (10, 2_957_800),
    (11, 3_113_500),
    (12, 3_269_200),
    (13, 3_304_500),
    (14, 3_454_700),
    (15, 3_604_900),
    (16, 3_755_100),
    (17, 3_905_300),
    (18, 4_055_500),
    (19, 4_868_800),
    (20, 5_093_800),
    (21, 5_318_800),
    (22, 5_543_800),
    (23, 5_768_800),
    (24, 5_993_800),
    (25, 6_143_100),
    (26, 6_365_900),
    (27, 6_588_600),
    (28, 6_811_400),
    (29, 7_034_200),
    (30, 7_257_000),
    (31, 7_415_800),
    (32, 7_637_000),
    (33, 7_858_200),
    (34, 8_079_300),
    (35, 8_300_500),
    (36, 8_521_700),
]

TRAIL_REQUIREMENTS = [
    ("Lv7", "星魂 Lv5"),
    ("Lv13", "星魂 Lv9"),
    ("Lv19", "星魂 Lv13"),
    ("Lv25", "星魂 Lv17"),
    ("Lv31", "星魂 Lv21"),
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


def rounded(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def center_text(draw, box, text, fnt, fill):
    x1, y1, x2, y2 = box
    bbox = draw.textbbox((0, 0), text, font=fnt)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    draw.text((x1 + (x2 - x1 - tw) / 2 - bbox[0], y1 + (y2 - y1 - th) / 2 - bbox[1]), text, font=fnt, fill=fill)


def fmt(value):
    if value is None:
        return "-"
    return f"{value:,}"


def chunked(rows, size):
    return [rows[i : i + size] for i in range(0, len(rows), size)]


def draw_summary_card(draw, x, y, w, label, value, sub, color):
    rounded(draw, (x, y, x + w, y + 96), 18, "#fffdf7", "#e3cfaa", 2)
    draw.text((x + 18, y + 14), label, font=font(20, True), fill="#6f3b12")
    draw.text((x + 18, y + 40), value, font=font(30, True), fill=color)
    draw.text((x + 18, y + 73), sub, font=font(15), fill="#5b4634")


def draw_grouped_table(draw, x, y, w, title, headers, groups, row_height, colors):
    border = "#2a1b12"
    ink = "#20130c"
    title_h = 50
    header_h = 40
    max_rows = max(len(g) for g in groups)
    group_gap = 16
    group_w = (w - group_gap * (len(groups) - 1)) / len(groups)
    total_h = title_h + header_h + row_height * max_rows

    draw.rectangle((x, y, x + w, y + total_h), fill="#fff9e8", outline=border, width=2)
    draw.rectangle((x, y, x + w, y + title_h), fill=border)
    center_text(draw, (x, y, x + w, y + title_h), title, font(28, True), "#fff8e7")

    for group_idx, group in enumerate(groups):
        gx = x + group_idx * (group_w + group_gap)
        gy = y + title_h
        draw.rectangle((gx, gy, gx + group_w, gy + header_h), fill="#f3e8cf")
        col_count = len(headers)
        col_w = group_w / col_count
        xs = [gx + i * col_w for i in range(col_count + 1)]
        for i, header in enumerate(headers):
            center_text(draw, (xs[i], gy, xs[i + 1], gy + header_h), header, font(17, True), colors.get(i, ink))
        for row_idx, row in enumerate(group):
            y1 = gy + header_h + row_idx * row_height
            y2 = y1 + row_height
            fill = "#eaf8f0" if row_idx % 2 == 0 else "#fff3eb"
            draw.rectangle((gx, y1, gx + group_w, y2), fill=fill)
            for line_x in xs:
                draw.line((line_x, y1, line_x, y2), fill=border, width=1)
            draw.line((gx, y2, gx + group_w, y2), fill=border, width=1)
            for col_idx, value in enumerate(row):
                fill_color = colors.get(col_idx, ink)
                center_text(draw, (xs[col_idx], y1, xs[col_idx + 1], y2), fmt(value), font(17, True), fill_color)

    return total_h


def draw_requirements(draw, x, y, w):
    ink = "#20130c"
    green = "#0f766e"
    rounded(draw, (x, y, x + w, y + 86), 18, "#ffffff", "#e6d5b5", 2)
    draw.text((x + 22, y + 16), "命轨同步要求", font=font(20, True), fill="#6f3b12")
    chip_x = x + 170
    for target, req in TRAIL_REQUIREMENTS:
        text = f"{target} 需 {req}"
        bbox = draw.textbbox((0, 0), text, font=font(16, True))
        chip_w = bbox[2] - bbox[0] + 28
        rounded(draw, (chip_x, y + 14, chip_x + chip_w, y + 48), 14, "#e8f7ef", "#b9ddcf", 1)
        center_text(draw, (chip_x, y + 14, chip_x + chip_w, y + 48), text, font(16, True), green)
        chip_x += chip_w + 10
    draw.text((x + 22, y + 58), "只整理材料需求；星魂属性、技能解锁和左表红色任务数字未纳入本图。", font=font(17), fill=ink)


def main():
    w, h = 1080, 1420
    img = Image.new("RGB", (w, h), "#f7efe0")
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / h
        draw.line((0, y, w, y), fill=blend((253, 245, 226), (230, 241, 238), t))

    margin = 48
    red = "#c81e1e"
    green = "#0f766e"
    blue = "#0369a1"
    magenta = "#a21caf"

    qr_size = 132
    qr_x = w - margin - qr_size
    qr_y = 28
    rounded(draw, (qr_x - 12, qr_y - 12, qr_x + qr_size + 12, qr_y + qr_size + 12), 22, "#fffdf7", "#e1c684", 2)
    qr = Image.open(QR).convert("RGB").resize((qr_size, qr_size), Image.Resampling.LANCZOS)
    img.paste(qr, (qr_x, qr_y))

    draw.text((margin, 44), "星魂升级材料", font=font(52, True), fill=red)
    draw.text((margin, 108), "星魂升级至 Lv24 / 命轨升级至 Lv36 材料需求速览", font=font(24, True), fill=green)

    summary_y = 178
    gap = 16
    card_w = (w - margin * 2 - gap * 2) / 3
    body_total = sum(row[1] or 0 for row in STARSOUL_ROWS)
    essence_total = sum(row[2] or 0 for row in STARSOUL_ROWS)
    trail_total = sum(row[1] for row in TRAIL_ROWS)
    draw_summary_card(draw, margin, summary_y, card_w, "星魂本体", f"{body_total}", "星魂 Lv1 - Lv24 合计", magenta)
    draw_summary_card(draw, margin + card_w + gap, summary_y, card_w, "星魂精髓", fmt(essence_total), "星魂 Lv1 - Lv24 合计", green)
    draw_summary_card(draw, margin + (card_w + gap) * 2, summary_y, card_w, "命轨材料", fmt(trail_total), "Lv2 - Lv36 合计", blue)

    table_y = 306
    starsoul_groups = chunked(STARSOUL_ROWS, 8)
    starsoul_h = draw_grouped_table(
        draw,
        margin,
        table_y,
        w - margin * 2,
        "星魂升级材料需求",
        ["Lv", "星魂本体", "星魂精髓"],
        starsoul_groups,
        36,
        {0: green, 1: magenta, 2: green},
    )

    trail_y = table_y + starsoul_h + 32
    trail_groups = chunked(TRAIL_ROWS, 12)
    draw_grouped_table(
        draw,
        margin,
        trail_y,
        w - margin * 2,
        "命轨升级材料需求",
        ["Lv", "命轨材料"],
        trail_groups,
        35,
        {0: green, 1: blue},
    )

    footer_y = h - 130
    draw_requirements(draw, margin, footer_y, w - margin * 2)
    draw.text((margin + 24, h - 33), "换算：1 个星魂本体 = 5,000 星魂碎片。", font=font(18, True), fill="#6f3b12")
    draw_brand_footnote(draw, w - margin - 24, h - 33, font)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, optimize=True)
    print(OUT)


if __name__ == "__main__":
    main()
