import test from "node:test";
import assert from "node:assert/strict";

import { resolveAuthContext } from "../../netlify/functions/_shared/auth/auth-context.mjs";

const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const TRUSTED_ORIGIN = "https://stage.example.test";
const CSRF_TOKEN = "E".repeat(43);

function account(overrides = {}) {
  return {
    accountId: ACCOUNT_ID,
    role: "vip",
    status: "active",
    guild: "Shine",
    gameName: "Player One",
    authzVersion: 7,
    migrationId: null,
    ...overrides
  };
}

function capabilitiesForAccount(value) {
  const blocked = value.role === "blocked" || value.status === "blocked";
  return {
    authenticated: true,
    role: value.role,
    blocked,
    canAccessRegistered: !blocked,
    canAccessPremium: !blocked && (value.role === "vip" || value.role === "admin"),
    isAdmin: !blocked && value.role === "admin"
  };
}

function resolver(value) {
  return async () => resolveAuthContext({}, {
    readValidSessionFromCookie: async () => ({
      sessionId: "33333333-3333-4333-8333-333333333333",
      authSource: "logto",
      accountId: value.accountId,
      logtoSubject: "logto-user-1",
      authzVersion: value.authzVersion
    }),
    findAccountByLogtoSubject: async () => value,
    findAccountByLegacyUserId: async () => value,
    capabilitiesForAccount
  });
}

function request(body) {
  return new Request("https://stage.example.test/api/ai-chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: TRUSTED_ORIGIN,
      Cookie: `__Host-shinegame_csrf=${CSRF_TOKEN}`,
      "X-CSRF-Token": CSRF_TOKEN
    },
    body: JSON.stringify(body)
  });
}

test("AI hourly limit increments the authenticated accountId and ignores legacy email buckets", async () => {
  const { createAiChatHandler } = await import("../../netlify/functions/ai-chat.mjs");
  assert.equal(typeof createAiChatHandler, "function");

  const increments = [];
  const handler = createAiChatHandler({
    resolveAuthContext: resolver(account()),
    trustedOrigins: TRUSTED_ORIGIN,
    aiLimitRepository: {
      async increment(input) {
        increments.push(input);
        return { count: 1, limit: 10, resetAt: "2026-08-27T00:00:00.000Z" };
      }
    },
    apiKey: "test-deepseek-key",
    fetch: async () => new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  });

  const response = await handler(request({
    email: "legacy-attacker@example.com",
    question: "请回答一个问题"
  }));
  assert.equal(response.status, 200);
  assert.equal(increments.length, 1);
  assert.equal(increments[0].accountId, ACCOUNT_ID);
  assert.equal("email" in increments[0], false);
  assert.equal("key" in increments[0], false);
});

