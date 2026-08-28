import test from "node:test";
import assert from "node:assert/strict";

import { createMeHandler } from "../../netlify/functions/me.mjs";
import { createVipRequestHandler } from "../../netlify/functions/vip-request.mjs";
import { createAdminUsersHandler } from "../../netlify/functions/admin-users.mjs";
import { createAdminSetRoleHandler } from "../../netlify/functions/admin-set-role.mjs";
import { createAdminDeleteUserHandler } from "../../netlify/functions/admin-delete-user.mjs";
import { AuthError, resolveAuthContext } from "../../netlify/functions/_shared/auth/auth-context.mjs";
import {
  createAuthRuntime,
  requireRequestCapability
} from "../../netlify/functions/_shared/auth/runtime.mjs";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const SUBJECT = "logto-user-1";
const TRUSTED_ORIGIN = "https://stage.example.test";
const CSRF_TOKEN = "E".repeat(43);

function account(overrides = {}) {
  return {
    accountId: TARGET_ID,
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

function contextResolver(value = account()) {
  return async () => resolveAuthContext({}, {
    readValidSessionFromCookie: async () => ({
      sessionId: "33333333-3333-4333-8333-333333333333",
      authSource: "logto",
      accountId: value.accountId,
      logtoSubject: SUBJECT,
      authzVersion: value.authzVersion
    }),
    findAccountByLogtoSubject: async () => value,
    findAccountByLegacyUserId: async () => value,
    capabilitiesForAccount
  });
}

function request(path, body, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.origin !== false) headers.Origin = TRUSTED_ORIGIN;
  if (options.csrf !== false) {
    headers.Cookie = `__Host-shinegame_csrf=${CSRF_TOKEN}`;
    headers["X-CSRF-Token"] = CSRF_TOKEN;
  }
  return new Request(`https://stage.example.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

async function responseBody(response) {
  return response.json();
}

test("missing account mapping cannot fall back to an email-based admin/free identity", async () => {
  const handler = createMeHandler({
    resolveAuthContext: async () => {
      throw new AuthError("ACCOUNT_MAPPING_MISSING", 401);
    },
    currentUser: async () => ({ email: "admin@example.com" }),
    isAdminEmail: () => true,
    canAccessPremium: () => true,
    readProfile: async () => ({ email: "admin@example.com", role: "admin", status: "approved" }),
    publicProfile: (value) => value
  });

  const response = await handler(new Request("https://stage.example.test/api/me"));
  assert.equal(response.status, 401);
  assert.equal((await responseBody(response)).authenticated, undefined);
});

test("anonymous /api/me reports an incomplete profile state", async () => {
  const handler = createMeHandler({ resolveAuthContext: async () => null });
  const response = await handler(new Request("https://stage.example.test/api/me"));
  assert.equal(response.status, 401);
  assert.equal((await responseBody(response)).profileComplete, false);
});

test("default auth runtime composes the session and account repositories at one issuer boundary", async () => {
  const accountValue = account({ accountId: TARGET_ID });
  const runtime = createAuthRuntime({
    issuerOrTenant: "tenant-dev",
    environmentId: "stage",
    siteId: "site-stage",
    sessionRepository: {
      async readValidSessionFromCookie() {
        return {
          sessionId: "33333333-3333-4333-8333-333333333333",
          authSource: "logto",
          accountId: TARGET_ID,
          logtoSubject: SUBJECT,
          authzVersion: accountValue.authzVersion
        };
      }
    },
    accountRepository: {
      async findAccountByLogtoSubject(subject) {
        assert.equal(subject, SUBJECT);
        return accountValue;
      },
      async findAccountByLegacyUserId() { return accountValue; }
    }
  });
  const context = await runtime.resolveAuthContext(new Request("https://stage.example.test/api/me"));
  assert.equal(context.accountId, TARGET_ID);
  assert.equal(context.authSource, "logto");
});

test("a blocked admin context is denied by protected admin mutation", async () => {
  let writes = 0;
  const blockedAdmin = account({
    accountId: ADMIN_ID,
    role: "admin",
    status: "blocked",
    authzVersion: 4
  });
  const handler = createAdminSetRoleHandler({
    resolveAuthContext: contextResolver(blockedAdmin),
    trustedOrigins: TRUSTED_ORIGIN,
    accountRepository: {
      async setAuthorization() {
        writes += 1;
        return { account: account({ role: "free" }), authzVersion: 5 };
      }
    },
    requireAdmin: async () => ({ user: { email: "legacy-admin@example.com" }, response: null }),
    readProfile: async () => ({ email: "target@example.com", role: "free", status: "pending" }),
    writeProfile: async (value) => value
  });

  const response = await handler(request("/api/admin/set-role", {
    accountId: TARGET_ID,
    email: "target@example.com",
    role: "vip"
  }));
  assert.equal(response.status, 403);
  assert.equal(writes, 0);
});

test("VIP request accepts an empty body and writes only by session accountId", async () => {
  let received;
  const handler = createVipRequestHandler({
    resolveAuthContext: contextResolver(account({ role: "free" })),
    trustedOrigins: TRUSTED_ORIGIN,
    accountRepository: {
      async requestVip(input) {
        received = input;
        return account({ role: "pending", status: "active" });
      }
    },
    readProfile: async () => ({ email: "attacker@example.com", role: "admin", status: "approved" }),
    writeProfile: async (value) => value
  });

  const response = await handler(request("/api/vip-request", {}));
  assert.equal(response.status, 200);
  assert.deepEqual(received, { accountId: TARGET_ID });
  const body = await responseBody(response);
  assert.equal(body.profile.accountId, TARGET_ID);
  assert.equal(body.profile.email, undefined);
  assert.equal(body.profile.guild, "Shine");
  assert.equal(body.profile.gameName, "Player One");
});

test("VIP request rejects client profile, authorization, and account fields without repository writes", async () => {
  let writes = 0;
  const handler = createVipRequestHandler({
    resolveAuthContext: contextResolver(account({ role: "free" })),
    trustedOrigins: TRUSTED_ORIGIN,
    accountRepository: {
      async requestVip() {
        writes += 1;
        throw new Error("must not receive client-controlled VIP fields");
      }
    }
  });

  for (const [field, value] of [
    ["guild", "Attacker Guild"],
    ["gameName", "Attacker Name"],
    ["role", "admin"],
    ["status", "active"],
    ["accountId", ADMIN_ID]
  ]) {
    const response = await handler(request("/api/vip-request", { [field]: value }));
    assert.equal(response.status, 400, field);
    assert.deepEqual(await responseBody(response), { error: "Invalid JSON" }, field);
  }
  assert.equal(writes, 0);
});

test("admin role mutation targets accountId, returns the affected account, and advances authzVersion", async () => {
  let received;
  const admin = account({ accountId: ADMIN_ID, role: "admin", status: "active", authzVersion: 12 });
  const updated = account({ accountId: TARGET_ID, role: "vip", status: "active", authzVersion: 8 });
  const handler = createAdminSetRoleHandler({
    resolveAuthContext: contextResolver(admin),
    trustedOrigins: TRUSTED_ORIGIN,
    accountRepository: {
      async setAuthorization(input) {
        received = input;
        return { account: updated, authzVersion: updated.authzVersion, revokedSessionCount: 0 };
      }
    },
    requireAdmin: async () => ({ user: { email: "legacy-admin@example.com" }, response: null }),
    readProfile: async () => ({ email: "target@example.com", role: "free", status: "pending" }),
    writeProfile: async (value) => value
  });

  const response = await handler(request("/api/admin/set-role", {
    accountId: TARGET_ID,
    email: "attacker@example.com",
    role: "vip"
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(received, {
    actorAccountId: ADMIN_ID,
    targetAccountId: TARGET_ID,
    role: "vip",
    status: "active",
    metadata: { operation: "admin-set-role" }
  });
  assert.deepEqual(await responseBody(response), {
    ok: true,
    account: {
      accountId: TARGET_ID,
      role: "vip",
      status: "active",
      authzVersion: 8,
      guild: "Shine",
      gameName: "Player One",
      migrationId: null
    },
    revokedSessionCount: 0
  });
});

test("admin users list account records without falling back to Blob users or email identity", async () => {
  const admin = account({ accountId: ADMIN_ID, role: "admin", status: "active" });
  const handler = createAdminUsersHandler({
    resolveAuthContext: contextResolver(admin),
    accountRepository: {
      async listAccounts() {
        return [account({ accountId: TARGET_ID, role: "free", status: "active" })];
      }
    },
    requireAdmin: async () => ({ user: { email: "legacy-admin@example.com" }, response: null }),
    getUsersStore: () => ({ list: async () => ({ blobs: [] }) })
  });

  const response = await handler(new Request("https://stage.example.test/api/admin/users"));
  assert.equal(response.status, 200);
  assert.deepEqual(await responseBody(response), {
    users: [{
      accountId: TARGET_ID,
      role: "free",
      status: "active",
      authzVersion: 7,
      guild: "Shine",
      gameName: "Player One"
    }]
  });
});

test("admin delete mutation targets accountId and never asks Netlify Identity for email confirmation", async () => {
  let received;
  const admin = account({ accountId: ADMIN_ID, role: "admin", status: "active" });
  const handler = createAdminDeleteUserHandler({
    resolveAuthContext: contextResolver(admin),
    trustedOrigins: TRUSTED_ORIGIN,
    accountRepository: {
      async deleteAccount(input) {
        received = input;
        return { accountId: TARGET_ID, revokedSessionCount: 2 };
      }
    },
    requireAdmin: async () => ({ user: { email: "legacy-admin@example.com" }, response: null }),
    readProfile: async () => ({ email: "target@example.com", emailVerified: false }),
    identityAdmin: {
      async listUsers() {
        throw new Error("Netlify Identity must not be consulted");
      }
    }
  });

  const response = await handler(request("/api/admin/delete-user", {
    accountId: TARGET_ID,
    email: "attacker@example.com"
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(received, { actorAccountId: ADMIN_ID, targetAccountId: TARGET_ID });
  assert.deepEqual(await responseBody(response), {
    ok: true,
    accountId: TARGET_ID,
    revokedSessionCount: 2
  });
});

test("canonical /api/me exposes only a masked primary email and account capabilities", async () => {
  const handler = createMeHandler({
    resolveAuthContext: contextResolver(account({ role: "admin" })),
    accountRepository: {
      async getPrimaryEmailMasked(accountId) {
        assert.equal(accountId, TARGET_ID);
        return "p***@example.com";
      }
    }
  });
  const response = await handler(new Request("https://stage.example.test/api/me"));
  assert.equal(response.status, 200);
  assert.deepEqual(await responseBody(response), {
    authenticated: true,
    accountId: TARGET_ID,
    role: "admin",
    canAccessRegistered: true,
    canAccessPremium: true,
    isAdmin: true,
    profileComplete: true,
    profile: {
      primaryEmailMasked: "p***@example.com",
      guild: "Shine",
      gameName: "Player One",
      status: "active"
    }
  });
});

test("canonical /api/me marks an active member with missing profile fields incomplete", async () => {
  const handler = createMeHandler({
    resolveAuthContext: contextResolver(account({ guild: "", gameName: "" }))
  });
  const response = await handler(new Request("https://stage.example.test/api/me"));
  assert.equal(response.status, 200);
  const body = await responseBody(response);
  assert.equal(body.profileComplete, false);
  assert.deepEqual(body.profile, {
    primaryEmailMasked: "",
    guild: "",
    gameName: "",
    status: "active"
  });
});

test("incomplete member profiles fail closed on protected APIs while explicit profile recovery is allowed", async () => {
  const incomplete = account({ guild: "", gameName: "" });
  const runtime = createAuthRuntime({ resolveAuthContext: contextResolver(incomplete) });
  const authRequest = new Request("https://stage.example.test/api/protected");

  await assert.rejects(
    () => requireRequestCapability(runtime, authRequest, "canAccessRegistered"),
    (error) => error instanceof AuthError && error.code === "PROFILE_INCOMPLETE" && error.status === 403
  );
  const recovery = await requireRequestCapability(runtime, authRequest, "canAccessRegistered", {
    allowIncompleteProfile: true
  });
  assert.equal(recovery.context.accountId, TARGET_ID);
});

test("active admins remain authorized even when their profile fields are empty", async () => {
  const admin = account({ accountId: ADMIN_ID, role: "admin", guild: "", gameName: "" });
  const runtime = createAuthRuntime({ resolveAuthContext: contextResolver(admin) });
  const result = await requireRequestCapability(
    runtime,
    new Request("https://stage.example.test/api/protected"),
    "canAccessRegistered"
  );
  assert.equal(result.context.accountId, ADMIN_ID);
});

test("default protected VIP handlers deny incomplete profiles before repository writes", async () => {
  let writes = 0;
  const handler = createVipRequestHandler({
    resolveAuthContext: contextResolver(account({ guild: "", gameName: "" })),
    trustedOrigins: TRUSTED_ORIGIN,
    accountRepository: {
      async requestVip() {
        writes += 1;
        throw new Error("must not write incomplete profile");
      }
    }
  });
  const response = await handler(request("/api/vip-request", {}));
  assert.equal(response.status, 403);
  assert.deepEqual(await responseBody(response), { error: "PROFILE_INCOMPLETE" });
  assert.equal(writes, 0);
});

test("admin quality-price writes persist updatedBy as the admin accountId", async () => {
  const { createAdminQualityPricesHandler } = await import("../../netlify/functions/admin-quality-prices.mjs");
  assert.equal(typeof createAdminQualityPricesHandler, "function");
  let updatedBy;
  const handler = createAdminQualityPricesHandler({
    resolveAuthContext: contextResolver(account({ accountId: ADMIN_ID, role: "admin" })),
    trustedOrigins: TRUSTED_ORIGIN,
    writeQualityPrices: async (input, accountId) => {
      updatedBy = accountId;
      return { ...input, updatedBy };
    }
  });
  const response = await handler(request("/api/admin/quality-prices", { email: "attacker@example.com" }));
  assert.equal(response.status, 200);
  assert.equal(updatedBy, ADMIN_ID);
});

test("blocked admin traffic requests are denied before reading the Blob analytics store", async () => {
  const { createAdminTrafficHandler } = await import("../../netlify/functions/admin-traffic.mjs");
  assert.equal(typeof createAdminTrafficHandler, "function");
  const blockedAdmin = account({ accountId: ADMIN_ID, role: "admin", status: "blocked", authzVersion: 4 });
  const handler = createAdminTrafficHandler({
    resolveAuthContext: contextResolver(blockedAdmin),
    getStore: () => {
      throw new Error("blocked admin must not read analytics");
    }
  });
  const response = await handler(new Request("https://stage.example.test/api/admin/traffic?days=7"));
  assert.equal(response.status, 403);
});

test("cookie-backed POST auth APIs require a trusted Origin and matching CSRF token", async () => {
  const admin = account({ accountId: ADMIN_ID, role: "admin", status: "active" });
  const resolver = async () => {
    throw new Error("auth resolution must not run before browser write checks");
  };
  const { createAdminQualityPricesHandler } = await import("../../netlify/functions/admin-quality-prices.mjs");
  const { createAiChatHandler } = await import("../../netlify/functions/ai-chat.mjs");
  const cases = [
    ["vip", createVipRequestHandler({ resolveAuthContext: resolver, trustedOrigins: TRUSTED_ORIGIN }), { guild: "Shine", gameName: "Player" }],
    ["set-role", createAdminSetRoleHandler({ resolveAuthContext: resolver, trustedOrigins: TRUSTED_ORIGIN }), { accountId: TARGET_ID, role: "vip" }],
    ["delete-user", createAdminDeleteUserHandler({ resolveAuthContext: resolver, trustedOrigins: TRUSTED_ORIGIN }), { accountId: TARGET_ID }],
    ["quality-prices", createAdminQualityPricesHandler({ resolveAuthContext: resolver, trustedOrigins: TRUSTED_ORIGIN }), {}],
    ["ai-chat", createAiChatHandler({ resolveAuthContext: resolver, trustedOrigins: TRUSTED_ORIGIN, apiKey: "test-key" }), { question: "hello" }]
  ];
  for (const [name, handler, body] of cases) {
    const response = await handler(request(`/api/${name}`, body, { origin: false, csrf: false }));
    assert.equal(response.status, 403, name);
  }
});

test("admin role mutation rejects non-UUID targets and unknown roles before writing", async () => {
  let writes = 0;
  const handler = createAdminSetRoleHandler({
    resolveAuthContext: contextResolver(account({ accountId: ADMIN_ID, role: "admin" })),
    trustedOrigins: TRUSTED_ORIGIN,
    accountRepository: {
      async setAuthorization() {
        writes += 1;
        return {};
      }
    }
  });
  for (const body of [
    { accountId: "not-an-account", role: "vip" },
    { accountId: TARGET_ID, role: "superadmin" }
  ]) {
    const response = await handler(request("/api/admin/set-role", body));
    assert.equal(response.status, 400);
  }
  assert.equal(writes, 0);
});

test("admin cannot demote, block, or delete its own account", async () => {
  let roleWrites = 0;
  let deleteWrites = 0;
  const admin = account({ accountId: ADMIN_ID, role: "admin", status: "active" });
  const roleHandler = createAdminSetRoleHandler({
    resolveAuthContext: contextResolver(admin),
    trustedOrigins: TRUSTED_ORIGIN,
    accountRepository: {
      async setAuthorization() {
        roleWrites += 1;
        return {};
      }
    }
  });
  for (const role of ["free", "blocked"]) {
    const response = await roleHandler(request("/api/admin/set-role", { accountId: ADMIN_ID.toUpperCase(), role }));
    assert.equal(response.status, 409);
  }
  const deleteHandler = createAdminDeleteUserHandler({
    resolveAuthContext: contextResolver(admin),
    trustedOrigins: TRUSTED_ORIGIN,
    accountRepository: {
      async deleteAccount() {
        deleteWrites += 1;
        return {};
      }
    }
  });
  const response = await deleteHandler(request("/api/admin/delete-user", { accountId: ADMIN_ID.toUpperCase() }));
  assert.equal(response.status, 409);
  assert.equal(roleWrites, 0);
  assert.equal(deleteWrites, 0);
});

test("admin quality-price GET strips write-audit and storage error metadata", async () => {
  const { createAdminQualityPricesHandler } = await import("../../netlify/functions/admin-quality-prices.mjs");
  const handler = createAdminQualityPricesHandler({
    resolveAuthContext: contextResolver(account({ accountId: ADMIN_ID, role: "admin" })),
    readQualityPrices: async () => ({
      source: "manual-json",
      tiers: [],
      updatedBy: ADMIN_ID,
      storageError: "private storage detail"
    })
  });
  const response = await handler(new Request("https://stage.example.test/api/admin/quality-prices"));
  const body = await responseBody(response);
  assert.equal(response.status, 200);
  assert.equal(body.updatedBy, undefined);
  assert.equal(body.storageError, undefined);
});

test("public quality-price GET strips write-audit and storage error metadata", async () => {
  const { createQualityPricesHandler } = await import("../../netlify/functions/quality-prices.mjs");
  const handler = createQualityPricesHandler({
    readQualityPrices: async () => ({
      source: "manual-json",
      starDiamondBoundDiamondRatio: 5,
      tiers: [],
      updatedBy: ADMIN_ID,
      storageError: "private storage detail"
    })
  });
  const response = await handler(new Request("https://stage.example.test/api/quality-prices"));
  const body = await responseBody(response);
  assert.equal(response.status, 200);
  assert.equal(body.updatedBy, undefined);
  assert.equal(body.storageError, undefined);
});

test("admin traffic storage failures return sanitized 503 responses", async () => {
  const { createAdminTrafficHandler } = await import("../../netlify/functions/admin-traffic.mjs");
  const handler = createAdminTrafficHandler({
    resolveAuthContext: contextResolver(account({ accountId: ADMIN_ID, role: "admin" })),
    getStore: () => ({
      async list() { throw new Error("private analytics storage detail"); }
    })
  });
  const response = await handler(new Request("https://stage.example.test/api/admin/traffic?days=7"));
  const body = await responseBody(response);
  assert.equal(response.status, 503);
  assert.deepEqual(body, { error: "AUTH_UNAVAILABLE" });
});

test("admin users list passes a bounded limit to the account repository", async () => {
  let receivedLimit;
  const handler = createAdminUsersHandler({
    resolveAuthContext: contextResolver(account({ accountId: ADMIN_ID, role: "admin" })),
    accountRepository: {
      async listAccounts(options) {
        receivedLimit = options?.limit;
        return [];
      }
    }
  });
  const response = await handler(new Request("https://stage.example.test/api/admin/users?limit=999999"));
  assert.equal(response.status, 200);
  assert.equal(receivedLimit, 1000);
});

test("protected JSON endpoints reject a null or array body without throwing", async () => {
  const admin = account({ accountId: ADMIN_ID, role: "admin" });
  const handlers = [
    createVipRequestHandler({
      resolveAuthContext: contextResolver(account({ role: "free" })),
      trustedOrigins: TRUSTED_ORIGIN,
      accountRepository: { async requestVip() { throw new Error("must not write"); } }
    }),
    createAdminSetRoleHandler({
      resolveAuthContext: contextResolver(admin),
      trustedOrigins: TRUSTED_ORIGIN,
      accountRepository: { async setAuthorization() { throw new Error("must not write"); } }
    }),
    createAdminDeleteUserHandler({
      resolveAuthContext: contextResolver(admin),
      trustedOrigins: TRUSTED_ORIGIN,
      accountRepository: { async deleteAccount() { throw new Error("must not write"); } }
    })
  ];
  for (const handler of handlers) {
    for (const body of [null, []]) {
      const response = await handler(request("/api/protected", body));
      assert.equal(response.status, 400);
    }
  }
});
