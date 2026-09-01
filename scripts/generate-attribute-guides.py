from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from guide_image_style import add_guide_watermark, draw_brand_footnote


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "flipgame" / "images"
QR = ROOT / "flipgame" / "assets" / "shinegame_pro_qr_logo_real.png"

THEME = {
    "bg_top": (253, 245, 226),
    "bg_bottom": (230, 241, 238),
    "ink": "#20130c",
    "red": "#c81e1e",
    "green": "#0f766e",
    "border": "#2a1b12",
    "gold": "#e1c684",
    "paper": "#fffdf7",
    "soft_green": "#eaf8f0",
    "soft_red": "#fff3eb",
    "soft_gold": "#fff7dc",
}

EXPLANATION_ROWS = [
    ("攻击", "提升英雄造成的伤害；攻击总值按先加后乘汇总。"),
    ("血量", "提升英雄基础血量；血量总值按先加后乘汇总。"),
    ("护甲", "提升英雄防御力，通过护甲减伤率降低传统伤害。"),
    ("速度", "决定出手顺序；速度高先出手；双方同速攻方先；同方同速位置靠前先。"),
    ("技能伤害率", "直接加到主动技能伤害百分比中；仅对基于攻击者自身攻击力计算的伤害有效。"),
    ("精准", "降低格挡几率；每 1% 精准额外增加 0.3% 伤害，最高 45%；只放大基于自身攻击力的伤害。"),
    ("格挡", "决定格挡几率；格挡成功减 30% 伤害；如果是暴击伤害，额外再减 20%。"),
    ("暴击", "基础暴击造成 150% 伤害。旧图记录暴击伤害 = 伤害 x (1.5 + 2 x 暴击伤害率)。"),
    ("暴击伤害值", "增加暴击伤害；旧图记录实际面板最高暴击伤害值为 150%。"),
    ("破甲", "百分比抵消目标护甲值，上限 100%；100% 破甲时，目标护甲减伤率按 0 处理。"),
    ("免控率", "免除控制的几率；免控率与控制率分别计算。"),
    ("减伤率", "降低受到的伤害，上限 75%；只对基于攻击者自身攻击力计算的伤害有效。"),
    ("神圣伤害", "额外造成无视护甲的伤害，但会被减伤率降低。"),
    ("职业伤害加成", "提高己方英雄对指定职业造成的伤害；只对基于攻击者自身攻击力计算的伤害有效。"),
    ("持续伤害减免", "减少受到的所有持续伤害。"),
    ("能量", "初始 50；普攻 +50，被击 +10，被暴击 +20；满 100 时释放主动。"),
    ("受到治疗提升", "提高自身受到的治疗效果。"),
    ("造成治疗提升", "提高自身造成的治疗效果。"),
]

