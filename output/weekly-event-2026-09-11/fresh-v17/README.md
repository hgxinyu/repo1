# 9/11 周攻略 · 小尺寸双语 v17

当前发布源稿，文案沿用v16确认版本。用户要求采用较小分辨率，并把水印放大、移到画面中间。

- 中文：[1200×1600 PNG](../../../flipgame/images/weekly-event-2026-09-11.png) · [独立HTML](weekly-event-2026-09-11-zh-v17.html)
- 英文：[1200×1600 PNG](../../../flipgame/images/weekly-event-2026-09-11-en.png) · [独立HTML](weekly-event-2026-09-11-en-v17.html)
- 文案：[copy.json](copy.json) · 导出脚本：[build.mjs](build.mjs) · 验收：[qa/report.json](qa/report.json)

直接从1200×1600排版源以1倍像素密度渲染，没有缩放旧成图。复用v16的干净页眉插画、原始Logo及道具图标；本次没有调用图像生成模型。图像生成token与本地PNG导出尺寸是两件事，不能把像素减少比例当成总token节省比例。

水印中心为画布中心(600,800)，68px字、逆时针10°、7.5%不透明度；文字和关键数字在水印上层。两版各一处水印，整行没有被卡片标签截断。本次用户已授权推送，站内使用相同的1200×1600输出。

```bash
node output/weekly-event-2026-09-11/fresh-v17/build.mjs
```

已检查真实尺寸、整图及原尺寸局部；中英文无主要容器溢出，水印中心位置检查通过。此版只改导出分辨率和水印，源文案与v16逐字一致。

导出生成的HTML、预览PNG及qa目录仅供本地验收，不随源文件提交；需要查看时运行上方命令。实际生产部署结果记录在项目progress.md。
