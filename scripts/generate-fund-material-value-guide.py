from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "flipgame" / "images" / "fund-material-value-guide.png"
QR = ROOT / "flipgame" / "assets" / "shinegame_pro_qr_logo_real.png"

ROWS = [
    (4, "星辰碎片", 500_000, 2_500_000, 6_000_000, 2.4, "蓝碎"),
    (5, "意识精华", 280_000, 300_000, 3_360_000, 11.2, ""),
    (6, "散落的灵脉碎片", 80_000, 400_000, 960_000, 2.4, "飞升碎片"),
    (7, "光玉碎块", 12_000, 50_000, 144_000, 2.88, ""),
    (8, "星魂碎片箱", 400, 5_000, 4_800, 0.96, ""),
    (9, "赋能灌注石碎片2种", 3_000, 10_000, 36_000, 3.6, ""),
    (10, "魔典精华", 360_000, 1_400_000, 4_320_000, 3.085714286, ""),
    (11, "魔典印痕精华", 58_000, 175_000, 696_000, 3.977142857, ""),
    (13, "生化滋养针", 30_000, 180_000, 360_000, 2.0, "根源之树"),
    (14, "根源之核碎片32种", 25, 100, 300, 3.0, ""),
    (15, "星魂精髓3种", 4_000, 50_000, 48_000, 0.96, ""),
]

RATIO_RANKS = {row[0]: rank for rank, row in enumerate(sorted(ROWS, key=lambda item: item[5], reverse=True), start=1)}


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


def wrap_text(draw, text, fnt, max_width):
    lines = []
    current = ""
    for char in text:
        test = current + char
        if text_size(draw, test, fnt)[0] <= max_width or not current:
            current = test
        else:
            lines.append(current)
            current = char
    if current:
        lines.append(current)
    return lines


def draw_wrapped(draw, xy, text, fnt, fill, max_width, line_gap=5):
    x, y = xy
    lines = wrap_text(draw, text, fnt, max_width)
    line_h = text_size(draw, "国", fnt)[1] + line_gap
    for i, line in enumerate(lines):
        draw.text((x, y + i * line_h), line, font=fnt, fill=fill)


def fmt_num(value):
    return f"{value:,}"


def fmt_ratio(value):
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    if value in (3.085714286, 3.977142857):
        text = f"{value:.4f}"
    return text


def ratio_style(row_id):
    rank = RATIO_RANKS[row_id]
    if rank == 1:
        return "#ffd21f", "#7c2d12"
    if rank <= 3:
        return "#fff200", "#7c2d12"
    if rank <= 6:
        return "#fff7a8", "#7c2d12"
    if rank >= len(ROWS) - 1:
        return "#f8c9d3", "#9f1239"
    return None, "#20130c"


def main():
    w, h = 1080, 1040
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

    draw.text((margin, 44), "基金材料性价比", font=font(52, True), fill=red)
    summary_y = 122
    summary_right = qr_x - 26
    rounded(draw, (margin, summary_y, summary_right, summary_y + 52), 16, "#ffffff", "#e4d2ab", 2)
    draw.text((margin + 24, summary_y + 13), "公式", font=font(24, True), fill="#6f3b12")
    draw.text((margin + 106, summary_y + 6), "基金12倍 / 任务兑换", font=font(31, True), fill=red)
    draw.text((margin + 510, summary_y + 13), "比例越高，基金越实惠", font=font(22, True), fill=green)

    table_x = margin
    table_y = 208
    table_w = w - margin * 2
    header_h = 56
    row_h = 54
    cols = [58, 226, 132, 154, 142, 112, table_w - 58 - 226 - 132 - 154 - 142 - 112]
    headers = ["序", "物品名称", "记录上限", "任务10材", "基金12倍", "比例", "备注"]
    xs = [table_x]
    for cw in cols:
        xs.append(xs[-1] + cw)

    table_h = header_h + row_h * len(ROWS)
    rounded(draw, (table_x, table_y, table_x + table_w, table_y + table_h), 22, "#fff8dd", border, 4)
    draw.rectangle((table_x, table_y, table_x + table_w, table_y + header_h), fill=border)
    for i, header in enumerate(headers):
        center_text(draw, (xs[i], table_y, xs[i + 1], table_y + header_h), header, font(21, True), "#fff8e7")

    for i, row in enumerate(ROWS):
        idx, name, cap, task_exchange, fund12, ratio, note = row
        y1 = table_y + header_h + i * row_h
        y2 = y1 + row_h
        fill = "#eaf8f0" if i % 2 == 0 else "#fff3eb"
        draw.rectangle((table_x, y1, table_x + table_w, y2), fill=fill)
        for x in xs:
            draw.line((x, y1, x, y2), fill=border, width=2)
        draw.line((table_x, y2, table_x + table_w, y2), fill=border, width=2)
        center_text(draw, (xs[0], y1, xs[1], y2), str(idx), font(20, True), green)
        draw_wrapped(draw, (xs[1] + 10, y1 + 11), name, font(19, True), ink, cols[1] - 20)
        center_text(draw, (xs[2], y1, xs[3], y2), fmt_num(cap), font(19), ink)
        center_text(draw, (xs[3], y1, xs[4], y2), fmt_num(task_exchange), font(19), ink)
        center_text(draw, (xs[4], y1, xs[5], y2), fmt_num(fund12), font(19), ink)
        ratio_fill, ratio_color = ratio_style(idx)
        if ratio_fill:
            draw.rectangle((xs[5] + 3, y1 + 3, xs[6] - 3, y2 - 3), fill=ratio_fill)
        center_text(draw, (xs[5], y1, xs[6], y2), fmt_ratio(ratio), font(20, True), ratio_color)
        draw_wrapped(draw, (xs[6] + 10, y1 + 13), note, font(18), ink, cols[6] - 20)

    footer_y = table_y + table_h + 22
    rounded(draw, (margin, footer_y, w - margin, h - 36), 22, "#ffffff", "#e6d5b5", 2)
    draw.text((margin + 24, footer_y + 18), "说明", font=font(23, True), fill="#6f3b12")
    draw_wrapped(draw, (margin + 96, footer_y + 20), "比例 = 基金12倍 ÷ 任务每10材料换取量；倍数越高代表基金越实惠。", font(21), ink, 820)
    draw_wrapped(draw, (margin + 96, footer_y + 56), "比例按从高到低高亮：深黄最高，浅黄次之；粉色为最低两档。", font(21, True), red, 820)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, optimize=True)
    print(OUT)


if __name__ == "__main__":
    main()
