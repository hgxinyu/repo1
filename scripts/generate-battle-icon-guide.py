from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from guide_image_style import draw_guide_footnote


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "flipgame" / "images" / "tubiao.jpg"
OUT = ROOT / "flipgame" / "images" / "battle-buff-debuff-icons-guide.png"
QR = ROOT / "flipgame" / "assets" / "shinegame_pro_qr_logo_real.png"


BUFF_ROWS = [
    ("攻击力增加 x%", (21, 101, 50, 129)),
    ("增加暴击几率 x%", (21, 142, 50, 171)),
    ("增加暴击伤害 x%", (21, 183, 50, 212)),
    ("增加护甲 x%", (21, 224, 50, 252)),
    ("增加护甲破损 x%", (21, 265, 50, 294)),
    ("速度增加 x", (21, 306, 50, 335)),
    ("提高 x% 准确率", (21, 347, 50, 376)),
    ("增加 x% 格挡", (21, 388, 50, 416)),
    ("增加技能伤害 x%", (21, 428, 50, 458)),
    ("增加神圣伤害 x%", (21, 469, 50, 499)),
    ("增加伤害减少 x%", (21, 510, 50, 540)),
    ("增加治疗效果 x%", (21, 552, 50, 580)),
    ("随着时间的推移而愈合（仅限 Vesa）", (22, 592, 50, 621)),
    ("增加 CC 免疫力 x%", (21, 634, 50, 662)),
    ("救援标记（见奥玛斯）", (21, 674, 50, 703)),
]

DEBUFF_ROWS = [
    ("攻击力降低 x%", (333, 101, 362, 129)),
    ("降低暴击几率 x%", (333, 142, 362, 171)),
    ("减少暴击伤害 x%", (333, 183, 362, 212)),
    ("降低护甲 x%", (333, 224, 362, 252)),
    ("减少护甲破坏 x%", (333, 265, 362, 294)),
    ("速度降低 x", (333, 306, 362, 335)),
    ("降低精度 x%", (333, 347, 362, 376)),
    ("减少 x% 阻挡", (333, 388, 362, 416)),
    ("减少技能伤害 x%", (333, 428, 362, 455)),
    ("减少神圣伤害 x%", (333, 469, 362, 498)),
    ("移除伤害减少 x%", (333, 510, 362, 540)),
    ("消除治疗效果 x%", (333, 552, 362, 580)),
    ("移除随时间推移的治疗", (334, 592, 362, 621)),
    ("降低 CC 免疫力 x%", (335, 634, 360, 662)),
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


def rounded(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def text_width(draw, text, fnt):
    box = draw.textbbox((0, 0), text, font=fnt)
    return box[2] - box[0]


def draw_centered(draw, box, text, fnt, fill):
    x1, y1, x2, y2 = box
    bbox = draw.textbbox((0, 0), text, font=fnt)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    draw.text((x1 + (x2 - x1 - tw) / 2 - bbox[0], y1 + (y2 - y1 - th) / 2 - bbox[1]), text, font=fnt, fill=fill)


def paste_icon(canvas, source, box, x, y, size):
    icon = source.crop(box).resize((size, size), Image.Resampling.LANCZOS)
    canvas.paste(icon, (x, y))


def draw_table(canvas, draw, source, x, y, w, title, rows, accent, light):
    header_h = 76
    row_h = 66
    icon_size = 42
    table_h = header_h + row_h * len(rows)

    rounded(draw, (x, y, x + w, y + table_h), 26, "#fffdf7", "#d8c6a9", 2)
    rounded(draw, (x, y, x + w, y + header_h), 26, accent, accent)
    draw.rectangle((x, y + header_h - 26, x + w, y + header_h), fill=accent)
    draw_centered(draw, (x, y, x + w, y + header_h), title, font(34, True), "#fffaf0")

    label_font = font(23, True)
    small_label_font = font(20, True)
    for idx, (label, crop_box) in enumerate(rows):
        y1 = y + header_h + idx * row_h
        fill = light if idx % 2 == 0 else "#ffffff"
        draw.rectangle((x + 1, y1, x + w - 1, y1 + row_h), fill=fill)
        draw.line((x + 22, y1 + row_h, x + w - 22, y1 + row_h), fill="#eadcc8", width=1)
        paste_icon(canvas, source, crop_box, x + 30, y1 + (row_h - icon_size) // 2, icon_size)
        fnt = small_label_font if text_width(draw, label, label_font) > w - 128 else label_font
        draw.text((x + 92, y1 + 20), label, font=fnt, fill="#2b2118")

    return table_h


def main():
    source = Image.open(SOURCE).convert("RGB")
    w, h = 1400, 1440
    canvas = Image.new("RGB", (w, h), "#f7efe1")
    draw = ImageDraw.Draw(canvas)

    for y in range(h):
        shade = int(16 * y / h)
        draw.line((0, y, w, y), fill=(247 - shade, 239 - shade, 225 - shade))

    margin = 64
    qr_size = 142
    qr_x = w - margin - qr_size
    qr_y = 44

    draw.text((margin, 48), "战斗 Buff / Debuff 图标", font=font(58, True), fill="#2b2118")

    rounded(draw, (qr_x - 13, qr_y - 13, qr_x + qr_size + 13, qr_y + qr_size + 13), 24, "#fffdf7", "#d8c6a9", 2)
    qr = Image.open(QR).convert("RGB").resize((qr_size, qr_size), Image.Resampling.LANCZOS)
    canvas.paste(qr, (qr_x, qr_y))

    col_gap = 46
    col_w = (w - margin * 2 - col_gap) // 2
    start_y = 202
    left_h = draw_table(canvas, draw, source, margin, start_y, col_w, "增益 Buff", BUFF_ROWS, "#1d4ed8", "#eef6ff")
    right_h = draw_table(canvas, draw, source, margin + col_w + col_gap, start_y, col_w, "减益 Debuff", DEBUFF_ROWS, "#991b1b", "#fff1f2")

    draw_guide_footnote(draw, w, h, margin, font, rounded)

    canvas.save(OUT)
    print(OUT)


if __name__ == "__main__":
    main()
