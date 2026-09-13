# Logto 统一登录与平滑迁移设计

日期：2026-08-25

状态：用户已确认聊天中的四部分设计；已完成主控与 multi-agent 自审，待用户审阅本文档

范围：`flipgame/` 登录、账号、VIP、管理员鉴权与旧 Netlify Identity 迁移

## 2026-08-26 范围修订

- 首期登录方式改为 **Google OAuth + 邮箱一次性验证码**。
- QQ OAuth 暂停：当前无法完成 QQ Connect 登录，本轮不创建/保存 QQ connector，也不把 QQ 验证作为上线门槛。
- 微信登录只是未来候选，不能直接替代 QQ。若以后启用，必须单独验证开放平台资质、网站应用审核、回调域名、subject/openid/unionid 语义、账号绑定与重复账号修复流程。
- 下文涉及 QQ 的设计保留为未来参考，但不属于当前首期实施和验收范围；所有首期页面文案、测试矩阵和发布证据以 Google + 邮箱验证码为准。

## 1. 目标

把当前以 Netlify Identity 和邮箱为中心的账号体系迁移到 Logto，首发支持：

- Google OAuth，面向海外用户；
- 邮箱一次性验证码，作为通用入口、旧账号迁移和恢复方式；
- QQ OAuth 暂停，国内用户首期使用邮箱验证码；
- 未来取得 Apple Developer 资质后增加 Apple 登录，不再次迁移业务账号。

迁移应尽量无感：账号资料、VIP 和管理员角色在上线前后台迁移；仍持有旧 session 的用户由后端验证旧身份并直接换成第一方 bridge session，无需输入密码或验证码；已经退出的用户通过正常邮箱验证码或 Google 登录进入，不显示专门的迁移向导。

## 2. 非目标

- 本期不启用 Apple 登录。
- 本期不接入微信登录。
- 不把 VIP、管理员或封禁规则迁入 Logto RBAC。
- 不长期并行维护两套业务账号源。
- 不保存 Google、QQ 或 Apple 的 provider access token；未来若要调用第三方 API，须另行设计并取得授权。
- 不在本设计阶段提交、推送或部署代码。

## 3. 当前系统约束

当前账号资料保存在 Netlify Blobs 的 `vip-users` store，key 为 `users/{normalizedEmail}.json`。`pending`、`free`、`vip`、`admin`、`blocked` 角色，管理员邮箱、AI 限流和多个受保护页面均依赖 email 或 Netlify Identity user。

当前实现还存在必须随迁移一起关闭的边界：`vip-request.mjs` 接受未经认证的 email/profile 写入；`me.mjs` 在 profile 缺失时构造 free/admin fallback；`ADMIN_EMAILS` 可以先于 profile role 产生管理员或 Premium 能力；旧 token 存在 `gotrue.user`、`nf_jwt`、`nf_refresh` 和 recovery URL 中。新系统不得兼容这些放行语义。

主要耦合点包括：

- `flipgame/Login.html`、`flipgame/Register.html`；
- `flipgame/index.html`；
- `flipgame/assets/auth-session.js`、`flipgame/assets/vip-guard.js`；
- `flipgame/AwakeningRushSimulator.html`、`flipgame/SoulAscensionCalculator.html`、`flipgame/ExpeditionCalculator.html`、`flipgame/AIAsk.html`、`flipgame/Admin.html`；
- `flipgame/netlify/functions/_shared/access.mjs`；
- `me.mjs`、`vip-request.mjs`、`admin-users.mjs`、`admin-set-role.mjs`、`admin-delete-user.mjs`；
- `admin-quality-prices.mjs`、`admin-traffic.mjs`、`ai-chat.mjs`；
- `_shared/quality-prices.mjs` 中基于管理员 email 的审计字段；
- `flipgame/package.json`、`flipgame/package-lock.json` 和根 `netlify.toml`；
- 引入 Netlify Identity 的会员页和管理员页；
- `docs/vip-access.md`。

Stage 与 production 数据尚未完全隔离。开发验证不得对真实 `vip-users` 写入测试账号或迁移标记。

正式 access matrix 以根 `AGENTS.md` 和 `docs/vip-access.md` 为准：Soul Ascension、Expedition 和 Awakening Gala Simulator 是 registered-member 页面；AIAsk 是 VIP-only 页面；Admin 是 admin-only 页面。README 或功能文档中的旧描述必须同步修正。`blocked` 在所有页面和 API 上优先于其他角色，包括 admin。

