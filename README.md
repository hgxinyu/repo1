# 放置工具集

这是一个静态 HTML/CSS/JavaScript 工具站，主页面位于 `flipgame/`。项目没有构建步骤，部署时直接发布静态文件即可。

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
- 凝魂升格 & 魂力计算器（VIP）：`flipgame/SoulAscensionCalculator.html`
- 远征积分计算器（VIP）：`flipgame/ExpeditionCalculator.html`
- 攻略图片：`flipgame/GuideImages.html`
- 九宫格翻牌：`flipgame/flipgame.html`
- 核心计算器：`flipgame/CoreCalculator.html`
- 星钻计算器：`flipgame/StarDiamondCalculator.html`
- 觉醒冲榜模拟器（VIP）：`flipgame/AwakeningRushSimulator.html`
- 登录：`flipgame/Login.html`
- 注册：`flipgame/Register.html`
- 管理后台：`flipgame/Admin.html`
- PWA 安装帮助：`flipgame/AppBuildGuide.html`

## 数据文件

- 凝魂数据：`flipgame/soul_tiers.csv`
- 远征积分数据：`flipgame/seboss_all.json`
- 远征原始表：`flipgame/SE Boss New.xlsx`
- 攻略图片：`flipgame/images/`
- 图标与 PWA 资源：`flipgame/assets/`、`flipgame/site.webmanifest`、`flipgame/site.local.webmanifest`

## 文档

- Agent 规则：`AGENTS.md`
- 凝魂模块：`docs/soul-calculator.md`
- 远征模块：`docs/expedition-calculator.md`
- 觉醒冲榜模块：`docs/awakening-rush-simulator.md`
- VIP 账号与权限：`docs/vip-access.md`
- 攻略图片模块：`docs/guide-images.md`
- PWA 与资源：`docs/pwa-and-assets.md`
- 历史记录：`docs/history/progress.md`

## 维护原则

- 修改可见文案时，同步更新页面内 zh/en I18N 配置。
- 修改 CSV/JSON 数据后，通过本地 server 刷新验证。
- 不提交 `.DS_Store`、本地临时 Excel 等工作文件。
- 页面目前是单文件模式；除非明确重构，否则优先沿用现有 HTML 内联 CSS/JS 风格。