FORMULA_ROWS = [
    (
        "基础伤害",
        "A攻击 x [1 - D护甲减伤 x (1 - A破甲)] + A攻击 x A神圣伤害 x 0.7",
        "A=攻击者，D=防守者；旧图口径，神圣伤害无视护甲，但仍进入后续减伤。",
    ),
    (
        "护甲减伤",
        "护甲 / (200 + 20 x (等级 - 1))",
        "当前版本是否仍完全适用，需后续实测确认。",
    ),
    (
        "普攻伤害",
        "基础伤害 x (1 - 减伤) x (1 - 格挡减伤) x (1 - 科技减伤) x (1 - 印记减伤)",
        "适用于传统伤害主链路，具体技能需按文本拆段。",
    ),
    (
        "技能伤害",
        "技能伤害 = 普攻伤害 x 技能伤害率",
        "技能伤害率直接加到主动技能百分比中。",
    ),
    (
        "持续伤害",
        "增加持续伤害 = 技能伤害率 / (持续伤害时效 + 1)",
        "旧图口径；持续伤害时效含义仍需结合技能来源确认。",
    ),
    (
        "精准 / 格挡",
        "有效格挡 = max(0, D格挡 - A精准)；精准增伤 = min(A精准 x 0.3, 45%)",
        "精准 150% 达到增伤上限；精准增伤只放大基于自身攻击力的伤害。",
    ),
    (
        "格挡减伤",
        "格挡成功：伤害 x 70%；若为暴击伤害，再额外 x 80%",
        "旧图文字口径：格挡成功减少 30%，暴击伤害额外减少 20%。",
    ),
    (
        "暴击",
        "暴击伤害 = 伤害 x (1.5 + 2 x 暴击伤害率)",
        "旧图公式；2 x 暴击伤害率是否为当前版本实际规则待确认。",
    ),
    (
        "控制",
        "被控率 = A控制率 x (1 - 有效免控率) x (1 - D科技免控率)",
        "有效免控率 = max(0, D免控率 - A抵消免控率)。",
    ),
    (
        "普通减伤",
        "有效减伤率 = max(0, D减伤率 - A抵消减伤率)",
        "进入减伤乘区时按 1 - 有效减伤率 处理；上限 75%。",
    ),
    (
        "神圣伤害",
        "神圣伤害段 = A攻击 x A神圣伤害率 x 0.7",
        "额外造成无视护甲伤害，但仍会被减伤率降低。",
    ),
    (
        "能量",
        "初始 50；普攻 +50；被击 +10；被暴击 +20；满 100 放主动",
        "旧图还记录：每溢出 1 点，按 1% 技能伤害率对主动技能加成。",
    ),
    (
        "全增伤 / 全减伤",
        "最终比例 = 原始输出 x (1 + A全增伤) x (1 - D有效全伤害减免)",
        "二者不是直接相减；抵消全伤害减免才会先降低 D 的全减伤。",
    ),
    (
        "高资质增伤",
        "巨人杀手、挑战者、猎手专注、碎舰者等按全增伤类独立乘区记录",
        "同名来源叠加或互斥仍需按游戏文本和实测修正。",
    ),
    (
        "神能压制",
        "作为最终类乘区记录；多段伤害按每段分别触发的口径处理",
        "与旧 Boss 公式神能差值的精确关系仍待确认。",
    ),
    (
        "伤害限制顺序",
        "先计算石墨限制，再计算回合增伤，最后计算攻击减伤",
        "用户补充口径；神器、列车减伤需按来源继续拆分。",
    ),
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


def wrap_text(draw, text, fnt, max_width):
    lines = []
    current = ""
    for part in text.split("\n"):
        for char in part:
            test = current + char
            if text_size(draw, test, fnt)[0] <= max_width or not current:
                current = test
            else:
                lines.append(current)
                current = char
        lines.append(current)
        current = ""
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def draw_wrapped(draw, xy, text, fnt, fill, max_width, line_gap=7):
    x, y = xy
    lines = wrap_text(draw, text, fnt, max_width)
    line_h = text_size(draw, "国", fnt)[1] + line_gap
    for i, line in enumerate(lines):
        draw.text((x, y + i * line_h), line, font=fnt, fill=fill)
    return y + len(lines) * line_h


def center_text(draw, box, text, fnt, fill):
    x1, y1, x2, y2 = box
    bbox = draw.textbbox((0, 0), text, font=fnt)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    draw.text((x1 + (x2 - x1 - w) / 2 - bbox[0], y1 + (y2 - y1 - h) / 2 - bbox[1]), text, font=fnt, fill=fill)


def draw_header(img, draw, title, range_label, summary):
    w, _ = img.size
    margin = 48
    qr_size = 132
    qr_x = w - margin - qr_size
    qr_y = 28
    rounded(draw, (qr_x - 12, qr_y - 12, qr_x + qr_size + 12, qr_y + qr_size + 12), 22, THEME["paper"], THEME["gold"], 2)
    qr = Image.open(QR).convert("RGB").resize((qr_size, qr_size), Image.Resampling.LANCZOS)
    img.paste(qr, (qr_x, qr_y))

    draw.text((margin, 44), title, font=font(52, True), fill=THEME["red"])
    summary_y = 122
    summary_right = qr_x - 26
    rounded(draw, (margin, summary_y, summary_right, summary_y + 52), 16, "#ffffff", "#e4d2ab", 2)
    draw.text((margin + 24, summary_y + 13), "范围", font=font(24, True), fill="#6f3b12")
    draw.text((margin + 106, summary_y + 6), range_label, font=font(34, True), fill=THEME["red"])
    draw.text((margin + 320, summary_y + 13), summary, font=font(22, True), fill=THEME["green"])


def new_canvas(height):
    w = 1080
    img = Image.new("RGB", (w, height), "#f7efe0")
    draw = ImageDraw.Draw(img)
    for y in range(height):
        t = y / height
        draw.line((0, y, w, y), fill=blend(THEME["bg_top"], THEME["bg_bottom"], t))
    return img, draw


def draw_explanation():
    img, draw = new_canvas(1680)
    draw_header(img, draw, "属性解释速览", "基础属性", "作用 / 结算位置 / 常见限制")

    margin = 48
    x = margin
    y = 208
    w = 1080 - margin * 2
    row_h = 70
    label_w = 172
    header_h = 56
    table_h = header_h + row_h * len(EXPLANATION_ROWS)
    rounded(draw, (x, y, x + w, y + table_h), 22, "#fff8dd", THEME["border"], 4)
    draw.rectangle((x, y, x + w, y + header_h), fill=THEME["border"])
    center_text(draw, (x, y, x + label_w, y + header_h), "属性", font(23, True), "#fff8e7")
    center_text(draw, (x + label_w, y, x + w, y + header_h), "具体解释", font(23, True), "#fff8e7")

    body_font = font(23)
    for i, (name, desc) in enumerate(EXPLANATION_ROWS):
        y1 = y + header_h + i * row_h
        y2 = y1 + row_h
        fill = THEME["soft_green"] if i % 2 == 0 else THEME["soft_red"]
        draw.rectangle((x, y1, x + w, y2), fill=fill)
        draw.line((x + label_w, y1, x + label_w, y2), fill=THEME["border"], width=2)
        draw.line((x, y2, x + w, y2), fill=THEME["border"], width=2)
        center_text(draw, (x, y1, x + label_w, y2), name, font(25, True), THEME["green"] if i % 2 == 0 else THEME["red"])
        draw_wrapped(draw, (x + label_w + 22, y1 + 13), desc, body_font, THEME["ink"], w - label_w - 44, 5)

    footer_y = y + table_h + 22
    rounded(draw, (margin, footer_y, 1080 - margin, 1680 - 36), 22, "#ffffff", "#e6d5b5", 2)
    draw.text((margin + 24, footer_y + 18), "说明", font=font(23, True), fill="#6f3b12")
    draw_wrapped(
        draw,
        (margin + 96, footer_y + 20),
        "真实伤害、惩戒伤害和特殊伤害不一定吃全部传统属性；具体技能需结合伤害类型和文本拆段判断。",
        font(21),
        THEME["ink"],
        820,
    )
    draw_brand_footnote(draw, 1080 - margin - 24, footer_y + 72, font)

    out = OUT_DIR / "attribute-explanation-guide.png"
    img = add_guide_watermark(img, font)
    img.save(out, optimize=True)
    print(out)


def draw_formula():
    img, draw = new_canvas(1840)
    draw_header(img, draw, "属性算法速览", "公式口径", "传统伤害 / 控制 / 减伤 / 最终乘区")

    margin = 48
    x = margin
    y = 208
    w = 1080 - margin * 2
    row_h = 88
    label_w = 158
    formula_w = 510
    header_h = 56
    table_h = header_h + row_h * len(FORMULA_ROWS)
    rounded(draw, (x, y, x + w, y + table_h), 22, "#fff8dd", THEME["border"], 4)
    draw.rectangle((x, y, x + w, y + header_h), fill=THEME["border"])
    center_text(draw, (x, y, x + label_w, y + header_h), "项目", font(23, True), "#fff8e7")
    center_text(draw, (x + label_w, y, x + label_w + formula_w, y + header_h), "算法 / 公式", font(23, True), "#fff8e7")
    center_text(draw, (x + label_w + formula_w, y, x + w, y + header_h), "备注", font(23, True), "#fff8e7")

    formula_font = font(20, True)
    note_font = font(19)
    for i, (name, formula_text, note) in enumerate(FORMULA_ROWS):
        y1 = y + header_h + i * row_h
        y2 = y1 + row_h
        fill = THEME["soft_green"] if i % 2 == 0 else THEME["soft_red"]
        if i in (8, 11):
            fill = THEME["soft_gold"]
        draw.rectangle((x, y1, x + w, y2), fill=fill)
        draw.line((x + label_w, y1, x + label_w, y2), fill=THEME["border"], width=2)
        draw.line((x + label_w + formula_w, y1, x + label_w + formula_w, y2), fill=THEME["border"], width=2)
        draw.line((x, y2, x + w, y2), fill=THEME["border"], width=2)
        center_text(draw, (x, y1, x + label_w, y2), name, font(23, True), THEME["red"] if i in (8, 11) else THEME["green"])
        draw_wrapped(draw, (x + label_w + 16, y1 + 11), formula_text, formula_font, THEME["ink"], formula_w - 32, 4)
        draw_wrapped(draw, (x + label_w + formula_w + 16, y1 + 11), note, note_font, "#3d3028", w - label_w - formula_w - 32, 4)

    footer_y = y + table_h + 22
    rounded(draw, (margin, footer_y, 1080 - margin, 1840 - 36), 22, "#ffffff", "#e6d5b5", 2)
    draw.text((margin + 24, footer_y + 18), "说明", font=font(23, True), fill="#6f3b12")
    draw_wrapped(
        draw,
        (margin + 96, footer_y + 20),
        "本图是攻略速览；精确结算请以技能文本、伤害类型和实战验证为准。待确认项已在知识库保留。",
        font(21),
        THEME["ink"],
        820,
    )
    draw_brand_footnote(draw, 1080 - margin - 24, footer_y + 82, font)

    out = OUT_DIR / "attribute-formula-guide.png"
    img = add_guide_watermark(img, font)
    img.save(out, optimize=True)
    print(out)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    draw_explanation()
    draw_formula()


if __name__ == "__main__":
    main()
