# 攻略图片页面

页面：`flipgame/GuideImages.html`  
图片目录：`flipgame/images/`

## 当前规则

- 攻略图统一放在 `flipgame/images/`。
- 页面内卡片手动维护标题、图片路径和描述。
- 有文字的站内生成攻略图同时维护英文 `*-en.png` 版本。`GuideImages.html` 读取首页保存的 `localStorage.flipgame_lang`：中文显示原图，英文显示 `data-image-en` / `data-images-en` 指向的英文图。
- 奇幻梦工厂隐藏关图片本身没有文字，中英文共用原图；远征推图使用单独的 `expedition-stage-map-en.png` 英文编号版。
- 图片页面文案包含：`部分图片收集于网络，公众号。特此感谢作者！`
- 部分图片已加站内二维码角标。
- 觉醒概率新版图由 `scripts/generate-awakening-rate-guide.py` 生成，数据来自旧图 `flipgame/images/juexingailv.jpg`，输出为 `flipgame/images/awakening-rate-guide.png`。
- 印痕灌注新版图由 `scripts/generate-imprint-infusion-guide.py` 生成，数据来自旧图 `flipgame/images/guanzhu.png`，输出为 `flipgame/images/imprint-infusion-guide.png`。
- 印痕灌注分支选择图由 `scripts/generate-imprint-branch-guide.py` 生成，数据来自用户提供的利刃、强壁、精神三张截图和 `IHassistant/knowledge/imprint infusion/README.md`，输出为 `flipgame/images/imprint-branch-guide.png`。
- 根源灌注套装效果图由 `scripts/generate-root-infusion-set-guide.py` 生成，数据来自用户提供 Excel `根源灌注全套装属性表.xlsx` 和 `IHassistant/knowledge/imprint infusion/root-infusion-sets.md`，输出为 `flipgame/images/root-infusion-set-guide.png`。
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
- 战斗 Buff/Debuff 图标图由 `scripts/generate-battle-icon-guide.py` 生成，图标裁自旧图 `flipgame/images/tubiao.jpg`，输出为 `flipgame/images/battle-buff-debuff-icons-guide.png`。
- 彩章血量积分图由 `scripts/generate-se-boss-hp-guide.py` 生成，数据来自 `flipgame/seboss_all.json` 和 `IHassistant/knowledge/bosses/SEBoss/hp-score-table.md`，输出为 `flipgame/images/se-boss-hp-guide.png`。
- 虚空入侵 Boss 技能图由 `scripts/generate-void-invasion-boss-guide.py` 生成，数据来自用户提供截图和 `IHassistant/knowledge/bosses/void-invasion/README.md`，输出为 `flipgame/images/void-invasion-boss-guide.png`。

## 英文版生成

- 运行 `python3 scripts/generate-english-guide-images.py`，从现有中文生成器确定性生成全部 `*-en.png` 英文图和远征地图英文编号版。
- 英文构建器以中文生成器为数值和版式真相源，不覆盖中文图片。
- 翻译固化在 `scripts/guide-image-en-translations.json`；日常重建完全离线。
- 中文生成器新增或修改文案后，运行 `python3 scripts/generate-english-guide-images.py --refresh-translations` 更新翻译缓存，再人工复核游戏术语、数字与排版。

## 打开图片

- Web 模式：点击攻略图在站内弹层查看图片。
- App/PWA 模式：避免跳出到外部 Chrome，在当前 app 内用站内弹层查看。
- 弹层里的图片默认按原图自然尺寸显示；如果图片宽度超过当前屏幕，则自动缩到屏幕宽度内，超高长图继续由弹层提供纵向滚动。

## 新增图片流程

1. 把图片放入 `flipgame/images/`。
2. 在 `GuideImages.html` 中新增卡片数据。
3. 标题使用中文主标题，并维护英文翻译。
4. 图片内含文字时，生成英文 `*-en.png` 并在卡片补上 `data-image-en`；多图卡片使用 `data-images-en`。
5. 如需统一风格，给新增图片加站内二维码角标。
6. 本地 server 分别把 `localStorage.flipgame_lang` 设为 `zh` 和 `en`，验证缩略图与弹层图片路径大小写。

## 命名建议

- 尽量使用稳定、可读的文件名。
- 已存在中文文件名时可以继续沿用，但注意部署平台大小写敏感。
- 避免空格和特殊标点，除非文件已经存在并被页面引用。
