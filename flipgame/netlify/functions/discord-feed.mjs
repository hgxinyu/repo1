import { getStore } from "@netlify/blobs";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const MAX_MESSAGES = 30;
const DEFAULT_MESSAGES = 12;
const CHANNEL_FOLLOW_ADD = 12;
const CACHE_STORE = "discord-code-feed";
const CACHE_TTL_MS = 60 * 60 * 1000;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(init.headers || {})
    }
  });
}

function env(name) {
  if (typeof Netlify !== "undefined" && Netlify.env) {
    return Netlify.env.get(name);
  }
  return process.env[name];
}

function clampLimit(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MESSAGES;
  return Math.max(1, Math.min(MAX_MESSAGES, parsed));
}

function cacheStore() {
  return getStore({ name: CACHE_STORE, consistency: "strong" });
}

function cacheKey(channelId, limit) {
  return `channels/${encodeURIComponent(channelId)}/limit-${limit}.json`;
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function displayName(author) {
  if (!author) return "Discord";
  return author.global_name || author.username || author.display_name || "Discord";
}

function cleanDiscordText(value) {
  return String(value || "")
    .replace(/<a?:[A-Za-z0-9_.~-]+:\d+>/g, "")
    .replace(/<[@#][!&]?\d+>/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function embedText(embed) {
  if (!embed || typeof embed !== "object") return "";
  const fields = Array.isArray(embed.fields)
    ? embed.fields.map((field) => [field.name, field.value].map(stringValue).filter(Boolean).join("\n")).filter(Boolean)
    : [];
  return [
    embed.title,
    embed.description,
    ...fields,
    embed.footer && embed.footer.text
  ].map(stringValue).filter(Boolean).join("\n\n");
}

function imageFromValue(value) {
  if (!value || typeof value !== "object" || !value.url) return null;
  return {
    url: stringValue(value.url),
    proxyUrl: stringValue(value.proxy_url),
    width: Number(value.width) || 0,
    height: Number(value.height) || 0
  };
}

function isImageAttachment(item) {
  const contentType = stringValue(item && item.content_type).toLowerCase();
  const filename = stringValue(item && item.filename).toLowerCase();
  return contentType.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(filename);
}

function attachmentImage(item) {
  if (!item || typeof item !== "object" || !isImageAttachment(item) || !item.url) return null;
  return {
    url: stringValue(item.url),
    proxyUrl: stringValue(item.proxy_url),
    width: Number(item.width) || 0,
    height: Number(item.height) || 0,
    filename: stringValue(item.filename)
  };
}

function messageImages(message) {
  if (!message || typeof message !== "object") return [];
  const embeds = Array.isArray(message.embeds) ? message.embeds : [];
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const images = [
    ...embeds.flatMap((embed) => [imageFromValue(embed.image), imageFromValue(embed.thumbnail)]),
    ...attachments.map(attachmentImage)
  ].filter((item) => item && item.url);
  return images.filter((item, index, arr) => arr.findIndex((candidate) => candidate.url === item.url) === index);
}

function messageText(message) {
  if (!message || typeof message !== "object") return "";
  const embeds = Array.isArray(message.embeds) ? message.embeds.map(embedText).filter(Boolean) : [];
  return cleanDiscordText([message.content, ...embeds].map(stringValue).filter(Boolean).join("\n\n"));
}

function snapshotText(message) {
  const snapshots = Array.isArray(message.message_snapshots) ? message.message_snapshots : [];
  return cleanDiscordText(snapshots
    .map((item) => messageText(item && item.message ? item.message : item))
    .filter(Boolean)
    .join("\n\n"));
}

function snapshotImages(message) {
  const snapshots = Array.isArray(message.message_snapshots) ? message.message_snapshots : [];
  return snapshots.flatMap((item) => messageImages(item && item.message ? item.message : item));
}

function normalizeMessage(message) {
  const text = cleanDiscordText([messageText(message), snapshotText(message)].filter(Boolean).join("\n\n"));
  const images = [...messageImages(message), ...snapshotImages(message)]
    .filter((item, index, arr) => arr.findIndex((candidate) => candidate.url === item.url) === index);
  return {
    id: stringValue(message.id),
    channelId: stringValue(message.channel_id),
    type: Number(message.type),
    author: displayName(message.author),
    timestamp: stringValue(message.timestamp),
    editedTimestamp: stringValue(message.edited_timestamp),
    text,
    images
  };
}

async function fetchDiscordMessages(channelId, token, limit) {
  const url = new URL(`${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}/messages`);
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url, {
    headers: {
      "Authorization": `Bot ${token}`,
      "Accept": "application/json"
    }
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data && data.message ? data.message : "Discord API 返回错误。";
    return { response: json({ error: message }, { status: response.status }) };
  }
  return { messages: Array.isArray(data) ? data : [] };
}

async function handleRequest(req) {
  if (req.method !== "GET") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const token = env("DISCORD_BOT_TOKEN");
  const channelId = env("DISCORD_CHANNEL_ID");
  if (!token || !channelId) {
    return json({
      error: "Discord 订阅尚未配置 DISCORD_BOT_TOKEN 和 DISCORD_CHANNEL_ID。",
      setupRequired: true
    }, { status: 503 });
  }

  const url = new URL(req.url);
  const limit = clampLimit(url.searchParams.get("limit"));
  const store = cacheStore();
  const key = cacheKey(channelId, limit);
  const cached = await store.get(key, { type: "json" }).catch(() => null);
  const now = Date.now();
  if (cached && cached.fetchedAt && now - Date.parse(cached.fetchedAt) < CACHE_TTL_MS) {
    return json({
      ...cached,
      cached: true,
      cacheExpiresAt: new Date(Date.parse(cached.fetchedAt) + CACHE_TTL_MS).toISOString()
    });
  }

  const discord = await fetchDiscordMessages(channelId, token, limit);
  if (discord.response) return discord.response;

  const messages = discord.messages
    .map(normalizeMessage)
    .filter((message) => message.id && message.type !== CHANNEL_FOLLOW_ADD && (message.text || message.images.length));

  const payload = {
    channelId,
    fetchedAt: new Date().toISOString(),
    cacheExpiresAt: new Date(now + CACHE_TTL_MS).toISOString(),
    cached: false,
    mode: "text",
    messages
  };
  await store.setJSON(key, payload).catch(() => null);
  return json(payload);
}

export default async (req) => {
  try {
    return await handleRequest(req);
  } catch (error) {
    return json({
      error: "Discord feed function failed.",
      detail: error && error.message ? error.message : String(error)
    }, { status: 500 });
  }
};

export const config = {
  path: "/api/discord-feed"
};
