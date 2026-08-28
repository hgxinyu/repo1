# VIP 账号与权限

页面：

- 注册：`flipgame/Register.html`
- 登录：`flipgame/Login.html`
- 管理后台：`flipgame/Admin.html`
- 注册会员页面：`flipgame/SoulAscensionCalculator.html`
- 注册会员页面：`flipgame/ExpeditionCalculator.html`
- 注册会员页面：`flipgame/AwakeningRushSimulator.html`
- VIP 页面：`flipgame/AIAsk.html`（AI玩放置 / Play IH with AI）

## 权限流程

```text
用户通过第一方登录链路建立 accounts 账号
用户填写公会名字 / ID 名字
系统按当前 session accountId 写入 VIP 申请；active/free 账号通过数据库受控边界转为 pending，重复申请对 pending/vip/admin 幂等
管理员进入 Admin.html
管理员按 accountId 手动把账号设为 vip
管理员可将目标账号审计化禁用（保留账号、迁移和审计历史）
管理员可在 Admin.html 维护升格和觉醒使用的资质价格
用户登录后可访问注册会员页面（包括觉醒冲榜模拟器）
用户登录后可访问注册会员页面（包括凝魂魂力、远征积分和觉醒冲榜模拟器）
VIP 账号可额外访问 AI玩放置
```

## 浏览器登录与 session

- 登录和注册页只提供 Google 与邮箱验证码两个 Logto Hosted UI 入口；Hosted UI 负责登录/注册区分及验证码输入，不在页面收集密码，也不宣称 Apple、QQ 或微信已可用。
- 新链路由第一方 BFF session 绑定稳定 `accountId`；账号、角色和状态从数据库映射读取，不从客户端 email、role 或 emailVerified 推断权限。浏览器通过 `GET /api/auth/session` / `GET /api/me` 获取能力快照，异常或不完整响应一律按未认证处理。
- 首页、会员页、VIP 页和管理后台加载时会先读取第一方 session；迁移窗口内的旧 Netlify Identity session 只能通过 `/api/auth/legacy-bridge` 服务端验证并兑换，再读取 `/api/me` 权限。
- bridge 成功前不会把旧 Identity token 复制到 JavaScript 可读 cookie；只有服务端确认兑换成功后，才清理 `gotrue.user`、`nf_jwt` 和 `nf_refresh`。bridge session 的 idle TTL 为 14 天，absolute expiry 不得超过迁移窗口。
- VIP 或管理员账号登录首页后，右上角账号按钮会显示醒目的 `VIP` 标记；普通注册会员和待审核账号不显示该标记。
- 会员页和 VIP 页在 session 恢复与权限检查完成前只显示检查状态；确认未登录后才显示登录/注册入口。静态 `file://` / `:8000` 预览才使用本地 Mock；`localhost:8888` 的 Netlify local BFF 仍执行真实认证检查。

## 旧账号认领与首次登录 / Legacy verified-email claim

迁移窗口内，首次成功的 Google 或邮箱验证码登录在完成 OIDC issuer、audience、nonce、交易和“邮箱已由 provider 验证”等检查后，固定按下面顺序处理：

1. 已经绑定的用户按当前环境/site 下的 Logto `sub` 查找 `auth_identities`，直接解析到原有 `account_id`；不因邮箱变化而新建账号。
2. 尚未绑定 `sub` 时，如果导入结果中恰好有一个 active、已验证的邮箱匹配，则认领这个永久的旧 `account_id`，保留旧角色、状态、guild、game name、资料和审计/迁移记录；provider 传入的 `role`、`status` 或 profile 不能覆盖这些字段。
3. 没有邮箱匹配时，只有精确的 `(source, environment_id, site_id)` migration batch 已为 `reconciled`，才创建一个新的 `free / active` 账号。账号、邮箱和 Logto identity 在第一个数据库事务中永久写入；第一方 session 在该事务成功后由独立的第二个事务创建。若 session 事务失败，用户可安全重试登录，已绑定的永久 identity 会被复用，不会重复建号。
4. batch 缺失、仍在导入、计数不一致或有冲突时，返回可重试的 `503 MIGRATION_NOT_READY`，不写入账号/identity/session，也绝不把用户当成新用户而重复建号。
5. 邮箱匹配不唯一、账号 blocked/inactive，或 `sub` 与别的账号冲突时，fail closed 返回脱敏的 `409` recovery 响应，不写入账号、identity 或 session。

During the migration window, a first successful Google or email-code login performs the same ordered flow after the issuer, audience, nonce, transaction, and provider-verified-email checks:

