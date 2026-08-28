import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  createSessionRepository,
  consumeBridgeTransaction,
  consumeBridgeAndCreateAppSession,
  cancelOAuthTransaction,
  revokeSessionFromCookie
} from "../../netlify/functions/_shared/auth/session-repository.mjs";
import {
  encryptSecret,
  tokenHash
} from "../../netlify/functions/_shared/auth/crypto.mjs";

const HMAC_KEY = "hmac-key-01234567890123456789012";
const ENCRYPTION_KEY = "encryption-key-01234567890123456";
const TOKEN_BYTES = 32;
const FAMILY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FAMILY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION_TOKEN = Buffer.alloc(TOKEN_BYTES, 0xa1).toString("base64url");
const TOKEN_STATE = Buffer.alloc(TOKEN_BYTES, 0xb1).toString("base64url");
const TOKEN_NONCE = Buffer.alloc(TOKEN_BYTES, 0xb2).toString("base64url");
const TOKEN_PKCE = Buffer.alloc(TOKEN_BYTES, 0xb3).toString("base64url");
const TOKEN_CSRF = Buffer.alloc(TOKEN_BYTES, 0xb4).toString("base64url");
const TOKEN_BRIDGE_STATE = Buffer.alloc(TOKEN_BYTES, 0xb5).toString("base64url");
const TOKEN_ROTATED_REFRESH = Buffer.alloc(TOKEN_BYTES, 0xc1).toString("base64url");
const savedEnvironment = new Map(
  ["AUTH_HMAC_KEY", "AUTH_ENCRYPTION_KEY", "AUTH_ENCRYPTION_KEY_VERSION"].map((name) => [name, process.env[name]])
);

before(() => {
  process.env.AUTH_HMAC_KEY = HMAC_KEY;
  process.env.AUTH_ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.AUTH_ENCRYPTION_KEY_VERSION = "1";
});

