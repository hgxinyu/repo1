from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "flipgame" / "images" / "empower-infusion-guide.png"
QR = ROOT / "flipgame" / "assets" / "shinegame_pro_qr_logo_real.png"

ROWS = [
    ("1/4", "1", "生命值 +12%", "生命值 +18%", "战斗开始时额外提高自身 20% 全伤害减免；首次自身生命低于 80% 时该效果结束"),
    ("1/4", "2", "攻击 +8%", "攻击 +12%", "精准 +20%；每次释放普通攻击或主动技能时，自身精准额外 +10%，上限 50%"),
    ("1/4", "3", "生命值 +5%，攻击 +3%，速度 +20", "生命值 +8%，攻击 +5%，速度 +30", "生命值 +8%，攻击 +5%，速度 +80"),
    ("2", "1", "受到暴击伤害降低 15%", "降低 22%", "受到暴击伤害时，有 80% 概率额外恢复自身最大生命值 8%"),
    ("2", "2", "绝地：主动或普攻对当前生命高于自身的敌人造成伤害时，额外造成自身造成全伤害的 12%", "额外伤害提高到 18%", "当目标当前生命高于自身，且超出部分大于等于自身当前生命值 30% 时，额外造成目标最大生命值 30% 的伤害，上限为自身攻击力 3000%"),
    ("2", "3", "受到治疗效果提高 15%", "受疗效果 +15%", "自身受到治疗时，为当前生命最低的 1 名友方提供等同自身攻击力 800% 的护盾"),
    ("3", "1", "回合结束时，恢复自身已损失生命值 15%", "恢复 22% 已损失生命值", "额外恢复自身最大生命值 10%"),
    ("3", "2", "回合结束时，自身攻击提高，数值为存活英雄数量 x 1.2%，持续 1 回合", "攻击提高改为 1.8%", "回合结束时，对全体敌人造成 存活英雄数量 x 50% 攻击伤害"),
    ("3", "3", "回合结束时，100% 移除自身 1 个随机额外效果，包括印记、控制、持续伤害、属性降低", "回合结束时，有 25% 概率移除自身 1 个随机额外效果", "概率提高到 50%"),
    ("5", "1", "均衡：如果普通攻击或主动技能暴击，恢复自身造成伤害 15% 的生命；否则额外造成 30% 伤害", "暴击时恢复提高到 22%；否则额外伤害提高到 45%", "未暴击且目标生命低于 50% 时，额外伤害提高 150%；暴击时额外提高自身 12% 减伤率，持续 2 回合"),
    ("5", "2", "受到致命伤害时，免疫直接伤害和持续伤害 4 次；不免疫印记伤害", "最多免疫 6 次伤害", "每场战斗首次生命低于 20% 时，提高自身 30% 全伤害减免 2 回合；首次生命低于 10% 时，获得自身最大生命值 30% 的护盾"),
    ("5", "3", "压制：普通攻击或主动技能命中目标时，对生命低于自身的目标额外造成 1300% 攻击伤害", "同基础方向", "普通攻击或主动技能对生命低于 50% 的敌人造成伤害时，额外造成其已损失生命值 10% 的伤害，上限 1500% 攻击"),
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
    return len(lines) * line_h


def center_text(draw, box, text, fnt, fill):
    x1, y1, x2, y2 = box
    bbox = draw.textbbox((0, 0), text, font=fnt)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    draw.text((x1 + (x2 - x1 - w) / 2 - bbox[0], y1 + (y2 - y1 - h) / 2 - bbox[1]), text, font=fnt, fill=fill)


def row_height(draw, row, widths, body_font):
    _, _, base, lv1, lv2 = row
    max_lines = max(
        len(wrap_text(draw, base, body_font, widths[2] - 24)),
        len(wrap_text(draw, lv1, body_font, widths[3] - 24)),
        len(wrap_text(draw, lv2, body_font, widths[4] - 24)),
    )
    return max(76, 24 + max_lines * (text_size(draw, "国", body_font)[1] + 5))


def main():
    w = 1080
    margin = 48
    table_w = w - margin * 2
    widths = [86, 64, 262, 208, table_w - 86 - 64 - 262 - 208]
    body_font = font(19)

    probe = Image.new("RGB", (w, 10), "white")
    probe_draw = ImageDraw.Draw(probe)
    row_heights = [row_height(probe_draw, row, widths, body_font) for row in ROWS]
    table_h = 56 + sum(row_heights)
    footer_h = 170
    h = 208 + table_h + 22 + footer_h + 36

    img = Image.new("RGB", (w, h), "#f7efe0")
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / h
        draw.line((0, y, w, y), fill=blend((253, 245, 226), (230, 241, 238), t))

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

    draw.text((margin, 44), "赋能灌注速览", font=font(52, True), fill=red)
    summary_y = 122
    summary_right = qr_x - 26
    rounded(draw, (margin, summary_y, summary_right, summary_y + 52), 16, "#ffffff", "#e4d2ab", 2)
    draw.text((margin + 24, summary_y + 13), "规则", font=font(24, True), fill="#6f3b12")
    draw.text((margin + 106, summary_y + 6), "赋能位 3 选 1", font=font(34, True), fill=red)
    draw.text((margin + 374, summary_y + 13), "基础效果 / Lv1 / Lv2 中文整理", font=font(22, True), fill=green)

    x = margin
    y = 208
    xs = [x]
    for width in widths:
        xs.append(xs[-1] + width)

    rounded(draw, (x, y, x + table_w, y + table_h), 22, "#fff8dd", border, 4)
    draw.rectangle((x, y, x + table_w, y + 56), fill=border)
    headers = ["赋能位", "选项", "基础效果", "Lv1", "Lv2"]
    for i, header in enumerate(headers):
        center_text(draw, (xs[i], y, xs[i + 1], y + 56), header, font(23, True), "#fff8e7")

    cursor = y + 56
    last_slot = None
    for i, (row, rh) in enumerate(zip(ROWS, row_heights)):
        slot, col, base, lv1, lv2 = row
        fill = "#eaf8f0" if i % 2 == 0 else "#fff3eb"
        if slot != last_slot:
            fill = "#fff7dc"
            last_slot = slot
        y1 = cursor
        y2 = y1 + rh
        draw.rectangle((x, y1, x + table_w, y2), fill=fill)
        for line_x in xs:
            draw.line((line_x, y1, line_x, y2), fill=border, width=2)
        draw.line((x, y2, x + table_w, y2), fill=border, width=2)
        center_text(draw, (xs[0], y1, xs[1], y2), slot, font(23, True), red if slot in {"1/4", "5"} else green)
        center_text(draw, (xs[1], y1, xs[2], y2), col, font(23, True), ink)
        draw_wrapped(draw, (xs[2] + 12, y1 + 12), base, body_font, ink, widths[2] - 24)
        draw_wrapped(draw, (xs[3] + 12, y1 + 12), lv1, body_font, ink, widths[3] - 24)
        draw_wrapped(draw, (xs[4] + 12, y1 + 12), lv2, body_font, ink, widths[4] - 24)
        cursor = y2

    footer_y = y + table_h + 22
    rounded(draw, (margin, footer_y, w - margin, h - 36), 22, "#ffffff", "#e6d5b5", 2)
    draw.text((margin + 24, footer_y + 18), "说明", font=font(23, True), fill="#6f3b12")
    draw_wrapped(draw, (margin + 96, footer_y + 18), "每个赋能位从 3 个选项中选 1 个；赋能 1 和 4 使用同一组选项。", font(21), ink, 840)
    draw_wrapped(draw, (margin + 96, footer_y + 54), "所有魔典灌注 Lv3：生命值 +5.5%，攻击 +4%。", font(21, True), red, 840)
    draw_wrapped(draw, (margin + 96, footer_y + 92), "E1 前置：魔典等级 50，需 2,042,800 魔典精华 + 1 个赋能灌注石。", font(20), ink, 840)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, optimize=True)
    print(OUT)


if __name__ == "__main__":
    main()