1. An existing user resolves by the scoped Logto `sub` in `auth_identities` to the permanent `account_id`; an email change does not create a new account.
2. For an unbound `sub`, exactly one imported active account with a verified email match claims the old permanent `account_id`. Its role, status, guild, game name, profile, audit history, and migration link are preserved; provider input cannot supply or override role/profile state.
3. With no email match, a new `free / active` account is created only after the exact `(source, environment_id, site_id)` migration batch is `reconciled`. Account, email, and Logto identity are committed in the first database transaction; the first-party session is created in a separate second transaction. If session creation fails, login can be retried safely and the permanent identity is reused without another account.
4. A missing, incomplete, mismatched, or conflicted batch returns retryable `503 MIGRATION_NOT_READY`, writes no account/identity/session, and never creates a duplicate account.
5. An ambiguous email, blocked/inactive account, or conflicting `sub` fails closed with a sanitized `409` recovery response and no account/identity/session write.

本地开发 / Local development：连接 development DB 的 BFF 在浏览器没有有效第一方 session cookie 时从匿名状态启动，不 seed 或自动登录默认 `Local Admin`。只有显式的 runtime-only synthetic fixture harness 才能写入被精确绑定的 `local-test`；`localhost:8888` 执行真实认证，`file://` / `:8000` 才使用静态 Mock。

## 角色

- `pending`：已提交申请，可访问注册会员页面，等待 VIP 审核。
- `free`：普通注册用户，可访问注册会员页面。
- `vip`：可访问注册会员页面和 VIP 页面。
- `admin`：管理员角色，可访问注册会员页面、VIP 页面和管理能力。
- `blocked`：禁用，不可访问注册会员页面、VIP 页面或管理能力；阻断状态优先于其他角色能力。

权限能力由统一角色矩阵计算：`pending`、`free`、`vip`、`admin` 的注册会员能力分别为可、可、可、可；仅 `vip` 和 `admin` 可访问 VIP 页面；仅 `admin` 具备管理能力。账号角色为 `blocked`，或账号状态不是 `active`（包括 `blocked`、`disabled`、`merged`）时，所有受保护能力均关闭。管理员身份来自 `accounts.role`，不再由 `ADMIN_EMAILS` 或客户端邮箱决定。

## API

- `GET /api/auth/session`：读取当前第一方 session 的 `accountId` 与能力快照；匿名、失效或响应格式异常时，浏览器端按未认证处理。
- `POST /api/vip-request`：提交 VIP 申请。
- `POST /api/auth/legacy-bridge`：在迁移窗口内，用服务端验证的 immutable Netlify user ID 将旧 session 一次性兑换为第一方 `legacy_bridge` session；要求可信 Origin 和 CSRF，拒绝 email-only fallback。
- `GET /api/me`：读取当前登录用户、注册会员状态和 VIP 权限。响应使用稳定 `accountId`，只返回 `primaryEmailMasked`，不返回完整 email。
- `GET /api/quality-prices`：读取升格和觉醒使用的当前资质价格；未保存后台价格时返回静态默认值。
- `POST /api/ai-chat`：VIP 调用 AI玩放置，后端代理 DeepSeek API。VIP 每个 UTC 小时最多提问 10 次，管理员账号不受限制；计数以数据库 `(account_id, hour_start)` 原子 upsert 保存，不读取旧 email Blob bucket。
- `GET /api/admin/users`：管理员按 accountId 读取申请列表，带有界 limit。
- `POST /api/admin/set-role`：管理员按 accountId 修改角色；数据库递增 `authz_version` 并写审计记录，降权或禁用时撤销目标账号的当前环境/site active sessions。
- `POST /api/admin/delete-user`：管理员按 accountId 审计化禁用目标账号，不物理删除账号、迁移记录或审计历史；管理员不能禁用或删除自己。
- `GET /api/admin/quality-prices`：管理员读取资质价格；响应不包含 `updatedBy` 或存储错误细节。
- `POST /api/admin/quality-prices`：管理员保存 `starDiamondBoundDiamondRatio`、各资质 `foodPrice` 和 `keptPrice`。
- `GET /api/admin/traffic?days=7|30|90`：管理员读取按国家聚合的页面访问量、每日趋势和热门页面。

所有 cookie-backed POST（VIP 申请、AI 问答和管理员写操作）都要求浏览器自动提供可信 `Origin`，并由共享浏览器客户端把可读 CSRF cookie 复制到 `X-CSRF-Token`；缺少或不匹配时 fail closed。前端客户端不会手动设置 `Origin`，也不会持久化 session/provider token。

VIP 申请和管理员授权变更只通过数据库的 `SECURITY DEFINER` 边界执行。迁移会撤销 `PUBLIC` 的执行权限；部署时必须只向受信任的非 owner BFF 数据库角色显式授予 `request_account_vip` 与 `set_account_authorization`，不能向 `PUBLIC` 授权。

