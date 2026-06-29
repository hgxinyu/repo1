# 飞升殿堂与神能等级

来源：用户提供截图 `Weixin Image_20260628202226_11664_38.jpg`，并在 2026-06-29 对术语和计算口径做了补充确认。

结构化数据源：`flipgame/destiny_temple_levels.json`。

普通 E5 英雄从 E5 到神六的完整升级链路另见：`hero-upgrade-progression.md`。

## 术语

| 中文 | 别名 | 英文建议 | 代码字段建议 |
| --- | --- | --- | --- |
| 飞升等级 | 飞 | Destiny Level | `destinyLevel` |
| 神能加成 | - | Divine Power Bonus | `divinePowerBonus` |
| 神能等级 | 神 | Divine Power Level | `divinePowerLevel` |
| 飞升殿堂 | 神殿 | Destiny Temple | `destinyTempleLevel` |
| 神玉 | 蓝玉 | Aurora Gem | `auroraGem` |
| 星碎 | 蓝碎、印痕 | Stellar Shards | `stellarShards` |
| 意识 | 意识精华、树精华 | Spiritual Essence | `spiritualEssence` |
| 灵碎 | 黄碎、黄玉 | Scattered Spiritvein Shard | `scatteredSpiritveinShard` |
| 时晶 | 时空结晶、紫碎 | Crystal of Transcendence | `crystalOfTranscendence` |

## 神能等级公式

```text
神能等级 = 飞升等级 + 神能加成
Divine Power Level = Destiny Level + Divine Power Bonus
```

截图中的 `升级要求` 使用 `飞1`、`飞2` 等写法，表示飞升等级要求。`实际展示` 使用 `神1`、`神2` 等写法，表示同一批英雄在当前殿堂神能加成下显示出来的神能等级。

示例：

- 如果当前 `神能加成 = 4`，要求 `2飞3 1飞4`。
- 实际展示可由公式自动计算为 `2神7 1神8`。

因此计算器里不需要把 `实际展示` 作为独立事实表维护；它可以由 `升级要求 + 神能加成` 推导。

## 资源口径

截图中每个飞升殿堂等级都有两类资源口径：

1. 前置条件：
   - `前置星碎`
   - `前置意识`
   - 两者是升级到该殿堂等级需要满足的前置条件，可以计入总成本。
2. 升满需求：
   - `神玉需求`
   - `灵碎需求`
   - `星碎需求`
   - `时晶需求(k)`
   - 这些是当前殿堂等级升满后的累计资源需求。

其中 1 级殿堂前置条件可以和普通 E5 英雄升级链路对照：

```text
E5 -> E9 蓝碎 4,935,000
E9 -> 根源 120 印痕 9,994,100
合计 = 14,929,100 = 飞升殿堂 1 级前置星碎

E9 -> 根源 120 意识精华 1,248,120
= 飞升殿堂 1 级前置意识
```

除此之外，用户补充 E9 到根源满还需要：

- 核武箱子（Core of Origin）：`8` 个，每个 `50` 碎片，合计 `400` 碎片。
- 技能点：`16/720K`，分为主动、被动 1、被动 2、被动 3 各 `4` 点。

这些额外门槛未出现在飞升殿堂截图的前置星碎 / 前置意识列里，但进入飞升阶段时也需要满足。

## 增量规则

`前置增加` 表示从上一级殿堂的前置条件变化到当前等级前置条件的差值：

```text
上一级前置星碎 + 当前级前置星碎增加 = 当前级前置星碎
上一级前置意识 + 当前级前置意识增加 = 当前级前置意识
```

`需求增加` 表示从上一级满级达到当前级满级所需的额外资源：

```text
上一级满级需求 + 当前级需求增加 = 当前级满级需求
```

## 计算器接入口径

后续如果整合到 `flipgame/CoreCalculator.html`，建议作为独立模块处理，不与当前“核心换算”表混在同一张输入表里。

推荐输入：

- 当前飞升殿堂等级。
- 目标飞升殿堂等级。

推荐输出：

- 当前等级到目标等级的前置差值。
- 当前等级到目标等级的升满资源差值。
- 合计成本：前置资源差值 + 升满资源差值。
- 对应的 Destiny 要求和 Divine Power 展示。

## 数据维护

- 1-30 级完整数值表已录入 `flipgame/destiny_temple_levels.json`。
- JSON 中 `upgradeRequirements` 保存截图里的 Destiny 要求。
- JSON 中 `actualDisplay` 由 `upgradeRequirements + divinePowerBonus` 推导，用于复现截图里的 Divine Power 展示。
- `progressPercent` 第 30 行按最终进度推断为 `100.00`，因为截图最右边缘切掉了该单元格。
