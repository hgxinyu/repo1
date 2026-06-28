# 放置工具集

这是一个放置奇兵工具与知识库项目。公开工具站位于 `flipgame/`，放置奇兵知识库位于 `IHassistant/`。

`flipgame/` 是静态 HTML/CSS/JavaScript 工具站。项目没有传统构建步骤，部署时直接发布静态文件即可。

`IHassistant/` 用来沉淀游戏机制、英雄、神器、水晶、魔兽、Boss、星魂、远征星印、印痕灌注和阵容资料。它当前作为内部知识库维护，未来可接入 VIP 页面，向有权限账号提供知识库访问。

## 分支与发布

- 日常开发和测试在 `stage` 分支进行。
- 测试完成后，再从 `stage` 合并到 production 对应分支/环境。
- 当前 stage 和 production 暂时不拆分数据；测试后台写入、Blobs、账号权限或价格配置时，要按共享/线上数据处理。

## 本地启动

```bash
cd flipgame && python3 -m http.server 8000
```

然后打开：

```text
http://localhost:8000/
```

不要用 `file://` 直接打开需要读取 CSV/JSON 的页面；浏览器会拦截 `fetch()`。

## 页面模块

- 首页：`flipgame/index.html`
- 放置奇兵兑换码：`flipgame/DiscordDigest.html`
- 凝魂升格 & 魂力计算（注册会员）：`flipgame/SoulAscensionCalculator.html`
- 远征积分计算器（注册会员）：`flipgame/ExpeditionCalculator.html`
- AI玩放置（VIP）：`flipgame/AIAsk.html`
- 攻略图片：`flipgame/GuideImages.html`
- 九宫格翻牌：`flipgame/flipgame.html`
- 核心计算器：`flipgame/CoreCalculator.html`
- 星钻计算器：`flipgame/StarDiamondCalculator.html`
- 觉醒冲榜模拟器（VIP）：`flipgame/AwakeningRushSimulator.html`
- 登录：`flipgame/Login.html`
- 注册：`flipgame/Register.html`
- 管理后台：`flipgame/Admin.html`
- PWA 安装帮助：`flipgame/AppBuildGuide.html`

## 知识库模块

- 知识库入口：`IHassistant/README.md`
- 知识目录：`IHassistant/knowledge/`
- 通用机制：`IHassistant/knowledge/mechanics/`
- 英雄资料：`IHassistant/knowledge/heroes/`
- 神器资料：`IHassistant/knowledge/artifacts/`
- 水晶资料：`IHassistant/knowledge/soulstone/`
- 魔兽资料：`IHassistant/knowledge/monster/`
- Boss 资料：`IHassistant/knowledge/bosses/`
- 场景与阵容：`IHassistant/knowledge/modes/`、`IHassistant/knowledge/lineups/`

## 数据文件

- 凝魂数据：`flipgame/soul_tiers.csv`
- 远征积分数据：`flipgame/seboss_all.json`
- 远征原始表：`flipgame/SE Boss New.xlsx`
- 攻略图片：`flipgame/images/`
- 图标与 PWA 资源：`flipgame/assets/`、`flipgame/site.webmanifest`、`flipgame/site.local.webmanifest`
- 知识库截图与资料：`IHassistant/knowledge/`

## 文档

- Agent 规则：`AGENTS.md`
- 知识库模块：`docs/ihassistant.md`
- 凝魂模块：`docs/soul-calculator.md`
- 远征模块：`docs/expedition-calculator.md`
- AI玩放置：`docs/ai-ask.md`
- 放置奇兵兑换码：`docs/discord-digest.md`
- 觉醒冲榜模块：`docs/awakening-rush-simulator.md`
- VIP 账号与权限：`docs/vip-access.md`
- 攻略图片模块：`docs/guide-images.md`
- PWA 与资源：`docs/pwa-and-assets.md`
- 历史记录：`docs/history/progress.md`

## 维护原则

- 修改可见文案时，同步更新页面内 zh/en I18N 配置。
- 修改 CSV/JSON 数据后，通过本地 server 刷新验证。
- 新增或更新游戏相关 Markdown 文档、游戏知识时，运行 `node scripts/build-ih-knowledge-index.mjs` 同步 AI玩放置知识索引；游戏知识优先放入 `IHassistant/knowledge/`，并保持事实、推论、待确认分离。登录、VIP、PWA、部署等网站维护文档不进入 AI 游戏知识索引。
- 不要把 `IHassistant/` 的资料直接暴露到 `flipgame/`，除非明确要做成公开或 VIP 页面。
- 不提交 `.DS_Store`、本地临时 Excel 等工作文件。
- 页面目前是单文件模式；除非明确重构，否则优先沿用现有 HTML 内联 CSS/JS 风格。