## 4. 核心架构

### 4.1 职责边界

Logto 只负责：

- Google、QQ、邮箱验证码及未来 Apple 身份验证；
- OAuth/OIDC 流程；
- Logto 用户和多种登录身份的关联；
- Logto session/token 生命周期。

应用自己的事务型账号层负责：

- 永久 `accountId`；
- VIP、管理员和封禁状态；
- 公会、游戏昵称及业务资料；
- AI 使用限流；
- identity 到 `accountId` 的映射；
- 账号迁移、合并和审计。

### 4.2 永久账号标识与事务存储

每个业务账号生成与认证供应商无关的不可变 `accountId`。邮箱、Logto user ID 和 provider identity 都不是业务主键。

账号、identity 唯一索引、session、OAuth transaction、迁移状态和合并状态使用 Netlify Database（托管 Postgres），不使用 Netlify Functions 内存或 Netlify Blobs。原因是这些数据需要唯一约束、行锁和跨表事务；Blobs 保留给现有非事务型内容。

核心表：

```text
accounts
account_emails
auth_identities
auth_sessions
oauth_transactions
migration_records
account_merge_operations
```

关键约束：

```text
accounts.account_id                         PRIMARY KEY
account_emails.email_lookup_hash            UNIQUE
auth_identities(issuer_or_tenant, connector_scope, provider_subject) UNIQUE
auth_sessions.session_id_hash               UNIQUE
migration_records(source, source_user_id)   UNIQUE
```

`account_emails` 保存规范化邮箱的 HMAC lookup hash 和需要展示/发信时使用的加密邮箱；不把完整邮箱放进 key、URL 或普通日志。`auth_identities` 保存 issuer/tenant、connector target 或 provider client/app scope、provider subject、subject 类型（`sub`、`openid`、`unionid` 等）、Logto user ID、`accountId` 和状态。QQ identity 不使用裸 openid 跨 app 推断同一人，只有明确验证后才允许跨 app 合并。

`accounts` 保存 role、status、guild、gameName、`authzVersion`、`mergedInto` 和迁移审计。`migration_records` 保存 legacy Netlify user ID、legacy email hash、snapshot hash、migrationId、状态和错误。遇到唯一性冲突时事务回滚并 fail closed。

### 4.3 统一 AuthContext 与权限

所有 API 只接受服务端 session resolver 生成的统一 AuthContext：

```text
authSource: logto | legacy_bridge
accountId
sessionId
authnSubject
authzVersion
migrationId?
```

- `logto` session：Logto `sub` → `auth_identities` → `accountId`。
- `legacy_bridge` session：session 中保存的 immutable Netlify user ID → `migration_records/auth_identities` → `accountId`。
- email 只能用于 OTP 后的首次账号认领或受控恢复，不允许作为业务请求中的权限 fallback。
- legacy session 不伪装为 Logto grant，不保存 Logto subject，不进行 Logto refresh；注销只撤销 first-party bridge session 并清理旧 Netlify 浏览器状态。
- `canAccessPremium()`、`requireAdmin()`、registered-member gate 和 `blocked` 检查只基于 account record。
- `ADMIN_EMAILS` 仅在迁移期作为受控 bootstrap；稳定后使用不可变管理员 `accountId`，不允许通过更换邮箱获得管理员权限。
- AI 限流 key 从 normalized email 改为 `accountId`。
- AI 小时限流写入 Postgres 并用事务或原子 upsert 计数；旧 email bucket 不导入，只保留到其自然过期。管理员豁免来自 account role，不来自 email。
- 所有受保护 API 必须在每次请求时重新检查 `blocked` 和角色；有效 session 不覆盖业务封禁。
- `/api/me` 返回 `authenticated`、`accountId`、`role`、`canAccessRegistered`、`canAccessPremium`、`isAdmin` 等 canonical capabilities；前端 VIP 标记和页面 gate 只使用这些 capabilities，不再组合 raw role、email 或客户端推断。
- `/api/vip-request` 必须要求可信 session，并从 session 取得 `accountId`；客户端不得提交可信 email、role 或 emailVerified。

## 5. 登录与账号体验

### 5.1 统一登录入口

