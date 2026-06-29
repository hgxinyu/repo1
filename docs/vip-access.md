# VIP 账号与权限

页面：

- 注册：`flipgame/Register.html`
- 登录：`flipgame/Login.html`
- 管理后台：`flipgame/Admin.html`
- 注册会员页面：`flipgame/SoulAscensionCalculator.html`
- 注册会员页面：`flipgame/ExpeditionCalculator.html`
- VIP 页面：`flipgame/AwakeningRushSimulator.html`
- VIP 页面：`flipgame/AIAsk.html`（AI玩放置 / Play IH with AI）

## 权限流程

```text
用户注册账号
用户填写 email / 公会名字 / ID 名字
系统写入 VIP 申请，默认 role=pending
管理员进入 Admin.html
管理员手动把账号设为 vip
管理员可在 Admin.html 维护升格和觉醒使用的资质价格
用户登录后可访问注册会员页面
VIP 账号可额外访问觉醒冲榜模拟器和 AI玩放置
```

## 登录与密码重置

- 注册后必须先点击 Netlify Identity 发出的邮箱确认链接，确认后才能登录。
- 登录页提供“忘记密码？”入口，用户输入注册邮箱后，Netlify Identity 会发送密码重置邮件。
- 用户从密码重置邮件链接返回站点后，会进入设置新密码页面；完成后用新密码登录。
- 如果密码重置邮件默认跳回首页，首页会把 recovery token 转交给 `Login.html` 处理。
- 首页、会员页、VIP 页和管理后台加载时会先尝试恢复 Netlify Identity session，再读取当前用户和 `/api/me` 权限。
- VIP 或管理员账号登录首页后，右上角账号按钮会显示醒目的 `VIP` 标记；普通注册会员和待审核账号不显示该标记。
- 会员页和 VIP 页在 session 恢复与权限检查完成前只显示检查状态；确认未登录后才显示登录/注册入口。

## 角色

- `pending`：已提交申请，可访问注册会员页面，等待 VIP 审核。
- `free`：普通注册用户，可访问注册会员页面。
- `vip`：可访问 VIP 页面。
- `admin`：管理员角色。
- `blocked`：禁用。

当前管理员身份不写在前端页面里，由 Netlify 环境变量控制：

```text
ADMIN_EMAILS=admin1@example.com,admin2@example.com
```

## API

- `POST /api/vip-request`：提交 VIP 申请。
- `GET /api/me`：读取当前登录用户、注册会员状态和 VIP 权限。
- `GET /api/quality-prices`：读取升格和觉醒使用的当前资质价格；未保存后台价格时返回静态默认值。
- `POST /api/ai-chat`：VIP 调用 AI玩放置，后端代理 DeepSeek API。VIP 每小时最多提问 10 次，管理员账号不受限制。
- `GET /api/admin/users`：管理员读取申请列表。
- `POST /api/admin/set-role`：管理员修改用户角色。
- `GET /api/admin/quality-prices`：管理员读取资质价格和存储状态。
- `POST /api/admin/quality-prices`：管理员保存 `starDiamondBoundDiamondRatio`、各资质 `foodPrice` 和 `keptPrice`。

后台用户列表会显示邮箱确认状态：

- `已确认`：账号已完成邮箱确认。后台会优先读取 Netlify Identity 的当前 `confirmedAt` 状态，并同步回 `vip-users`。
- `未确认`：Netlify Identity 当前没有确认时间，或注册时返回未确认且尚未刷新到已确认。
- `未知`：旧资料或后台临时无法读取 Identity 状态。

用户资料存储在 Netlify Blobs 的 `vip-users` store 中，key 格式：

```text
users/{email}.json
```

资质价格存储在 Netlify Blobs 的 `quality-prices` store 中，key 为 `current.json`。`flipgame/quality_prices.json` 仍保留为默认值和本地静态服务器回退。

## 部署要求

需要在 Netlify 启用 Identity，并配置环境变量：

```text
ADMIN_EMAILS=你的管理员邮箱
DEEPSEEK_API_KEY=你的 DeepSeek API Key
```

Identity 设置建议：

```text
Registration = Open
Autoconfirm = Off
```

如果注册页只显示 `AuthError` 或提示不允许注册，优先检查 Identity 是否启用，以及 Registration 是否仍为 Invite only/Disabled。

本地 `python3 -m http.server 8000` 只能预览静态页面，不能完整验证 Netlify Identity、Functions、Blobs。账号注册、登录、真实管理员后台、注册会员权限和 VIP 权限需要部署到 Netlify 后测试。

首页在 `file://`、`localhost`、`127.0.0.1`、`0.0.0.0`、`::1` 下会默认显示 `Local Admin` 和 Admin Portal 入口，方便打开本地后台 UI。

`Admin.html` 在同样的本地地址下会进入本地 Mock 预览模式，只渲染示例用户和本地 `quality_prices.json` 价格。Mock 模式不会读取真实 Identity，不会调用 admin API，也不会写入 Netlify Blobs。后台两个主面板默认折叠，点击标题区域或“展开”按钮后查看内容。

为了方便本地静态预览，会员页和 VIP 页在 `file://`、`localhost`、`127.0.0.1`、`0.0.0.0`、`::1`，以及私有局域网 IPv4（`10.*`、`172.16.*` 至 `172.31.*`、`192.168.*`）下会跳过前端权限门。线上 Netlify 地址仍必须登录并通过 `/api/me` 权限检查。

## 安全边界

当前注册会员页面和 VIP 页面使用前端权限门隐藏页面内容，并通过 `/api/me` 确认权限。这个方式适合第一版人工审核。

如果未来页面包含付费核心算法、高级数据或批量模拟结果，应把核心计算放到 Netlify Functions，由后端校验 VIP 后返回结果。纯静态 HTML 无法防止源码被复制。
