# Core Calculator

页面：

- `flipgame/Calculators.html`：计算器入口。
- `flipgame/CoreCalculator.html`：核心换算。
- `flipgame/DestinyCalculator.html`：殿堂 / 飞升资源计算。

核心计算器当前用于把常见资源/阶段换算成核心数量。页面采用单文件 HTML 结构，文案通过页面内 `I18N` 对象维护。

首页的计算器卡片会直接打开计算器选择面板，由用户选择核心换算或殿堂 / 飞升资源计算。`flipgame/Calculators.html` 仍保留为可直接访问的计算器入口页。

## 当前数据

当前核心换算数据直接写在页面脚本内：

- `E8.3`
- `E9`
- `400`
- `420`
- `飞1-100` 到 `飞6-100`
- `额外星碎/蓝碎/印痕（K）`

英文翻译口径：

- `飞` = `Destiny`
- `星碎 / 蓝碎 / 印痕` = `Stellar Shards`

## 飞升殿堂 / Destiny Temple

飞升殿堂资料暂时整理在：

- `IHassistant/knowledge/mechanics/hero-upgrade-progression.md`
- `IHassistant/knowledge/mechanics/destiny-temple.md`
- `flipgame/destiny_temple_levels.json`

已确认术语：

| 中文 | 别名 | 英文 |
| --- | --- | --- |
| 飞升等级 | 飞 | Destiny Level |
| 神能加成 | - | Divine Power Bonus |
| 神能等级 | 神 | Divine Power Level |
| 飞升殿堂 | 神殿 | Destiny Temple |
| 神玉 | 蓝玉 | Aurora Gem |
| 星碎 | 蓝碎、印痕 | Stellar Shards |
| 意识 | 意识精华、树精华 | Spiritual Essence |
| 灵碎 | 黄碎、黄玉 | Scattered Spiritvein Shard |
| 时晶 | 时空结晶、紫碎 | Crystal of Transcendence |

公式：

```text
Divine Power Level = Destiny Level + Divine Power Bonus
神能等级 = 飞升等级 + 神能加成
```

前置资源和升满需求口径：

- `前置星碎`、`前置意识` 是升级该殿堂等级的前置条件，可以计入总成本。
- `前置增加` 是从上一级前置条件变化到当前等级前置条件的差值。
- `需求` 是当前等级升满后的累计资源。
- `需求增加` 是上一级满级达到当前级满级的额外资源。

普通 E5 英雄升级链路：

- E5 -> E9：当前按 `4,935,000` 蓝碎记录。
- E9 -> 根源 120：`9,994,100` 印痕 + `1,248,120` 意识精华 + `8` 个 Core of Origin 箱子（每个 `50` 碎片，合计 `400` 碎片）+ 主动 / 被动 1 / 被动 2 / 被动 3 各 `4` 个技能点（合计 `16` 点；每点 `45K` Essence Sublimation，合计 `720K`）。
- 根源 120 -> 神六：`60` 光玉 + `2,400,536` 灵碎 + `5,030,000` 时空结晶 + `10,000,490` 星辰碎片。

交叉校验：

```text
4,935,000 + 9,994,100 = 14,929,100
```

这个结果等于 `flipgame/destiny_temple_levels.json` 中飞升殿堂 1 级的 `前置星碎`；根源 120 意识精华 `1,248,120` 等于飞升殿堂 1 级的 `前置意识`。

Core of Origin 和 Essence Sublimation 是额外进入飞升门槛，不在飞升殿堂截图的前置星碎 / 前置意识列里。

## 殿堂 / 飞升计算器

页面：`flipgame/DestinyCalculator.html`

数据源：

- 殿堂 1-30 级数据读取 `flipgame/destiny_temple_levels.json`。
- 单英雄飞 1-6 成本来自 `flipgame/images/飞升1.jpg`，已按表内数值写入页面脚本。
- E5 -> E9、根源 120、Core of Origin、Essence Sublimation 口径记录在 `IHassistant/knowledge/mechanics/hero-upgrade-progression.md`。

下一殿堂计算：

- 用户选择当前殿堂等级，页面计算当前等级到下一殿堂等级。
- 前置星碎 / 前置意识使用 `max(0, 下一等级前置 - 当前等级前置)`，避免前置条件降低时出现负数。
- 升满资源使用下一等级累计需求减当前等级累计需求。
- 如果下一等级 `heroCount` 高于当前等级，每个新增英雄额外计入 `5,000K` 时空结晶，用于普通英雄升级成时空英雄。

单英雄 E5 到目标飞升等级计算：

- 基础前置固定计入：`4,935,000` 蓝碎、`9,994,100` 印痕、`1,248,120` 意识精华。
- 额外进入飞升门槛固定计入：`8` 个 Core of Origin 箱子（`400` 碎片）和主动 / 被动 1 / 被动 2 / 被动 3 各 `4` 个技能点（合计 `720K` Essence Sublimation）。
- 转时空英雄固定计入 `5,000K` 时空结晶。
- 再叠加目标飞升等级 1 到目标等级的飞升段累计资源。

## 维护规则

- 修改页面可见文本时，同步更新 zh/en I18N。
- 飞升殿堂 1-30 级数据维护在 `flipgame/destiny_temple_levels.json`，不要把长表直接散落在 UI 逻辑里。
- 修改计算器规则后，同步更新本文件和相关知识库文档。