登录和注册使用 Logto Hosted UI 的同一流程。中文界面依次展示 QQ、Google、邮箱验证码；英文界面依次展示 Google、QQ、邮箱验证码。不按 IP 隐藏入口。应用通过 authorization URL 传递受 allowlist 限制的同源 `next`、locale 和 connector hint；不在本期自建 headless OTP 表单。

示意文案：

```text
使用 QQ 登录
使用 Google 登录
—— 或 ——
邮箱地址
获取验证码
```

`Login.html` 和 `Register.html` 的旧 URL 继续有效，统一进入 Logto 流程。登录完成后返回发起登录的原页面。

### 5.2 新用户

1. 用户通过任一入口完成身份验证。
2. 系统创建 Logto user、业务 `accountId` 和 identity mapping。
3. 认证完成后再收集公会和游戏昵称，不以此阻塞登录。
4. 普通注册会员功能立即可用。
5. VIP 申请与账号创建分离。

### 5.3 多身份关联

- Google 仅在返回已验证邮箱且与现有账号唯一匹配时允许自动关联。
- QQ 不依赖邮箱匹配；已有用户应从已登录账号中心发起 QQ 绑定。
- 账号中心允许查看、添加和移除登录方式，但不得移除最后一种可用的登录或恢复方式。
- 未来 Apple identity 关联到已有 Logto user 和同一 `accountId`。

### 5.4 重复账号合并

如果老用户在未迁移状态下直接用 QQ 创建空白账号，系统提供“验证原邮箱并合并”。执行前必须展示：

- 保留的原账号、角色和业务资料；
- 新增的 QQ 登录身份；
- 将停用的空白重复账号。

用户明确确认并完成原邮箱验证码后才执行。不得按昵称、公会名或相似邮箱自动合并。跨 Logto 与应用数据库不能形成单一事务，因此合并采用 durable saga：`pending → verified → locked → linking → account_committed → duplicate_disabled → completed|needs_repair`。每步幂等、可重试并保存源/目标快照；合并期间冻结源账号，任何时刻不得存在两个可访问同一 VIP 权限的账号。

QQ identity 已属于重复 Logto user 时，先在 development tenant 实测“解绑重复用户并重新授权目标用户”的完整流程。若 generic OAuth connector 不支持安全解绑/转移，saga 进入 `needs_manual_repair`：冻结空白重复账号及其业务权限，保留原 VIP 账号通过邮箱或 Google 访问；管理员不得后台伪造 identity transfer。用户重新授权且 provider 明确确认目标绑定后才完成合并。

## 6. 浏览器与服务端 session

采用 Backend for Frontend 模式：

1. 浏览器经 Logto 执行 Authorization Code flow；
2. callback Netlify Function 在服务端完成 code exchange；
3. 服务端验证 issuer、audience、JWKS、`state`、`nonce` 和 PKCE；
4. 浏览器仅得到随机第一方 session ID；
5. cookie 名使用 `__Host-shinegame_session`，设置 `Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/`，不设置 `Domain`；
6. 服务端 session 以 session ID 的 hash 为 key，保存 `authSource`、`accountId`、Logto subject 或 immutable legacy Netlify user ID、migrationId、加密 refresh token或服务端 token reference、创建/最近使用/idle/absolute expiry、撤销时间、`authzVersion` 和 refresh rotation version；
7. 登录 transaction 在数据库保存 hash 后的 state、nonce、PKCE verifier、environment、同源 next 和过期时间，消费后立即删除。

登录 transaction TTL 为 10 分钟；bridge transaction TTL 为 5 分钟；普通 session idle TTL 为 14 天、absolute TTL 为 30 天。refresh 使用数据库事务和行锁串行化，每次成功后旋转版本；检测到旧 refresh/rotation replay 时撤销整个 session family。

Logto access token、refresh token、QQ/Google token、验证码和密码不得写入 `localStorage`、`sessionStorage`、URL、前端日志或可公开读取的 Blob。

