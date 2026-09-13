# AGENTS.md

ShineGame 的静态页面位于 `flipgame/`，游戏知识库位于 `IHassistant/`。默认尽量中文回复。

## 协作与按需读取

- 在本任务已授权范围内自主完成可逆工作。技能的通用步骤按任务选择；不因关键词、工具次数或“可能相关”叠加预读、规划、TDD、评审代理或设计审批。明确指定的流程与实际安全、权限、平台要求仍须遵守。
- 本项目使用已配置的登录架构，不因通用平台技能的宽泛触发条件更换身份服务。通用技能是可选方法，不能扩大本次任务范围。
- 当前源码说明本地实现；线上行为以当前部署及必要的只读数据为准。历史设计、计划、旧验证和记忆用于定位，不能作为已实现或已发布的证明。文档与实现冲突时说明差异。
- 问题查询以给出有证据的结论为完成；实施任务需完成受影响行为的验证和必要修复。通过后只因新问题扩大检查，不停在未经验证的首稿。
- 保留无关 dirty 改动。计划与进度按交接需要记录，优先复用当前任务记录；不把不同任务持续追加成一个“最新状态”。

只读与本任务相关的资料：

| 任务 | 入口 |
| --- | --- |
| 网页设计、视觉小修 | `web-design-quality`；沿用现有品牌与单文件页面模式 |
| 登录、VIP、管理员、账号查询 | [当前权限说明](docs/vip-access.md)；只读诊断见 [账号排查](docs/account-diagnostics.md) |
| 游戏机制、计算器规则、阵容、知识维护 | [游戏工作规则](IHassistant/AGENTS.md)，再读对应机制笔记或 `docs/*-calculator.md` |
| 打牌周活动计算、方案比较、文案整理 | [打牌活动分析模块](skills/ih-guide-images/references/card-event.md)；纯分析不进入制图步骤 |
| 攻略图制作、修改、核对、整理 | [ih-guide-images](skills/ih-guide-images/SKILL.md)；周活动用其中固定 Discord 来源，纯网页代码调整不进入制图流程 |
| 发布与交接 | 本文件下方规则；历史发布记录不授予本次发布权限 |

## 项目与修改约定

- 页面是独立 HTML，无静态构建步骤；Functions 位于 `flipgame/netlify/functions/`，依赖在 `flipgame/package.json`。
- 可见文案同步 zh/en I18N。改计算规则同步对应 `docs/`；改登录、角色、权限同步 `docs/vip-access.md`；未来 VIP 知识库权限同时同步 `docs/ihassistant.md`。
- `IHassistant/` 不自动公开。未经明确要求，不将知识文件复制到公开或 VIP 页面。
- 游戏知识变更运行 `node scripts/build-ih-knowledge-index.mjs`；不要把站点维护文档加入游戏索引。
- 数据入口：魂力 `flipgame/soul_tiers.csv`；远征 `flipgame/seboss_all.json`；核心/神殿/命运 `docs/core-calculator.md` 与 `flipgame/destiny_temple_levels.json`。Excel 再生成时记录来源，浏览器最终使用 CSV/JSON。
- 攻略发布素材位于 `flipgame/images/`，原始知识截图位于 `IHassistant/knowledge/`。Logo、水印及双语验收规格集中在制图技能和 `docs/guide-images.md`。普通攻略的品牌底注并入已有说明卡；没有说明卡才用虚空入侵图的独立圆角底注样式。
- 不提交 `.DS_Store`、本地表格工作文件、临时截图或生成中间产物；明确用于发布的正式攻略图除外。

## 本地环境与验证

读取 CSV/JSON 的静态页面，从仓库根运行 `cd flipgame && python3 -m http.server 8000`，访问 `http://localhost:8000/`，不要用 `file://` 验证 fetch。

- 静态 `file://` / `:8000` 可显示 Local Admin；`Admin.html` 仅用 mock，不调用真实管理员 API 或写 Blobs。
- `:8888` 等 BFF 使用真实认证，无有效第一方 Cookie 时必须匿名，禁止 seed 或自动登录 Local Admin。已有有效会话正常恢复；新注册验收使用干净 profile，不靠删除开发账号。
- 项目不维护 stage。历史 stage 主机名、图标或记录不代表有隔离环境；任何配置不明的外部数据库或 Blob 写入都按生产写入处理。仅在核实独立开发资源后，才用于会写数据的测试。
- 验证受影响的行为：文案/链接做对应检查；视觉修改看实际浏览器；权限和数据脚本检查成功与拒绝路径。静态检查不能称为视觉、登录或生产验收。确认无生产访问的本地 fixture 测试可自主运行及修复本次引入的失败。

## Git / Deploy Rules

- This is a small project and does not maintain a `stage` branch or environment. After relevant local verification, push approved releases directly to `main`.
- A push to `main` is a production release and still requires the user's explicit current-turn authorization.
- Do not push after every small change by default. Netlify deploys consume credits on each push.
- Prefer batching related changes into one commit and one push after the user confirms the work is ready.
- Do not carry push, commit, production deploy, or Netlify deploy permission across turns. Even if the user asked to push earlier, require an explicit current-turn request before committing, pushing, or deploying again.
- If the user explicitly asks to push, push only the intended staged changes and leave unrelated dirty worktree changes alone.

## Session Handoff

- If `HANDOFF.md` exists, read it before making changes.
- Use `HANDOFF.md` only for unfinished work that needs to continue in another session; do not create one for every completed session.
- Keep only one current handoff file. Update it before ending an incomplete task instead of accumulating dated handoff files.
- Record the objective, completed work, remaining work, changed files, verification results, dirty-worktree boundaries, exact next steps, and actions that must not be taken.
- Delete `HANDOFF.md` after the work is completed and the durable decisions are documented in the appropriate `README.md`, `AGENTS.md`, or `docs/` file.
- Never store passwords, API keys, tokens, production data, or other secrets in `HANDOFF.md`.
