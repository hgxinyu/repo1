# 攻略图片页面

页面：`flipgame/GuideImages.html`  
图片目录：`flipgame/images/`

## 当前规则

- 攻略图统一放在 `flipgame/images/`。
- 页面内卡片手动维护标题、图片路径和描述。
- 图片页面文案包含：`部分图片收集于网络，公众号。特此感谢作者！`
- 部分图片已加站内二维码角标。
- 觉醒概率新版图由 `scripts/generate-awakening-rate-guide.py` 生成，数据来自旧图 `flipgame/images/juexingailv.jpg`，输出为 `flipgame/images/awakening-rate-guide.png`。
- 印痕灌注新版图由 `scripts/generate-imprint-infusion-guide.py` 生成，数据来自旧图 `flipgame/images/guanzhu.png`，输出为 `flipgame/images/imprint-infusion-guide.png`。
- 分解资质魂力新版图由 `scripts/generate-breakdown-soulpower-guide.py` 生成，数据来自旧图 `flipgame/images/fengjiehunli.png`，输出为 `flipgame/images/breakdown-soulpower-guide.png`。
- 升格需求新版图由 `scripts/generate-merge-requirements-guide.py` 生成，数据来自旧图 `flipgame/images/shengexuqiu.jpg`，输出为 `flipgame/images/merge-requirements-guide.png`。
- 根源等级新版图由 `scripts/generate-root-level-guide.py` 生成，数据来自旧图 `flipgame/images/genyuan.jpeg` 和 `IHassistant/knowledge/mechanics/hero-upgrade-progression.md`，输出为 `flipgame/images/root-level-guide.png`。
- 飞升升级资源图由 `scripts/generate-destiny-upgrade-guide.py` 生成，数据来自用户提供 `IMG_5996.jpg`，并与 `IHassistant/knowledge/mechanics/hero-upgrade-progression.md` 对照一致，输出为 `flipgame/images/destiny-upgrade-guide.png`。
- 飞升殿堂升级资料图由 `scripts/generate-destiny-temple-guide.py` 生成，数据来自 `flipgame/destiny_temple_levels.json` 和 `IHassistant/knowledge/mechanics/destiny-temple.md`，输出为 `flipgame/images/destiny-temple-guide.png`。
- 属性解释与算法新版图由 `scripts/generate-attribute-guides.py` 生成，数据来自旧图 `flipgame/images/属性解释.jpg` 和 `IHassistant/knowledge/mechanics/attributes-affixes.md`，输出为 `flipgame/images/attribute-explanation-guide.png` 与 `flipgame/images/attribute-formula-guide.png`。
- 赋能灌注新版图由 `scripts/generate-empower-infusion-guide.py` 生成，数据来自旧英文图 `flipgame/images/funengguanzhu.jpg` 和 `IHassistant/knowledge/hero enabling/README.md`，输出为 `flipgame/images/empower-infusion-guide.png`。
- 基金材料性价比图由 `scripts/generate-fund-material-value-guide.py` 生成，数据来自用户提供截图 `Weixin Image_20260704213500_128_58.jpg` 和 `IHassistant/knowledge/mechanics/fund-material-value.md`，输出为 `flipgame/images/fund-material-value-guide.png`。
- 魔典升级需求图由 `scripts/generate-grimoire-upgrade-guide.py` 生成，数据来自用户提供截图 `image.png` 和 `IHassistant/knowledge/mechanics/grimoire-upgrade.md`，输出为 `flipgame/images/grimoire-upgrade-guide.png`。
- 星魂升级材料图由 `scripts/generate-starsoul-upgrade-guide.py` 生成，数据来自用户提供截图 `RDT_20240908_1722111431203826012194248.png` 和 `IHassistant/knowledge/starsoul/upgrade-requirements.md`，输出为 `flipgame/images/starsoul-upgrade-guide.png`。
- 彩章血量积分图由 `scripts/generate-se-boss-hp-guide.py` 生成，数据来自旧图 `flipgame/images/se boss hp.png`、`flipgame/seboss_all.json` 和 `IHassistant/knowledge/bosses/SEBoss/hp-score-table.md`，输出为 `flipgame/images/se-boss-hp-guide.png`。

## 打开图片

- Web 模式：点击攻略图在站内弹层查看图片。
- App/PWA 模式：避免跳出到外部 Chrome，在当前 app 内用站内弹层查看。
- 弹层里的图片默认按原图自然尺寸显示；如果图片宽度超过当前屏幕，则自动缩到屏幕宽度内，超高长图继续由弹层提供纵向滚动。

## 新增图片流程

1. 把图片放入 `flipgame/images/`。
2. 在 `GuideImages.html` 中新增卡片数据。
3. 标题使用中文主标题，并维护英文翻译。
4. 如需统一风格，给新增图片加站内二维码角标。
5. 本地 server 打开攻略页面验证图片路径大小写。

## 命名建议

- 尽量使用稳定、可读的文件名。
- 已存在中文文件名时可以继续沿用，但注意部署平台大小写敏感。
- 避免空格和特殊标点，除非文件已经存在并被页面引用。
