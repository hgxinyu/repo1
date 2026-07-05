from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from guide_image_style import draw_brand_footnote


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "flipgame" / "images" / "grimoire-upgrade-guide.png"
QR = ROOT / "flipgame" / "assets" / "shinegame_pro_qr_logo_real.png"

LEVELS = ["1-25", "26-50", "51-75", "76-100", "101-125", "126-150"]
CHAPTER1 = [
    (402_700, 402_700),
    (1_545_100, 1_947_800),
    (3_352_800, 5_300_600),
    (5_827_700, 11_128_300),
    (8_970_600, 20_098_900),
    (12_781_300, 32_880_200),
]
CHAPTER2 = [
    (301_800, 37_815, 301_800, 37_815),
    (1_158_500, 144_910, 1_460_300, 182_725),
    (2_514_100, 314_381, 3_974_400, 497_106),
    (4_370_200, 546_390, 8_344_600, 1_043_496),
    (6_727_400, 841_045, 15_072_000, 1_884_541),
    (9_585_500, 1_198_280, 24_657_500, 3_082_821),
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
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    draw.text((x1 + (x2 - x1 - w) / 2 - bbox[0], y1 + (y2 - y1 - h) / 2 - bbox[1]), text, font=fnt, fill=fill)


def fmt(value):
    return f"{value:,}"


def draw_table(draw, x, y, w, title, headers, rows, colors):
    border = "#2a1b12"
    ink = "#20130c"
    red = "#c81e1e"
    green = "#0f766e"
    title_h = 48
    header_h = 52
    row_h = 58
    rounded(draw, (x, y, x + w, y + title_h + header_h + row_h * len(rows)), 22, "#fff8dd", border, 4)
    draw.rectangle((x, y, x + w, y + title_h), fill=border)
    center_text(draw, (x, y, x + w, y + title_h), title, font(26, True), "#fff8e7")
    y += title_h
    draw.rectangle((x, y, x + w, y + header_h), fill="#f5ead0")
    cols = [0.24] + [(1 - 0.24) / (len(headers) - 1)] * (len(headers) - 1)
    xs = [x]
    for ratio in cols:
        xs.append(xs[-1] + w * ratio)
    for i, header in enumerate(headers):
        color = colors.get(i, ink)
        center_text(draw, (xs[i], y, xs[i + 1], y + header_h), header, font(18, True), color)
    for i, row in enumerate(rows):
        y1 = y + header_h + i * row_h
        y2 = y1 + row_h
        fill = "#eaf8f0" if i % 2 == 0 else "#fff3eb"
        if i == len(rows) - 1:
            fill = "#fff7dc"
        draw.rectangle((x, y1, x + w, y2), fill=fill)
        for line_x in xs:
            draw.line((line_x, y1, line_x, y2), fill=border, width=2)
        draw.line((x, y2, x + w, y2), fill=border, width=2)
        center_text(draw, (xs[0], y1, xs[1], y2), LEVELS[i], font(19, True), green)
        for col, value in enumerate(row, start=1):
            color = red if i == len(rows) - 1 and col >= len(row) - 1 else ink
            center_text(draw, (xs[col], y1, xs[col + 1], y2), fmt(value), font(18, True) if i == len(rows) - 1 else font(18), color)


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

    qr_size = 132
    qr_x = w - margin - qr_size
    qr_y = 28
    rounded(draw, (qr_x - 12, qr_y - 12, qr_x + qr_size + 12, qr_y + qr_size + 12), 22, "#fffdf7", "#e1c684", 2)
    qr = Image.open(QR).convert("RGB").resize((qr_size, qr_size), Image.Resampling.LANCZOS)
    img.paste(qr, (qr_x, qr_y))

    draw.text((margin, 44), "魔典升级需求", font=font(52, True), fill=red)
    summary_y = 122
    summary_right = qr_x - 26
    rounded(draw, (margin, summary_y, summary_right, summary_y + 52), 16, "#ffffff", "#e4d2ab", 2)
    draw.text((margin + 24, summary_y + 13), "范围", font=font(24, True), fill="#6f3b12")
    draw.text((margin + 106, summary_y + 6), "1 - 150", font=font(34, True), fill=red)
    draw.text((margin + 300, summary_y + 13), "赋能魔典 / 印痕魔典材料分开计算", font=font(22, True), fill=green)

    table_y = 210
    gap = 24
    table_w = (w - margin * 2 - gap) / 2
    draw_table(
        draw,
        margin,
        table_y,
        table_w,
        "Chapter 1：赋能魔典",
        ["等级", "魔典精华", "累计魔典精华"],
        CHAPTER1,
        {1: "#a21caf", 2: "#a21caf"},
    )
    draw_table(
        draw,
        margin + table_w + gap,
        table_y,
        table_w,
        "Chapter 2：印痕魔典",
        ["等级", "魔典精华", "印痕精华", "累计魔典", "累计印痕"],
        CHAPTER2,
        {1: "#a21caf", 2: "#0369a1", 3: "#a21caf", 4: "#0369a1"},
    )

    footer_y = 680
    rounded(draw, (margin, footer_y, w - margin, h - 36), 22, "#ffffff", "#e6d5b5", 2)
    draw.text((margin + 24, footer_y + 18), "说明", font=font(23, True), fill="#6f3b12")
    draw.text((margin + 96, footer_y + 20), "Chapter 1 = 赋能魔典，只消耗魔典精华。", font=font(21), fill=ink)
    draw.text((margin + 96, footer_y + 54), "Chapter 2 = 印痕魔典，同时消耗魔典精华和魔典印痕精华。", font=font(21), fill=ink)
    draw_brand_footnote(draw, w - margin - 24, footer_y + 23, font)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, optimize=True)
    print(OUT)


if __name__ == "__main__":
    main()