test("AI hourly limit is not applied to an authenticated admin account", async () => {
  const { createAiChatHandler } = await import("../../netlify/functions/ai-chat.mjs");
  const increments = [];
  const handler = createAiChatHandler({
    resolveAuthContext: resolver(account({ role: "admin" })),
    trustedOrigins: TRUSTED_ORIGIN,
    aiLimitRepository: {
      async increment(input) {
        increments.push(input);
        return { count: 1, limit: 10 };
      }
    },
    apiKey: "test-deepseek-key",
    fetch: async () => new Response(JSON.stringify({
      choices: [{ message: { content: "admin answer" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  });

  const response = await handler(request({ question: "管理员问题" }));
  assert.equal(response.status, 200);
  assert.equal(increments.length, 0);
});

test("AI validates question and API key before consuming the hourly quota", async () => {
  const { createAiChatHandler } = await import("../../netlify/functions/ai-chat.mjs");
  for (const [body, options] of [
    [{ question: "" }, { apiKey: "test-key" }],
    [{ question: "valid question" }, {}],
    [{ question: "valid question" }, { apiKey: "   " }],
    [{ question: "valid question" }, { apiKey: 12345 }]
  ]) {
    let increments = 0;
    const handler = createAiChatHandler({
      resolveAuthContext: resolver(account()),
      trustedOrigins: TRUSTED_ORIGIN,
      ...options,
      aiLimitRepository: {
        async increment() {
          increments += 1;
          return { count: 1, resetAt: "2026-08-27T00:00:00.000Z" };
        }
      }
    });
    const response = await handler(request(body));
    assert.ok(response.status === 400 || response.status === 503);
    assert.equal(increments, 0);
  }
});

test("AI trims a configured key before the provider call", async () => {
  const { createAiChatHandler } = await import("../../netlify/functions/ai-chat.mjs");
  let authorization;
  const handler = createAiChatHandler({
    resolveAuthContext: resolver(account()),
    trustedOrigins: TRUSTED_ORIGIN,
    apiKey: "  test-key  ",
    aiLimitRepository: { async increment() { return { count: 1 }; } },
    fetch: async (_url, options) => {
      authorization = options.headers.Authorization;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  const response = await handler(request({ question: "valid question" }));
  assert.equal(response.status, 200);
  assert.equal(authorization, "Bearer test-key");
});

test("AI provider failures return a generic 502 without leaking provider details", async () => {
  const { createAiChatHandler } = await import("../../netlify/functions/ai-chat.mjs");
  const handler = createAiChatHandler({
    resolveAuthContext: resolver(account()),
    trustedOrigins: TRUSTED_ORIGIN,
    apiKey: "test-key",
    aiLimitRepository: { async increment() { return { count: 1 }; } },
    fetch: async () => new Response(JSON.stringify({
      error: { message: "provider secret detail", code: "private-provider-code" }
    }), { status: 429, headers: { "Content-Type": "application/json" } })
  });
  const response = await handler(request({ question: "valid question" }));
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.deepEqual(body, { error: "AI 服务暂时不可用，请稍后再试。" });
});

test("AI quota repository uses the database hour and a parameterized account UUID", async () => {
  const { createAiRateLimitRepository } = await import("../../netlify/functions/_shared/auth/ai-rate-limit.mjs");
  const calls = [];
  const sql = (strings, ...values) => {
    calls.push({ text: Array.from(strings.raw || strings).join("?"), values });
    return [{ count: 11, hour_start: "2026-08-26T15:00:00.000Z" }];
  };
  const repository = createAiRateLimitRepository({
    sql,
    clock: () => new Date("2026-08-26T15:59:59.000Z")
  });
  const result = await repository.increment({ accountId: ACCOUNT_ID });
  assert.equal(result.count, 11);
  assert.equal(result.hourStart.toISOString(), "2026-08-26T15:00:00.000Z");
  assert.equal(result.resetAt.toISOString(), "2026-08-26T16:00:00.000Z");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, [ACCOUNT_ID]);
  assert.match(calls[0].text, /returning count[\s\S]*hour_start/i);
});

test("AI quota repository rejects non-UUID account identifiers before SQL", async () => {
  const { createAiRateLimitRepository } = await import("../../netlify/functions/_shared/auth/ai-rate-limit.mjs");
  let calls = 0;
  const repository = createAiRateLimitRepository({ sql: () => { calls += 1; return []; } });
  await assert.rejects(
    () => repository.increment({ accountId: "legacy@example.com" }),
    /AUTH_ACCOUNT_INVALID/
  );
  assert.equal(calls, 0);
});

test("AI quota repository canonicalizes UUID case before the database key", async () => {
  const { createAiRateLimitRepository } = await import("../../netlify/functions/_shared/auth/ai-rate-limit.mjs");
  const calls = [];
  const repository = createAiRateLimitRepository({
    sql: (strings, ...values) => {
      calls.push(values);
      return [{ count: 1, hour_start: "2026-08-26T15:00:00.000Z" }];
    }
  });
  await repository.increment({ accountId: ACCOUNT_ID.toUpperCase() });
  assert.deepEqual(calls, [[ACCOUNT_ID]]);
});