生产数据库的 BFF 角色由 `202608280001_auth_bff_runtime_role.sql` 固定为
`shinegame_auth_bff`。该 migration 不创建角色、不接触密码；数据库 owner
必须先在数据库外 provision 一个专用、非 owner、`NOINHERIT` 角色（local
smoke 使用 `NOLOGIN`；生产连接若需要 `LOGIN`，其认证凭据也必须在该
migration 外管理），并确保它没有 superuser、role/database creation、replication、bypass-RLS、
角色继承或 public application object ownership 能力。migration 只授予：
public schema/type usage；运行时 auth 表所需的 SELECT；账号/邮箱/identity/
OAuth transaction/session/AI 限流的精确列级 INSERT/UPDATE；以及
`request_account_vip`、`set_account_authorization` 两个已验证
`SECURITY DEFINER` 函数的 EXECUTE。`auth_migration_batches` 与
`migration_records` 仅可读，审计/context/merge 表、授权直接变更和 migration
写入保持 owner-only。BFF 运行时必须通过受控的该角色上下文执行数据库请求，
不得使用 Neon owner 作为应用运行角色；部署前应重跑 PostgreSQL role smoke。

其中，BFF 没有 `accounts` 表的直接 `INSERT` 权限。新账号只能调用
`public.create_free_account(text, text)`；这是 `SECURITY DEFINER` 函数，只接收
公会和游戏名，并在函数体内固定写入 `role=free`、`status=active`。该函数的
`EXECUTE` 权限先从 `PUBLIC` 撤销，再只授予 `shinegame_auth_bff`；管理员、VIP、
blocked 或其他授权状态不能通过新账号创建路径伪造。账号、主 email 与 Logto
identity 仍在同一个 BFF 数据库事务中写入。

账号资料和主 email 映射存储在第一方数据库 `accounts` / `account_emails` 表中；主 email 在服务端加密保存，只在 `/api/me` 以掩码形式返回。Task 9 迁移的受保护 API 不读取或写入旧 `vip-users` email Blob，也不把 email 当作授权主键。

资质价格存储在 Netlify Blobs 的 `quality-prices` store 中，key 为 `current.json`。`flipgame/quality_prices.json` 仍保留为默认值和本地静态服务器回退。

访问流量由 `netlify/edge-functions/track-traffic.js` 在成功的 HTML 页面请求上采集。只记录 UTC 日期、小时、国家代码和页面路径，不保存 IP、邮箱、Cookie 或设备指纹。数据按小时写入 Netlify Blobs 的 `site-traffic` store；后台可查看最近 7、30 或 90 天。由于 Blobs 不提供原子自增，同一国家在同一小时内的并发请求可能造成少量低估，因此该页用于站点趋势观察，不作为计费级统计。

## Logto 迁移状态

- 新登录链路由 ShineGame BFF 对接 Logto；第一阶段启用 Google 与邮箱验证码，QQ 暂停。
- OAuth 一次性 transaction 同时保存 nonce 哈希和加密 nonce：哈希用于发现篡改，加密原值仅在原子消费 transaction 后交给 OIDC 客户端验证 ID Token。
- PKCE verifier、nonce、Logto refresh token 都只在服务端加密保存，不进入浏览器存储、URL、日志或文档。
- 旧 Netlify Identity session 在迁移窗口内通过受限 bridge 兑换为第一方 session；账号关联以稳定 `account_id` 为准，不以可变邮箱作为长期主键。
- Task 9 已将 `/api/me`、VIP 申请、管理员账号/角色/删除、价格、流量和 AI 限流接入 `resolveAuthContext` / `requireCapability`；旧 email/`ADMIN_EMAILS`/Identity/用户 Blob 不再作为这些 API 的授权来源。
- AI 限流表按 `(account_id, hour_start)` 原子 upsert；管理员不消耗额度。旧 `ai-question-limits` email bucket 不读不写。
- Task 10 已完成登录/注册页面、共享浏览器 session/CSRF 客户端、能力驱动 guards 与受保护 POST 接线；Task 4/5 已在 Neon `local-test` 通过真实 Google legacy verified-email claim、VIP/profile 保留、重复登录和 unmatched readiness matrix。邮箱 OTP 的真实 delivery/callback 与 genuinely fresh-profile HTTPS stage callback 仍是发布前 gate。
- Production Google OAuth 的公开资料固定使用 `https://shinegame.pro/`、`https://shinegame.pro/Privacy.html` 和 `https://shinegame.pro/Terms.html`；两份政策页均提供中英文版本，并从登录与注册页可达。Google consent screen 只请求 `openid profile email`，不得为通过发布检查临时增加未使用的敏感 scope。
- Production import and finalization share one `(source, environment, site)` advisory-lock namespace. Import locks and reads the exact batch before any row write and refuses any reconciled/completed scope. Finalization holds that same lock while it locks and compares the full source/snapshot migration population, validates ordered migration completion evidence and the committed `accounts`、verified primary `account_emails` 和 active legacy `auth_identities`, constructs and deep-freezes the complete reconciliation report and completion time internally, then persists the batch. Read-only diagnostics, caller objects, serialized reports, and imported JSON cannot authorize finalization. Snapshot/review files are exclusive-create mode `0600`; CLI stdout contains only redacted counts, hash, and status.

