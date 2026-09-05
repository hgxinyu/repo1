import test from "node:test";
import assert from "node:assert/strict";
import {
  AuthError,
  resolveAuthContext,
  requireCapability,
  createAuthContextResolver
} from "../../netlify/functions/_shared/auth/auth-context.mjs";

const account = {
  accountId: "11111111-1111-4111-8111-111111111111",
  role: "vip",
  status: "active",
  guild: "Shine",
  gameName: "Player One",
  authzVersion: 7,
  migrationId: null,
  email: "must-not-be-exposed@example.com"
};

function capabilitiesForAccount(value) {
  const blocked = value.role === "blocked" || value.status === "blocked";
  return {
    authenticated: true,
    role: value.role,
    blocked,
    canAccessRegistered: !blocked,
    canAccessPremium: !blocked && value.role === "vip",
    isAdmin: !blocked && value.role === "admin"
  };
}

function contextDeps(overrides = {}) {
  return {
    readValidSessionFromCookie: async () => ({
      id: "session-1",
      authSource: "logto",
      accountId: account.accountId,
      logtoSubject: "logto-user-1",
      authnSubject: "logto-user-1",
      authzVersion: 7,
      migrationId: null
    }),
    findAccountByLogtoSubject: async () => account,
    findAccountByLegacyUserId: async () => account,
    capabilitiesForAccount,
    ...overrides
  };
}

test("resolveAuthContext maps a valid Logto app session to accountId", async () => {
  const context = await resolveAuthContext({ headers: { cookie: "opaque" } }, contextDeps());

  assert.deepEqual(context, {
    authSource: "logto",
    accountId: account.accountId,
    sessionId: "session-1",
    authnSubject: "logto-user-1",
    authzVersion: 7,
    migrationId: null,
    account: {
      accountId: account.accountId,
      role: "vip",
      status: "active",
      guild: "Shine",
      gameName: "Player One",
      authzVersion: 7,
      migrationId: null
    },
    capabilities: {
      authenticated: true,
      role: "vip",
      blocked: false,
      canAccessRegistered: true,
      canAccessPremium: true,
      canAccessSvip: false,
      isAdmin: false
    }
  });
  assert.equal("email" in context, false);
  assert.equal("email" in context.account, false);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.account), true);
  assert.equal(Object.isFrozen(context.capabilities), true);
});

test("resolveAuthContext maps a valid legacy bridge session to accountId", async () => {
  const context = await resolveAuthContext(
    {},
    contextDeps({
      readValidSessionFromCookie: async () => ({
        id: "session-legacy",
        authSource: "legacy_bridge",
        accountId: account.accountId,
        legacyNetlifyUserId: "legacy-user-1",
        authnSubject: "legacy-user-1",
        authzVersion: 7
      })
    })
  );

  assert.equal(context.authSource, "legacy_bridge");
  assert.equal(context.accountId, account.accountId);
  assert.equal(context.sessionId, "session-legacy");
});

test("AuthContext derives authnSubject from the verified source identity", async () => {
  const context = await resolveAuthContext(
    {},
    contextDeps({
      readValidSessionFromCookie: async () => ({
        id: "session-legacy",
        authSource: "legacy_bridge",
        accountId: account.accountId,
        legacyNetlifyUserId: "legacy-user-1",
        authnSubject: "attacker-controlled-value",
        authzVersion: 7
      })
    })
  );

  assert.equal(context.authnSubject, "legacy-user-1");
});

test("AuthContext does not trust issuer or connector scope supplied by a session", async () => {
  let lookupArgs;
  const context = await resolveAuthContext(
    {},
    contextDeps({
      readValidSessionFromCookie: async () => ({
        id: "session-logto",
        authSource: "logto",
        accountId: account.accountId,
        logtoSubject: "logto-user-1",
        issuerOrTenant: "attacker-tenant",
        connectorScope: "attacker-connector",
        authzVersion: 7
      }),
      findAccountByLogtoSubject: async (...args) => {
        lookupArgs = args;
        return account;
      }
    })
  );

  assert.equal(context.accountId, account.accountId);
  assert.deepEqual(lookupArgs, ["logto-user-1"]);
});