cookie 认证的写操作还必须验证 Origin 和 CSRF token。callback、bridge 和错误页返回 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`；生产启用 HSTS 和限制性 CSP。注销默认同时撤销应用 session 和对应 Logto grant；如果全局 Logto 注销不可用，至少撤销本应用全部 session 并明确记录。session 刷新失败、用户被封禁、`authzVersion` 变化或账号映射缺失时清除 cookie 并 fail closed。

## 7. 平滑迁移

### 7.1 写入冻结、snapshot 与业务账号迁移

- 先部署 `MIGRATION_WRITE_MODE=legacy|frozen|account` 控制。进入 `frozen` 后，旧 `vip-request`、Admin role/profile 修改和所有 `vip-users` 回写返回 maintenance 响应；此阶段不可跳过。
- 记录 `freezeAt`、snapshot ID 和 snapshot hash；冻结后才读取 snapshot，导入完成后再次做只读 reconciliation。
- 导出并加密备份现有 `vip-users` 和可读取的 Netlify Identity 用户元数据。
- 使用只读 snapshot 生成 dry-run 报告并为每个 legacy profile 生成 `accountId`。
- 以 immutable Netlify user ID 为 legacy identity 主键；仅在 verified email 唯一且无冲突时把 email 当迁移认领依据。
- 预创建业务 account、email lookup 和 Netlify identity mapping；保存 snapshot hash 和幂等 migration 状态，但不批量预创建 Logto 用户。
- 保持旧 `users/{email}.json` 不变，作为迁移核对依据。
- 导入与 reconciliation 通过后切换为 `MIGRATION_WRITE_MODE=account`；dual window 的所有业务写入只进入 Postgres，不双写旧 Blob。

迁移保留原角色，不自动升降级。`blocked` 仍为 blocked。异常邮箱、重复索引、缺少 identity 或不一致管理员记录逐项隔离，不猜测修复。

### 7.2 已登录用户的无感 bridge

迁移窗口内，浏览器若持有有效 Netlify session：

1. 调用 session bridge endpoint；
2. 后端创建 5 分钟一次性 bridge transaction，绑定旧 session hash、目标 environment、CSRF、同源 next 和预期 account；
3. 后端用 Netlify Identity 服务端能力验证旧 session，绝不信任前端提交的 email/user ID；
4. 通过 Netlify user ID 查 `migration_records/auth_identities` 得到 `accountId`，不在业务鉴权阶段使用 email fallback；
5. 事务消费 bridge transaction 并创建 `auth_source=legacy_bridge` 的第一方 session，重放必须失败；
6. 清除浏览器中的 `gotrue.user`、`nf_jwt`、`nf_refresh` 和 recovery URL；
7. 用户继续访问原页面，无需先取得 Logto session。

这条路径实现业务访问无感迁移，但不会伪造或后台替用户完成 Google/QQ 授权。legacy-bridged session idle TTL 为 14 天，absolute expiry 不超过 30 天迁移窗口且不可越过窗口刷新。用户下次主动登录、绑定 provider 或 session 到期时进入正常 Logto 流程。

本期不使用 Logto one-time token 实现 bridge，也不把 subject token 当浏览器登录凭证。

### 7.3 已退出用户

- 原邮箱验证码登录：Logto 完成 OTP 后，callback 取得已验证邮箱；若其 HMAC lookup 唯一命中尚未被其他 Logto user 认领的 legacy account，则在数据库事务中写入 Logto identity mapping 并继承原 `accountId`。
- Google 登录：只有 provider 返回 verified email、唯一命中 legacy account 且 Logto automatic linking 行为通过 development tenant 测试时，使用同一认领事务。
- QQ 登录：不能自动推断旧邮箱；用户须先恢复旧账号或完成明确的邮箱验证合并。

认领事务检查 email 唯一性、legacy role、现有 Logto mapping、blocked 状态和 migration snapshot；冲突时不创建第二条可访问 VIP 的 mapping，返回账号恢复页。恢复页要求用户再次完成原邮箱 OTP，展示要认领的原账号和当前 Logto identity，并明确确认；成功后以同一事务绑定。Google 的 Logto automatic account linking 必须显式配置并测试；只接受 provider 明确声明 verified 的邮箱。

### 7.4 双认证窗口

使用仅由服务端环境控制的 `AUTH_MODE=legacy|dual|logto`：

- `legacy`：只允许已有 Netlify 用户恢复访问，禁止新注册；
- `dual`：后端可接受 Netlify 或 Logto session，并统一映射到 `accountId`；
- `logto`：仅接受 Logto/第一方 session。

双认证窗口固定 30 天。新注册只进入 Logto。旧业务资料保持只读，所有后续业务修改只写入 Postgres account record。

迁移监控至少包括：迁移账号数、旧 session 使用数、各入口成功率、账号合并数、孤立映射、权限拒绝、邮件投递失败和 callback 错误码。日志不保存 token、验证码、完整 callback 参数或不必要的个人信息。

### 7.5 关闭旧认证

满足以下全部条件后才切换为 `AUTH_MODE=logto` 并删除前端 Netlify Identity 入口：迁移窗口达到 30 天；连续 7 天 legacy bridge 占成功登录低于 1%；没有 unresolved VIP/admin identity collision；角色和账号数量核对通过；回滚演练完成。旧数据加密备份保留 90 天，之后经单独明确授权删除，不在切换当天删除。

## 8. 回滚

- QQ 或 Google 单一连接器异常：单独隐藏该入口，邮箱验证码继续工作。
- Logto 整体异常且仍在迁移窗口：切换 `legacy`，仅允许已有 Netlify 用户；暂停新注册，避免产生两套新账号。已有第一方 session 继续按 account record 鉴权到自身 expiry。
- 业务账号和权限已经独立于认证入口，认证回滚不回滚 account records。
- 所有迁移写入包含 `migrationId`、源记录和时间戳；禁止自动 destructive rollback。
- 一旦 Logto 新用户开始产生业务资料，不允许把整个业务源切回 email-key legacy records。
- 回滚时 account database 始终是唯一业务 source of truth；旧 `vip-users` 不恢复写入。新 Logto-only 用户不得被路由到 Netlify Identity。

## 9. API 合同

现有接口保持 URL 兼容，但内部目标全部改为 accountId，响应由后端 canonical capabilities 驱动：

- `GET /api/me`
- `POST /api/vip-request`
- `POST /api/ai-chat`
- `GET /api/admin/users`
- `POST /api/admin/set-role`
- `POST /api/admin/delete-user`
- `GET|POST /api/admin/quality-prices`
- `GET /api/admin/traffic`
- `GET /api/quality-prices`

新增路由族：

- `/api/auth/sign-in`、`/api/auth/callback`、`/api/auth/session`、`/api/auth/logout`；
- `/api/auth/legacy-bridge`；
- `/api/account/identities`、`/api/account/identities/link`、`/api/account/identities/unlink`；
- `/api/account/merge/preview`、`/api/account/merge/confirm`、`/api/account/merge/status`；
- `/api/admin/auth-migration/status`、`/api/admin/auth-migration/conflicts`。

所有 `next` 只接受同源相对路径并经过 allowlist；禁止 `//host`、scheme、反斜线和编码绕过。删除用户重新定义为停用业务 account 与撤销身份/session，不再仅按 email 删除一条 Blob profile。

