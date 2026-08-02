#!/usr/bin/env python3
"""Build English variants of every generated guide image.

The Chinese generators remain the source of truth for values and layout. This
script translates their string literals, executes the translated AST in memory,
and redirects only final guide-image saves to ``*-en`` siblings.

Translations are cached in ``guide-image-en-translations.json`` so normal
regeneration is deterministic and does not require network access. Pass
``--refresh-translations`` only when Chinese copy has changed.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = ROOT / "scripts"
IMAGE_DIR = ROOT / "flipgame" / "images"
CACHE = SCRIPT_DIR / "guide-image-en-translations.json"

GENERATORS = sorted(SCRIPT_DIR.glob("generate-*-guide.py")) + [
    SCRIPT_DIR / "generate-attribute-guides.py"
]

OUTPUT_NAMES = {
    "attribute-explanation-guide.png",
    "attribute-formula-guide.png",
    "awakening-rate-guide.png",
    "battle-buff-debuff-icons-guide.png",
    "breakdown-soulpower-guide.png",
    "destiny-temple-guide.png",
    "destiny-upgrade-guide.png",
    "empower-infusion-guide.png",
    "fund-material-value-guide.png",
    "grimoire-upgrade-guide.png",
    "imprint-branch-guide.png",
    "imprint-infusion-guide.png",
    "merge-requirements-guide.png",
    "root-infusion-set-guide.png",
    "root-level-guide.png",
    "se-boss-hp-guide.png",
    "starsoul-upgrade-guide.png",
    "void-invasion-boss-guide.png",
}

# Longest entries are substituted first. Placeholders keep official game terms
# out of machine translation, then restore the canonical English vocabulary.
GLOSSARY = {
    "抵消全伤害减免": "All-Damage Reduction Offset",
    "全伤害减免": "All-Damage Reduction",
    "抵消控制免疫": "Control Immunity Offset",
    "抵消免控": "Control Immunity Offset",
    "抵消减伤": "Damage Reduction Offset",
    "暴击伤害减免": "Crit Damage Reduction",
    "暴伤减免": "Crit Damage Reduction",
    "散落的灵脉碎片": "Scattered Spiritvein Shards",
    "灵脉碎片": "Spiritvein Shards",
    "意识精华": "Spiritual Essence",
    "时空结晶": "Crystals of Transcendence",
    "星辰碎片": "Stellar Shards",
    "星碎": "Stellar",
    "光玉碎块": "Aurora Gem Shards",
    "神玉": "Aurora Gems",
    "光玉": "Aurora Gems",
    "时晶": "Crystals of Transcendence",
    "灵碎": "Scattered Spiritvein Shards",
    "根源灌注": "Origin Infusion",
    "印痕灌注": "Imprint Infusion",
    "赋能灌注": "Enabling Infusion",
    "魔典印痕精华": "Grimoire Imprint Essence",
    "魔典精华": "Grimoire Essence",
    "赋能魔典": "Enabling Grimoire",
    "印痕魔典": "Imprint Grimoire",
    "飞升殿堂": "Destiny Temple",
    "飞升等级": "Destiny Level",
    "飞升": "Destiny",
    "神能加成": "Divine Power Bonus",
    "神能等级": "Divine Power Level",
    "神能": "Divine Power",
    "根源等级": "Origin Level",
    "根源": "Origin",
    "印痕": "Imprints",
    "星魂精髓": "Star Soul Essence",
    "星魂碎片": "Star Soul Shards",
    "星魂本体": "Star Soul Core",
    "星魂": "Star Soul",
    "命轨": "Destiny Trail",
    "全伤": "All Damage",
    "全减伤": "All-Damage Reduction",
    "减伤率": "Damage Reduction",
    "减伤": "Damage Reduction",
    "控制免疫": "Control Immunity",
    "免控率": "Control Immunity",
    "免控": "Control Immunity",
    "控免": "Control Immunity",
    "控制精准": "Control Precision",
    "控精": "Control Precision",
    "精准": "Precision",
    "格挡": "Block",
    "破甲": "Armor Break",
    "护甲": "Armor",
    "暴击伤害": "Crit Damage",
    "暴伤": "Crit Damage",
    "暴击": "Crit",
    "神圣伤害": "Holy Damage",
    "技能伤害": "Skill Damage",
    "持续伤害": "Damage over Time",
    "普攻": "basic attack",
    "主动技能": "active skill",
    "主动": "active skill",
    "大招": "active skill",
    "被动": "passive",
    "应对": "counterplay",
    "待确认": "unverified",
    "生命值": "HP",
    "生命": "HP",
    "血量": "HP",
    "攻击力": "Attack",
    "攻击": "Attack",
    "速度": "Speed",
    "能量": "Energy",
    "回合": "round",
    "资质": "Awakening Tier",
    "魂力": "Soul Power",
    "觉醒": "Awakening",
}

EXACT = {
    "图一": "Image 1",
    "图二": "Image 2",
    "图三": "Image 3",
    "图四": "Image 4",
    "图五": "Image 5",
    "图六": "Image 6",
    "图七": "Image 7",
    "上": "Top",
    "下": "Bottom",
    "飞": "D",
    "神": "DP",
    "国": "M",
    "S及以上": "S and above",
    "万亿": "trillion",
    " 万亿": " trillion",
    " 需 ": ": ",
    "摧甲之唤醒": "Armorbreak Awakening",
    "神行之唤醒": "Swift Awakening",
    "不动之唤醒": "Steadfast Awakening",
    "苏生之唤醒": "Revival Awakening",
    "熔炉之唤醒": "Furnace Awakening",
    "调和之唤醒": "Harmony Awakening",
    "利刃": "Blade",
    "强壁": "Wall",
    "精神": "Spirit",
    "属性解释速览": "Attribute Guide",
    "属性算法速览": "Attribute Formulas",
    "印痕灌注分支选择攻略": "Imprint Infusion Branches",
    "利刃 / 强壁 / 精神 · 3 大类 × 3 分支 × 2 条线": "Blade / Wall / Spirit · 18 options",
    "根源灌注套装效果速览": "Origin Infusion Sets",
    "六种唤醒套装 · Lv1->Lv7 区间速览 · 关键触发条件已展开": "Six awakening sets · Lv1-Lv7 effects and triggers",
    "持续伤害减免": "DoT Reduction",
    "职业伤害加成": "Class Damage",
    "受到治疗提升": "Healing Received",
    "造成治疗提升": "Healing Done",
    "普通减伤": "Damage Reduction",
    "全增伤 / 全减伤": "All-Dmg Up / Reduction",
    "高资质增伤": "Awakened Tier Dmg",
    "神能压制": "Divine Power",
    "伤害限制顺序": "Damage Cap Order",
    "护甲减伤": "Armor DR",
    "格挡减伤": "Block DR",
    "普攻伤害": "Basic Attack",
    "持续伤害": "DoT Damage",
    "Chapter 1：赋能魔典": "Chapter 1 · Enabling Grimoire",
    "Chapter 2：印痕魔典": "Chapter 2 · Imprint Grimoire",
    "项目": "Item",
    "范围": "Range",
    "等级范围": "Level Range",
    "公式": "Formula",
    "公式口径": "Formula Notes",
    "算法 / 公式": "Algorithm / Formula",
    "说明": "Notes",
    "概率": "Rate",
    "彩章血量积分": "Octopus Boss HP Score",
    "彩章血量积分表": "Octopus Boss HP Score Table",
    "层": "Level",
    "总积分": "Total Score",
    "1%血量": "1% HP",
    "基础效果": "Base Effect",
    "基础效果 / Lv1 / Lv2 中文整理": "Base Effect / Lv1 / Lv2",
    "单次期望分": "Expected Score",
    "觉醒品质": "Awakening Tier",
    "积分详情": "Points",
    "积分期望": "Expected Points",
    "累计意识": "Spiritual Essence",
    "源初": "Origin",
    "进发": "Advance",
    "混沌": "Chaos",
    "凝核": "Core",
    "聚星": "Polystar",
    "超脱": "Nirvana",
    "飞1 - 飞6": "Destiny 1 - 6",
    "殿堂 1 - 30": "Temple 1 - 30",
    "要求(飞)": "Required D",
    "展示(神)": "Display DP",
    "前置星碎": "Stellar Req.",
    "前置意识": "Essence Req.",
    "前置星碎 / 前置意识是升级门槛；神玉、时晶、灵碎、星碎为当前殿堂升满累计资源。": "Prerequisites unlock each level. Resource columns show cumulative totals.",
    "拆分口径": "Breakdown",
    "概率合计 100%，积分期望合计 5.92963。": "Total rate: 100%. Total expected score: 5.92963.",
    "回合结束若生命低于50%，获得10%最大生命护盾；回合开始若护盾大于生命30%，全伤害减免 +10% 2回合。": "At round end, if HP is below 50%, gain a shield equal to 10% of max HP; at round start, if the shield exceeds 30% of HP, gain 10% All-Damage Reduction for 2 rounds.",
    "攻击护甲高于自身的目标追加1000%攻神圣伤害并叠圣甲；3层后追加2500%攻神圣惩戒。": "When attacking a target with higher Armor, deal an extra 1000% Attack as Holy Damage and add a Holy Armor mark; at 3 stacks, deal an extra 2500% Attack as Holy Punishment.",
    "暴击时恢复提高到 22%；否则额外伤害提高到 45%": "On Crit, healing increases to 22%; otherwise, extra damage increases to 45%.",
    "神能等级 = 飞升等级 + 神能加成；展示(神)由要求(飞)自动推导。": "Divine Power Level = Destiny Level + Divine Power Bonus; Display DP is derived automatically from Required D.",
    "分解资质魂力速览": "Dismantle Soul Power",
    "最高性价比": "Best Value",
    "性价比 = 充能进度 / 分解价": "Value = Energy / Cost",
    "品质": "Tier",
    "充能进度": "Energy",
    "分解价": "Cost",
    "充能进度 / 分解价": "Value",
    "数值来自原分解资质魂力攻略图；比值越高，单位分解价换到的充能进度越多。": "Source: original dismantling guide. A higher value is better.",
    "光玉 / 时晶 / 灵碎 / 星辰碎片": "Aurora / CoT / Spiritvein / Stellar",
    "阶位": "Rank",
    "英文": "EN",
    "光玉": "Aurora",
    "时晶": "CoT",
    "灵碎": "Spiritvein",
    "星辰碎片": "Stellar Shards",
    "合计 神六": "D6 Total",
    "换算": "Conversion",
    "1 光玉 = 5,000 光玉碎片": "1 Aurora Gem = 5,000 shards",
    "掉落参考（日 / 月）": "Drops (day / month)",
    "关卡": "Stage",
    "灵碎日": "Spirit/day",
    "灵碎月": "Spirit/month",
    "光玉日": "Aurora/day",
    "光玉月": "Aurora/month",
    "基金材料性价比": "Fund Material Value",
    "基金12倍 / 任务兑换": "Fund x12 / Task",
    "比例越高，基金越实惠": "Higher ratio = better value",
    "序": "#",
    "物品名称": "Item",
    "记录上限": "Cap",
    "任务10材": "Task x10",
    "基金12倍": "Fund x12",
    "比例": "Ratio",
    "备注": "Notes",
    "星魂碎片箱": "Star Soul Shard Chest",
    "散落的灵脉碎片": "Spiritvein Shards",
    "蓝碎": "Stellar Shards",
    "飞升碎片": "Destiny Shards",
    "赋能灌注石碎片2种": "Enabling Stone Shards (2)",
    "生化滋养针": "Bio-Nourishing Injector",
    "根源之核碎片32种": "Origin Core Shards (32)",
    "星魂精髓3种": "Star Soul Essence (3)",
    "比例 = 基金12倍 ÷ 任务每10材料换取量；倍数越高代表基金越实惠。": "Ratio = Fund x12 / Task x10. Higher is better.",
    "比例按从高到低高亮：深黄最高，浅黄次之；粉色为最低两档。": "Highlight: dark yellow is highest; pink marks the lowest tiers.",
    "升格需求速览": "Merge Requirements",
    "资质范围": "Tier Range",
    "凝魂次数 / 属性提升 / 材料": "Condensations / Stat Gain / Materials",
    "资质品质": "Tier",
    "可凝魂次数": "Condensations",
    "每次凝魂提升属性": "Stat Gain",
    "升格所需材料": "Materials",
    "属性随机分配给攻击 / 生命 / 速度；分给速度时按数值 ÷ 100。": "Stats go to Attack, HP, or Speed; Speed gains are value / 100.",
    "等级": "Lv",
    "魔典精华": "Essence",
    "累计魔典精华": "Total Essence",
    "印痕精华": "Imprint",
    "累计魔典": "Grimoire Total",
    "累计印痕": "Imprint Total",
    "赋能魔典 / 印痕魔典材料分开计算": "Enabling / Imprint Grimoire calculated separately",
    "命轨同步要求": "Destiny Trail Sync",
    "只整理材料需求；星魂属性、技能解锁和左表红色任务数字未纳入本图。": "Materials only; stats, skill unlocks, and red mission numbers are excluded.",
    "换算：1 个星魂本体 = 5,000 星魂碎片。": "1 Star Soul Core = 5,000 Star Soul Shards.",
    "赋能灌注速览": "Enabling Infusion",
    "规则": "Rule",
    "赋能位 3 选 1": "Choose 1 of 3",
    "基础效果 / Lv1 / Lv2 中文整理": "Base / Lv1 / Lv2",
    "赋能位": "Slot",
    "选项": "Pick",
    "灌注等级": "Level",
    "虚空入侵 Boss 技能速览": "Void Invasion Boss Skills",
    "图一到图七 · 大招 / 普攻 / 被动 / 应对重点": "Images 1-7 · Active / Basic / Passive / Tips",
    "待确认机制已直接标注；图六、图七优先按不可硬抗处理。": "Unverified mechanics are marked. Images 6-7 should not be face-tanked.",
    "大招": "Active",
    "普攻": "Basic",
    "被动": "Passive",
    "应对": "Tip",
}

CHINESE_RE = re.compile(r"[\u3400-\u9fff]")
IMAGE_PATH_RE = re.compile(r"\.(?:png|jpe?g|webp|gif)$", re.I)


def english_output(path: Path) -> Path:
    if path.name not in OUTPUT_NAMES:
        return path
    return path.with_name(f"{path.stem}-en{path.suffix}")


def collect_strings() -> list[str]:
    strings: set[str] = set()
    for path in GENERATORS:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
                continue
            value = node.value
            if CHINESE_RE.search(value) and not IMAGE_PATH_RE.search(value):
                strings.add(value)
    return sorted(strings)


def protect_terms(text: str) -> tuple[str, dict[str, str]]:
    protected = text
    restore: dict[str, str] = {}
    for index, (zh, en) in enumerate(sorted(GLOSSARY.items(), key=lambda item: -len(item[0]))):
        if zh not in protected:
            continue
        token = f"ZXQTERM{index:03d}QXZ"
        protected = protected.replace(zh, token)
        restore[token] = en
    return protected, restore


def request_translation(text: str) -> str:
    params = urllib.parse.urlencode({
        "client": "gtx",
        "sl": "zh-CN",
        "tl": "en",
        "dt": "t",
        "q": text,
    })
    url = f"https://translate.googleapis.com/translate_a/single?{params}"
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=25) as response:
                payload = json.load(response)
            return "".join(part[0] for part in payload[0] if part and part[0])
        except Exception as exc:  # pragma: no cover - network retry path
            last_error = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Translation request failed: {last_error}")


def clean_translation(translated: str, restore: dict[str, str]) -> str:
    for token, term in restore.items():
        translated = re.sub(rf"\s*{re.escape(token)}\s*", f" {term} ", translated)
    translated = re.sub(r"\s+([,.;:%)])", r"\1", translated)
    translated = re.sub(r"([(])\s+", r"\1", translated)
    translated = re.sub(r"\s{2,}", " ", translated).strip()
    return translated


def translate_batch(texts: list[str]) -> dict[str, str]:
    translated: dict[str, str] = {}
    pending: list[tuple[int, str, dict[str, str]]] = []
    lines: list[str] = []
    for index, text in enumerate(texts):
        if text in EXACT:
            translated[text] = EXACT[text]
            continue
        protected, restore = protect_terms(text)
        pending.append((index, text, restore))
        lines.append(f"ZXQITEM{index:04d}QXZ {protected}")
    if not pending:
        return translated

    response = request_translation("\n".join(lines))
    matches = list(re.finditer(r"ZXQITEM(\d{4})QXZ\s*", response))
    pieces: dict[int, str] = {}
    for match_index, match in enumerate(matches):
        start = match.end()
        end = matches[match_index + 1].start() if match_index + 1 < len(matches) else len(response)
        pieces[int(match.group(1))] = response[start:end].strip()
    for index, text, restore in pending:
        if index not in pieces:
            raise RuntimeError(f"Batch response omitted marker {index} for {text!r}")
        translated[text] = clean_translation(pieces[index], restore)
    return translated


def load_translations(refresh: bool) -> dict[str, str]:
    cached: dict[str, str] = {}
    if CACHE.exists():
        cached = json.loads(CACHE.read_text(encoding="utf-8"))
    cached = {key: value.splitlines()[0].strip() for key, value in cached.items()}
    cached.update({key: value for key, value in EXACT.items() if key in collect_strings()})
    source_strings = collect_strings()
    missing = [text for text in source_strings if refresh or text not in cached]
    if missing:
        print(f"Translating {len(missing)} strings…", flush=True)
        batch_size = 18
        for start in range(0, len(missing), batch_size):
            batch = missing[start:start + batch_size]
            cached.update(translate_batch(batch))
            CACHE.write_text(
                json.dumps(dict(sorted(cached.items())), ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            print(f"  {min(start + batch_size, len(missing))}/{len(missing)}", flush=True)
    CACHE.write_text(
        json.dumps(dict(sorted(cached.items())), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return cached


class TranslateStrings(ast.NodeTransformer):
    def __init__(self, translations: dict[str, str]):
        self.translations = translations

    def visit_Constant(self, node: ast.Constant):  # noqa: N802 - AST API
        if isinstance(node.value, str) and node.value in self.translations:
            return ast.copy_location(ast.Constant(self.translations[node.value]), node)
        return node


class EnglishLayout(ast.NodeTransformer):
    """Give longer English copy more vertical room in the densest guides."""

    def __init__(self, path: Path):
        self.path = path
        self.function = ""

    def visit_FunctionDef(self, node: ast.FunctionDef):  # noqa: N802 - AST API
        previous = self.function
        self.function = node.name
        node = self.generic_visit(node)
        self.function = previous
        return node

    def visit_Constant(self, node: ast.Constant):  # noqa: N802 - AST API
        if self.path.name == "generate-attribute-guides.py":
            if self.function == "draw_explanation" and node.value == 1680:
                return ast.copy_location(ast.Constant(2160), node)
            if self.function == "draw_formula" and node.value == 1840:
                return ast.copy_location(ast.Constant(2440), node)
        return node

    def visit_Assign(self, node: ast.Assign):  # noqa: N802 - AST API
        node = self.generic_visit(node)
        names = {target.id for target in node.targets if isinstance(target, ast.Name)}
        if self.path.name == "generate-attribute-guides.py":
            if self.function == "draw_explanation" and "row_h" in names:
                node.value = ast.copy_location(ast.Constant(94), node.value)
            elif self.function == "draw_formula" and "row_h" in names:
                node.value = ast.copy_location(ast.Constant(125), node.value)
        elif self.path.name == "generate-destiny-temple-guide.py" and self.function == "main":
            if "cols" in names:
                node.value = ast.parse(
                    "[54, 52, 160, 160, 106, 98, 58, 82, 98, "
                    "table_w - 54 - 52 - 160 - 160 - 106 - 98 - 58 - 82 - 98]",
                    mode="eval",
                ).body
        elif self.path.name == "generate-imprint-branch-guide.py" and self.function == "main":
            if "section_h" in names:
                node.value = ast.copy_location(ast.Constant(980), node.value)
            elif "card_h" in names:
                node.value = ast.copy_location(ast.Constant(250), node.value)
        elif self.path.name == "generate-void-invasion-boss-guide.py" and self.function == "main":
            if "card_h" in names:
                node.value = ast.copy_location(ast.Constant(300), node.value)
        elif self.path.name == "generate-root-infusion-set-guide.py" and self.function == "draw_section":
            if "label_w" in names:
                node.value = ast.copy_location(ast.Constant(108), node.value)
        return node

    def visit_AugAssign(self, node: ast.AugAssign):  # noqa: N802 - AST API
        node = self.generic_visit(node)
        if (
            self.path.name == "generate-void-invasion-boss-guide.py"
            and self.function == "draw_card"
            and isinstance(node.target, ast.Name)
            and node.target.id == "yy"
        ):
            node.value = ast.copy_location(ast.Constant(55), node.value)
        return node


def run_generator(path: Path, translations: dict[str, str]) -> None:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    tree = TranslateStrings(translations).visit(tree)
    tree = EnglishLayout(path).visit(tree)
    ast.fix_missing_locations(tree)
    namespace = {
        "__name__": f"guide_en_{path.stem.replace('-', '_')}",
        "__file__": str(path),
    }
    exec(compile(tree, str(path), "exec"), namespace)
    original_wrap = namespace.get("wrap_text")
    if original_wrap:
        def english_wrap_text(draw, text, fnt, max_width):
            def width(value):
                box = draw.textbbox((0, 0), value, font=fnt)
                return box[2] - box[0]

            def split_long_word(word):
                chunks = []
                current = ""
                for char in word:
                    candidate = current + char
                    if current and width(candidate) > max_width:
                        chunks.append(current)
                        current = char
                    else:
                        current = candidate
                if current:
                    chunks.append(current)
                return chunks

            lines = []
            for paragraph in str(text).split("\n"):
                words = paragraph.split()
                current = ""
                for word in words:
                    pieces = split_long_word(word) if width(word) > max_width else [word]
                    for piece in pieces:
                        candidate = piece if not current else f"{current} {piece}"
                        if current and width(candidate) > max_width:
                            lines.append(current)
                            current = piece
                        else:
                            current = candidate
                if current:
                    lines.append(current)
                elif not words:
                    lines.append("")
            return lines

        namespace["wrap_text"] = english_wrap_text
    # Use a stronger Latin typeface and create room for readable English copy.
    # Dense guides receive taller rows/cards above rather than tiny body text.
    original_font = namespace.get("font")
    if original_font:
        def english_font(size, bold=False):
            dense = {
                "generate-attribute-guides.py",
                "generate-imprint-branch-guide.py",
                "generate-root-infusion-set-guide.py",
                "generate-void-invasion-boss-guide.py",
                "generate-destiny-temple-guide.py",
            }
            if size >= 44:
                factor = 0.82
            elif size >= 30:
                factor = 0.76
            else:
                factor = 0.66 if path.name in dense else 0.70
            pixel_size = max(11, round(size * factor))
            latin_font = (
                "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
                if bold
                else "/System/Library/Fonts/Supplemental/Arial.ttf"
            )
            if Path(latin_font).exists():
                return ImageFont.truetype(latin_font, pixel_size)
            return original_font(pixel_size, bold)

        namespace["font"] = english_font
    namespace["main"]()


def generate_expedition_map() -> Path:
    source = IMAGE_DIR / "远征推图.jpeg"
    output = IMAGE_DIR / "expedition-stage-map-en.png"
    image = Image.open(source).convert("RGB")
    draw = ImageDraw.Draw(image, "RGBA")
    regular = "/System/Library/Fonts/Supplemental/Arial.ttf"
    bold = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
    font_title = ImageFont.truetype(bold, 29)
    font_count = ImageFont.truetype(regular, 24)
    panels = [
        (0, 8), (334, 9), (670, 14), (1006, 9), (1343, 8), (1679, 7), (2015, 8)
    ]
    box_x = image.width - 142
    for index, (panel_y, mobs) in enumerate(panels, 1):
        box_y = panel_y + 12
        draw.rounded_rectangle(
            (box_x, box_y, image.width - 8, box_y + 75),
            radius=10,
            fill=(22, 18, 54, 190),
            outline=(255, 255, 255, 155),
            width=1,
        )
        draw.text((box_x + 12, box_y + 7), f"Image {index}", font=font_title, fill="white")
        draw.text((box_x + 12, box_y + 42), f"{mobs} mobs", font=font_count, fill=(238, 241, 255))
    image.save(output, optimize=True)
    print(output)
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--refresh-translations",
        action="store_true",
        help="Retranslate all Chinese strings and refresh the checked-in cache.",
    )
    args = parser.parse_args()
    translations = load_translations(args.refresh_translations)

    original_save = Image.Image.save

    def redirected_save(image, fp, *save_args, **save_kwargs):
        target = Path(fp) if isinstance(fp, (str, Path)) else fp
        if isinstance(target, Path):
            target = english_output(target)
        return original_save(image, target, *save_args, **save_kwargs)

    Image.Image.save = redirected_save
    try:
        for generator in GENERATORS:
            print(f"Generating English: {generator.name}")
            run_generator(generator, translations)
    finally:
        Image.Image.save = original_save

    generate_expedition_map()


if __name__ == "__main__":
    main()