## 部署要求

Functions 运行环境需要配置与当前部署完全匹配的认证边界：

```text
AUTH_ENV_ID=当前环境标识
AUTH_EXPECTED_SITE_ID=当前 Netlify site 标识
NETLIFY_SITE_ID=当前 Netlify site 标识
NETLIFY_DB_URL=第一方数据库连接
LOGTO_ENDPOINT=规范化 Logto OIDC issuer
LOGTO_APP_ID=Logto 应用 ID
LOGTO_APP_SECRET=Logto 应用 secret
AUTH_HMAC_KEY=32 字节认证 HMAC key
AUTH_ENCRYPTION_KEY=32 字节认证加密 key
AUTH_ENCRYPTION_KEY_VERSION=1
AUTH_TRUSTED_ORIGIN=https://当前站点域名
DEEPSEEK_API_KEY=DeepSeek API key
```

迁移窗口仍启用旧 Identity bridge 时，还需配置对应的服务端 Identity 校验地址和迁移窗口；这些值只应进入部署环境，不写入仓库。管理员角色由 `accounts.role` 管理，不配置 `ADMIN_EMAILS`。

价格数据仍使用 `quality-prices/current.json` 作为站点存储；这只是价格数据存储，不是身份或授权来源。流量统计仍使用 `site-traffic` Blob，管理员 API 会先完成第一方授权再读取。

旧 Netlify Identity 仅保留迁移窗口内的 legacy bridge：服务端验证已经存在的旧 session，并将其一次性兑换为第一方 session。新用户不得再通过旧 Identity 注册，旧注册/密码 UI 也不再暴露；新账号统一从 Logto Hosted UI 进入。cutover 与冻结策略以迁移文档和 `MIGRATION_WRITE_MODE` 为准。

本地 `python3 -m http.server 8000` 只能预览静态页面，不能完整验证 Functions、Blobs 或登录。账号注册、登录、真实管理员后台、注册会员权限和 VIP 权限需要 Netlify local runtime（例如 `localhost:8888`）或部署后测试。

首页在 `file://` 或文档约定的静态预览端口 `:8000`（包括 `localhost`、`127.0.0.1`、`0.0.0.0`、`::1` 和私有局域网 IPv4）下会默认显示 `Local Admin` 和右上角管理后台入口，方便电脑或手机打开本地后台 UI。`localhost:8888` 等 Netlify local runtime 不会被当作 Mock。

连接 Neon `local-test` 等 development-branch 数据库的本地 BFF 必须在浏览器没有有效第一方 session Cookie 时保持匿名，禁止 seed 或自动登录 `Local Admin`。浏览器已有的有效 session 可以按正常产品逻辑恢复；测试全新注册应使用无 Cookie 的浏览器 profile/incognito 窗口，不能靠服务器启动时静默删除 development 账号。

`Admin.html` 在同样的 `file://` / `:8000` 静态预览模式下会进入本地 Mock，只渲染示例用户、本地 `quality_prices.json` 价格和示例流量。Mock 模式不会读取真实身份状态，不会调用 admin API，也不会写入 Netlify Blobs。用户审核、资质价格和流量统计由侧栏切换为三个独立 workspace，当前 workspace 内的面板默认展开。

为了方便本地静态预览，会员页和 VIP 页仅在 `file://` / `:8000` 下跳过前端权限门；`localhost:8888` 等 credentialed local BFF runtime 仍必须登录并通过 `/api/auth/session` / `/api/me` 能力检查。

## 安全边界

当前注册会员页面和 VIP 页面使用前端权限门隐藏页面内容，并通过 `/api/me` 确认权限。这个方式适合第一版人工审核。

如果未来页面包含付费核心算法、高级数据或批量模拟结果，应把核心计算放到 Netlify Functions，由后端校验 VIP 后返回结果。纯静态 HTML 无法防止源码被复制。
