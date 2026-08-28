import test from "node:test";
import assert from "node:assert/strict";
import { createMeHandler } from "../../netlify/functions/me.mjs";
import { createVipRequestHandler } from "../../netlify/functions/vip-request.mjs";
import { createAdminSetRoleHandler } from "../../netlify/functions/admin-set-role.mjs";
import { createAdminUsersHandler } from "../../netlify/functions/admin-users.mjs";
import { createAdminDeleteUserHandler } from "../../netlify/functions/admin-delete-user.mjs";
import { resolveAuthContext } from "../../netlify/functions/_shared/auth/auth-context.mjs";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "https://stage.example.test";
const CSRF = "E".repeat(43);

function account(overrides = {}) {
  return {
    accountId: TARGET_ID,
    role: "free",
    status: "active",
    guild: "Shine",
    gameName: "Player",
    authzVersion: 1,
    migrationId: null,
    ...overrides
  };
}

function capabilitiesForAccount(value) {
  const blocked = value.role === "blocked" || value.status !== "active";
  return {
    authenticated: true,
    role: value.role,
    blocked,
    canAccessRegistered: !blocked,
    canAccessPremium: !blocked && (value.role === "vip" || value.role === "admin"),
    isAdmin: !blocked && value.role === "admin"
  };
}

function contextResolver(value) {
  return async () => resolveAuthContext({}, {
    readValidSessionFromCookie: async () => ({
      sessionId: "33333333-3333-4333-8333-333333333333",
      authSource: "logto",
      accountId: value.accountId,
      logtoSubject: "task9-freeze-test",
      authzVersion: value.authzVersion
    }),
    findAccountByLogtoSubject: async () => value,
    findAccountByLegacyUserId: async () => value,
    capabilitiesForAccount
  });
}

function postRequest(path, body) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Cookie: `__Host-shinegame_csrf=${CSRF}`,
      "X-CSRF-Token": CSRF
    },
    body: JSON.stringify(body)
  });
}

async function withFrozenMode(callback) {
  const previous = process.env.MIGRATION_WRITE_MODE;
  process.env.MIGRATION_WRITE_MODE = "frozen";
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.MIGRATION_WRITE_MODE;
    else process.env.MIGRATION_WRITE_MODE = previous;
  }
}

test("/api/me uses the first-party account context while legacy writeback is frozen", async () => {
  await withFrozenMode(async () => {
    const handler = createMeHandler({
      resolveAuthContext: contextResolver(account({ accountId: ADMIN_ID, role: "admin" })),
      accountRepository: { async getPrimaryEmailMasked() { return "a***@example.com"; } }
    });
    const response = await handler(new Request(`${ORIGIN}/api/me`));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).accountId, ADMIN_ID);
  });
});

test("/api/vip-request uses accountId and ignores the legacy migration freeze hook", async () => {
  await withFrozenMode(async () => {
    let received;
    const handler = createVipRequestHandler({
      resolveAuthContext: contextResolver(account()),
      trustedOrigins: ORIGIN,
      accountRepository: {
        async requestVip(input) { received = input; return account({ ...input, role: "vip" }); }
      }
    });
    const response = await handler(postRequest("/api/vip-request", {
      email: "legacy@example.com",
      guild: "New Guild",
      gameName: "New Player"
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(received, { accountId: TARGET_ID, guild: "New Guild", gameName: "New Player" });
  });
});

test("admin role/profile writes use the account authorization boundary while legacy writes are frozen", async () => {
  await withFrozenMode(async () => {
    let received;
    const handler = createAdminSetRoleHandler({
      resolveAuthContext: contextResolver(account({ accountId: ADMIN_ID, role: "admin" })),
      trustedOrigins: ORIGIN,
      accountRepository: {
        async setAuthorization(input) {
          received = input;
          return { account: account({ role: "vip" }), revokedSessionCount: 0 };
        }
      }
    });
    const response = await handler(postRequest("/api/admin/set-role", {
      accountId: TARGET_ID,
      role: "vip"
    }));
    assert.equal(response.status, 200);
    assert.equal(received.actorAccountId, ADMIN_ID);
    assert.equal(received.targetAccountId, TARGET_ID);
  });
});

test("admin-users reads account records instead of legacy Identity/Blob while migration writes are frozen", async () => {
  await withFrozenMode(async () => {
    let reads = 0;
    const handler = createAdminUsersHandler({
      resolveAuthContext: contextResolver(account({ accountId: ADMIN_ID, role: "admin" })),
      accountRepository: {
        async listAccounts() { reads += 1; return [account()]; }
      },
      identityAdmin: { async listUsers() { throw new Error("legacy Identity must not be read"); } },
      getUsersStore: () => { throw new Error("legacy Blob must not be read"); }
    });
    const response = await handler(new Request(`${ORIGIN}/api/admin/users`));
    assert.equal(response.status, 200);
    assert.equal(reads, 1);
  });
});

test("admin-delete-user performs an audited account disable instead of a legacy Identity delete", async () => {
  await withFrozenMode(async () => {
    let received;
    const handler = createAdminDeleteUserHandler({
      resolveAuthContext: contextResolver(account({ accountId: ADMIN_ID, role: "admin" })),
      trustedOrigins: ORIGIN,
      accountRepository: {
        async deleteAccount(input) { received = input; return { accountId: TARGET_ID, revokedSessionCount: 1 }; }
      },
      identityAdmin: { async listUsers() { throw new Error("legacy Identity must not be consulted"); } }
    });
    const response = await handler(postRequest("/api/admin/delete-user", { accountId: TARGET_ID }));
    assert.equal(response.status, 200);
    assert.deepEqual(received, { actorAccountId: ADMIN_ID, targetAccountId: TARGET_ID });
  });
});
