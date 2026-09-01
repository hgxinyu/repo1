import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from guide_image_style import add_guide_watermark, draw_brand_footnote


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "flipgame" / "seboss_all.json"
OUT = ROOT / "flipgame" / "images" / "se-boss-hp-guide.png"
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
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    draw.text((x1 + (x2 - x1 - tw) / 2 - bbox[0], y1 + (y2 - y1 - th) / 2 - bbox[1]), text, font=fnt, fill=fill)


def fmt_total(value):
    return f"{round(value):,}"


def fmt_per1(value):
    return f"{value:,.2f}"


def load_rows():
    data = json.loads(DATA.read_text())
    rows = [
        {
            "layer": int(row["layer"]),
            "total": float(row["total"]),
            "per1": float(row["per1"]),
        }
        for row in data
        if 1 <= int(row["layer"]) <= 100
    ]
    return sorted(rows, key=lambda row: row["layer"], reverse=True)


def chunked(rows):
    return [rows[:34], rows[34:68], rows[68:]]


def draw_summary_card(draw, x, y, w, label, value, sub, color):
    rounded(draw, (x, y, x + w, y + 94), 18, "#fffdf7", "#e3cfaa", 2)
    draw.text((x + 18, y + 14), label, font=font(20, True), fill="#6f3b12")
    draw.text((x + 18, y + 39), value, font=font(29, True), fill=color)
    draw.text((x + 18, y + 72), sub, font=font(15), fill="#5b4634")


def draw_table(draw, rows, x, y, w):
    border = "#2a1b12"
    ink = "#20130c"
    red = "#c81e1e"
    green = "#0f766e"
    blue = "#0369a1"
    title_h = 50
    header_h = 38
    row_h = 31
    gap = 14
    groups = chunked(rows)
    group_w = (w - gap * 2) / 3
    table_h = title_h + header_h + row_h * max(len(group) for group in groups)

    draw.rectangle((x, y, x + w, y + table_h), fill="#fff9e8", outline=border, width=2)
    draw.rectangle((x, y, x + w, y + title_h), fill=border)
    center_text(draw, (x, y, x + w, y + title_h), "彩章血量积分表", font(28, True), "#fff8e7")

    for group_idx, group in enumerate(groups):
        gx = x + group_idx * (group_w + gap)
        gy = y + title_h
        draw.rectangle((gx, gy, gx + group_w, gy + header_h), fill="#f3e8cf")
        widths = [52, 166, group_w - 52 - 166]
        xs = [gx]
        for width in widths:
            xs.append(xs[-1] + width)
        headers = ["层", "总积分", "1%血量"]
        colors = [green, red, blue]
        for idx, header in enumerate(headers):
            center_text(draw, (xs[idx], gy, xs[idx + 1], gy + header_h), header, font(17, True), colors[idx])
        for row_idx, row in enumerate(group):
            y1 = gy + header_h + row_idx * row_h
            y2 = y1 + row_h
            fill = "#eaf8f0" if row_idx % 2 == 0 else "#fff3eb"
            draw.rectangle((gx, y1, gx + group_w, y2), fill=fill)
            for line_x in xs:
                draw.line((line_x, y1, line_x, y2), fill=border, width=1)
            draw.line((gx, y2, gx + group_w, y2), fill=border, width=1)
            center_text(draw, (xs[0], y1, xs[1], y2), str(row["layer"]), font(15, True), green)
            center_text(draw, (xs[1], y1, xs[2], y2), fmt_total(row["total"]), font(15, True), ink)
            center_text(draw, (xs[2], y1, xs[3], y2), fmt_per1(row["per1"]), font(15, True), blue)
    return table_h


def main():
    rows = load_rows()
    w, h = 1080, 1620
    img = Image.new("RGB", (w, h), "#f7efe0")
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / h
        draw.line((0, y, w, y), fill=blend((253, 245, 226), (230, 241, 238), t))

    margin = 48
    red = "#c81e1e"
    green = "#0f766e"
    blue = "#0369a1"

    qr_size = 132
    qr_x = w - margin - qr_size
    qr_y = 28
    rounded(draw, (qr_x - 12, qr_y - 12, qr_x + qr_size + 12, qr_y + qr_size + 12), 22, "#fffdf7", "#e1c684", 2)
    qr = Image.open(QR).convert("RGB").resize((qr_size, qr_size), Image.Resampling.LANCZOS)
    img.paste(qr, (qr_x, qr_y))

    draw.text((margin, 44), "彩章血量积分", font=font(52, True), fill=red)
    draw.text((margin, 108), "远征章鱼 Boss 100 - 1 层血量积分速查", font=font(24, True), fill=green)

    row100 = next(row for row in rows if row["layer"] == 100)
    row50 = next(row for row in rows if row["layer"] == 50)
    row1 = next(row for row in rows if row["layer"] == 1)
    summary_y = 178
    gap = 16
    card_w = (w - margin * 2 - gap * 2) / 3
    draw_summary_card(draw, margin, summary_y, card_w, "100 层", fmt_total(row100["total"]), f"1% = {fmt_per1(row100['per1'])} 万亿", green)
    draw_summary_card(draw, margin + card_w + gap, summary_y, card_w, "50 层", fmt_total(row50["total"]), f"1% = {fmt_per1(row50['per1'])} 万亿", red)
    draw_summary_card(draw, margin + (card_w + gap) * 2, summary_y, card_w, "1 层", fmt_total(row1["total"]), f"1% = {fmt_per1(row1['per1'])} 万亿", blue)

    table_y = 306
    table_h = draw_table(draw, rows, margin, table_y, w - margin * 2)

    footer_y = table_y + table_h + 24
    rounded(draw, (margin, footer_y, w - margin, h - 36), 22, "#ffffff", "#e6d5b5", 2)
    draw.text((margin + 24, footer_y + 18), "说明", font=font(23, True), fill="#6f3b12")
    draw.text((margin + 96, footer_y + 20), "单位：万亿。总积分按四舍五入显示，1% 血量积分保留两位小数。", font=font(21), fill="#20130c")
    draw.text((margin + 96, footer_y + 56), "计算剩余积分：当前层总积分 × 剩余血量百分比。", font=font(21, True), fill=red)
    draw_brand_footnote(draw, w - margin - 24, footer_y + 84, font)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img = add_guide_watermark(img, font)
    img.save(OUT, optimize=True)
    print(OUT)


if __name__ == "__main__":
    main()