## 10. 异常处理

- 用户取消 OAuth：返回原页面并显示“登录已取消”，不创建半成品业务账号。
- provider 暂时不可用：提供邮箱验证码备用入口。
- 邮件延迟：提供倒计时、重发和垃圾箱提示；响应不泄露邮箱是否存在。
- callback 配置错误：用户看到通用提示，内部记录无敏感参数的稳定错误码。
- identity mapping 缺失或冲突：拒绝会员权限，进入受控修复；不临时按 email 放行。
- VIP 迁移失败：保留旧记录并隔离账号；不降级为 free。
- account database、Logto 或邮件服务不可用：相关认证和受保护访问 fail closed。
- 已封禁用户从其他 provider 登录：映射回同一 `blocked accountId` 并拒绝访问。
- OTP 发送使用 Logto 的 CAPTCHA、identifier lockout 和 recipient rate limit，并增加应用层 IP/device abuse 控制；发送、重发、未知邮箱和错误响应保持统一语义与近似时序。

## 11. 测试与上线门槛

### 11.1 单元测试

- JWT、callback 和 session 校验；
- identity/account/email 索引唯一性；
- VIP、Admin、registered member、blocked 权限；
- 邮箱规范化；
- 迁移脚本幂等性；
- 重复邮箱和重复 identity 冲突；
- AI 限流使用 `accountId`。

### 11.2 API 集成测试

- Google、QQ、邮箱 callback；
- session 创建、刷新、注销和撤销；
- Netlify session bridge；
- 新账号创建与老 VIP 继承；
- 账号合并的确认、验证、原子性与失败恢复；
- provider 超时和错误；
- 管理员不能通过邮箱变更获得权限；
- 并发登录、建号、绑定和合并；在 saga 每一阶段注入崩溃后可恢复；
- bridge 重放、跨账号、已有其他 Logto session、恶意 next、referrer/history 泄漏全部拒绝；
- state、nonce、PKCE、CSRF、refresh rotation/replay 和 session family revoke。

