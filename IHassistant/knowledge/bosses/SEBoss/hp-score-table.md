# 彩章血量积分表

来源：

- 旧图：`flipgame/images/se boss hp.png`
- 结构化数据：`flipgame/seboss_all.json`

## 口径

- 记录星域远征章鱼 Boss 100 到 1 层的总积分和 1% 血量积分。
- 单位为 `万亿`。
- 攻略图中总积分按四舍五入显示，1% 血量积分保留两位小数。
- 计算剩余积分时：

```text
剩余积分 = 当前层总积分 * 剩余血量百分比 / 100
```

攻略图输出：`flipgame/images/se-boss-hp-guide.png`，由 `scripts/generate-se-boss-hp-guide.py` 根据 `flipgame/seboss_all.json` 生成。

## 关键样例

| 层数 | 总积分（万亿） | 1%血量积分（万亿） |
| ---: | ---: | ---: |
| 100 | 32 | 0.32 |
| 50 | 1,372,604 | 13,726.04 |
| 1 | 47,496,923,280 | 474,969,232.80 |

## 数据维护

- 完整数据以 `flipgame/seboss_all.json` 为准。
- 如更新远征计算器数据，应同时重新生成 `se-boss-hp-guide.png`。