test("missing opaque app session returns null without querying account mappings", async () => {
  let lookups = 0;
  const context = await resolveAuthContext({}, contextDeps({
    readValidSessionFromCookie: async () => null,
    findAccountByLogtoSubject: async () => {
      lookups += 1;
      return account;
    }
  }));

  assert.equal(context, null);
  assert.equal(lookups, 0);
});

test("session shape requires the persisted accountId and rejects a mismatched mapping", async () => {
  await assert.rejects(
    () => resolveAuthContext({}, contextDeps({
      readValidSessionFromCookie: async () => ({
        id: "session-missing-account",
        authSource: "logto",
        logtoSubject: "logto-user-1",
        authzVersion: 7
      })
    })),
    (error) => error instanceof AuthError && error.code === "SESSION_INVALID" && error.status === 401
  );

  await assert.rejects(
    () => resolveAuthContext({}, contextDeps({
      readValidSessionFromCookie: async () => ({
        id: "session-wrong-account",
        authSource: "logto",
        accountId: "99999999-9999-4999-8999-999999999999",
        logtoSubject: "logto-user-1",
        authzVersion: 7
      })
    })),
    (error) => error instanceof AuthError && error.code === "SESSION_INVALID" && error.status === 401
  );
});

test("missing account mapping fails closed with a structured AuthError", async () => {
  await assert.rejects(
    () => resolveAuthContext({}, contextDeps({ findAccountByLogtoSubject: async () => null })),
    (error) => error instanceof AuthError && error.code === "ACCOUNT_MAPPING_MISSING" && error.status === 401
  );
});

test("authz version mismatch fails closed as SESSION_STALE", async () => {
  await assert.rejects(
    () => resolveAuthContext({}, contextDeps({ findAccountByLogtoSubject: async () => ({ ...account, authzVersion: 8 }) })),
    (error) => error instanceof AuthError && error.code === "SESSION_STALE" && error.status === 401
  );
});

test("blocked account context carries blocked capabilities and cannot satisfy a capability", async () => {
  const blocked = { ...account, role: "blocked", status: "blocked" };
  const context = await resolveAuthContext({}, contextDeps({
    findAccountByLogtoSubject: async () => blocked
  }));

  assert.equal(context.accountId, account.accountId);
  assert.equal(context.capabilities.blocked, true);
  assert.equal(context.capabilities.canAccessRegistered, false);
  assert.throws(
    () => requireCapability(context, "canAccessRegistered"),
    (error) => error instanceof AuthError && error.code === "CAPABILITY_DENIED" && error.status === 403
  );
});

test("requireCapability returns a complete context for an allowed capability", async () => {
  const context = await resolveAuthContext({}, contextDeps());
  assert.equal(requireCapability(context, "canAccessPremium"), context);
});

test("SVIP boundary allows canonical SVIP/admin and rejects VIP/free", async () => {
  const { capabilitiesForAccount: canonicalCapabilities } = await import("../../netlify/functions/_shared/auth/capabilities.mjs");
  for (const role of ["svip", "admin", "vip", "free"]) {
    const context = await resolveAuthContext({}, contextDeps({
      findAccountByLogtoSubject: async () => ({ ...account, role }),
      capabilitiesForAccount: canonicalCapabilities
    }));
    if (["svip", "admin"].includes(role)) assert.equal(requireCapability(context, "canAccessSvip"), context);
    else assert.throws(() => requireCapability(context, "canAccessSvip"), (error) => error.code === "CAPABILITY_DENIED");
  }
});

test("SVIP capability is denied when the resolver omits or disables it", async () => {
  for (const canAccessSvip of [undefined, false]) {
    const context = await resolveAuthContext({}, contextDeps({
      findAccountByLogtoSubject: async () => ({ ...account, role: "svip" }),
      capabilitiesForAccount: (value) => ({
        authenticated: true, role: value.role, blocked: false,
        canAccessRegistered: true, canAccessPremium: true, isAdmin: false,
        ...(canAccessSvip === undefined ? {} : { canAccessSvip })
      })
    }));
    assert.throws(
      () => requireCapability(context, "canAccessSvip"),
      (error) => error instanceof AuthError && error.code === "CAPABILITY_DENIED" && error.status === 403
    );
  }
});