### 11.3 浏览器验收

- 中文和英文；
- 桌面和手机；
- 登录后返回原页面；
- Google、QQ、邮箱验证码；
- 已登录老会员自动换 session；
- QQ 绑定和重复账号合并；
- 注销、重新登录和 session 过期；
- pending、free、vip、admin、blocked 权限；
- 旧 `gotrue.user`、`nf_jwt`、`nf_refresh` 和 recovery URL 被安全清理；
- local static Mock 与 Logto development integration 是两个明确模式。

### 11.4 迁移验收

- 迁移前后账号总数和各角色数量可核对；
- 每个账号恰有一个永久 `accountId`；
- 无孤立 VIP、无 identity 覆盖、无重复管理员；
- dry-run 与实际写入使用同一套转换逻辑；
- development/stage 使用独立 Logto tenant、OAuth app、Netlify Database branch/connection、M2M/session secrets 和 callback domain；
- 服务端启动时校验 environment/site/tenant/database sentinel，任何不匹配均 fail closed；stage bridge 永远不能指向 production；
- local static Mock 不调用真实认证 API；Logto development integration 使用本地/分支 Postgres 和 synthetic 用户，绝不导入真实用户或写 shared live 数据；
- production cutover 前完成真实回滚演练；
- `docs/vip-access.md`、README、Awakening 文档和 AI 文档与实际权限行为同步更新；
- `rg` 证明切换后不存在仍参与授权的 Netlify Identity、`gotrue.user`、`nf_jwt` 或 email-key authorization 路径。

## 12. 数据隔离与外部前置条件

实施和真实验收需要：

- Logto development 与 production tenant；
- Netlify Database（托管 Postgres）及 development/stage/production 隔离连接；该服务会消耗 Netlify credits，启用前需由用户明确授权；
- Google OAuth production credentials；
- 已审核的 QQ 互联网站应用及 App ID/App Key；
- 可用于生产的发信服务和域名 SPF、DKIM、DMARC；
- Netlify 环境中的 Logto、QQ、Google、session encryption/signing 和 M2M 凭证。

迁移脚本使用独立、最小权限的 M2M 凭证；runtime 不持有批量迁移权限。备份加密密钥与应用 runtime secret 分离，记录访问审计并做一次恢复演练。

缺少 QQ 资质时可以完成并验证其他架构，但 production 登录页不得展示无法工作的 QQ 入口。

## 13. 实施依赖顺序

1. 冻结 access matrix、canonical `/api/me` capabilities、role/status/blocked 不变量和 API 合同。
2. 建立 Netlify Database migration、环境 sentinel、account/identity/session/merge schema 与数据访问层。
3. 建立测试基础设施；当前仓库只有语法检查，不能直接宣称已覆盖单元或浏览器测试。
4. 部署 legacy 写冻结开关；冻结后做 snapshot/export、dry-run 转换器、导入与 reconciliation。
5. 在 Logto development tenant 完成 email OTP legacy claim、Google automatic linking、QQ connector 和 QQ 重复账号修复路径的阻塞试验。
6. 实现 BFF OAuth transaction、session、refresh、logout、CSRF 和 legacy bridge。
7. 实现统一授权上下文，再改造 `/api/me`、VIP、Admin、quality price、traffic 和 AI API。
8. 改造 Login/Register、首页、共享 guard、Awakening 独立 gate、Admin 和账号中心。
9. 实现 merge saga、迁移监控、环境健康检查和回滚控制。
10. 同步 `netlify.toml`、依赖、锁文件和权限文档，完成自动化与浏览器验收。
11. 用户审阅 dry-run 与冲突清单并明确授权后，才允许 production migration/cutover。

## 14. Multi-agent 实施边界

实施阶段使用一个主控和多个边界清晰的执行代理：

- 主控：维护本文档、拆解计划、决定共享接口、整合改动、处理冲突并执行最终验收；
- 账号/迁移执行代理：account store、索引、dry-run、导入和 session bridge；
- 登录体验执行代理：登录页、callback、账号中心、双语文案和返回原页面；
- 权限/测试执行代理：API 鉴权、VIP/Admin/blocked、限流、自动化测试和安全审查。

共享接口和 schema 由主控先确定。代理不得各自更改账号主键、session 格式或迁移语义；不得自行 commit、push、部署或写入 production 数据。
