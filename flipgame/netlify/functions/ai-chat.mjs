import { canAccessPremium, currentUser, json, normalizeEmail, readProfile } from "./_shared/access.mjs";
import { IH_KNOWLEDGE_CHUNKS } from "./_shared/ih-knowledge-index.mjs";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-flash";
const MAX_QUESTION_LENGTH = 1200;
const MAX_HISTORY_TURNS = 6;
const MAX_KNOWLEDGE_CHUNKS = 6;
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 8;
const rateBuckets = new Map();

const PUBLIC_CONTEXT = `
站点公开资料摘要：
- 这是放置奇兵工具站。首页是 flipgame/index.html。
- IHassistant/knowledge/ 是 VIP AI 可用的内部知识库。回答相关问题时只使用检索到的知识片段，不要超出片段内容补全。
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

function selectKnowledge(question) {
  const terms = queryTerms(question);
  if (!terms.length) return [];
  return IH_KNOWLEDGE_CHUNKS
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
    .slice(0, MAX_KNOWLEDGE_CHUNKS)
    .map((item) => item.chunk);
}

function knowledgeContext(chunks) {
  if (!chunks.length) {
    return "本次问题没有匹配到 IHassistant/knowledge/ 的相关片段。若问题超出公开工具文档，请回答待确认。";
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

function checkRateLimit(email) {
  const now = Date.now();
  const key = normalizeEmail(email) || "anonymous";
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt > WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return null;
  }
  bucket.count += 1;
  if (bucket.count > MAX_REQUESTS_PER_WINDOW) {
    return json({ error: "请求过于频繁，请稍后再试。" }, { status: 429 });
  }
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

  return { email, response: null };
}

export default async (req) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const auth = await requireVipUser();
  if (auth.response) return auth.response;

  const limited = checkRateLimit(auth.email);
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
        "你是国风 ShinE 放置奇兵工具站的 AI 问答助手。",
        "只基于下方公开资料摘要、检索到的 IHassistant/knowledge/ 片段、用户问题和对话上下文回答。",
        "知识库还在慢慢完善中，不要把没有录入的内容当成已知事实。",
        "如果问题涉及未检索到的知识、阵容结论、游戏机制细节或你没有资料支持的内容，明确说待确认，不要编造。",
        "把事实、推断和待确认内容分开。默认用用户正在使用的语言回答。回答要简洁、可执行。",
        PUBLIC_CONTEXT,
        "IHassistant/knowledge/ 检索片段：",
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
        temperature: 0.2,
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

  return json({
    answer,
    model,
    sources: selectedKnowledge.map((chunk) => ({ path: chunk.path, title: chunk.title })),
    usage: data.usage || null
  });
};

export const config = {
  path: "/api/ai-chat"
};