test("requireCapability rejects a forged context without the resolver brand", () => {
  assert.throws(
    () => requireCapability({ capabilities: { canAccessPremium: true } }, "canAccessPremium"),
    (error) => error instanceof AuthError && error.code === "AUTH_REQUIRED" && error.status === 401
  );
});

test("requireCapability rejects a prototype-derived context even if it inherits the brand", async () => {
  const resolved = await resolveAuthContext({}, contextDeps());
  const forged = Object.create(resolved);
  assert.throws(
    () => requireCapability(forged, "canAccessPremium"),
    (error) => error instanceof AuthError && error.code === "AUTH_REQUIRED" && error.status === 401
  );
});

test("requireCapability rejects a Symbol-reflected brand copy with forged capabilities", async () => {
  const resolved = await resolveAuthContext({}, contextDeps());
  const reflectedSymbols = Object.getOwnPropertySymbols(resolved);
  assert.equal(reflectedSymbols.length, 0);

  const forged = {
    ...resolved,
    capabilities: {
      ...resolved.capabilities,
      isAdmin: true
    }
  };
  assert.throws(
    () => requireCapability(forged, "isAdmin"),
    (error) => error instanceof AuthError && error.code === "AUTH_REQUIRED" && error.status === 401
  );
});

test("requireCapability revalidates capabilities against the resolver canonical function", async () => {
  let evaluations = 0;
  const context = await resolveAuthContext({}, contextDeps({
    capabilitiesForAccount: (value) => {
      evaluations += 1;
      return capabilitiesForAccount(value);
    }
  }));

  assert.equal(evaluations, 1);
  assert.equal(requireCapability(context, "canAccessPremium"), context);
  assert.equal(evaluations, 2);
});

test("requireCapability rejects when canonical capabilities change after resolution", async () => {
  let premiumGranted = true;
  const context = await resolveAuthContext({}, contextDeps({
    capabilitiesForAccount: (value) => ({
      ...capabilitiesForAccount(value),
      canAccessPremium: premiumGranted
    })
  }));

  premiumGranted = false;
  assert.throws(
    () => requireCapability(context, "canAccessPremium"),
    (error) => error instanceof AuthError && error.code === "AUTH_CONTEXT_INVALID" && error.status === 500
  );
});

test("requireCapability uses one structured AuthError for missing and denied access", async () => {
  assert.throws(
    () => requireCapability(null, "canAccessRegistered"),
    (error) => error instanceof AuthError && error.code === "AUTH_REQUIRED" && error.status === 401
  );

  const blocked = await resolveAuthContext({}, contextDeps({
    findAccountByLogtoSubject: async () => ({ ...account, role: "blocked", status: "blocked" })
  }));
  assert.throws(
    () => requireCapability(blocked, "canAccessPremium"),
    (error) => error instanceof AuthError && error.code === "CAPABILITY_DENIED" && error.status === 403
  );
});

test("context resolver factory composes injected reader and repository lookups", async () => {
  const resolve = createAuthContextResolver(contextDeps());
  const context = await resolve({});
  assert.equal(context.accountId, account.accountId);
});

test("unsupported session source fails closed before any account lookup", async () => {
  let lookups = 0;
  await assert.rejects(
    () => resolveAuthContext({}, contextDeps({
      readValidSessionFromCookie: async () => ({ id: "session", authSource: "unknown", authzVersion: 7 }),
      findAccountByLogtoSubject: async () => {
        lookups += 1;
        return account;
      },
      findAccountByLegacyUserId: async () => {
        lookups += 1;
        return account;
      }
    })),
    (error) => error instanceof AuthError && error.code === "SESSION_INVALID" && error.status === 401
  );
  assert.equal(lookups, 0);
});
