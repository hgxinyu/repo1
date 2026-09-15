# VIP 申请回主页与管理员登录信息设计

## 目标

VIP 资料提交成功后返回主页，并沿用当前 first-party session；管理员会员列表显示每个账号最近一次成功登录的时间和粗粒度地点。

## 已确认行为

### VIP 申请

- `POST /api/vip-request` 仍由当前登录 session 的 `accountId` 处理，不新增客户端账号、角色或邮箱字段。
- API 成功后，`Register.html` 总是跳转到安全的站内目标；没有 `return_to` 时目标为 `/index.html`。
- 跳转使用同一站点的现有 Cookie，不退出、不重新走 Logto、不把凭据写入 localStorage/sessionStorage。
- 提交失败时停留在申请页，保留错误提示。

### 最近登录信息

- “上次登录”指最近一次成功创建 first-party app session，不使用会随请求续期的 `auth_sessions.last_seen_at`。
- `accounts` 保存 `last_login_at`、`last_login_country`、`last_login_region`、`last_login_city`。
- Logto callback 和 legacy bridge 两条成功登录路径都写入这些字段；读取 session、刷新 session、登出和 VIP 申请不会更新它们。
- 地点来自 Netlify function context 的可信 geo 信息；不接受浏览器提交的位置，不保存原始 IP、精确地址或设备指纹。
- 地点按“城市、州/省、国家”尽量显示，缺失部分省略；完全未知时显示“位置未知”。
- 时间以 UTC 存储，管理员页面使用浏览器本地时区格式化；从未登录显示“从未登录”。

### 管理员接口与页面

- `GET /api/admin/users` 继续只允许管理员访问，并为每个用户返回 `lastLoginAt` 和 `lastLoginLocation`。
- `lastLoginLocation` 为 `{ country, region, city }` 或 `null`，普通用户接口不暴露这些字段。
- `Admin.html` 在用户表增加“上次登录”单元格，桌面端显示时间和地点两行，移动端保持单列可读。
- 本地静态管理员预览和浏览器 fixture 同步覆盖“有登录记录”和“从未登录”两种状态。

## 安全与部署边界

- 数据库新增迁移必须纳入现有 Neon migration chain；BFF runtime 只获得更新四个登录元数据字段所需的最小权限。
- 生产数据库迁移需要在代码发布前由用户或既有发布流程应用；本轮只修改仓库，不连接或写入真实生产数据库。
- 隐私政策中明确说明保存有限的登录元数据和粗粒度地点。

## 验收标准

1. VIP 提交成功后默认到主页，失败不跳转；安全 `return_to` 仍可用。
2. 主页重新读取 session 后显示已登录账号，不出现重新登录入口。
3. 两条成功登录路径都记录时间和地点；session 读取/刷新不会改写登录时间。
4. 管理员 API 返回新字段，匿名、普通会员和非管理员仍不能读取管理员列表。
5. 管理员桌面与 390px/320px 页面均无横向溢出，未知值有明确文案。
6. 认证测试、页面契约测试、管理员浏览器测试、数据库迁移静态检查和 `git diff --check` 通过。
