import { getStore } from "@netlify/blobs";
import { canAccessPremium, currentUser, isAdminEmail, json, normalizeEmail, readProfile } from "./_shared/access.mjs";
import { IH_KNOWLEDGE_CHUNKS } from "./_shared/ih-knowledge-index.mjs";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-flash";
const MAX_QUESTION_LENGTH = 1200;
const MAX_HISTORY_TURNS = 10;
const MAX_KNOWLEDGE_CHUNKS = 6;
const MAX_VIP_REQUESTS_PER_HOUR = 10;
const RATE_LIMIT_STORE = "ai-question-limits";
const PINNED_KNOWLEDGE_ALIASES = [
  {
    path: "IHassistant/knowledge/artifacts/duanzuizhijian.md",
    aliases: ["duanzuizhijian.md", "断罪之剪", "命运裁断者", "剪刀", "粉三剪刀", "极3剪刀", "极三剪刀"]
  }
];

const PUBLIC_CONTEXT = `
站点公开资料摘要：
- 这是放置奇兵工具站。首页是 flipgame/index.html。
- 游戏相关 Markdown 文档和 IHassistant/knowledge/ 文本资料是 VIP AI 可用的内部知识库。回答相关问题时只使用检索到的知识片段，不要超出片段内容补全。登录、VIP、PWA、部署等网站维护文档不作为游戏知识来源。
- 当前知识库还很有限，正在逐步完善。答案只能代表已经录入和检索到的资料。
- 凝魂计算：当前总和 = x + y + 100*z；当前均值 = (x + y + 100*z) / 3。
- 游戏界面速度可能隐藏小数，凝魂页面会按 z 和 z+1 两组结果计算。
- X 资质：任意一维超过旧上限时进入 X 输入校验；有效 X 输入需要 x > 9900、y > 9900、z >= 99；9900,9900,99 固定视为 SSS 顶。
- 当前 X 目标均值：9900 + 100 * 60 / 3 = 11900。
- 远征积分：1 到 179 层显示万亿单位；180 到 200 层显示原始分数。剩余积分 = 当前层总积分 * 剩余血量百分比 / 100。
- 公会总分估算从 200 层开始逐层累计，输出所在层数和该层剩余进度，属于手动数据估算，可能有误差。
- 觉醒冲榜模拟器：每次觉醒消耗 100 绑钻，B+ 及以下分解返还绑钻，A- 及以上保留。
- 攻略图片页面集中展示 flipgame/images/ 下维护的攻略图，新增图片需要同步维护中英文标题。
`;

const STRICT_CONTEXT_RULES = `
硬性来源规则：
- 回答神器、英雄、Boss、机制、属性、百分比、层数、触发条件、文件内容时，只能使用下方检索片段明确写出的内容。
- 如果某个数值、层数、触发条件或机制没有在检索片段中出现，必须写“待确认”或“当前检索片段没有记录”，不得根据名称、常识、旧版本、外部记忆或相似机制补全。
- 如果用户问某个具体档案文件，优先使用该档案文件本身的片段，不要只根据 README 或索引清单回答。
- 不要把“文件存在”说成“文件内容如此”；具体内容必须来自对应档案片段。
- 不要在正文中列出来源路径、知识片段编号或模型名称；只直接回答问题。
`;

function queryTerms(question) {
  const lower = String(question || "").toLowerCase();
  const terms = new Set();
  for (const token of lower.match(/[a-z0-9][a-z0-9+._-]{1,}/g) || []) {
    terms.add(token);
  }
  const cjk = lower.replace(/[^\p{Script=Han}]/gu, "");
  for (let size = 2; size <= 4; size += 1) {
    for (let i = 0; i <= cjk.length - size; i += 1) {
      terms.add(cjk.slice(i, i + size));
    }
  }
  return [...terms].filter((term) => term.length >= 2);
}

function pinnedKnowledge(question) {
  const lower = String(question || "").toLowerCase();
  const pinnedPaths = PINNED_KNOWLEDGE_ALIASES
    .filter((item) => item.aliases.some((alias) => lower.includes(alias.toLowerCase())))
    .map((item) => item.path);
  if (!pinnedPaths.length) return [];
  return pinnedPaths
    .map((path) => IH_KNOWLEDGE_CHUNKS.find((chunk) => chunk.path === path))
    .filter(Boolean);
}

