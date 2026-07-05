from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "flipgame" / "images" / "root-level-guide.png"
QR = ROOT / "flipgame" / "assets" / "shinegame_pro_qr_logo_real.png"

ROWS = [
    (20, 360, 330_050, 33_390, 45_069, 4_056_337),
    (30, None, 574_775, 59_580, 70_422, 6_338_027),
    (40, 370, 944_700, 100_840, 98_591, 8_873_238),
    (50, None, 1_437_125, 157_800, 133_802, 12_042_252),
    (60, 380, 2_072_050, 233_460, 169_013, 15_211_266),
    (70, None, 2_869_475, 330_820, 211_266, 19_014_082),
    (80, 390, 3_849_400, 452_880, 253_520, 22_816_899),
    (90, None, 5_031_825, 602_640, 306_336, 27_570_420),
    (100, 400, 6_436_750, 783_100, 359_153, 32_323_941),
    (110, None, 8_084_175, 997_260, 429_575, 38_661_969),
    (120, None, 9_994_100, 1_248_120, 500_000, 45_000_000),
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


def fmt(value):
    if value is None:
        return "-"
    return f"{value:,}"


def main():
    w, h = 1080, 960
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

    left_text(draw, (margin, 44), "根源等级速览", font(52, True), red)

    summary_y = 122
    summary_right = qr_x - 26
    rounded(draw, (margin, summary_y, summary_right, summary_y + 52), 16, "#ffffff", "#e4d2ab", 2)
    left_text(draw, (margin + 24, summary_y + 13), "等级范围", font(24, True), "#6f3b12")
    left_text(draw, (margin + 162, summary_y + 6), "20 - 120", font(34, True), red)
    left_text(draw, (margin + 374, summary_y + 13), "累计印痕 / 意识精华 / 攻击 / 血量", font(22, True), green)

    table_x = margin
    table_y = 208
    table_w = w - margin * 2
    header_h = 56
    row_h = 50
    cols = [126, 126, 205, 205, 154, table_w - 126 - 126 - 205 - 205 - 154]
    headers = ["根源", "英雄等级", "累计印痕", "累计意识", "攻击", "血量"]
    xs = [table_x]
    for cw in cols:
        xs.append(xs[-1] + cw)

    rounded(draw, (table_x, table_y, table_x + table_w, table_y + header_h + row_h * len(ROWS)), 22, "#fff8dd", border, 4)
    draw.rectangle((table_x, table_y, table_x + table_w, table_y + header_h), fill=border)
    for i, header in enumerate(headers):
        center_text(draw, (xs[i], table_y, xs[i + 1], table_y + header_h), header, font(23, True), "#fff8e7")

    for i, row in enumerate(ROWS):
        root_level, hero_level, imprints, essence, attack, hp = row
        y1 = table_y + header_h + i * row_h
        y2 = y1 + row_h
        fill = "#eaf8f0" if i % 2 == 0 else "#fff3eb"
        if root_level == 120:
            fill = "#fff7dc"
        draw.rectangle((table_x, y1, table_x + table_w, y2), fill=fill)
        for x in xs:
            draw.line((x, y1, x, y2), fill=border, width=2)
        draw.line((table_x, y2, table_x + table_w, y2), fill=border, width=2)
        center_text(draw, (xs[0], y1, xs[1], y2), str(root_level), font(27, True), red if root_level == 120 else green)
        center_text(draw, (xs[1], y1, xs[2], y2), fmt(hero_level), font(27, True), ink)
        center_text(draw, (xs[2], y1, xs[3], y2), fmt(imprints), font(25, True), ink)
        center_text(draw, (xs[3], y1, xs[4], y2), fmt(essence), font(25, True), ink)
        center_text(draw, (xs[4], y1, xs[5], y2), fmt(attack), font(25, True), ink)
        center_text(draw, (xs[5], y1, xs[6], y2), fmt(hp), font(25, True), ink)

    footer_y = table_y + header_h + row_h * len(ROWS) + 22
    rounded(draw, (margin, footer_y, w - margin, h - 36), 22, "#ffffff", "#e6d5b5", 2)
    left_text(draw, (margin + 24, footer_y + 18), "说明", font(23, True), "#6f3b12")
    left_text(draw, (margin + 96, footer_y + 20), "资源为从 E9 到对应根源等级的累计值；120 级为当前满根源。", font(21), ink)
    left_text(draw, (margin + 96, footer_y + 56), "满根源累计：9,994,100 印痕 / 1,248,120 意识精华。", font(21, True), red)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, optimize=True)
    print(OUT)


if __name__ == "__main__":
    main()
