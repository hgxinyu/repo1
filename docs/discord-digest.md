# 放置奇兵兑换码

页面：`flipgame/DiscordDigest.html`  
访问权限：公开。页面不要求登录。

## 功能口径

- 前端页面调用 `/api/discord-feed` 读取已配置频道的最新消息。
- Netlify Function 使用 `DISCORD_BOT_TOKEN` 调用 Discord API。
- 后端不翻译消息，只抽取 Discord API 提供的文字内容。
- 页面只展示文字，图片、附件、组件、贴纸和结构化 JSON 不显示。
- Discord 自定义 emoji、用户/频道提及等尖括号标记会被过滤，避免显示成乱码。
- `/api/discord-feed` 是公开接口；Bot token 只保存在 Netlify 环境变量中，不暴露给浏览器。
- 页面首次打开会自动读取一次，之后每 1 小时自动刷新一次；不提供手动刷新按钮。
- `/api/discord-feed` 使用 Netlify Blobs 缓存 1 小时。同一小时内的访问会复用缓存，不会每次都请求 Discord API。

## 环境变量

```text
DISCORD_BOT_TOKEN=你的 Discord Bot Token
DISCORD_CHANNEL_ID=需要订阅的 Discord Channel ID
```

Discord Bot 需要能访问对应频道，并具备读取频道和历史消息的权限。若频道消息内容返回为空，优先检查 Discord Developer Portal 里的 Message Content intent，以及该 Bot 在频道内的权限。

## 本地验证边界

`python3 -m http.server 8000` 只能预览静态页面，不能验证 Netlify Function 或 Discord API。

真实订阅链路需要部署到 Netlify 后测试：

```text
Discord API -> /api/discord-feed -> 文字兑换码列表
```
