from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "flipgame" / "images" / "imprint-branch-guide.png"
QR = ROOT / "flipgame" / "assets" / "shinegame_pro_qr_logo_real.png"


SECTIONS = [
    {
        "name": "利刃",
        "role": "输出向：主 C、追伤、破防、低血压制",
        "accent": "#dc2626",
        "soft": "#fff1f2",
        "items": [
            {
                "line": "分支1 左线",
                "name": "暴击率 / 主动追伤",
                "stats": "沿途：暴击 +3.3%/点",
                "core": "伤害后自身暴击 +8% 2回合；每累计暴击2次，下次主动追加3000%攻，且无视护甲、减伤、全减、格挡、闪避、暴伤减免。",
                "fit": "暴击主C、主动爆发",
            },
            {
                "line": "分支1 右线",
                "name": "暴击伤害 / 降暴伤减免",
                "stats": "沿途：暴击伤害 +9.5%/点",
                "core": "回合开始若自身暴击 >=50%，暴击伤害 +15% 1回合；造成暴击时目标暴伤减免 -10% 3回合。",
                "fit": "高暴击率输出",
            },
            {
                "line": "分支2 左线",
                "name": "神圣伤害 / 圣甲标记",
                "stats": "沿途：神圣伤害 +7.5%/点",
                "core": "攻击护甲高于自身的目标追加1000%攻神圣伤害并叠圣甲；3层后追加2500%攻神圣惩戒。",
                "fit": "打高护甲目标",
            },
            {
                "line": "分支2 右线",
                "name": "精准 / 攻击增长",
                "stats": "沿途：精准 +6.6%/点",
                "core": "普攻/主动分别叠攻击 +4%/+6%，最高12%；终点为暴击 -50%、攻击 +50%。",
                "fit": "高攻PVE，需重算暴击",
            },
            {
                "line": "分支3 左线",
                "name": "全伤 / 尖刺护甲",
                "stats": "沿途：全伤 +3.3%/点",
                "core": "普攻获得尖刺护甲，最多4层；主动在满层时清空，每层使自身全伤 +3%，尖刺护甲不会被清除。",
                "fit": "普攻循环、持续输出",
            },
            {
                "line": "分支3 右线",
                "name": "抵消减伤 / 降目标减伤",
                "stats": "沿途：抵消减伤 +2%/点",
                "core": "普攻/主动使自身抵消减伤 +3%，最高9%；目标血量低于50%时额外使其减伤 -15% 2回合。",
                "fit": "收割、压低血线",
            },
        ],
    },
    {
        "name": "强壁",
        "role": "生存向：承伤、护盾、免控、治疗联动",
        "accent": "#15803d",
        "soft": "#f0fdf4",
        "items": [
            {
                "line": "分支1 左线",
                "name": "护甲 / 护甲反击",
                "stats": "沿途：护甲 +12%/点",
                "core": "受伤时护甲 +10% 2回合；若攻击者护甲低于自身，80%反击，造成目标最大生命10%伤害，上限攻击者1500%攻。",
                "fit": "高护甲前排",
            },
            {
                "line": "分支1 右线",
                "name": "闪避 / 格挡 / 护盾",
                "stats": "沿途：闪避 +2.5%、格挡 +7.5%",
                "core": "累计格挡3次提高前排格挡 +10%；自身格挡成功时，最低血队友格挡 +10% 并获得1500%攻护盾。",
                "fit": "格挡前排、保护队友",
            },
            {
                "line": "分支2 左线",
                "name": "免控 / 解控",
                "stats": "沿途：免控 +3.5%/点",
                "core": "战斗开始免控 +15% 1回合；受控时免控 +10% 2回合，并有50%概率立刻解除1种随机控制。",
                "fit": "怕控制的核心位",
            },
            {
                "line": "分支2 右线",
                "name": "减伤 / 暴伤减免",
                "stats": "沿途：减伤 +3.3%、暴伤减免 +3.3%",
                "core": "受到暴击伤害时暴伤减免 +8% 2回合；生命低于30%时减伤 +15% 2回合。",
                "fit": "抗爆发承伤",
            },
            {
                "line": "分支3 左线",
                "name": "全伤害减免 / 护盾",
                "stats": "沿途：全伤害减免 +2.5%/点",
                "core": "回合结束若生命低于50%，获得10%最大生命护盾；回合开始若护盾大于生命30%，全伤害减免 +10% 2回合。",
                "fit": "低血续航、防秒",
            },
            {
                "line": "分支3 右线",
                "name": "受治疗 / 治疗转护盾",
                "stats": "沿途：受到治疗效果 +6.6%/点",
                "core": "自身受治疗时，最低血队友获得10%已损生命护盾；生命低于30%时立刻回复30%最大生命，每场限1次。",
                "fit": "治疗队、保护低血队友",
            },
        ],
    },
    {
        "name": "精神",
        "role": "功能向：速度、控制抗性、偷属性、清负面、能量干扰",
        "accent": "#2563eb",
        "soft": "#eff6ff",
        "items": [
            {
                "line": "分支1 左线",
                "name": "抵消免控 / 降免控",
                "stats": "沿途：抵消免控 +2.5%/点",
                "core": "战斗开始抵消免控 +10% 2回合；回合开始对低速敌人60%使免控 -10% 1回合。",
                "fit": "控制队、先手控制",
            },
            {
                "line": "分支1 右线",
                "name": "速度 / 速度压制伤害",
                "stats": "沿途：速度 +20/点",
                "core": "战斗开始速度 +50 1回合；普攻/主动命中低速目标时，80%额外造成伤害量10%的伤害。",
                "fit": "抢先手、速度压制",
            },
            {
                "line": "分支2 左线",
                "name": "偷攻击 / 低攻额外伤害",
                "stats": "沿途：攻击 +1%、生命 +1.5%",
                "core": "主动后偷最高攻敌人10%攻击2回合；攻击低于自身的敌人时追加其最大生命10%伤害，上限1500%攻。",
                "fit": "攻击压制、打低攻目标",
            },
            {
                "line": "分支2 右线",
                "name": "降护甲 / 偷护甲",
                "stats": "沿途：攻击 +1%、生命 +1.5%",
                "core": "普攻使目标护甲 -10% 3回合；主动偷护甲最高敌人15%护甲3回合。",
                "fit": "削甲、对高护甲敌人",
            },
            {
                "line": "分支3 左线",
                "name": "清负面",
                "stats": "沿途：攻击 +1%、生命 +1.5%",
                "core": "主动时70%清自身1种负面；回合结束时60%清自身1种负面。",
                "fit": "怕DOT/减益的核心",
            },
            {
                "line": "分支3 右线",
                "name": "高洁 / 魔能爆发",
                "stats": "沿途：攻击 +1%、生命 +1.5%",
                "core": "主动获得高洁，最多4层；普攻时每层60%回7能；主动60%给最高能量敌人魔能爆发：目标每1点能量受10%攻伤害，并清空能量。",
                "fit": "能量循环、控能",
            },
        ],
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


def center_text(draw, box, text, fnt, fill):
    x1, y1, x2, y2 = box
    bbox = draw.textbbox((0, 0), text, font=fnt)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    draw.text((x1 + (x2 - x1 - w) / 2 - bbox[0], y1 + (y2 - y1 - h) / 2 - bbox[1]), text, font=fnt, fill=fill)


def draw_pill(draw, x, y, text, fill, fnt, pad_x=14, pad_y=6):
    tw, th = text_size(draw, text, fnt)
    rounded(draw, (x, y, x + tw + pad_x * 2, y + th + pad_y * 2), 14, fill)
    draw.text((x + pad_x, y + pad_y - 1), text, font=fnt, fill="#ffffff")
    return x + tw + pad_x * 2


def draw_line_card(draw, box, item, accent, soft):
    x1, y1, x2, y2 = box
    rounded(draw, box, 22, "#ffffff", "#d9e2ec", 2)
    draw.rectangle((x1, y1, x2, y1 + 54), fill=soft)
    draw.line((x1, y1 + 54, x2, y1 + 54), fill="#d9e2ec", width=2)
    draw_pill(draw, x1 + 18, y1 + 13, item["line"], accent, font(18, True), 11, 4)
    draw.text((x1 + 150, y1 + 15), item["name"], font=font(25, True), fill="#1f2937")
    draw.text((x1 + 20, y1 + 72), item["stats"], font=font(20, True), fill=accent)
    draw_wrapped(draw, (x1 + 20, y1 + 108), "核心：" + item["core"], font(19), "#273142", x2 - x1 - 40, line_gap=5, max_lines=4)
    draw.text((x1 + 20, y2 - 34), "适合：" + item["fit"], font=font(19, True), fill="#475569")


def main():
    w = 1600
    margin = 70
    section_gap = 42
    header_h = 245
    section_h = 760
    footer_h = 72
    h = header_h + len(SECTIONS) * section_h + (len(SECTIONS) - 1) * section_gap + footer_h + 60
    img = Image.new("RGB", (w, h), "#f8fafc")
    draw = ImageDraw.Draw(img)

    top = (245, 248, 252)
    bottom = (232, 241, 247)
    for y in range(h):
        t = y / max(1, h - 1)
        draw.line((0, y, w, y), fill=blend(top, bottom, t))

    qr_size = 164
    qr_x = w - margin - qr_size
    qr_y = 50
    rounded(draw, (qr_x - 14, qr_y - 14, qr_x + qr_size + 14, qr_y + qr_size + 14), 26, "#ffffff", "#cbd5e1", 2)
    qr = Image.open(QR).convert("RGB").resize((qr_size, qr_size), Image.Resampling.LANCZOS)
    img.paste(qr, (qr_x, qr_y))

    draw.text((margin, 58), "印痕灌注分支选择攻略", font=font(62, True), fill="#0f172a")
    draw.text((margin, 136), "利刃 / 强壁 / 精神 · 3 大类 × 3 分支 × 2 条线", font=font(31, True), fill="#334155")
    y = header_h
    card_gap = 18
    card_w = (w - margin * 2 - card_gap) // 2
    card_h = 190
    for section in SECTIONS:
        accent = section["accent"]
        soft = section["soft"]
        rounded(draw, (margin, y, w - margin, y + section_h), 30, "#ffffff", "#cbd5e1", 2)
        draw.rectangle((margin, y, w - margin, y + 84), fill=accent)
        draw.text((margin + 30, y + 20), section["name"], font=font(42, True), fill="#ffffff")
        draw.text((margin + 170, y + 29), section["role"], font=font(27, True), fill="#f8fafc")

        grid_y = y + 112
        for idx, item in enumerate(section["items"]):
            col = idx % 2
            row = idx // 2
            x1 = margin + 24 + col * (card_w + card_gap)
            y1 = grid_y + row * (card_h + 20)
            draw_line_card(draw, (x1, y1, x1 + card_w, y1 + card_h), item, accent, soft)

        y += section_h + section_gap

    footer_y = h - footer_h - 42
    rounded(draw, (margin, footer_y, w - margin, h - 54), 24, "#ffffff", "#cbd5e1", 2)
    draw.text((w - margin - 360, footer_y + 24), "ShineGame · Idle Heroes Guide", font=font(21, True), fill="#64748b")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, optimize=True)
    print(OUT)


if __name__ == "__main__":
    main()
