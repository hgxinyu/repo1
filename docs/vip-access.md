# VIP 账号与权限

页面：

- 注册：`flipgame/Register.html`
- 登录：`flipgame/Login.html`
- 管理后台：`flipgame/Admin.html`
- VIP 页面：`flipgame/SoulAscensionCalculator.html`
- VIP 页面：`flipgame/ExpeditionCalculator.html`
- VIP 页面：`flipgame/AwakeningRushSimulator.html`

## 权限流程

```text
用户注册账号
用户填写 email / 公会名字 / ID 名字
系统写入 VIP 申请，默认 role=pending
管理员进入 Admin.html
管理员手动把账号设为 vip
用户登录后可访问 VIP 页面
```

## 角色

- `pending`：已提交申请，等待审核。
- `free`：普通用户。
- `vip`：可访问 VIP 页面。
- `admin`：管理员角色。
- `blocked`：禁用。

当前管理员身份不写在前端页面里，由 Netlify 环境变量控制：

```text
ADMIN_EMAILS=admin1@example.com,admin2@example.com
```

## API

- `POST /api/vip-request`：提交 VIP 申请。
- `GET /api/me`：读取当前登录用户和 VIP 权限。
- `GET /api/admin/users`：管理员读取申请列表。
- `POST /api/admin/set-role`：管理员修改用户角色。

用户资料存储在 Netlify Blobs 的 `vip-users` store 中，key 格式：

```text
users/{email}.json
```

## 部署要求

需要在 Netlify 启用 Identity，并配置环境变量：

```text
ADMIN_EMAILS=你的管理员邮箱
```

本地 `python3 -m http.server 8000` 只能预览静态页面，不能完整验证 Netlify Identity、Functions、Blobs。账号注册、登录、管理员后台和 VIP 权限需要部署到 Netlify 后测试。

## 安全边界

当前 VIP 页面使用前端权限门隐藏页面内容，并通过 `/api/me` 确认权限。这个方式适合第一版人工审核。

如果未来页面包含付费核心算法、高级数据或批量模拟结果，应把核心计算放到 Netlify Functions，由后端校验 VIP 后返回结果。纯静态 HTML 无法防止源码被复制。