after(() => {
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function fakeTaggedSql(handler) {
  const calls = [];
  const sql = (strings, ...values) => {
    const parts = Array.from(strings.raw || strings);
    const text = parts.reduce(
      (result, part, index) => `${result}${part}${index < values.length ? "<param>" : ""}`,
      ""
    );
    const call = { text, values };
    calls.push(call);
    return Promise.resolve(handler(call, calls.length - 1)).then((result) => {
      if (!/auth_sessions/i.test(text) || !Array.isArray(result)) return result;
      return result.map((row) => row && typeof row === "object"
        ? {
          environment_id: row.environment_id ?? "stage",
          site_id: row.site_id ?? "site-stage",
          ...row
        }
        : row);
    });
  };
  sql.calls = calls;
  return sql;
}

function deterministicTokenGenerator(tokens = [
  TOKEN_STATE,
  TOKEN_NONCE,
  TOKEN_PKCE,
  TOKEN_CSRF,
  SESSION_TOKEN,
  TOKEN_ROTATED_REFRESH
]) {
  let index = 0;
  return () => tokens[index++] ?? tokens[tokens.length - 1];
}

function repoFor(sql, overrides = {}) {
  const withTransaction = async (callback) => {
    const transaction = (strings, ...values) => sql(strings, ...values);
    transaction.savepoint = () => {};
    return callback(transaction);
  };
  return createSessionRepository({
    sql,
    withTransaction,
    environmentId: "stage",
    siteId: "site-stage",
    clock: () => new Date(createdAt),
    tokenGenerator: deterministicTokenGenerator(),
    uuidGenerator: () => FAMILY_A,
    ...overrides
  });
}

const createdAt = new Date("2026-08-25T00:00:00.000Z");
const accountId = "11111111-1111-4111-8111-111111111111";
const migrationId = "22222222-2222-4222-8222-222222222222";

test("createOAuthTransaction hashes credentials, allowlists nextPath, and applies a 10 minute TTL", async () => {
  const sql = fakeTaggedSql((call) => {
    assert.match(call.text, /insert into oauth_transactions/i);
    assert.match(call.text, /transaction_kind/i);
    assert.equal(call.values.some((value) => value === "raw-state" || value === "raw-nonce" || value === "raw-verifier"), false);
    return [{
      transaction_id: "tx-oauth",
      created_at: createdAt,
      expires_at: new Date(createdAt.getTime() + 10 * 60 * 1000)
    }];
  });
  const repository = repoFor(sql);

  const transaction = await repository.createOAuthTransaction({
    nextPath: "AIAsk.html"
  });

  assert.equal(transaction.transactionId, "tx-oauth");
  assert.equal(transaction.nextPath, "/AIAsk.html");
  assert.equal(transaction.expiresAt.getTime() - transaction.createdAt.getTime(), 600000);
  assert.equal(sql.calls[0].values[1].equals(tokenHash(transaction.state)), true);
  assert.equal(sql.calls[0].values[2].equals(tokenHash(transaction.nonce)), true);
  assert.equal(Buffer.isBuffer(sql.calls[0].values[3]), true);
  assert.equal(Buffer.isBuffer(sql.calls[0].values[4]), true);
});

test("createBridgeTransaction stores only hashes and expires after five minutes", async () => {
  const sql = fakeTaggedSql((call) => {
    assert.match(call.text, /insert into oauth_transactions/i);
    assert.match(call.text, /transaction_kind/i);
    assert.equal(call.values.includes("legacy-session"), false);
    assert.equal(call.values.includes("csrf-secret"), false);
    return [{
      transaction_id: "tx-bridge",
      created_at: createdAt,
      expires_at: new Date(createdAt.getTime() + 5 * 60 * 1000)
    }];
  });
  const repository = repoFor(sql);

  const transaction = await repository.createBridgeTransaction({
    legacySessionId: "legacy-session",
    accountId,
    migrationId,
    nextPath: "/AIAsk.html"
  });

  assert.equal(transaction.transactionId, "tx-bridge");
  assert.equal(transaction.expiresAt.getTime() - transaction.createdAt.getTime(), 300000);
  assert.equal(sql.calls[0].values[1].equals(tokenHash(transaction.state)), true);
  assert.equal(sql.calls[0].values[5].equals(tokenHash(transaction.csrfToken)), true);
});

test("createOAuthTransaction generates one-time opaque credentials when the caller omits them", async () => {
  const sql = fakeTaggedSql((call) => {
    assert.match(call.text, /insert into oauth_transactions/i);
    assert.equal(call.values.some((value) => typeof value === "string" && value.length >= 20), false);
    assert.equal(call.values.some((value) => Buffer.isBuffer(value)), true);
    return [{
      transaction_id: "tx-generated",
      created_at: createdAt,
      expires_at: new Date(createdAt.getTime() + 10 * 60 * 1000)
    }];
  });
  const transaction = await repoFor(sql, {
    tokenGenerator: deterministicTokenGenerator([TOKEN_STATE, TOKEN_NONCE, TOKEN_PKCE])
  }).createOAuthTransaction({
    nextPath: "AIAsk.html"
  });

  for (const name of ["state", "nonce", "pkceVerifier"]) {
    assert.equal(transaction[name].length, 43);
    assert.equal(Buffer.from(transaction[name], "base64url").length, TOKEN_BYTES);
  }
  assert.equal(transaction.transactionId, "tx-generated");
});

test("consumeBridgeTransaction locks and atomically consumes only matching hashed bridge credentials", async () => {
  const state = TOKEN_BRIDGE_STATE;
  const legacySessionId = "legacy-session-to-consume";
  const csrfToken = TOKEN_CSRF;
  const sql = fakeTaggedSql((call) => {
    if (/select[\s\S]*from oauth_transactions/i.test(call.text)) {
      assert.match(call.text, /for update/i);
      assert.match(call.text, /environment_id\s*=\s*<param>/i);
      assert.match(call.text, /site_id\s*=\s*<param>/i);
      assert.equal(call.values.some((value) => [state, legacySessionId, csrfToken].includes(value)), false);
      return [{
        transaction_id: "tx-bridge",
        transaction_kind: "bridge",
        state_hash: tokenHash(state),
        csrf_token_hash: tokenHash(csrfToken),
        legacy_session_id_hash: tokenHash(legacySessionId),
        environment_id: "stage",
        site_id: "site-stage",
        account_id: accountId,
        migration_id: migrationId,
        next_path: "/AIAsk.html",
        created_at: createdAt,
        expires_at: new Date(createdAt.getTime() + 5 * 60 * 1000),
        consumed_at: null
      }];
    }
    if (/update oauth_transactions/i.test(call.text)) {
      assert.match(call.text, /environment_id\s*=\s*<param>/i);
      assert.match(call.text, /site_id\s*=\s*<param>/i);
      return [{ consumed_at: createdAt }];
    }
    throw new Error(`unexpected query: ${call.text}`);
  });

  const consumed = await repoFor(sql).consumeBridgeTransaction({
    state,
    legacySessionId,
    csrfToken
  });

  assert.deepEqual(consumed, {
    transactionId: "tx-bridge",
    nextPath: "/AIAsk.html",
    accountId,
    migrationId
  });
  assert.equal(sql.calls.length, 2);
});

test("consumeBridgeAndCreateAppSession consumes and issues through the same transaction adapter", async () => {
  const legacySessionId = "legacy-session-atomic";
  let committed = false;
  let rolledBack = false;
  const rootSql = () => {
    throw new Error("root SQL adapter must not be used by the atomic bridge");
  };
  const transactionSql = fakeTaggedSql((call) => {
    if (/select[\s\S]*from oauth_transactions/i.test(call.text)) {
      return [{
        transaction_id: "tx-atomic",
        transaction_kind: "bridge",
        state_hash: tokenHash(TOKEN_BRIDGE_STATE),
        csrf_token_hash: tokenHash(TOKEN_CSRF),
        legacy_session_id_hash: tokenHash(legacySessionId),
        environment_id: "stage",
        site_id: "site-stage",
        account_id: accountId,
        migration_id: migrationId,
        next_path: "/AIAsk.html",
        created_at: createdAt,
        expires_at: new Date(createdAt.getTime() + 5 * 60 * 1000),
        consumed_at: null
      }];
    }
    if (/update oauth_transactions/i.test(call.text)) return [{ consumed_at: createdAt }];
    if (/update auth_sessions/i.test(call.text)) {
      assert.match(call.text, /environment_id\s*=\s*<param>/i);
      assert.match(call.text, /site_id\s*=\s*<param>/i);
      assert.match(call.text, /legacy_netlify_user_id\s*=\s*<param>/i);
      assert.match(call.text, /revoked_at\s+is\s+null/i);
      return [];
    }
    if (/insert into auth_sessions/i.test(call.text)) {
      assert.match(call.text, /on conflict[\s\S]*environment_id, site_id, legacy_netlify_user_id/i);
      return [{
        session_id: "session-atomic",
        auth_source: "legacy_bridge",
        session_family_id: FAMILY_A,
        account_id: accountId,
        legacy_netlify_user_id: "legacy-user",
        migration_id: migrationId,
        issued_at: createdAt,
        last_seen_at: createdAt,
        idle_expires_at: new Date(createdAt.getTime() + 14 * 86400000),
        absolute_expires_at: new Date(createdAt.getTime() + 30 * 86400000),
        authz_version: 7,
        rotation_version: 1
      }];
    }
    throw new Error(`unexpected query: ${call.text}`);
  });
  const withTransaction = async (callback) => {
    try {
      const result = await callback(transactionSql);
      committed = true;
      return result;
    } catch (error) {
      rolledBack = true;
      throw error;
    }
  };
  const repository = repoFor(rootSql, { withTransaction });

  const result = await repository.consumeBridgeAndCreateAppSession({
    state: TOKEN_BRIDGE_STATE,
    legacySessionId,
    csrfToken: TOKEN_CSRF,
    sessionInput: {
      authSource: "legacy_bridge",
      accountId,
      legacyNetlifyUserId: "legacy-user",
      migrationId,
      migrationWindowEndsAt: new Date(createdAt.getTime() + 30 * 86400000),
      authzVersion: 7
    }
  });

  assert.equal(committed, true);
  assert.equal(rolledBack, false);
  assert.equal(result.consumed.accountId, accountId);
  assert.equal(result.session.authSource, "legacy_bridge");
  assert.equal(result.session.accountId, accountId);
  assert.equal(transactionSql.calls.length, 4);
});

test("consumeBridgeAndCreateAppSession rolls back the consumed transaction when session creation fails", async () => {
  let rolledBack = false;
  const transactionSql = fakeTaggedSql((call) => {
    if (/select[\s\S]*from oauth_transactions/i.test(call.text)) {
      return [{
        transaction_id: "tx-atomic-failure",
        transaction_kind: "bridge",
        state_hash: tokenHash(TOKEN_BRIDGE_STATE),
        csrf_token_hash: tokenHash(TOKEN_CSRF),
        legacy_session_id_hash: tokenHash("legacy-session-failure"),
        environment_id: "stage",
        site_id: "site-stage",
        account_id: accountId,
        migration_id: migrationId,
        next_path: "/AIAsk.html",
        created_at: createdAt,
        expires_at: new Date(createdAt.getTime() + 5 * 60 * 1000),
        consumed_at: null
      }];
    }
    if (/update oauth_transactions/i.test(call.text)) return [{ consumed_at: createdAt }];
    if (/update auth_sessions/i.test(call.text)) return [];
    if (/insert into auth_sessions/i.test(call.text)) throw new Error("insert failed");
    throw new Error(`unexpected query: ${call.text}`);
  });
  const withTransaction = async (callback) => {
    try {
      return await callback(transactionSql);
    } catch (error) {
      rolledBack = true;
      throw error;
    }
  };
  const repository = repoFor(() => {
    throw new Error("root SQL adapter must not be used by the atomic bridge");
  }, { withTransaction });

  await assert.rejects(
    () => repository.consumeBridgeAndCreateAppSession({
      state: TOKEN_BRIDGE_STATE,
      legacySessionId: "legacy-session-failure",
      csrfToken: TOKEN_CSRF,
      sessionInput: {
        authSource: "legacy_bridge",
        accountId,
        legacyNetlifyUserId: "legacy-user",
        migrationId,
        migrationWindowEndsAt: new Date(createdAt.getTime() + 30 * 86400000),
        authzVersion: 7
      }
    }),
    /insert failed/
  );
  assert.equal(rolledBack, true);
});

test("consumeBridgeAndCreateAppSession treats an active scoped duplicate as a replay", async () => {
  const transactionSql = fakeTaggedSql((call) => {
    if (/select[\s\S]*from oauth_transactions/i.test(call.text)) {
      return [{
        transaction_id: "tx-atomic-replay",
        transaction_kind: "bridge",
        state_hash: tokenHash(TOKEN_BRIDGE_STATE),
        csrf_token_hash: tokenHash(TOKEN_CSRF),
        legacy_session_id_hash: tokenHash("legacy-session-replay"),
        environment_id: "stage",
        site_id: "site-stage",
        account_id: accountId,
        migration_id: migrationId,
        next_path: "/AIAsk.html",
        created_at: createdAt,
        expires_at: new Date(createdAt.getTime() + 5 * 60 * 1000),
        consumed_at: null
      }];
    }
    if (/update oauth_transactions/i.test(call.text)) return [{ consumed_at: createdAt }];
    if (/update auth_sessions/i.test(call.text)) return [];
    if (/insert into auth_sessions/i.test(call.text)) return [];
    throw new Error(`unexpected query: ${call.text}`);
  });
  const repository = repoFor(() => {
    throw new Error("root SQL adapter must not be used by the atomic bridge");
  }, {
    withTransaction: async (callback) => callback(transactionSql)
  });

  await assert.rejects(
    () => repository.consumeBridgeAndCreateAppSession({
      state: TOKEN_BRIDGE_STATE,
      legacySessionId: "legacy-session-replay",
      csrfToken: TOKEN_CSRF,
      sessionInput: {
        authSource: "legacy_bridge",
        accountId,
        legacyNetlifyUserId: "legacy-user",
        migrationId,
        migrationWindowEndsAt: new Date(createdAt.getTime() + 30 * 86400000),
        authzVersion: 7
      }
    }),
    /SESSION_REPLAY/
  );
});

test("consumeOAuthTransaction locks, validates, and atomically consumes a transaction once", async () => {
  const state = TOKEN_STATE;
  const nonce = TOKEN_NONCE;
  const verifier = TOKEN_PKCE;
  const encryptedVerifier = await encryptSecret(verifier, {
    environmentId: "stage",
    siteId: "site-stage",
    keyVersion: 1
  });
  const encryptedNonce = await encryptSecret(nonce, {
    environmentId: "stage",
    siteId: "site-stage",
    keyVersion: 1
  });
  const sql = fakeTaggedSql((call) => {
    if (/select[\s\S]*from oauth_transactions/i.test(call.text)) {
      assert.match(call.text, /for update/i);
      assert.match(call.text, /environment_id\s*=\s*<param>/i);
      assert.match(call.text, /site_id\s*=\s*<param>/i);
      assert.equal(call.values.includes(state), false);
      return [{
        transaction_id: "tx-oauth",
        transaction_kind: "oauth",
        state_hash: tokenHash(state),
        nonce_hash: tokenHash(nonce),
        nonce_encrypted: encryptedNonce,
        pkce_verifier_encrypted: encryptedVerifier,
        environment_id: "stage",
        site_id: "site-stage",
        next_path: "/AIAsk.html",
        created_at: createdAt,
        expires_at: new Date(createdAt.getTime() + 600000),
        consumed_at: null
      }];
    }
    if (/update oauth_transactions/i.test(call.text)) {
      assert.match(call.text, /environment_id\s*=\s*<param>/i);
      assert.match(call.text, /site_id\s*=\s*<param>/i);
      return [{ consumed_at: createdAt }];
    }
    throw new Error(`unexpected query: ${call.text}`);
  });
  const repository = repoFor(sql);

  const consumed = await repository.consumeOAuthTransaction({
    state,
    nonce,
    pkceVerifier: verifier
  });

  assert.equal(consumed.transactionId, "tx-oauth");
  assert.equal(consumed.nextPath, "/AIAsk.html");
  assert.equal(sql.calls.length, 2);
  assert.match(sql.calls[1].text, /consumed_at/i);
});

test("consumeOAuthTransaction can atomically consume before code exchange and return only stored callback material", async () => {
  const encryptedVerifier = await encryptSecret(TOKEN_PKCE, {
    environmentId: "stage",
    siteId: "site-stage",
    keyVersion: 1
  });
  const encryptedNonce = await encryptSecret(TOKEN_NONCE, {
    environmentId: "stage",
    siteId: "site-stage",
    keyVersion: 1
  });
  const sql = fakeTaggedSql((call) => {
    if (/select[\s\S]*from oauth_transactions/i.test(call.text)) {
      assert.match(call.text, /for update/i);
      return [{
        transaction_id: "tx-consume-first",
        transaction_kind: "oauth",
        state_hash: tokenHash(TOKEN_STATE),
        nonce_hash: tokenHash(TOKEN_NONCE),
        nonce_encrypted: encryptedNonce,
        pkce_verifier_encrypted: encryptedVerifier,
        environment_id: "stage",
        site_id: "site-stage",
        next_path: "/AIAsk.html",
        created_at: createdAt,
        expires_at: new Date(createdAt.getTime() + 600000),
        consumed_at: null
      }];
    }
    if (/update oauth_transactions/i.test(call.text)) {
      assert.match(call.text, /consumed_at/i);
      return [{ consumed_at: createdAt }];
    }
    throw new Error(`unexpected query: ${call.text}`);
  });

  const consumed = await repoFor(sql).consumeOAuthTransaction({ state: TOKEN_STATE });

  assert.deepEqual(consumed, {
    transactionId: "tx-consume-first",
    nextPath: "/AIAsk.html",
    accountId: undefined,
    migrationId: undefined,
    nonce: TOKEN_NONCE,
    pkceVerifier: TOKEN_PKCE,
    nonceHash: tokenHash(TOKEN_NONCE)
  });
  assert.equal(sql.calls.length, 2);
});

test("cancelOAuthTransaction consumes a provider-cancelled transaction exactly once", async () => {
  const sql = fakeTaggedSql((call) => {
    if (/select[\s\S]*from oauth_transactions/i.test(call.text)) {
      assert.match(call.text, /for update/i);
      return [{
        transaction_id: "tx-cancel",
        transaction_kind: "oauth",
        state_hash: tokenHash(TOKEN_STATE),
        nonce_hash: tokenHash(TOKEN_NONCE),
        pkce_verifier_encrypted: Buffer.from("ciphertext"),
        environment_id: "stage",
        site_id: "site-stage",
        next_path: "/AIAsk.html",
        created_at: createdAt,
        expires_at: new Date(createdAt.getTime() + 600000),
        consumed_at: null
      }];
    }
    if (/update oauth_transactions/i.test(call.text)) {
      assert.match(call.text, /consumed_at/i);
      return [{ consumed_at: createdAt }];
    }
    throw new Error(`unexpected query: ${call.text}`);
  });

  const cancelled = await cancelOAuthTransaction({ state: TOKEN_STATE }, {
    sql,
    withTransaction: async (callback) => {
      const transaction = (strings, ...values) => sql(strings, ...values);
      transaction.savepoint = () => {};
      return callback(transaction);
    },
    environmentId: "stage",
    siteId: "site-stage",
    clock: () => new Date(createdAt),
    tokenHash,
    decryptSecret: async () => TOKEN_PKCE
  });

  assert.deepEqual(cancelled, {
    transactionId: "tx-cancel",
    nextPath: "/AIAsk.html"
  });
  assert.equal(sql.calls.length, 2);
});

test("consumeOAuthTransaction rejects replay and expiry, and checks the configured environment", async () => {
  const sql = fakeTaggedSql((call) => {
    if (/select[\s\S]*from oauth_transactions/i.test(call.text)) return [];
    throw new Error(`unexpected query: ${call.text}`);
  });
  const repository = repoFor(sql);

  await assert.rejects(
    () => repository.consumeOAuthTransaction({ state: TOKEN_STATE }),
    /TRANSACTION_REPLAY|TRANSACTION_INVALID/
  );
  const expiredSql = fakeTaggedSql((call) => {
    if (/select[\s\S]*from oauth_transactions/i.test(call.text)) {
      return [{
        transaction_id: "tx-expired",
        transaction_kind: "oauth",
        state_hash: tokenHash(TOKEN_STATE),
        nonce_hash: tokenHash(TOKEN_NONCE),
        pkce_verifier_encrypted: Buffer.from("ciphertext"),
        environment_id: "stage",
        site_id: "site-stage",
        next_path: "/AIAsk.html",
        created_at: new Date(createdAt.getTime() - 600000),
        expires_at: new Date(createdAt.getTime() - 1),
        consumed_at: null
      }];
    }
    throw new Error(`unexpected query: ${call.text}`);
  });
  await assert.rejects(
    () => repoFor(expiredSql).consumeOAuthTransaction({ state: TOKEN_STATE }),
    /TRANSACTION_EXPIRED/
  );
  const mismatchSql = fakeTaggedSql((call) => {
    if (/select[\s\S]*from oauth_transactions/i.test(call.text)) {
      return [{
        transaction_id: "tx-mismatch",
        transaction_kind: "oauth",
        state_hash: tokenHash(TOKEN_STATE),
        nonce_hash: tokenHash(TOKEN_NONCE),
        pkce_verifier_encrypted: Buffer.from("ciphertext"),
        environment_id: "stage",
        site_id: "site-stage",
        next_path: "/AIAsk.html",
        created_at: createdAt,
        expires_at: new Date(createdAt.getTime() + 600000),
        consumed_at: null
      }];
    }
    throw new Error(`unexpected query: ${call.text}`);
  });
  await assert.rejects(
    () => repoFor(mismatchSql, { environmentId: "production" }).consumeOAuthTransaction({
      state: TOKEN_STATE,
      nonce: TOKEN_NONCE,
      pkceVerifier: TOKEN_PKCE
    }),
    /AUTH_ENV_MISMATCH|TRANSACTION_INVALID/
  );
});

test("createAppSession applies Logto idle and absolute TTLs and encrypts refresh token", async () => {
  const sql = fakeTaggedSql((call) => {
    assert.match(call.text, /insert into auth_sessions/i);
    assert.match(call.text, /session_family_id/i);
    assert.match(call.text, /created_at/i);
    assert.equal(call.values.includes("provider-refresh"), false);
    return [{
      session_id: "session-logto",
      created_at: createdAt,
      issued_at: createdAt,
      last_seen_at: createdAt,
      idle_expires_at: new Date(createdAt.getTime() + 14 * 86400000),
      absolute_expires_at: new Date(createdAt.getTime() + 30 * 86400000),
      rotation_version: 1,
      authz_version: 7,
      session_family_id: FAMILY_A
    }];
  });
  const repository = repoFor(sql);

  const session = await repository.createAppSession({
    authSource: "logto",
    accountId,
    logtoSubject: "logto-user",
    refreshToken: "provider-refresh",
    authzVersion: 7
  });

  assert.equal(Buffer.from(session.sessionToken, "base64url").length, 32);
  assert.equal(session.idleExpiresAt.getTime() - createdAt.getTime(), 14 * 86400000);
  assert.equal(session.absoluteExpiresAt.getTime() - createdAt.getTime(), 30 * 86400000);
});

test("createAppSession gives a legacy bridge no refresh token and caps absolute TTL at migrationWindowEndsAt", async () => {
  const migrationWindowEndsAt = new Date(createdAt.getTime() + 20 * 86400000);
  const sql = fakeTaggedSql((call) => {
    assert.match(call.text, /insert into auth_sessions/i);
    assert.match(call.text, /session_family_id/i);
    assert.equal(call.values.some((value) => value === "provider-refresh"), false);
    return [{
      session_id: "session-legacy",
      created_at: createdAt,
      issued_at: createdAt,
      last_seen_at: createdAt,
      idle_expires_at: new Date(createdAt.getTime() + 14 * 86400000),
      absolute_expires_at: migrationWindowEndsAt,
      rotation_version: 1,
      authz_version: 7,
      session_family_id: FAMILY_A
    }];
  });
  const repository = repoFor(sql);

  const session = await repository.createAppSession({
    authSource: "legacy_bridge",
    accountId,
    legacyNetlifyUserId: "legacy-user",
    migrationId,
    migrationWindowEndsAt,
    authzVersion: 7
  });

  assert.equal(session.absoluteExpiresAt.getTime(), migrationWindowEndsAt.getTime());
  assert.equal(session.refreshToken, undefined);
  assert.equal(sql.calls[0].values.some((value) => value === null), true);
});

test("rotateSession uses FOR UPDATE plus rotation-version CAS and returns a new opaque refresh token", async () => {
  const sessionToken = SESSION_TOKEN;
  const oldRefreshToken = "old-refresh-token";
  const encryptedRefreshToken = await encryptSecret(oldRefreshToken, {
    environmentId: "stage",
    siteId: "site-stage",
    keyVersion: 1
  });
  const sql = fakeTaggedSql((call) => {
    if (/select[\s\S]*from auth_sessions/i.test(call.text)) {
      assert.match(call.text, /for update/i);
      return [{
        session_id: "session-logto",
        auth_source: "logto",
        session_id_hash: tokenHash(sessionToken),
        account_id: accountId,
        session_family_id: FAMILY_A,
        logto_subject: "logto-user",
        encrypted_refresh_token: encryptedRefreshToken,
        refresh_token_key_version: 1,
        authz_version: 7,
        rotation_version: 4,
        idle_expires_at: new Date(createdAt.getTime() + 14 * 86400000),
        absolute_expires_at: new Date(createdAt.getTime() + 30 * 86400000),
        revoked_at: null
      }];
    }
    if (/update auth_sessions/i.test(call.text)) {
      assert.match(call.text, /rotation_version\s*=\s*rotation_version\s*\+\s*1/i);
      assert.match(call.text, /rotation_version\s*=\s*<param>/i);
      assert.equal(call.values.includes(oldRefreshToken), false);
      return [{ rotation_version: 5, session_id: "session-logto" }];
    }
    throw new Error(`unexpected query: ${call.text}`);
  });
  const repository = repoFor(sql, {
    tokenGenerator: deterministicTokenGenerator([TOKEN_ROTATED_REFRESH])
  });

  const rotated = await repository.rotateSession({
    sessionToken,
    presentedRefreshToken: oldRefreshToken,
    expectedRotationVersion: 4,
  });

  assert.equal(rotated.rotationVersion, 5);
  assert.equal(Buffer.from(rotated.refreshToken, "base64url").length, 32);
});

test("stale refresh version or replay revokes the session family and fails closed", async () => {
  const sessionToken = SESSION_TOKEN;
  const encryptedRefreshToken = await encryptSecret("current-refresh-token", {
    environmentId: "stage",
    siteId: "site-stage",
    keyVersion: 1
  });
  let revoked = false;
  const sql = fakeTaggedSql((call) => {
    if (/select[\s\S]*from auth_sessions/i.test(call.text)) {
      return [{
        session_id: "session-logto",
        auth_source: "logto",
        account_id: accountId,
        session_family_id: FAMILY_A,
        logto_subject: "logto-user",
        authz_version: 7,
        encrypted_refresh_token: encryptedRefreshToken,
        refresh_token_key_version: 1,
        rotation_version: 2,
        idle_expires_at: new Date(createdAt.getTime() + 86400000),
        absolute_expires_at: new Date(createdAt.getTime() + 86400000),
        revoked_at: null
      }];
    }
    if (/update auth_sessions[\s\S]*revoked_at/i.test(call.text)) {
      revoked = true;
      return [{ session_id: "session-logto", revoked_at: createdAt }];
    }
    throw new Error(`unexpected query: ${call.text}`);
  });
  const repository = repoFor(sql);

  await assert.rejects(
    () => repository.rotateSession({
      sessionToken,
      presentedRefreshToken: "current-refresh-token",
      expectedRotationVersion: 1
    }),
    /SESSION_REFRESH_REPLAY|SESSION_ROTATION_STALE/
  );
  assert.equal(revoked, true);
});

test("concurrent refresh CAS allows one rotation and revokes the family on replay", async () => {
  const sessionToken = SESSION_TOKEN;
  const oldRefreshToken = "concurrent-refresh-token";
  const encryptedRefreshToken = await encryptSecret(oldRefreshToken, {
    environmentId: "stage",
    siteId: "site-stage",
    keyVersion: 1
  });
  const state = { rotationVersion: 1, revoked: false };
  const sql = fakeTaggedSql(async (call) => {
    if (/select[\s\S]*from auth_sessions/i.test(call.text)) {
      return [{
        session_id: "session-concurrent",
        auth_source: "logto",
        account_id: accountId,
        session_family_id: FAMILY_A,
        logto_subject: "logto-user",
        authz_version: 7,
        encrypted_refresh_token: state.rotationVersion === 1
          ? encryptedRefreshToken
          : await encryptSecret("new-refresh-token", { environmentId: "stage", siteId: "site-stage", keyVersion: 1 }),
        refresh_token_key_version: 1,
        rotation_version: state.rotationVersion,
        idle_expires_at: new Date(createdAt.getTime() + 86400000),
        absolute_expires_at: new Date(createdAt.getTime() + 86400000),
        revoked_at: state.revoked ? createdAt : null
      }];
    }
    if (/update auth_sessions[\s\S]*rotation_version/i.test(call.text)) {
      const expectedVersion = call.values.find((value) => Number.isInteger(value));
      if (state.revoked || expectedVersion !== state.rotationVersion) return [];
      state.rotationVersion += 1;
      return [{ session_id: "session-concurrent", rotation_version: state.rotationVersion }];
    }
    if (/update auth_sessions[\s\S]*revoked_at/i.test(call.text)) {
      state.revoked = true;
      return [{ session_id: "session-concurrent", revoked_at: createdAt }];
    }
    throw new Error(`unexpected query: ${call.text}`);
  });
  const repository = repoFor(sql);

  const results = await Promise.allSettled([
    repository.rotateSession({ sessionToken, presentedRefreshToken: oldRefreshToken, expectedRotationVersion: 1 }),
    repository.rotateSession({ sessionToken, presentedRefreshToken: oldRefreshToken, expectedRotationVersion: 1 })
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(state.revoked, true);
});

test("readValidSessionFromCookie renews idle expiry without crossing absolute expiry", async () => {
  const now = new Date("2026-08-25T12:00:00.000Z");
  const sql = fakeTaggedSql((call) => {
    assert.match(call.text, /update auth_sessions/i);
    assert.match(call.text, /idle_expires_at/i);
    assert.match(call.text, /session_id_hash/i);
    return [{
      session_id: "session-cookie",
      auth_source: "logto",
      account_id: accountId,
      session_family_id: FAMILY_A,
      logto_subject: "logto-user",
      authz_version: 7,
      rotation_version: 1,
      idle_expires_at: new Date(now.getTime() + 14 * 86400000),
      absolute_expires_at: new Date(now.getTime() + 30 * 86400000),
      revoked_at: null
    }];
  });
  const repository = repoFor(sql, { clock: () => new Date(now) });

  const session = await repository.readValidSessionFromCookie({
    headers: { cookie: `__Host-shinegame_session=${SESSION_TOKEN}` }
  });

  assert.equal(session.sessionId, "session-cookie");
  assert.equal(session.authSource, "logto");
  assert.equal(session.accountId, accountId);
  assert.deepEqual(Object.keys(session).sort(), [
    "accountId",
    "authSource",
    "authzVersion",
    "logtoSubject",
    "migrationId",
    "sessionId"
  ]);
});

test("revokeSessionFromCookie locks the cookie row, revokes only its family, and returns the grant server-side", async () => {
  const encryptedRefreshToken = await encryptSecret("logout-refresh-token", {
    environmentId: "stage",
    siteId: "site-stage",
    keyVersion: 1
  });
  let revokeCall;
  const sql = fakeTaggedSql((call) => {
    if (/select[\s\S]*from auth_sessions/i.test(call.text)) {
      assert.match(call.text, /for update/i);
      assert.equal(call.values.includes(SESSION_TOKEN), false);
      return [{
        session_id: "session-logout",
        auth_source: "logto",
        session_id_hash: tokenHash(SESSION_TOKEN),
        session_family_id: FAMILY_A,
        account_id: accountId,
        logto_subject: "logto-user-logout",
        encrypted_refresh_token: encryptedRefreshToken,
        refresh_token_key_version: 1,
        authz_version: 7,
        rotation_version: 1,
        issued_at: createdAt,
        last_seen_at: createdAt,
        idle_expires_at: new Date(createdAt.getTime() + 86400000),
        absolute_expires_at: new Date(createdAt.getTime() + 30 * 86400000),
        revoked_at: null
      }];
    }
    if (/update auth_sessions[\s\S]*revoked_at/i.test(call.text)) {
      revokeCall = call;
      assert.equal(call.values.includes(accountId), true);
      assert.equal(call.values.includes(FAMILY_A), true);
      return [{ session_id: "session-logout", revoked_at: createdAt }];
    }
    throw new Error(`unexpected query: ${call.text}`);
  });
  const repository = repoFor(sql);

  const revoked = await repository.revokeSessionFromCookie({
    request: { headers: { cookie: `__Host-shinegame_session=${SESSION_TOKEN}` } }
  });

  assert.deepEqual(revoked, {
    sessionId: "session-logout",
    sessionFamilyId: FAMILY_A,
    accountId,
    authSource: "logto",
    refreshToken: "logout-refresh-token"
  });
  assert.ok(revokeCall);
  assert.equal(sql.calls.length, 2);
  assert.equal(sql.calls.some(({ values }) => values.includes("logout-refresh-token")), false);
});

test("revokeSessionFromCookie is idempotent for missing or malformed cookies and does not query SQL", async () => {
  const sql = fakeTaggedSql(() => {
    throw new Error("invalid cookie must not reach the database");
  });
  const repository = repoFor(sql);

  assert.equal(await repository.revokeSessionFromCookie({ headers: {} }), null);
  assert.equal(await repository.revokeSessionFromCookie({
    headers: { cookie: "__Host-shinegame_session=not-a-session-token" }
  }), null);
  assert.equal(sql.calls.length, 0);
});

test("readValidSessionFromCookie fails closed for duplicate or malformed Host-only cookie values", async () => {
  const sql = fakeTaggedSql(() => {
    throw new Error("malformed cookies must not query the database");
  });
  const repository = repoFor(sql);

  for (const cookie of [
    `__Host-shinegame_session=${SESSION_TOKEN}; __Host-shinegame_session=${TOKEN_STATE}`,
    "__Host-shinegame_session=not valid",
    "shinegame_session=missing-host-prefix",
    "__Host-shinegame_session="
  ]) {
    assert.equal(
      await repository.readValidSessionFromCookie({ headers: { cookie }, now: createdAt }),
      null
    );
  }
  assert.equal(sql.calls.length, 0);
});

test("readValidSessionFromCookie fails closed when the persisted source subject is absent", async () => {
  const sql = fakeTaggedSql((call) => {
    assert.match(call.text, /update auth_sessions/i);
    return [{
      session_id: "session-without-subject",
      auth_source: "logto",
      account_id: accountId,
      session_family_id: FAMILY_A,
      authz_version: 7,
      idle_expires_at: new Date(createdAt.getTime() + 86400000),
      absolute_expires_at: new Date(createdAt.getTime() + 86400000),
      revoked_at: null
    }];
  });
  await assert.rejects(
    () => repoFor(sql).readValidSessionFromCookie({
      headers: { cookie: `__Host-shinegame_session=${SESSION_TOKEN}` }
    }),
    /SESSION_INVALID/
  );
});

test("generated credentials ignore short business token overrides and use the trusted factory generator", async () => {
  const generated = [TOKEN_STATE, TOKEN_NONCE, TOKEN_PKCE];
  const sql = fakeTaggedSql((call) => {
    assert.match(call.text, /insert into oauth_transactions/i);
    return [{
      transaction_id: "tx-generated-factory",
      created_at: createdAt,
      expires_at: new Date(createdAt.getTime() + 600000)
    }];
  });
  const transaction = await repoFor(sql, {
    tokenGenerator: deterministicTokenGenerator(generated)
  }).createOAuthTransaction({
    state: "short-business-override",
    nonce: "short-business-override",
    pkceVerifier: "short-business-override"
  });

  assert.deepEqual(
    [transaction.state, transaction.nonce, transaction.pkceVerifier],
    generated
  );
});

test("invalid trusted token generator output fails closed with INTERNAL_TOKEN_INVALID", async () => {
  const sql = fakeTaggedSql(() => {
    throw new Error("invalid generated token must not reach SQL");
  });
  await assert.rejects(
    () => repoFor(sql, { tokenGenerator: () => "too-short" }).createOAuthTransaction({}),
    (error) => error?.code === "INTERNAL_TOKEN_INVALID"
  );
});

test("repository clock controls TTLs and ignores a body-supplied now value", async () => {
  const bodyNow = new Date("2030-01-01T00:00:00.000Z");
  const sql = fakeTaggedSql((call) => [{
    transaction_id: "tx-clock",
    created_at: createdAt,
    expires_at: new Date(createdAt.getTime() + 600000)
  }]);
  const transaction = await repoFor(sql, {
    clock: () => new Date(createdAt)
  }).createOAuthTransaction({ now: bodyNow });

  assert.equal(transaction.createdAt.getTime(), createdAt.getTime());
  assert.equal(transaction.expiresAt.getTime(), createdAt.getTime() + 600000);
});

test("replay revokes only the target session family for an account with multiple families", async () => {
  const activeFamilies = new Map([[FAMILY_A, true], [FAMILY_B, true]]);
  const sql = fakeTaggedSql(async (call) => {
    if (/select[\s\S]*from auth_sessions/i.test(call.text)) {
      return [{
        session_id: "session-family-a",
        auth_source: "logto",
        account_id: accountId,
        session_family_id: FAMILY_A,
        logto_subject: "logto-family-user",
        authz_version: 7,
        encrypted_refresh_token: await encryptSecret("family-a-refresh", {
          environmentId: "stage",
          siteId: "site-stage",
          keyVersion: 1
        }),
        refresh_token_key_version: 1,
        rotation_version: 2,
        issued_at: createdAt,
        idle_expires_at: new Date(createdAt.getTime() + 86400000),
        absolute_expires_at: new Date(createdAt.getTime() + 86400000),
        revoked_at: null
      }];
    }
    if (/update auth_sessions[\s\S]*revoked_at/i.test(call.text)) {
      assert.match(call.text, /session_family_id/i);
      assert.match(call.text, /where environment_id/i);
      assert.match(call.text, /account_id/i);
      assert.equal(call.values.includes(FAMILY_A), true);
      assert.equal(call.values.includes(accountId), true);
      activeFamilies.set(FAMILY_A, false);
      return [{ session_id: "session-family-a", revoked_at: createdAt }];
    }
    throw new Error(`unexpected query: ${call.text}`);
  });

  await assert.rejects(
    () => repoFor(sql).rotateSession({
      sessionToken: SESSION_TOKEN,
      presentedRefreshToken: "family-a-refresh",
      expectedRotationVersion: 1
    }),
    /SESSION_REFRESH_REPLAY|SESSION_ROTATION_STALE/
  );
  assert.equal(activeFamilies.get(FAMILY_A), false);
  assert.equal(activeFamilies.get(FAMILY_B), true);
});

test("clock is a required factory function and invalid clock values fail closed", async () => {
  const sql = fakeTaggedSql(() => {
    throw new Error("invalid clock must not reach SQL");
  });

  assert.throws(
    () => repoFor(sql, { clock: "not-a-clock" }),
    (error) => error?.code === "AUTH_DEPENDENCY_MISSING"
  );
  await assert.rejects(
    () => repoFor(sql, { clock: () => null }).createOAuthTransaction({}),
    (error) => error?.code === "INTERNAL_CLOCK_INVALID"
  );
});

test("revokeSessionFamily rejects null instead of dereferencing untrusted input", async () => {
  const sql = fakeTaggedSql(() => {
    throw new Error("invalid family must not reach SQL");
  });

  assert.throws(
    () => repoFor(sql).revokeSessionFamily(null),
    (error) => error?.code === "SESSION_INVALID"
  );
});

test("createAppSession ignores business family fields and uses the trusted uuidGenerator", async () => {
  const sql = fakeTaggedSql((call) => {
    assert.match(call.text, /insert into auth_sessions/i);
    return [{
      session_id: "session-trusted-family",
      auth_source: "logto",
      account_id: accountId,
      session_family_id: FAMILY_A,
      environment_id: "stage",
      site_id: "site-stage",
      logto_subject: "trusted-family-user",
      authz_version: 7,
      issued_at: createdAt,
      last_seen_at: createdAt,
      idle_expires_at: new Date(createdAt.getTime() + 86400000),
      absolute_expires_at: new Date(createdAt.getTime() + 86400000),
      rotation_version: 1
    }];
  });
  const repository = repoFor(sql, { uuidGenerator: () => FAMILY_A });

  await repository.createAppSession({
    authSource: "logto",
    accountId,
    logtoSubject: "trusted-family-user",
    refreshToken: "provider-refresh",
    authzVersion: 7,
    sessionFamilyId: FAMILY_B,
    familyId: FAMILY_B
  });

  assert.equal(sql.calls[0].values[4], FAMILY_A);
  assert.equal(sql.calls[0].values.includes(FAMILY_B), false);
});

test("createAppSession rejects a non-canonical trusted uuidGenerator result", async () => {
  const sql = fakeTaggedSql(() => {
    throw new Error("invalid family must not reach SQL");
  });

  await assert.rejects(
    () => repoFor(sql, { uuidGenerator: () => "short-family" }).createAppSession({
      authSource: "logto",
      accountId,
      logtoSubject: "trusted-family-user",
      refreshToken: "provider-refresh",
      authzVersion: 7,
      sessionFamilyId: FAMILY_A
    }),
    (error) => error?.code === "INTERNAL_FAMILY_ID_INVALID"
  );
});

test("createAppSession rejects uppercase or padded trusted UUIDs", async () => {
  const sql = fakeTaggedSql(() => {
    throw new Error("non-canonical family must not reach SQL");
  });

  await assert.rejects(
    () => repoFor(sql, { uuidGenerator: () => ` ${FAMILY_A.toUpperCase()} ` }).createAppSession({
      authSource: "logto",
      accountId,
      logtoSubject: "trusted-family-user",
      refreshToken: "provider-refresh",
      authzVersion: 7
    }),
    (error) => error?.code === "INTERNAL_FAMILY_ID_INVALID"
  );
});

test("revokeSessionFamily requires account plus family and scopes environment and site", async () => {
  let updateCall;
  const sql = fakeTaggedSql((call) => {
    if (/update auth_sessions[\s\S]*revoked_at/i.test(call.text)) {
      updateCall = call;
      return [{ session_id: "session-family-a", revoked_at: createdAt }];
    }
    throw new Error(`unexpected query: ${call.text}`);
  });

  await repoFor(sql).revokeSessionFamily({
    accountId,
    sessionFamilyId: FAMILY_A
  });

  assert.ok(updateCall);
  assert.match(updateCall.text, /account_id\s*=\s*<param>/i);
  assert.match(updateCall.text, /session_family_id\s*=\s*<param>/i);
  assert.match(updateCall.text, /environment_id\s*=\s*<param>/i);
  assert.match(updateCall.text, /site_id\s*=\s*<param>/i);
  assert.equal(updateCall.values.includes(accountId), true);
  assert.equal(updateCall.values.includes(FAMILY_A), true);
  assert.equal(updateCall.values.includes("stage"), true);
  assert.equal(updateCall.values.includes("site-stage"), true);
});

test("revokeSessionFamily does not revoke a same-family row belonging to another account", async () => {
  const active = new Map([
    [`${accountId}:${FAMILY_A}`, true],
    [`other:${FAMILY_A}`, true],
    [`${accountId}:${FAMILY_B}`, true]
  ]);
  const otherAccountId = "33333333-3333-4333-8333-333333333333";
  const sql = fakeTaggedSql((call) => {
    if (/update auth_sessions[\s\S]*revoked_at/i.test(call.text)) {
      const account = call.values.find((value) => value === accountId || value === otherAccountId);
      const family = call.values.find((value) => value === FAMILY_A || value === FAMILY_B);
      active.set(`${account}:${family}`, false);
      return [{ session_id: "session-family-a", revoked_at: createdAt }];
    }
    throw new Error(`unexpected query: ${call.text}`);
  });

  await repoFor(sql).revokeSessionFamily({ accountId, sessionFamilyId: FAMILY_A });

  assert.equal(active.get(`${accountId}:${FAMILY_A}`), false);
  assert.equal(active.get(`other:${FAMILY_A}`), true);
  assert.equal(active.get(`${accountId}:${FAMILY_B}`), true);
});

test("readValidSessionFromCookie fails closed when a row belongs to another environment or site", async () => {
  const sql = fakeTaggedSql((call) => {
    assert.match(call.text, /update auth_sessions/i);
    return [{
      session_id: "production-session",
      auth_source: "logto",
      account_id: accountId,
      session_family_id: FAMILY_A,
      environment_id: "production",
      site_id: "site-production",
      logto_subject: "production-user",
      authz_version: 7,
      issued_at: createdAt,
      last_seen_at: createdAt,
      idle_expires_at: new Date(createdAt.getTime() + 86400000),
      absolute_expires_at: new Date(createdAt.getTime() + 86400000),
      revoked_at: null,
      rotation_version: 1
    }];
  });

  const session = await repoFor(sql).readValidSessionFromCookie({
    headers: { cookie: `__Host-shinegame_session=${SESSION_TOKEN}` }
  });

  assert.equal(session, null);
});

test("rotateSession rejects a row from another environment or site before updating it", async () => {
  const encryptedRefreshToken = await encryptSecret("cross-environment-refresh", {
    environmentId: "production",
    siteId: "site-production",
    keyVersion: 1
  });
  const sql = fakeTaggedSql((call) => {
    if (/select[\s\S]*from auth_sessions/i.test(call.text)) {
      return [{
        session_id: "production-session",
        auth_source: "logto",
        account_id: accountId,
        session_family_id: FAMILY_A,
        environment_id: "production",
        site_id: "site-production",
        logto_subject: "production-user",
        authz_version: 7,
        encrypted_refresh_token: encryptedRefreshToken,
        refresh_token_key_version: 1,
        rotation_version: 1,
        issued_at: createdAt,
        idle_expires_at: new Date(createdAt.getTime() + 86400000),
        absolute_expires_at: new Date(createdAt.getTime() + 86400000),
        revoked_at: null
      }];
    }
    if (/update auth_sessions/i.test(call.text)) {
      throw new Error("cross-environment row must not be updated");
    }
    throw new Error(`unexpected query: ${call.text}`);
  });

  await assert.rejects(
    () => repoFor(sql).rotateSession({
      sessionToken: SESSION_TOKEN,
      presentedRefreshToken: "cross-environment-refresh",
      expectedRotationVersion: 1
    }),
    (error) => error?.code === "AUTH_ENV_MISMATCH"
  );
});
