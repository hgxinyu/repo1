from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from guide_image_style import draw_brand_footnote


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "flipgame" / "images" / "destiny-upgrade-guide.png"
QR = ROOT / "flipgame" / "assets" / "shinegame_pro_qr_logo_real.png"

ROWS = [
    (1, "源初", "Origin", 5, 420_000, 197_236, 821_540),
    (2, "进发", "Surge", 7, 590_000, 277_200, 1_155_000),
    (3, "混沌", "Chaos", 9, 750_000, 356_400, 1_485_000),
    (4, "凝核", "Core", 11, 920_000, 435_600, 1_815_000),
    (5, "聚星", "Polystar", 13, 1_100_000, 514_800, 2_145_000),
    (6, "超脱", "Nirvana", 15, 1_250_000, 619_300, 2_578_950),
]

DROP_ROWS = [
    ("2-6-10", 1_645, 49_352, 206, 6_169),
    ("4-1-1", 1_972, 59_149, 247, 7_396),
    ("5-1-1", 2_299, 68_982, 287, 8_623),
    ("6-1-1", 2_396, 71_885, 300, 8_986),
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


def text_size(draw, text, fnt):
    bbox = draw.textbbox((0, 0), text, font=fnt)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def center_text(draw, box, text, fnt, fill):
    x1, y1, x2, y2 = box
    bbox = draw.textbbox((0, 0), text, font=fnt)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    draw.text((x1 + (x2 - x1 - w) / 2 - bbox[0], y1 + (y2 - y1 - h) / 2 - bbox[1]), text, font=fnt, fill=fill)


def fmt(value):
    return f"{value:,}"


def main():
    w, h = 1080, 980
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

    draw.text((margin, 44), "飞升升级资源", font=font(52, True), fill=red)
    summary_y = 122
    summary_right = qr_x - 26
    rounded(draw, (margin, summary_y, summary_right, summary_y + 52), 16, "#ffffff", "#e4d2ab", 2)
    draw.text((margin + 24, summary_y + 13), "范围", font=font(24, True), fill="#6f3b12")
    draw.text((margin + 106, summary_y + 6), "飞1 - 飞6", font=font(34, True), fill=red)
    draw.text((margin + 330, summary_y + 13), "光玉 / 时晶 / 灵碎 / 星辰碎片", font=font(22, True), fill=green)

    table_x = margin
    table_y = 208
    table_w = w - margin * 2
    header_h = 56
    row_h = 58
    cols = [74, 144, 108, 142, 188, 188, table_w - 74 - 144 - 108 - 142 - 188 - 188]
    headers = ["飞", "阶位", "英文", "光玉", "时晶", "灵碎", "星辰碎片"]
    xs = [table_x]
    for cw in cols:
        xs.append(xs[-1] + cw)

    table_h = header_h + row_h * (len(ROWS) + 1)
    rounded(draw, (table_x, table_y, table_x + table_w, table_y + table_h), 22, "#fff8dd", border, 4)
    draw.rectangle((table_x, table_y, table_x + table_w, table_y + header_h), fill=border)
    for i, header in enumerate(headers):
        center_text(draw, (xs[i], table_y, xs[i + 1], table_y + header_h), header, font(21, True), "#fff8e7")

    for i, row in enumerate(ROWS):
        destiny, name, english, aurora, crystal, spirit, stellar = row
        y1 = table_y + header_h + i * row_h
        y2 = y1 + row_h
        fill = "#eaf8f0" if i % 2 == 0 else "#fff3eb"
        draw.rectangle((table_x, y1, table_x + table_w, y2), fill=fill)
        for x in xs:
            draw.line((x, y1, x, y2), fill=border, width=2)
        draw.line((table_x, y2, table_x + table_w, y2), fill=border, width=2)
        center_text(draw, (xs[0], y1, xs[1], y2), str(destiny), font(24, True), green)
        center_text(draw, (xs[1], y1, xs[2], y2), name, font(23, True), red if destiny == 6 else ink)
        center_text(draw, (xs[2], y1, xs[3], y2), english, font(17), "#5a4638")
        center_text(draw, (xs[3], y1, xs[4], y2), fmt(aurora), font(21, True), ink)
        center_text(draw, (xs[4], y1, xs[5], y2), fmt(crystal), font(21), ink)
        center_text(draw, (xs[5], y1, xs[6], y2), fmt(spirit), font(21), ink)
        center_text(draw, (xs[6], y1, xs[7], y2), fmt(stellar), font(21), ink)

    total = (
        sum(row[3] for row in ROWS),
        sum(row[4] for row in ROWS),
        sum(row[5] for row in ROWS),
        sum(row[6] for row in ROWS),
    )
    y1 = table_y + header_h + len(ROWS) * row_h
    y2 = y1 + row_h
    draw.rectangle((table_x, y1, table_x + table_w, y2), fill="#fff7dc")
    for x in xs:
        draw.line((x, y1, x, y2), fill=border, width=2)
    draw.line((table_x, y2, table_x + table_w, y2), fill=border, width=2)
    center_text(draw, (xs[0], y1, xs[3], y2), "合计 神六", font(24, True), red)
    center_text(draw, (xs[3], y1, xs[4], y2), fmt(total[0]), font(22, True), red)
    center_text(draw, (xs[4], y1, xs[5], y2), fmt(total[1]), font(22, True), red)
    center_text(draw, (xs[5], y1, xs[6], y2), fmt(total[2]), font(22, True), red)
    center_text(draw, (xs[6], y1, xs[7], y2), fmt(total[3]), font(22, True), red)

    info_y = table_y + table_h + 24
    left_w = 430
    right_x = margin + left_w + 28
    rounded(draw, (margin, info_y, margin + left_w, info_y + 220), 22, "#ffffff", "#e6d5b5", 2)
    draw.text((margin + 24, info_y + 18), "换算", font=font(24, True), fill="#6f3b12")
    center_text(draw, (margin + 24, info_y + 66, margin + left_w - 24, info_y + 116), "1 光玉 = 5,000 光玉碎片", font(28, True), red)

    right_w = w - margin - right_x
    rounded(draw, (right_x, info_y, w - margin, info_y + 220), 22, "#ffffff", "#e6d5b5", 2)
    draw.text((right_x + 24, info_y + 18), "掉落参考（日 / 月）", font=font(24, True), fill="#6f3b12")
    drop_x = right_x + 24
    drop_y = info_y + 58
    drop_cols = [92, 92, 98, 72, right_w - 24 * 2 - 92 - 92 - 98 - 72]
    drop_headers = ["关卡", "灵碎日", "灵碎月", "光玉日", "光玉月"]
    dxs = [drop_x]
    for cw in drop_cols:
        dxs.append(dxs[-1] + cw)
    for i, header in enumerate(drop_headers):
        center_text(draw, (dxs[i], drop_y, dxs[i + 1], drop_y + 34), header, font(15, True), green)
    for r, row in enumerate(DROP_ROWS):
        y = drop_y + 34 + r * 30
        stage, spirit_day, spirit_month, aurora_day, aurora_month = row
        values = [stage, fmt(spirit_day), fmt(spirit_month), fmt(aurora_day), fmt(aurora_month)]
        for i, value in enumerate(values):
            center_text(draw, (dxs[i], y, dxs[i + 1], y + 30), value, font(15, True) if i == 0 else font(15), ink)
    draw_brand_footnote(draw, margin + left_w - 24, info_y + 186, font)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, optimize=True)
    print(OUT)


if __name__ == "__main__":
    main()
