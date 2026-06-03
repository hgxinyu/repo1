# AI玩放置

页面：`flipgame/AIAsk.html`

访问权限：VIP。英文页面名称为 `Play IH with AI`。页面加载时会调用 `assets/vip-guard.js`，使用 `/api/me` 检查当前登录账号是否具备 VIP 或管理员权限。

后端接口：`POST /api/ai-chat`

## 当前范围

AI 问答回答这些范围内的问题：

- 游戏相关 Markdown 文档，例如计算器/模拟器规则和攻略图片文档。
- `IHassistant/knowledge/` 中已有的 Markdown/文本知识片段。

后端会从游戏相关 Markdown 文档和 `IHassistant/knowledge/` 文本资料生成私有知识片段索引，并按用户问题检索相关片段传给 DeepSeek。登录、VIP、PWA、部署等网站维护文档不进入游戏知识索引。当前资料库还很有限，正在逐步完善；没有检索到资料、资料不足或结论未验证时，后端 system prompt 要求回答 `待确认`，不要补全假设。

当前知识索引文件：

```text
flipgame/netlify/functions/_shared/ih-knowledge-index.mjs
```

该文件由游戏相关 Markdown 文档和 `IHassistant/knowledge/` 下的文本资料生成。更新游戏相关 Markdown 文档或知识库文本后需要重新生成该索引。

重新生成命令：

```bash
node scripts/build-ih-knowledge-index.mjs
```

如果从 `flipgame/` 目录操作，也可以运行：

```bash
npm run build:ih-knowledge-index
```

## 环境变量

Netlify Functions 需要配置：

```text
DEEPSEEK_API_KEY=你的 DeepSeek API Key
```

接口默认使用 `deepseek-v4-flash`。不要额外把模型名配置成 Netlify 环境变量，避免 secrets scan 把仓库里的模型字面量误判为环境变量泄漏。

## 安全边界

- API key 只放在 Netlify 环境变量里，不写入前端页面。
- `/api/ai-chat` 后端会检查 VIP 权限，非 VIP 账号不能调用。
- VIP 账号每小时最多提问 10 次，用于降低 token 误用和成本风险。
- 管理员账号不受 AI玩放置提问次数限制。
- 前端和后端最多保留最近 10 轮问答作为上下文，超过后会自动丢弃更早的问题和回答。
- 游戏相关 Markdown 文档和 `IHassistant/knowledge/` 文本不作为单独知识库页面直接公开；当前只打包到 Netlify Function 的私有索引里。

## 页面交互

- 在输入框按 Enter 会直接发送问题。
- 按 Shift+Enter 可在输入框内换行。

## 本地验证

普通静态预览：

```bash
cd flipgame && python3 -m http.server 8000
```

这个方式只能预览页面 UI，不能调用 Netlify Function。完整提问流程需要部署到 Netlify，或使用配置了 Identity、Functions 和环境变量的 Netlify 本地环境。
