from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

from guide_image_style import draw_guide_footnote


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "IHassistant" / "knowledge" / "bosses" / "void-invasion" / "Weixin Image_20260705105439_130_58.jpg"
OUT = ROOT / "flipgame" / "images" / "void-invasion-boss-guide.png"
QR = ROOT / "flipgame" / "assets" / "shinegame_pro_qr_logo_real.png"


BOSSES = [
    {
        "group": "图一",
        "pos": "上",
        "role": "嘲讽 / 反击 / 前排送死流",
        "crop": (50, 88, 203, 234),
        "ult": "全体两段伤害；高概率嘲讽；自身减伤提升2回合。",
        "basic": "全体两段伤害；中概率嘲讽。",
        "passive": "受主动攻击会全体反击；概率提升自身攻击1回合。",
        "tip": "前排送死流，基本可以抗住伤害。",
    },
    {
        "group": "图一",
        "pos": "下",
        "role": "前后排分段伤害 / 小怪加攻",
        "crop": (50, 250, 203, 394),
        "ult": "前排两段伤害。",
        "basic": "后排两段伤害。",
        "passive": "回合结束每存活1个小怪，增加全体友军一定攻击。",
        "tip": "前排送死流，基本可以抗住伤害。",
    },
    {
        "group": "图二",
        "pos": "上",
        "role": "群控 / 控制目标增伤",
        "crop": (50, 414, 203, 552),
        "ult": "全体两段伤害；中概率石化、眩晕、沉默、恐惧，持续回合待确认。",
        "basic": "全体两段伤害；小概率施加控制。",
        "passive": "大招后回复30能量；对受控目标增伤待确认。",
        "tip": "最简单的Boss，知道技能即可。",
    },
    {
        "group": "图二",
        "pos": "下",
        "role": "随机目标 / 亡语AOE",
        "crop": (50, 575, 203, 713),
        "ult": "随机4目标三段伤害。",
        "basic": "随机3目标两段伤害。",
        "passive": "亡语：对所有敌人造成伤害。",
        "tip": "最简单的Boss，知道技能即可。",
    },
    {
        "group": "图三",
        "pos": "上",
        "role": "中毒流血 / 降攻 / 高精准",
        "crop": (50, 738, 203, 871),
        "ult": "全体一段伤害；附带中毒、流血；概率降攻待确认。",
        "basic": "随机3目标一段伤害；附带中毒、流血、降暴击。",
        "passive": "对流血/中毒目标额外伤害待确认。",
        "tip": "精准属性较高。",
    },
    {
        "group": "图三",
        "pos": "下",
        "role": "中毒 / 降攻 / 高精准",
        "crop": (50, 899, 203, 1031),
        "ult": "随机4目标两段伤害；附带中毒。",
        "basic": "随机3目标两段伤害；降低攻击。",
        "passive": "暂未发现。",
        "tip": "精准属性较高。",
    },
    {
        "group": "图四",
        "pos": "上",
        "role": "低血点杀 / 反伤 / 亲意层数",
        "crop": (50, 1060, 203, 1192),
        "ult": "打当前血量最低2目标；追加已损生命伤害；偷取攻击3回合。",
        "basic": "打当前生命最低2目标；追加已损生命伤害；施加减疗。",
        "passive": "受主动攻击反伤；单位死亡回100能；主动击杀加亲意，反伤击杀不加。",
        "tip": "优先防低血单位被点杀。",
    },
    {
        "group": "图四",
        "pos": "下",
        "role": "低血点杀 / 石化",
        "crop": (50, 1220, 203, 1352),
        "ult": "当前血量最低2目标三段伤害，概率石化。",
        "basic": "当前血量最低1目标两段伤害，概率石化。",
        "passive": "暂未发现。",
        "tip": "优先保护最低血目标。",
    },
    {
        "group": "图五",
        "pos": "上",
        "role": "高额前排 / 降攻 / 治愈诅咒",
        "crop": (50, 1382, 203, 1512),
        "ult": "全体一段伤害；命中目标叠加大招释放次数相关层数待确认。",
        "basic": "前排一段高额伤害；后排攻击-30%若干回合，并施加治愈诅咒。",
        "passive": "暂未发现。",
        "tip": "75%减伤待确认。",
    },
    {
        "group": "图五",
        "pos": "下",
        "role": "治疗 / 全减伤",
        "crop": (50, 1542, 203, 1672),
        "ult": "随机3目标一段伤害；回复友军生命最低2个单位。",
        "basic": "随机3目标一段伤害；回复自身生命。",
        "passive": "亡语回复存活友军；行动后增加全体友军全减伤待确认。",
        "tip": "75%减伤待确认。",
    },
    {
        "group": "图六",
        "pos": "上",
        "role": "超高伤害 / 寒冰印记 / 不可硬抗",
        "crop": (50, 1704, 203, 1832),
        "ult": "全体超高三段伤害；降低护甲。",
        "basic": "全体超高三段伤害；当前版本不靠不屈可能硬抗不下来。",
        "passive": "受主动攻击全体反击，并概率施加寒冰印记；印记和反击均为致死伤害。",
        "tip": "抗法：闪避或极3戒指降攻；小怪伤害也很高。",
    },
    {
        "group": "图七",
        "pos": "上",
        "role": "超高AOE / 衰败诅咒 / 减疗",
        "crop": (50, 1864, 203, 1992),
        "ult": "全体三段超高伤害。",
        "basic": "全体一段超高伤害。",
        "passive": "攻击附带衰败诅咒和减疗，并降低攻击最高单位一定攻击。",
        "tip": "抗法：闪避或极3戒指降攻；小怪伤害也很高。",
    },
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
    for char in text:
        candidate = current + char
        if text_size(draw, candidate, fnt)[0] <= max_width or not current:
            current = candidate
        else:
            lines.append(current)
            current = char
    if current:
        lines.append(current)
    return lines


def draw_wrapped(draw, xy, text, fnt, fill, max_width, line_gap=5, max_lines=None):
    x, y = xy
    lines = wrap_text(draw, text, fnt, max_width)
    if max_lines is not None:
        lines = lines[:max_lines]
    line_h = text_size(draw, "国", fnt)[1] + line_gap
    for i, line in enumerate(lines):
        draw.text((x, y + i * line_h), line, font=fnt, fill=fill)
    return len(lines) * line_h


def make_thumb(source, crop, size=128):
    piece = source.crop(crop)
    piece = ImageOps.contain(piece, (size, size), method=Image.Resampling.LANCZOS)
    thumb = Image.new("RGB", (size, size), "#171044")
    x = (size - piece.width) // 2
    y = (size - piece.height) // 2
    thumb.paste(piece, (x, y))
    return thumb


def draw_label(draw, x, y, label, fill):
    fnt = font(18, True)
    tw, th = text_size(draw, label, fnt)
    rounded(draw, (x, y, x + tw + 20, y + th + 10), 13, fill)
    draw.text((x + 10, y + 4), label, font=fnt, fill="#ffffff")
    return x + tw + 28


def draw_card(canvas, draw, source, box, boss, palette):
    x1, y1, x2, y2 = box
    accent, soft = palette
    rounded(draw, box, 24, "#ffffff", "#cbd5e1", 2)
    draw.rectangle((x1, y1, x2, y1 + 54), fill=soft)
    draw.line((x1, y1 + 54, x2, y1 + 54), fill="#cbd5e1", width=2)
    nx = draw_label(draw, x1 + 18, y1 + 13, f"{boss['group']} {boss['pos']}", accent)
    draw.text((nx + 8, y1 + 14), boss["role"], font=font(23, True), fill="#1f2937")

    thumb = make_thumb(source, boss["crop"], 132)
    mask = Image.new("L", (132, 132), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((0, 0, 132, 132), 18, fill=255)
    canvas.paste(thumb, (x1 + 18, y1 + 72), mask)
    draw.rounded_rectangle((x1 + 18, y1 + 72, x1 + 150, y1 + 204), 18, outline="#94a3b8", width=2)

    tx = x1 + 168
    max_w = x2 - tx - 18
    rows = [
        ("大招", boss["ult"], "#b91c1c"),
        ("普攻", boss["basic"], "#1d4ed8"),
        ("被动", boss["passive"], "#7c3aed"),
        ("应对", boss["tip"], "#047857"),
    ]
    yy = y1 + 70
    for label, text, color in rows:
        draw.text((tx, yy), label, font=font(18, True), fill=color)
        draw_wrapped(draw, (tx + 48, yy - 1), text, font(18), "#334155", max_w - 48, line_gap=4, max_lines=2)
        yy += 43


def main():
    w = 1600
    margin = 64
    header_h = 250
    card_w = (w - margin * 2 - 26) // 2
    card_h = 228
    card_gap = 24
    row_gap = 28
    rows = 6
    footer_h = 84
    h = header_h + rows * card_h + (rows - 1) * row_gap + footer_h + 70

    canvas = Image.new("RGB", (w, h), "#edf4fb")
    draw = ImageDraw.Draw(canvas)
    for y in range(h):
        t = y / max(1, h - 1)
        draw.line((0, y, w, y), fill=blend((246, 250, 254), (226, 238, 248), t))

    source = Image.open(SOURCE).convert("RGB")

    qr_size = 166
    qr_x = w - margin - qr_size
    qr_y = 42
    rounded(draw, (qr_x - 14, qr_y - 14, qr_x + qr_size + 14, qr_y + qr_size + 14), 28, "#ffffff", "#cbd5e1", 2)
    qr = Image.open(QR).convert("RGB").resize((qr_size, qr_size), Image.Resampling.LANCZOS)
    canvas.paste(qr, (qr_x, qr_y))

    draw.text((margin, 52), "虚空入侵 Boss 技能速览", font=font(64, True), fill="#0f172a")
    draw.text((margin, 132), "图一到图七 · 大招 / 普攻 / 被动 / 应对重点", font=font(30, True), fill="#334155")
    rounded(draw, (margin, 190, qr_x - 26, 190 + 48), 18, "#ffffff", "#cbd5e1", 2)
    draw.text((margin + 22, 202), "待确认机制已直接标注；图六、图七优先按不可硬抗处理。", font=font(22), fill="#475569")

    palettes = [
        ("#b91c1c", "#fee2e2"),
        ("#be123c", "#ffe4e6"),
        ("#c2410c", "#ffedd5"),
        ("#7c3aed", "#ede9fe"),
        ("#0f766e", "#ccfbf1"),
        ("#1d4ed8", "#dbeafe"),
    ]
    start_y = header_h
    for idx, boss in enumerate(BOSSES):
        row = idx // 2
        col = idx % 2
        x1 = margin + col * (card_w + 26)
        y1 = start_y + row * (card_h + row_gap)
        draw_card(canvas, draw, source, (x1, y1, x1 + card_w, y1 + card_h), boss, palettes[row % len(palettes)])

    draw_guide_footnote(draw, w, h, margin, font, rounded, bottom=46, card_height=footer_h)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT, optimize=True)
    print(OUT)


if __name__ == "__main__":
    main()
