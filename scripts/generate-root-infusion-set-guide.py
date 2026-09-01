from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from guide_image_style import add_guide_watermark, draw_brand_footnote

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "flipgame" / "images" / "root-infusion-set-guide.png"
QR = ROOT / "flipgame" / "assets" / "shinegame_pro_qr_logo_real.png"

SECTIONS = [
    {
        "name": "摧甲之唤醒",
        "tag": "破甲 / 撕裂 / BOSS输出",
        "accent": "#f26a44",
        "slot": "插槽 Lv1->7：攻击 +1%->7% · 全伤 +1%->4%",
        "items": [
            ("1件", "普攻命中：+1400->2000%攻 + 目标最大HP 8%->20%，上限900->1500%攻；基石：目标有护盾时再+400->1000%攻。"),
            ("2件", "命中生命>70%目标：+1900->2500%攻，无视减伤8%->20%；基石：目标减伤-8%->20%、格挡-18%->30%。"),
            ("3件", "撕裂DOT每层400->1000%攻，最多6层；基石：撕裂上限提高到12层。"),
            ("5件", "清1->5个随机减益，技能伤害+200%->500% 2回合；基石：对Boss额外伤害+12%->30%。"),
        ],
    },
    {
        "name": "神行之唤醒",
        "tag": "先手 / 收割 / 残血压制",
        "accent": "#58a9f7",
        "slot": "插槽 Lv1->7：攻击 +1%->6% · 速度 +3->15",
        "items": [
            ("1件", "回合开始：每个HP<50%敌人使自身速度+9->15、暴伤+4%->10% 1回合；基石：HP<50%敌人伤害-8%->20%、速度-20->50。"),
            ("2件", "主动/普攻命中HP<50%目标：+1800->3000%攻；基石：每命中1个低速目标，下轮自身全伤+4%->10%。"),
            ("3件", "敌方死亡：回40->70能并进入无影2回合，闪避主动/普攻20%->35%；基石：无影中命中时按目标已损HP18%->30%追加，上限1800->3000%攻。"),
            ("5件", "每回合若自己第一个普攻/主动：主目标+1700->3500%攻，HP<50%目标同额外伤；基石：HP<30%目标再+1700->3500%攻，命中后进无影2回合。"),
        ],
    },
    {
        "name": "不动之唤醒",
        "tag": "护盾 / 嘲讽 / 团队减伤",
        "accent": "#6fd389",
        "slot": "插槽 Lv1->7：最大HP +1%->7% · 全减伤 +1%->4%",
        "items": [
            ("1件", "每轮开始50%->80%概率获得8%->20%最大HP护盾；基石：回合开始若自身有护盾，控免+8%->20% 1回合。"),
            ("2件", "自身生命越低，全伤害减免越高，最高18%->30%；基石：首次跌破80/50/30%时全队全减伤+8%->20% 2回合。"),
            ("3件", "被普攻/主动命中60%->90%概率反弹13%->25%攻击者最大HP，伤害上限1500%自身攻击，并嘲讽2回合；基石：目标攻击-10%->25%、能量-8->20。"),
            ("5件", "首次低于30%血：得20%->50%HP护盾、清控、不可毁灭2回合、全伤+8%->20%；基石：不可毁灭中控免+40%->100%，若护盾被打破则群嘲1回合并全敌攻击-10%->40%。"),
        ],
    },
    {
        "name": "苏生之唤醒",
        "tag": "回能 / 治疗 / 保护",
        "accent": "#ffc34d",
        "slot": "插槽 Lv1->7：伤害减免 +1%->6% · 速度 +3->9",
        "items": [
            ("1件", "普攻/主动命中：最高速队友+8->20能，最低血队友回8%->20%已损HP；基石前提：最高速队友能量>100，才使自身+13->25能、治疗效果+40%->70% 2回合。"),
            ("2件", "友军血量首次低于80/50/30%：全减伤+8%->20%，回8%->20%最大HP；基石：每回合开始最低血队友回12%->25%最大HP。"),
            ("3件", "主动给全队春雨印记5/6/7回合（Lv4为7），每层回400%->1000%攻；基石：春雨叠3层后每回合额外+5->35能。"),
            ("5件", "友军首次低于60%血：给春雨祝福2回合，单次承伤上限40%->20%自身HP；基石：施加祝福时目标控免+12%->30%。"),
        ],
    },
    {
        "name": "熔炉之唤醒",
        "tag": "控制 / 沉默 / 削能",
        "accent": "#c270f7",
        "slot": "插槽 Lv1->7：控免抵消 +1%->6% · 速度 +3->12",
        "items": [
            ("1件", "普攻/主动命中受控目标：+1300->2500%攻；基石：对受控目标成功造成伤害时，60%->100%概率削10->30能。"),
            ("2件", "主动命中40%->70%概率沉默2回合；基石：主动后50%->80%概率使目标控制效果持续时间+1回合。"),
            ("3件", "敌人普攻时40%->70%概率削13->25能，叠贤者镣铐并控免-8%->20%；基石：镣铐2层后清空目标能量，40%->100%概率石化2回合。"),
            ("5件", "自身累计主动2次后打最高攻敌2200->4000%攻，40%->70%削40->100能；基石：额外50%->80%概率施加光之封印2回合。"),
        ],
    },
    {
        "name": "调和之唤醒",
        "tag": "驱散 / 转移 / 团队增益",
        "accent": "#57cfc8",
        "slot": "插槽 Lv1->7：最大生命 +0.5%->5% · 控免 +1%->6%",
        "items": [
            ("1件", "主动命中：50%->80%移除目标1个随机属性增益，并50%->80%偷最高攻敌4%->10%攻击2回合；基石：偷攻提升到8%->20%。"),
            ("2件", "普攻命中：50%->80%复制1个随机DoT/属性降低到另一随机敌人；基石：改为复制3个到另外2名敌人。"),
            ("3件", "主动命中后给最高攻盟友和谐意图2回合：攻击+13%->25%、控精+8%->20%；已有意图则回45->75能；基石：意图加全伤+13%->25%，并额外给HP最低盟友。"),
            ("5件", "盟友释放主动叠1层亲和，8层清空：移除最高攻敌所有属性增益，并全敌攻击/减伤-13%->25% 2回合；基石：全队全伤+13%->25%、减伤+13%->25%。"),
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
    tokens = []
    current = ""
    for char in text:
        if char.isascii() and not char.isspace():
            current += char
            continue
        if current:
            tokens.append(current)
            current = ""
        tokens.append(char)
    if current:
        tokens.append(current)

    lines = []
    current = ""
    for token in tokens:
        if not current and token.isspace():
            continue
        test = current + token
        if text_size(draw, test, fnt)[0] <= max_width or not current:
            current = test
        else:
            lines.append(current)
            current = token
    if current:
        lines.append(current)
    return lines


def draw_wrapped(draw, xy, text, fnt, fill, max_width, line_gap=6):
    x, y = xy
    lines = wrap_text(draw, text, fnt, max_width)
    line_h = text_size(draw, "国", fnt)[1] + line_gap
    for i, line in enumerate(lines):
        draw.text((x, y + i * line_h), line, font=fnt, fill=fill)
    return y + line_h * len(lines)


def draw_pill(draw, x, y, text, fill, text_size_px=22):
    fnt = font(text_size_px, True)
    tw, th = text_size(draw, text, fnt)
    rounded(draw, (x, y, x + tw + 28, y + 38), 14, fill)
    draw.text((x + 14, y + (38 - th) / 2 - 2), text, font=fnt, fill="#ffffff")


def draw_light_brand(draw, right, y):
    draw_brand_footnote(draw, right, y, font, size=22)


def draw_section(draw, section, x, y, w, h):
    accent = section["accent"]
    ink = "#243044"
    muted = "#586476"
    rounded(draw, (x, y, x + w, y + h), 28, "#f8fafc", "#d8e0ea", 2)
    rounded(draw, (x, y, x + w, y + 72), 24, accent)
    draw.rectangle((x, y + 48, x + w, y + 74), fill=accent)
    draw.text((x + 30, y + 18), section["name"], font=font(32, True), fill="#ffffff")

    content_y = y + 96
    draw_pill(draw, x + 28, content_y, section["tag"], accent, 22)
    content_y += 52
    draw.text((x + 30, content_y), section["slot"], font=font(23, True), fill=ink)
    content_y += 42
    draw.line((x + 30, content_y, x + w - 30, content_y), fill="#d5dee8", width=2)
    content_y += 18

    label_w = 62
    for label, text in section["items"]:
        draw_pill(draw, x + 30, content_y + 1, label, accent, 22)
        text_x = x + 30 + label_w + 18
        content_y = draw_wrapped(draw, (text_x, content_y), text, font(24), muted, w - 30 - label_w - 54, line_gap=7)
        content_y += 14


def main():
    width, height = 1800, 2360
    img = Image.new("RGB", (width, height), "#111827")
    draw = ImageDraw.Draw(img)
    for y in range(height):
        t = y / height
        draw.line((0, y, width, y), fill=blend((16, 24, 39), (45, 35, 51), t))

    margin = 72
    qr_size = 150
    qr_x = margin
    qr_y = 34
    rounded(draw, (qr_x - 18, qr_y - 18, qr_x + qr_size + 18, qr_y + qr_size + 18), 30, "#ffffff")
    qr = Image.open(QR).convert("RGB").resize((qr_size, qr_size), Image.Resampling.LANCZOS)
    img.paste(qr, (qr_x, qr_y))

    title_x = qr_x + qr_size + 70
    draw.text((title_x, 44), "根源灌注套装效果速览", font=font(58, True), fill="#f8fafc")
    draw.text((title_x, 116), "六种唤醒套装 · Lv1->Lv7 区间速览 · 关键触发条件已展开", font=font(28), fill="#cbd5e1")
    rounded(draw, (title_x, 168, title_x + 840, 218), 16, "#101827", "#d6dee8", 2)
    draw.text((title_x + 24, 181), "提示：基石 = 活性基石效应；箭头表示 Lv1 到 Lv7 的数值变化。", font=font(23), fill="#dbe4ee")

    grid_x = margin
    grid_y = 282
    gap_x = 28
    gap_y = 26
    card_w = (width - margin * 2 - gap_x) // 2
    card_h = 646
    for index, section in enumerate(SECTIONS):
        row = index // 2
        col = index % 2
        x = grid_x + col * (card_w + gap_x)
        y = grid_y + row * (card_h + gap_y)
        draw_section(draw, section, x, y, card_w, card_h)

    draw_light_brand(draw, width - margin, height - 50)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img = add_guide_watermark(img, font)
    img.save(OUT, optimize=True)
    print(OUT)


if __name__ == "__main__":
    main()