function selectKnowledge(question) {
  const terms = queryTerms(question);
  const pinned = pinnedKnowledge(question);
  const pinnedPaths = new Set(pinned.map((chunk) => chunk.path));
  if (!terms.length) return pinned;
  const ranked = IH_KNOWLEDGE_CHUNKS
    .filter((chunk) => !pinnedPaths.has(chunk.path))
    .map((chunk) => {
      const haystack = `${chunk.title}\n${chunk.path}\n${chunk.body}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (chunk.title.toLowerCase().includes(term)) score += 8;
        if (chunk.path.toLowerCase().includes(term)) score += 5;
        if (haystack.includes(term)) score += 1;
      }
      return { chunk, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, MAX_KNOWLEDGE_CHUNKS - pinned.length))
    .map((item) => item.chunk);
  return [...pinned, ...ranked].slice(0, MAX_KNOWLEDGE_CHUNKS);
}

function knowledgeContext(chunks) {
  if (!chunks.length) {
    return "本次问题没有匹配到游戏相关 Markdown 文档或 IHassistant/knowledge/ 的相关片段。若问题超出公开工具文档，请回答待确认。";
  }
  return chunks.map((chunk, index) => [
    `知识片段 ${index + 1}`,
    `来源：${chunk.path}`,
    `标题：${chunk.title}`,
    chunk.body
  ].join("\n")).join("\n\n---\n\n");
}

function env(name) {
  if (typeof Netlify !== "undefined" && Netlify.env) {
    return Netlify.env.get(name);
  }
  return process.env[name];
}

function cleanMessage(message) {
  const role = message && (message.role === "assistant" || message.role === "user") ? message.role : "";
  const content = String((message && message.content) || "").trim();
  if (!role || !content) return null;
  return { role, content: content.slice(0, MAX_QUESTION_LENGTH) };
}

function recentHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map(cleanMessage)
    .filter(Boolean)
    .slice(-(MAX_HISTORY_TURNS * 2));
}

function rateLimitStore() {
  return getStore({ name: RATE_LIMIT_STORE, consistency: "strong" });
}

function hourKey(now = new Date()) {
  return now.toISOString().slice(0, 13);
}

function nextHourIso(now = new Date()) {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next.toISOString();
}

async function checkRateLimit(email, isAdmin) {
  if (isAdmin) return null;

  const normalizedEmail = normalizeEmail(email);
  const now = new Date();
  const hour = hourKey(now);
  const key = `questions/${encodeURIComponent(normalizedEmail)}/${hour}.json`;
  const store = rateLimitStore();
  const current = await store.get(key, { type: "json" }).catch(() => null);
  const count = Number(current && current.count) || 0;

  if (count >= MAX_VIP_REQUESTS_PER_HOUR) {
    return json({
      error: `已达到每小时 ${MAX_VIP_REQUESTS_PER_HOUR} 个问题上限，请稍后再试。`,
      resetAt: nextHourIso(now)
    }, { status: 429 });
  }

  await store.setJSON(key, {
    email: normalizedEmail,
    hour,
    count: count + 1,
    updatedAt: now.toISOString()
  });
  return null;
}

async function requireVipUser() {
  const user = await currentUser();
  const email = normalizeEmail(user && user.email);
  if (!email) {
    return { email: "", response: json({ error: "请先登录后再使用 AI 问答。" }, { status: 401 }) };
  }

  const profile = await readProfile(email).catch(() => null);
  if (!canAccessPremium(profile, email)) {
    return { email, response: json({ error: "AI 问答当前为 VIP 专属，请先开通 VIP 权限。" }, { status: 403 }) };
  }

  return { email, isAdmin: isAdminEmail(email), response: null };
}

export default async (req) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const auth = await requireVipUser();
  if (auth.response) return auth.response;

  const limited = await checkRateLimit(auth.email, auth.isAdmin);
  if (limited) return limited;

  const apiKey = env("DEEPSEEK_API_KEY");
  if (!apiKey) {
    return json({ error: "AI 服务尚未配置 DEEPSEEK_API_KEY。" }, { status: 503 });
  }

  let body = {};
  try {
    body = await req.json();
  } catch (error) {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  const question = String(body.question || "").trim();
  if (!question) {
    return json({ error: "请输入问题。" }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return json({ error: `问题过长，请控制在 ${MAX_QUESTION_LENGTH} 字以内。` }, { status: 400 });
  }

  const model = DEFAULT_MODEL;
  const selectedKnowledge = selectKnowledge(question);
  const messages = [
    {
      role: "system",
      content: [
        "你是国风 ShinE 放置奇兵工具站的 AI玩放置助手。",
        "只基于下方公开资料摘要、检索到的游戏相关 Markdown / IHassistant 知识片段、用户问题和对话上下文回答。",
        "知识库还在慢慢完善中，不要把没有录入的内容当成已知事实。",
        "如果问题涉及未检索到的知识、阵容结论、游戏机制细节或你没有资料支持的内容，明确说待确认，不要编造。",
        "把事实、推断和待确认内容分开。默认用用户正在使用的语言回答。回答要简洁、可执行。",
        PUBLIC_CONTEXT,
        STRICT_CONTEXT_RULES,
        "游戏文档 / IHassistant 检索片段：",
        knowledgeContext(selectedKnowledge)
      ].join("\n")
    },
    ...recentHistory(body.history),
    { role: "user", content: question }
  ];

  let upstream;
  try {
    upstream = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 1100,
        temperature: 0,
        thinking: { type: "disabled" },
        stream: false
      })
    });
  } catch (error) {
    return json({ error: "AI 服务连接失败，请稍后再试。" }, { status: 502 });
  }

  const data = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    const message = data && data.error && data.error.message ? data.error.message : "AI 服务返回错误。";
    return json({ error: message }, { status: upstream.status });
  }

  const answer = data && data.choices && data.choices[0] && data.choices[0].message
    ? String(data.choices[0].message.content || "").trim()
    : "";
  if (!answer) {
    return json({ error: "AI 服务没有返回可用答案。" }, { status: 502 });
  }

  const response = { answer };
  if (auth.isAdmin) {
    response.model = model;
    response.sources = selectedKnowledge.map((chunk) => ({ path: chunk.path, title: chunk.title }));
    response.usage = data.usage || null;
  }
  return json(response);
};

export const config = {
  path: "/api/ai-chat"
};
