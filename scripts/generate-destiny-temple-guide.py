import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from guide_image_style import draw_brand_footnote


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "flipgame" / "destiny_temple_levels.json"
OUT = ROOT / "flipgame" / "images" / "destiny-temple-guide.png"
QR = ROOT / "flipgame" / "assets" / "shinegame_pro_qr_logo_real.png"


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


def fmt_k(value):
    return f"{value:,}K"


def fmt_requirements(items, prefix):
    return " ".join(f"{item['count']}{prefix}{item['destinyLevel' if prefix == '飞' else 'divinePowerLevel']}" for item in items)


def main():
    data = json.loads(DATA.read_text())
    levels = data["levels"]

    w, h = 1080, 1640
    img = Image.new("RGB", (w, h), "#f7efe0")
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / h
        draw.line((0, y, w, y), fill=blend((253, 245, 226), (230, 241, 238), t))

    margin = 36
    ink = "#20130c"
    red = "#c81e1e"
    green = "#0f766e"
    border = "#2a1b12"

    qr_size = 124
    qr_x = w - margin - qr_size
    qr_y = 28
    rounded(draw, (qr_x - 12, qr_y - 12, qr_x + qr_size + 12, qr_y + qr_size + 12), 22, "#fffdf7", "#e1c684", 2)
    qr = Image.open(QR).convert("RGB").resize((qr_size, qr_size), Image.Resampling.LANCZOS)
    img.paste(qr, (qr_x, qr_y))

    draw.text((margin, 44), "飞升殿堂升级资料", font=font(48, True), fill=red)
    summary_y = 122
    summary_right = qr_x - 26
    rounded(draw, (margin, summary_y, summary_right, summary_y + 52), 16, "#ffffff", "#e4d2ab", 2)
    draw.text((margin + 24, summary_y + 13), "范围", font=font(23, True), fill="#6f3b12")
    draw.text((margin + 104, summary_y + 6), "殿堂 1 - 30", font=font(32, True), fill=red)
    draw.text((margin + 342, summary_y + 13), "升级要求 / 前置 / 升满资源", font=font(21, True), fill=green)

    table_x = margin
    table_y = 208
    table_w = w - margin * 2
    header_h = 54
    row_h = 39
    cols = [54, 52, 134, 134, 118, 110, 58, 82, 98, table_w - 54 - 52 - 134 - 134 - 118 - 110 - 58 - 82 - 98]
    headers = ["殿", "加成", "要求(飞)", "展示(神)", "前置星碎", "前置意识", "神玉", "时晶", "灵碎", "星碎"]
    xs = [table_x]
    for cw in cols:
        xs.append(xs[-1] + cw)

    table_h = header_h + row_h * len(levels)
    rounded(draw, (table_x, table_y, table_x + table_w, table_y + table_h), 20, "#fff8dd", border, 4)
    draw.rectangle((table_x, table_y, table_x + table_w, table_y + header_h), fill=border)
    for i, header in enumerate(headers):
        center_text(draw, (xs[i], table_y, xs[i + 1], table_y + header_h), header, font(16, True), "#fff8e7")

    for i, level in enumerate(levels):
        y1 = table_y + header_h + i * row_h
        y2 = y1 + row_h
        fill = "#eaf8f0" if i % 2 == 0 else "#fff3eb"
        if level["templeLevel"] in {1, 10, 20, 30}:
            fill = "#fff7dc"
        draw.rectangle((table_x, y1, table_x + table_w, y2), fill=fill)
        for x in xs:
            draw.line((x, y1, x, y2), fill=border, width=1)
        draw.line((table_x, y2, table_x + table_w, y2), fill=border, width=1)

        req = fmt_requirements(level["upgradeRequirements"], "飞")
        shown = fmt_requirements(level["actualDisplay"], "神")
        prereq = level["prerequisites"]
        resources = level["resources"]
        values = [
            str(level["templeLevel"]),
            f"+{level['divinePowerBonus']}",
            req,
            shown,
            fmt(prereq["stellarShards"]),
            fmt(prereq["spiritualEssence"]),
            fmt(resources["auroraGem"]["total"]),
            fmt_k(resources["crystalOfTranscendenceK"]["total"]),
            fmt(resources["scatteredSpiritveinShard"]["total"]),
            fmt(resources["stellarShards"]["total"]),
        ]
        for col, value in enumerate(values):
            fill_color = red if col == 0 and level["templeLevel"] in {10, 20, 30} else ink
            fnt = font(13, True) if col in {0, 1} else font(12)
            center_text(draw, (xs[col], y1, xs[col + 1], y2), value, fnt, fill_color)

    footer_y = table_y + table_h + 22
    rounded(draw, (margin, footer_y, w - margin, h - 36), 22, "#ffffff", "#e6d5b5", 2)
    draw.text((margin + 24, footer_y + 18), "说明", font=font(23, True), fill="#6f3b12")
    draw.text((margin + 96, footer_y + 20), "神能等级 = 飞升等级 + 神能加成；展示(神)由要求(飞)自动推导。", font=font(20), fill=ink)
    draw.text((margin + 96, footer_y + 54), "前置星碎 / 前置意识是升级门槛；神玉、时晶、灵碎、星碎为当前殿堂升满累计资源。", font=font(20), fill=ink)
    draw_brand_footnote(draw, w - margin - 24, footer_y + 112, font)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, optimize=True)
    print(OUT)


if __name__ == "__main__":
    main()
