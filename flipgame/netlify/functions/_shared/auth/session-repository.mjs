import { randomUUID, timingSafeEqual } from "node:crypto";
import { sql as defaultSql, withTransaction as defaultWithTransaction } from "./db.mjs";
import {
  decryptSecret as defaultDecryptSecret,
  encryptSecret as defaultEncryptSecret,
  randomToken as defaultRandomToken,
  tokenHash as defaultTokenHash
} from "./crypto.mjs";
import { safeNextPath as defaultSafeNextPath } from "./http.mjs";

const OAUTH_TTL_MS = 10 * 60 * 1000;
const BRIDGE_TTL_MS = 5 * 60 * 1000;
const IDLE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const LOGTO_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OPAQUE_TOKEN_BYTES = 32;
const OPAQUE_TOKEN_LENGTH = 43;
const LEGACY_SECRET_MAX_LENGTH = 4096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SESSION_COOKIE_NAME = "__Host-shinegame_session";

/** Stable auth-boundary error with no sensitive details. */
export class SessionAuthError extends Error {
  constructor(code, status = 401) {
    super(code);
    this.name = "SessionAuthError";
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.httpStatus = status;
  }
}

function fail(code, status = 401) {
  return new SessionAuthError(code, status);
}

function hasOwn(value, name) {
  return Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, name));
}

function field(row, camelName, snakeName = camelName) {
  if (!row || typeof row !== "object") return undefined;
  if (hasOwn(row, camelName)) return row[camelName];
  return row[snakeName];
}

function taggedAdapter(value) {
  return typeof value === "function" || Boolean(value && typeof value.query === "function");
}

function query(adapter, parts, values = []) {
  const strings = Array.from(parts);
  strings.raw = Array.from(parts);
  if (typeof adapter === "function") return adapter(strings, ...values);
  if (adapter && typeof adapter.query === "function") {
    const text = strings.reduce(
      (result, part, index) => `${result}${part}${index < values.length ? `$${index + 1}` : ""}`,
      ""
    );
    return adapter.query(text, values);
  }
  throw new TypeError("auth SQL adapter must be a tagged function or query object");
}

function valueParts(prefix, valueCount, suffix) {
  return [prefix, ...Array.from({ length: valueCount - 1 }, () => ", "), suffix];
}

async function rowsFrom(result) {
  const value = await result;
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.rows)) return value.rows;
  return [];
}

function text(value, code = "AUTH_INPUT_INVALID", status = 400) {
  if (typeof value !== "string" || value.trim() === "") throw fail(code, status);
  return value.trim();
}

function boundedText(value, maxLength, code = "AUTH_INPUT_INVALID", status = 400) {
  const result = text(value, code, status);
  if (result.length > maxLength || /[\u0000-\u001f\u007f]/u.test(result)) throw fail(code, status);
  return result;
}

function optionalText(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim();
}

function asDate(value, code = "AUTH_INPUT_INVALID", status = 400) {
  if (value === undefined || value === null || value === "") throw fail(code, status);
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw fail(code, status);
  return date;
}

function dateOrNull(value) {
  if (value === undefined || value === null) return null;
  return asDate(value, "SESSION_INVALID", 401);
}

function nowValue(deps) {
  let value;
  try {
    value = deps.clock();
  } catch {
    throw fail("INTERNAL_CLOCK_INVALID", 500);
  }
  return asDate(value, "INTERNAL_CLOCK_INVALID", 500);
}

function positiveInteger(value, code = "AUTH_INPUT_INVALID", status = 400) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "bigint" && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/u.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  throw fail(code, status);
}

function positiveVersion(value, code = "SESSION_INVALID", status = 401) {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/u.test(normalized)) throw fail(code, status);
  return normalized;
}

function opaqueToken(value, code = "AUTH_TOKEN_INVALID", status = 400) {
  if (typeof value !== "string" || value.length !== OPAQUE_TOKEN_LENGTH ||
      !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw fail(code, status);
  }
  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    throw fail(code, status);
  }
  if (decoded.length !== OPAQUE_TOKEN_BYTES || decoded.toString("base64url") !== value) {
    throw fail(code, status);
  }
  return value;
}

async function generatedToken(deps) {
  let candidate;
  try {
    candidate = await deps.tokenGenerator();
  } catch {
    throw fail("INTERNAL_TOKEN_INVALID", 500);
  }
  return opaqueToken(candidate, "INTERNAL_TOKEN_INVALID", 500);
}

function legacySecret(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > LEGACY_SECRET_MAX_LENGTH ||
      !/^[\u0021-\u007e]+$/u.test(value)) {
    throw fail("AUTH_TOKEN_INVALID", 400);
  }
  return value;
}

function uuid(value, code = "AUTH_INPUT_INVALID", status = 400) {
  if (typeof value !== "string" || value !== value.trim() || !UUID_PATTERN.test(value)) {
    throw fail(code, status);
  }
  return value;
}

function generatedFamilyId(deps) {
  let candidate;
  try {
    candidate = deps.uuidGenerator();
  } catch {
    throw fail("INTERNAL_FAMILY_ID_INVALID", 500);
  }
  return uuid(candidate, "INTERNAL_FAMILY_ID_INVALID", 500);
}

function secretText(value, code = "AUTH_INPUT_INVALID", status = 400) {
  return text(value, code, status);
}

function resolveEnvironmentId(overrides) {
  return boundedText(
    overrides.environmentId ?? overrides.envId ?? process.env.AUTH_ENV_ID,
    128,
    "AUTH_CONFIG_MISSING:AUTH_ENV_ID",
    500
  );
}

function resolveSiteId(overrides) {
  return boundedText(
    overrides.siteId ?? overrides.expectedSiteId ??
      process.env.NETLIFY_SITE_ID ?? process.env.AUTH_EXPECTED_SITE_ID,
    255,
    "AUTH_CONFIG_MISSING:NETLIFY_SITE_ID",
    500
  );
}

function resolveKeyVersion(overrides) {
  const normalized = String(
    overrides.keyVersion ?? overrides.encryptionKeyVersion ??
      process.env.AUTH_ENCRYPTION_KEY_VERSION ?? "1"
  ).trim();
  if (!/^[1-9][0-9]*$/u.test(normalized)) throw fail("AUTH_KEY_VERSION_INVALID", 500);
  const version = Number(normalized);
  if (!Number.isSafeInteger(version) || version > 0x7fffffff) {
    throw fail("AUTH_KEY_VERSION_INVALID", 500);
  }
  return version;
}

function dependencies(overrides = {}) {
  if (!overrides || typeof overrides !== "object") {
    throw new TypeError("auth session repository dependencies must be an object");
  }
  const hasSql = hasOwn(overrides, "sql") && overrides.sql !== undefined;
  const hasWithTransaction = hasOwn(overrides, "withTransaction") &&
    overrides.withTransaction !== undefined;
  if (hasSql !== hasWithTransaction) throw fail("AUTH_REPOSITORY_DEPENDENCY_MISMATCH", 500);

  const resolved = {
    sql: hasSql ? overrides.sql : defaultSql,
    withTransaction: hasWithTransaction ? overrides.withTransaction : defaultWithTransaction,
    environmentId: resolveEnvironmentId(overrides),
    siteId: resolveSiteId(overrides),
    keyVersion: resolveKeyVersion(overrides),
    clock: hasOwn(overrides, "clock") ? overrides.clock : () => new Date(),
    tokenGenerator: hasOwn(overrides, "tokenGenerator")
      ? overrides.tokenGenerator
      : hasOwn(overrides, "randomToken") ? overrides.randomToken : defaultRandomToken,
    uuidGenerator: hasOwn(overrides, "uuidGenerator")
      ? overrides.uuidGenerator : () => randomUUID(),
    hmacKey: overrides.hmacKey ?? overrides.authHmacKey,
    encryptionKey: overrides.encryptionKey ?? overrides.authEncryptionKey,
    tokenHash: overrides.tokenHash || defaultTokenHash,
    encryptSecret: overrides.encryptSecret || defaultEncryptSecret,
    decryptSecret: overrides.decryptSecret || defaultDecryptSecret,
    safeNextPath: overrides.safeNextPath || defaultSafeNextPath,
    allowedPaths: overrides.allowedPaths ?? overrides.nextPathAllowlist
  };
  if (!taggedAdapter(resolved.sql) || typeof resolved.withTransaction !== "function") {
    throw fail("AUTH_REPOSITORY_DEPENDENCY_MISMATCH", 500);
  }
  for (const name of ["clock", "tokenGenerator", "uuidGenerator", "tokenHash", "encryptSecret", "decryptSecret", "safeNextPath"]) {
    if (typeof resolved[name] !== "function") throw fail("AUTH_DEPENDENCY_MISSING", 500);
  }
  return resolved;
}

function assertTransaction(transaction) {
  if (!taggedAdapter(transaction) || typeof transaction.begin === "function") {
    throw fail("TRANSACTION_REQUIRED", 500);
  }
  return transaction;
}

async function hashToken(deps, value) {
  return deps.tokenHash(text(value, "AUTH_TOKEN_INVALID", 400));
}

function hashesEqual(left, right) {
  if (left === undefined || left === null || right === undefined || right === null) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function safePath(deps, value) {
  try {
    const options = deps.allowedPaths === undefined ? {} : { allowedPaths: deps.allowedPaths };
    return deps.safeNextPath(value ?? "/", options);
  } catch {
    throw fail("INVALID_NEXT", 400);
  }
}

function transactionFallback(row, fallback = {}) {
  const transactionId = field(row, "transactionId", "transaction_id");
  if (transactionId === undefined || transactionId === null || String(transactionId).trim() === "") {
    throw fail("TRANSACTION_INVALID", 401);
  }
  const createdAt = dateOrNull(field(row, "createdAt", "created_at")) ?? fallback.createdAt;
  const expiresAt = dateOrNull(field(row, "expiresAt", "expires_at")) ?? fallback.expiresAt;
  return {
    transactionId,
    transactionKind: field(row, "transactionKind", "transaction_kind") ?? fallback.transactionKind,
    nextPath: field(row, "nextPath", "next_path") ?? fallback.nextPath,
    accountId: field(row, "accountId", "account_id") ?? fallback.accountId,
    migrationId: field(row, "migrationId", "migration_id") ?? fallback.migrationId,
    createdAt,
    expiresAt
  };
}

async function transactionInput(input, kind, deps) {
  if (!input || typeof input !== "object") throw fail("AUTH_INPUT_INVALID", 400);
  const now = nowValue(deps);
  const state = await generatedToken(deps);
  const nextPath = safePath(deps, input.nextPath);
  const expiresAt = new Date(now.getTime() + (kind === "oauth" ? OAUTH_TTL_MS : BRIDGE_TTL_MS));
  return { now, state, nextPath, expiresAt };
}

async function insertOAuthTransaction(input, deps) {
  const { now, state, nextPath, expiresAt } = await transactionInput(input, "oauth", deps);
  const nonce = await generatedToken(deps);
  const pkceVerifier = await generatedToken(deps);
  const encryptedNonce = await deps.encryptSecret(
    nonce,
    cryptoOptions(deps, deps.keyVersion)
  );
  const encryptedVerifier = await deps.encryptSecret(
    pkceVerifier,
    cryptoOptions(deps, deps.keyVersion)
  );
  const rows = await rowsFrom(query(
    deps.sql,
    valueParts(
      `INSERT INTO oauth_transactions
        (transaction_kind, state_hash, nonce_hash, nonce_encrypted, pkce_verifier_encrypted,
         csrf_token_hash, environment_id, site_id, next_path, account_id,
         legacy_session_id_hash, migration_id, created_at, expires_at)
       VALUES (`,
      14,
      `)
       RETURNING transaction_id, transaction_kind, next_path, created_at, expires_at`
    ),
    [
      "oauth",
      await hashToken(deps, state),
      await hashToken(deps, nonce),
      encryptedNonce,
      encryptedVerifier,
      null,
      deps.environmentId,
      deps.siteId,
      nextPath,
      input.accountId ?? null,
      null,
      input.migrationId ?? null,
      now,
      expiresAt
    ]
  ));
  if (rows.length !== 1) throw fail("TRANSACTION_CREATE_FAILED", 500);
  const output = transactionFallback(rows[0], {
    transactionKind: "oauth",
    nextPath,
    createdAt: now,
    expiresAt
  });
  output.state = state;
  output.nonce = nonce;
  output.pkceVerifier = pkceVerifier;
  return output;
}

async function insertBridgeTransaction(input, deps) {
  if (!input || typeof input !== "object") throw fail("AUTH_INPUT_INVALID", 400);
  const { now, state, nextPath, expiresAt } = await transactionInput(input, "bridge", deps);
  const legacySessionId = legacySecret(input.legacySessionId ?? input.legacySessionToken);
  const csrfToken = await generatedToken(deps);
  const accountId = text(input.accountId);
  const migrationId = text(input.migrationId);
  const rows = await rowsFrom(query(
    deps.sql,
    valueParts(
      `INSERT INTO oauth_transactions
        (transaction_kind, state_hash, nonce_hash, nonce_encrypted, pkce_verifier_encrypted,
         csrf_token_hash, environment_id, site_id, next_path, account_id,
         legacy_session_id_hash, migration_id, created_at, expires_at)
       VALUES (`,
      14,
      `)
       RETURNING transaction_id, transaction_kind, next_path, account_id,
                 migration_id, created_at, expires_at`
    ),
    [
      "bridge",
      await hashToken(deps, state),
      null,
      null,
      null,
      await hashToken(deps, csrfToken),
      deps.environmentId,
      deps.siteId,
      nextPath,
      accountId,
      await hashToken(deps, legacySessionId),
      migrationId,
      now,
      expiresAt
    ]
  ));
  if (rows.length !== 1) throw fail("TRANSACTION_CREATE_FAILED", 500);
  const output = transactionFallback(rows[0], {
    transactionKind: "bridge",
    nextPath,
    accountId,
    migrationId,
    createdAt: now,
    expiresAt
  });
  output.state = state;
  output.csrfToken = csrfToken;
  output.accountId = output.accountId ?? accountId;
  output.migrationId = output.migrationId ?? migrationId;
  return output;
}

function cryptoOptions(deps, keyVersion) {
  const options = {
    environmentId: deps.environmentId,
    siteId: deps.siteId,
    keyVersion
  };
  if (deps.hmacKey !== undefined) options.hmacKey = deps.hmacKey;
  if (deps.encryptionKey !== undefined) options.encryptionKey = deps.encryptionKey;
  return options;
}

function transactionMetadata(row, deps) {
  const environmentId = field(row, "environmentId", "environment_id");
  const siteId = field(row, "siteId", "site_id");
  if (environmentId !== deps.environmentId || siteId !== deps.siteId) {
    throw fail("AUTH_ENV_MISMATCH", 401);
  }
  const createdAt = dateOrNull(field(row, "createdAt", "created_at"));
  const expiresAt = dateOrNull(field(row, "expiresAt", "expires_at"));
  if (!createdAt || !expiresAt) throw fail("TRANSACTION_INVALID", 401);
  return { createdAt, expiresAt };
}

async function lockTransaction(input, expectedKind, adapter, deps) {
  if (!input || typeof input !== "object") throw fail("AUTH_INPUT_INVALID", 400);
  const state = opaqueToken(input.state, "AUTH_TOKEN_INVALID", 400);
  const rows = await rowsFrom(query(
    adapter,
    [
      `SELECT transaction_id, transaction_kind, state_hash, nonce_hash,
              nonce_encrypted, pkce_verifier_encrypted, csrf_token_hash, environment_id,
              site_id, next_path, account_id, legacy_session_id_hash,
              migration_id, created_at, expires_at, consumed_at
       FROM oauth_transactions
       WHERE state_hash = `,
      ` AND environment_id = `,
      ` AND site_id = `,
      `
       FOR UPDATE`
    ],
    [await hashToken(deps, state), deps.environmentId, deps.siteId]
  ));
  if (rows.length !== 1) throw fail("TRANSACTION_REPLAY", 401);
  const row = rows[0];
  if (field(row, "transactionKind", "transaction_kind") !== expectedKind) {
    throw fail("TRANSACTION_INVALID", 401);
  }
  const { createdAt, expiresAt } = transactionMetadata(row, deps);
  const consumedAt = field(row, "consumedAt", "consumed_at");
  if (consumedAt !== undefined && consumedAt !== null) throw fail("TRANSACTION_REPLAY", 401);
  const now = nowValue(deps);
  if (now.getTime() < createdAt.getTime() || now.getTime() >= expiresAt.getTime()) {
    throw fail("TRANSACTION_EXPIRED", 401);
  }
  return { row, state, now, createdAt, expiresAt };
}

async function consumeOAuth(input, transaction, deps) {
  const locked = await lockTransaction(input, "oauth", transaction, deps);
  const row = locked.row;
  const expectedStateHash = await hashToken(deps, locked.state);
  const consumeBeforeExchange = input.nonce === undefined && input.pkceVerifier === undefined;
  if (!consumeBeforeExchange && (input.nonce === undefined || input.pkceVerifier === undefined)) {
    throw fail("TRANSACTION_INVALID", 401);
  }
  if (!hashesEqual(field(row, "stateHash", "state_hash"), expectedStateHash)) {
    throw fail("TRANSACTION_INVALID", 401);
  }
  const encryptedVerifier = field(row, "pkceVerifierEncrypted", "pkce_verifier_encrypted");
  const encryptedNonce = field(row, "nonceEncrypted", "nonce_encrypted");
  if (encryptedNonce === undefined || encryptedNonce === null) throw fail("TRANSACTION_INVALID", 401);
  if (encryptedVerifier === undefined || encryptedVerifier === null) throw fail("TRANSACTION_INVALID", 401);
  let storedNonce;
  let storedVerifier;
  try {
    storedNonce = await deps.decryptSecret(
      encryptedNonce,
      cryptoOptions(deps, deps.keyVersion)
    );
    storedVerifier = await deps.decryptSecret(
      encryptedVerifier,
      cryptoOptions(deps, deps.keyVersion)
    );
  } catch {
    throw fail("TRANSACTION_INVALID", 401);
  }
  opaqueToken(storedNonce, "TRANSACTION_INVALID", 401);
  opaqueToken(storedVerifier, "TRANSACTION_INVALID", 401);
  if (!hashesEqual(
    field(row, "nonceHash", "nonce_hash"),
    await hashToken(deps, storedNonce)
  )) {
    throw fail("TRANSACTION_INVALID", 401);
  }
  if (!consumeBeforeExchange) {
    const expectedNonceHash = await hashToken(
      deps,
      opaqueToken(input.nonce, "AUTH_TOKEN_INVALID", 400)
    );
    const expectedVerifierHash = await hashToken(
      deps,
      opaqueToken(input.pkceVerifier, "AUTH_TOKEN_INVALID", 400)
    );
    if (!hashesEqual(field(row, "nonceHash", "nonce_hash"), expectedNonceHash) ||
        !hashesEqual(await hashToken(deps, storedVerifier), expectedVerifierHash)) {
      throw fail("TRANSACTION_INVALID", 401);
    }
  }
  const rows = await rowsFrom(query(
    transaction,
    [
      `UPDATE oauth_transactions
          SET consumed_at = `,
      `
        WHERE transaction_id = `,
      ` AND environment_id = `,
      ` AND site_id = `,
      ` AND consumed_at IS NULL
        RETURNING consumed_at`
    ],
    [
      locked.now,
      field(row, "transactionId", "transaction_id"),
      deps.environmentId,
      deps.siteId
    ]
  ));
  if (rows.length !== 1) throw fail("TRANSACTION_REPLAY", 401);
  return {
    transactionId: field(row, "transactionId", "transaction_id"),
    nextPath: field(row, "nextPath", "next_path"),
    accountId: field(row, "accountId", "account_id") ?? undefined,
    migrationId: field(row, "migrationId", "migration_id") ?? undefined,
    nonce: storedNonce,
    pkceVerifier: storedVerifier,
    nonceHash: field(row, "nonceHash", "nonce_hash")
  };
}

async function consumeBridge(input, transaction, deps) {
  const locked = await lockTransaction(input, "bridge", transaction, deps);
  const row = locked.row;
  const legacySessionId = legacySecret(
    input.legacySessionId ?? input.legacySessionToken,
  );
  const csrfToken = opaqueToken(input.csrfToken, "AUTH_TOKEN_INVALID", 400);
  if (!hashesEqual(field(row, "stateHash", "state_hash"), await hashToken(deps, locked.state)) ||
      !hashesEqual(field(row, "legacySessionIdHash", "legacy_session_id_hash"), await hashToken(deps, legacySessionId)) ||
      !hashesEqual(field(row, "csrfTokenHash", "csrf_token_hash"), await hashToken(deps, csrfToken))) {
    throw fail("TRANSACTION_INVALID", 401);
  }
  const rows = await rowsFrom(query(
    transaction,
    [
      `UPDATE oauth_transactions
          SET consumed_at = `,
      `
        WHERE transaction_id = `,
      ` AND environment_id = `,
      ` AND site_id = `,
      ` AND consumed_at IS NULL
        RETURNING consumed_at`
    ],
    [
      locked.now,
      field(row, "transactionId", "transaction_id"),
      deps.environmentId,
      deps.siteId
    ]
  ));
  if (rows.length !== 1) throw fail("TRANSACTION_REPLAY", 401);
  return {
    transactionId: field(row, "transactionId", "transaction_id"),
    nextPath: field(row, "nextPath", "next_path"),
    accountId: field(row, "accountId", "account_id"),
    migrationId: field(row, "migrationId", "migration_id")
  };
}

/** Consume a cancelled OAuth transaction without accepting provider input. */
async function cancelOAuth(input, transaction, deps) {
  const locked = await lockTransaction(input, "oauth", transaction, deps);
  const rows = await rowsFrom(query(
    transaction,
    [
      `UPDATE oauth_transactions
          SET consumed_at = `,
      `
        WHERE transaction_id = `,
      ` AND environment_id = `,
      ` AND site_id = `,
      ` AND consumed_at IS NULL
        RETURNING consumed_at`
    ],
    [
      locked.now,
      field(locked.row, "transactionId", "transaction_id"),
      deps.environmentId,
      deps.siteId
    ]
  ));
  if (rows.length !== 1) throw fail("TRANSACTION_REPLAY", 401);
  return {
    transactionId: field(locked.row, "transactionId", "transaction_id"),
    nextPath: field(locked.row, "nextPath", "next_path")
  };
}

function sessionRowShape(row, includeSecrets = false, expectedEnvironmentId = null, expectedSiteId = null) {
  if (!row || typeof row !== "object") throw fail("SESSION_INVALID", 401);
  const authSource = field(row, "authSource", "auth_source");
  const sessionId = field(row, "sessionId", "session_id");
  const sessionFamilyId = field(row, "sessionFamilyId", "session_family_id");
  const accountId = field(row, "accountId", "account_id");
  const authzVersion = field(row, "authzVersion", "authz_version");
  const environmentId = field(row, "environmentId", "environment_id");
  const siteId = field(row, "siteId", "site_id");
  if ((authSource !== "logto" && authSource !== "legacy_bridge") ||
      sessionId === undefined || sessionFamilyId === undefined ||
      accountId === undefined || authzVersion === undefined ||
      environmentId === undefined || siteId === undefined) {
    throw fail("SESSION_INVALID", 401);
  }
  const safeSessionId = text(sessionId, "SESSION_INVALID", 401);
  const safeSessionFamilyId = uuid(sessionFamilyId, "SESSION_INVALID", 401);
  const safeAccountId = text(accountId, "SESSION_INVALID", 401);
  const safeAuthzVersion = positiveVersion(authzVersion);
  const safeEnvironmentId = boundedText(environmentId, 128, "SESSION_INVALID", 401);
  const safeSiteId = boundedText(siteId, 255, "SESSION_INVALID", 401);
  if ((expectedEnvironmentId !== null && safeEnvironmentId !== expectedEnvironmentId) ||
      (expectedSiteId !== null && safeSiteId !== expectedSiteId)) {
    throw fail("AUTH_ENV_MISMATCH", 401);
  }
  const sourceSubject = authSource === "logto"
    ? field(row, "logtoSubject", "logto_subject")
    : field(row, "legacyNetlifyUserId", "legacy_netlify_user_id");
  const safeSourceSubject = text(sourceSubject, "SESSION_INVALID", 401);
  const output = {
    sessionId: safeSessionId,
    sessionFamilyId: safeSessionFamilyId,
    environmentId: safeEnvironmentId,
    siteId: safeSiteId,
    authSource,
    accountId: safeAccountId,
    authzVersion: safeAuthzVersion,
    migrationId: field(row, "migrationId", "migration_id") ?? null,
    issuedAt: dateOrNull(field(row, "issuedAt", "issued_at")),
    lastSeenAt: dateOrNull(field(row, "lastSeenAt", "last_seen_at")),
    idleExpiresAt: dateOrNull(field(row, "idleExpiresAt", "idle_expires_at")),
    absoluteExpiresAt: dateOrNull(field(row, "absoluteExpiresAt", "absolute_expires_at")),
    rotationVersion: field(row, "rotationVersion", "rotation_version")
  };
  if (authSource === "logto") output.logtoSubject = safeSourceSubject;
  else output.legacyNetlifyUserId = safeSourceSubject;
  if (includeSecrets) {
    output.encryptedRefreshToken = field(row, "encryptedRefreshToken", "encrypted_refresh_token");
    output.refreshTokenKeyVersion = field(row, "refreshTokenKeyVersion", "refresh_token_key_version");
    output.revokedAt = field(row, "revokedAt", "revoked_at") ?? null;
  }
  return output;
}

function task3SessionShape(row, deps) {
  const session = sessionRowShape(row, false, deps.environmentId, deps.siteId);
  const output = {
    sessionId: session.sessionId,
    accountId: session.accountId,
    authSource: session.authSource,
    migrationId: session.migrationId,
    authzVersion: session.authzVersion
  };
  if (session.authSource === "logto") output.logtoSubject = session.logtoSubject;
  else output.legacyNetlifyUserId = session.legacyNetlifyUserId;
  return output;
}

async function sessionCreationInput(input, deps) {
  if (!input || typeof input !== "object") throw fail("AUTH_INPUT_INVALID", 400);
  const authSource = text(input.authSource).toLowerCase();
  if (authSource !== "logto" && authSource !== "legacy_bridge") throw fail("AUTH_INPUT_INVALID", 400);
  const accountId = text(input.accountId);
  const now = nowValue(deps);
  const sessionToken = await generatedToken(deps);
  const sessionFamilyId = generatedFamilyId(deps);
  const authzVersion = positiveInteger(input.authzVersion);
  let sourceSubject;
  let migrationId = null;
  let refreshToken = null;
  let refreshTokenKeyVersion = null;
  let absoluteExpiresAt = new Date(now.getTime() + LOGTO_ABSOLUTE_TTL_MS);
  if (authSource === "logto") {
    sourceSubject = boundedText(input.logtoSubject ?? input.subject, 512);
    refreshToken = secretText(input.refreshToken, "AUTH_INPUT_INVALID", 400);
    refreshTokenKeyVersion = deps.keyVersion;
  } else {
    sourceSubject = boundedText(input.legacyNetlifyUserId ?? input.legacySessionId, 255);
    migrationId = text(input.migrationId);
    if (input.refreshToken !== undefined && input.refreshToken !== null) {
      throw fail("SESSION_REFRESH_NOT_ALLOWED", 400);
    }
    const migrationWindowEndsAt = asDate(input.migrationWindowEndsAt, "AUTH_INPUT_INVALID", 400);
    if (migrationWindowEndsAt.getTime() <= now.getTime()) throw fail("SESSION_EXPIRED", 400);
    absoluteExpiresAt = new Date(Math.min(
      absoluteExpiresAt.getTime(),
      migrationWindowEndsAt.getTime()
    ));
  }
  const idleExpiresAt = new Date(Math.min(
    now.getTime() + IDLE_TTL_MS,
    absoluteExpiresAt.getTime()
  ));
  if (idleExpiresAt.getTime() <= now.getTime()) throw fail("SESSION_EXPIRED", 400);
  return {
    authSource,
    accountId,
    sessionFamilyId,
    sourceSubject,
    migrationId,
    refreshToken,
    refreshTokenKeyVersion,
    sessionToken,
    authzVersion,
    now,
    idleExpiresAt,
    absoluteExpiresAt
  };
}

async function revokeExpiredLegacySessionInTransaction(transaction, parsed, deps) {
  if (parsed.authSource !== "legacy_bridge") return;
  await rowsFrom(query(
    transaction,
    [
      `UPDATE auth_sessions
          SET revoked_at = `,
      `
        WHERE environment_id = `,
      ` AND site_id = `,
      ` AND legacy_netlify_user_id = `,
      ` AND revoked_at IS NULL
        AND (idle_expires_at <= `,
      ` OR absolute_expires_at <= `,
      `)
        RETURNING session_id`
    ],
    [
      parsed.now,
      deps.environmentId,
      deps.siteId,
      parsed.sourceSubject,
      parsed.now,
      parsed.now
    ]
  ));
}

async function insertAppSession(
  input,
  deps,
  adapter = deps.sql,
  parsedInput = null,
  options = {}
) {
  const parsed = parsedInput || await sessionCreationInput(input, deps);
  const encryptedRefreshToken = parsed.refreshToken === null
    ? null
    : await deps.encryptSecret(
      parsed.refreshToken,
      cryptoOptions(deps, parsed.refreshTokenKeyVersion)
    );
  const rows = await rowsFrom(query(
    adapter,
    valueParts(
      `INSERT INTO auth_sessions
        (auth_source, environment_id, site_id, session_id_hash, session_family_id, account_id, logto_subject,
         legacy_netlify_user_id, migration_id, encrypted_refresh_token,
         refresh_token_key_version, issued_at, last_seen_at, idle_expires_at,
         absolute_expires_at, authz_version, rotation_version, created_at)
       VALUES (`,
      18,
      `)
       ${options.bridgeAtomic ? `ON CONFLICT (environment_id, site_id, legacy_netlify_user_id)
         WHERE legacy_netlify_user_id IS NOT NULL AND revoked_at IS NULL
         DO NOTHING
       ` : ""}
       RETURNING session_id, auth_source, environment_id, site_id, session_family_id, account_id, logto_subject,
                 legacy_netlify_user_id, migration_id, issued_at,
                 last_seen_at, idle_expires_at, absolute_expires_at,
                 authz_version, rotation_version`
    ),
    [
      parsed.authSource,
      deps.environmentId,
      deps.siteId,
      await hashToken(deps, parsed.sessionToken),
      parsed.sessionFamilyId,
      parsed.accountId,
      parsed.authSource === "logto" ? parsed.sourceSubject : null,
      parsed.authSource === "legacy_bridge" ? parsed.sourceSubject : null,
      parsed.migrationId,
      encryptedRefreshToken,
      parsed.refreshTokenKeyVersion === null ? null : String(parsed.refreshTokenKeyVersion),
      parsed.now,
      parsed.now,
      parsed.idleExpiresAt,
      parsed.absoluteExpiresAt,
      parsed.authzVersion,
      1,
      parsed.now
    ]
  ));
  if (rows.length !== 1) {
    if (options.bridgeAtomic) throw fail("SESSION_REPLAY", 401);
    throw fail("SESSION_CREATE_FAILED", 500);
  }
  const row = rows[0];
  const merged = {
    ...row,
    auth_source: field(row, "authSource", "auth_source") ?? parsed.authSource,
    environment_id: field(row, "environmentId", "environment_id") ?? deps.environmentId,
    site_id: field(row, "siteId", "site_id") ?? deps.siteId,
    account_id: field(row, "accountId", "account_id") ?? parsed.accountId,
    logto_subject: field(row, "logtoSubject", "logto_subject") ??
      (parsed.authSource === "logto" ? parsed.sourceSubject : null),
    legacy_netlify_user_id: field(row, "legacyNetlifyUserId", "legacy_netlify_user_id") ??
      (parsed.authSource === "legacy_bridge" ? parsed.sourceSubject : null),
    migration_id: field(row, "migrationId", "migration_id") ?? parsed.migrationId,
    authz_version: field(row, "authzVersion", "authz_version") ?? parsed.authzVersion,
      rotation_version: field(row, "rotationVersion", "rotation_version") ?? 1,
      session_family_id: field(row, "sessionFamilyId", "session_family_id") ?? parsed.sessionFamilyId,
    issued_at: field(row, "issuedAt", "issued_at") ?? parsed.now,
    last_seen_at: field(row, "lastSeenAt", "last_seen_at") ?? parsed.now,
    idle_expires_at: field(row, "idleExpiresAt", "idle_expires_at") ?? parsed.idleExpiresAt,
    absolute_expires_at: field(row, "absoluteExpiresAt", "absolute_expires_at") ?? parsed.absoluteExpiresAt
  };
  const output = sessionRowShape(merged, false, deps.environmentId, deps.siteId);
  output.sessionToken = parsed.sessionToken;
  return output;
}

async function consumeBridgeAndCreateAppSessionInTransaction(input, transaction, deps) {
  if (!input || typeof input !== "object" || !input.sessionInput ||
      typeof input.sessionInput !== "object") {
    throw fail("AUTH_INPUT_INVALID", 400);
  }
  const consumed = await consumeBridge({
    state: input.state,
    legacySessionId: input.legacySessionId ?? input.legacySessionToken,
    csrfToken: input.csrfToken
  }, transaction, deps);
  const sessionInput = input.sessionInput;
  const consumedAccountId = field(consumed, "accountId", "account_id");
  const consumedMigrationId = field(consumed, "migrationId", "migration_id");
  if (consumedAccountId === undefined || consumedAccountId === null ||
      String(consumedAccountId) !== String(sessionInput.accountId) ||
      consumedMigrationId === undefined || consumedMigrationId === null ||
      String(consumedMigrationId) !== String(sessionInput.migrationId)) {
    throw fail("ACCOUNT_MAPPING_CONFLICT", 401);
  }
  const parsed = await sessionCreationInput(sessionInput, deps);
  await revokeExpiredLegacySessionInTransaction(transaction, parsed, deps);
  const session = await insertAppSession(
    sessionInput,
    deps,
    transaction,
    parsed,
    { bridgeAtomic: true }
  );
  return { consumed, session };
}

async function consumeBridgeAndCreateAppSessionWithDeps(input, deps) {
  return deps.withTransaction((rawTransaction) =>
    consumeBridgeAndCreateAppSessionInTransaction(input, assertTransaction(rawTransaction), deps)
  );
}

async function revokeFamilyInTransaction(transaction, accountId, sessionFamilyId, deps, now) {
  const safeAccountId = uuid(accountId, "SESSION_INVALID", 401);
  const familyId = uuid(sessionFamilyId, "SESSION_INVALID", 401);
  await rowsFrom(query(
    transaction,
    [
      `UPDATE auth_sessions
          SET revoked_at = COALESCE(revoked_at, `,
      `)
        WHERE environment_id = `,
      ` AND site_id = `,
      ` AND account_id = `,
      ` AND session_family_id = `,
      ` AND revoked_at IS NULL
        RETURNING session_id, revoked_at`
    ],
    [now, deps.environmentId, deps.siteId, safeAccountId, familyId]
  ));
}

function delayedFailure(code, status = 401) {
  return { __sessionFailure: fail(code, status) };
}

async function rotateInTransaction(transaction, input, deps) {
  assertTransaction(transaction);
  if (!input || typeof input !== "object") throw fail("AUTH_INPUT_INVALID", 400);
  const sessionToken = opaqueToken(input.sessionToken, "AUTH_TOKEN_INVALID", 400);
  const presentedRefreshToken = secretText(
    input.presentedRefreshToken ?? input.refreshToken,
    "AUTH_TOKEN_INVALID",
    400
  );
  const expectedValue = input.expectedRotationVersion ?? input.rotationVersion;
  const expectedVersion = expectedValue === undefined || expectedValue === null
    ? null
    : positiveInteger(expectedValue, "SESSION_ROTATION_STALE", 401);
  const now = nowValue(deps);
  const sessionHash = await hashToken(deps, sessionToken);
  const rows = await rowsFrom(query(
    transaction,
    [
      `SELECT session_id, auth_source, environment_id, site_id, session_id_hash, session_family_id, account_id,
              logto_subject, legacy_netlify_user_id, migration_id,
              encrypted_refresh_token, refresh_token_key_version,
              issued_at, last_seen_at, idle_expires_at, absolute_expires_at,
              authz_version, rotation_version, revoked_at
       FROM auth_sessions
       WHERE session_id_hash = `,
      ` AND environment_id = `,
      ` AND site_id = `,
      `
       FOR UPDATE`
    ],
    [sessionHash, deps.environmentId, deps.siteId]
  ));
  if (rows.length !== 1) return delayedFailure("SESSION_REFRESH_REPLAY", 401);
  const row = rows[0];
  const shape = sessionRowShape(row, true, deps.environmentId, deps.siteId);
  const rotationVersion = positiveInteger(shape.rotationVersion, "SESSION_INVALID", 401);
  const issuedAt = shape.issuedAt;
  const idleExpiresAt = shape.idleExpiresAt;
  const absoluteExpiresAt = shape.absoluteExpiresAt;
  if (shape.authSource !== "logto" || !shape.encryptedRefreshToken || shape.revokedAt ||
      !idleExpiresAt || !absoluteExpiresAt ||
      (issuedAt && now.getTime() < issuedAt.getTime()) ||
      now.getTime() >= idleExpiresAt.getTime() || now.getTime() >= absoluteExpiresAt.getTime()) {
    await revokeFamilyInTransaction(transaction, shape.accountId, shape.sessionFamilyId, deps, now);
    return delayedFailure("SESSION_REFRESH_REPLAY", 401);
  }
  if (expectedVersion !== null && expectedVersion !== rotationVersion) {
    await revokeFamilyInTransaction(transaction, shape.accountId, shape.sessionFamilyId, deps, now);
    return delayedFailure("SESSION_ROTATION_STALE", 401);
  }
  let storedRefreshToken;
  try {
    const storedKeyVersion = positiveInteger(
      shape.refreshTokenKeyVersion,
      "SESSION_INVALID",
      401
    );
    storedRefreshToken = await deps.decryptSecret(
      shape.encryptedRefreshToken,
      cryptoOptions(deps, storedKeyVersion)
    );
  } catch {
    await revokeFamilyInTransaction(transaction, shape.accountId, shape.sessionFamilyId, deps, now);
    return delayedFailure("SESSION_REFRESH_REPLAY", 401);
  }
  if (!hashesEqual(
    await hashToken(deps, storedRefreshToken),
    await hashToken(deps, presentedRefreshToken)
  )) {
    await revokeFamilyInTransaction(transaction, shape.accountId, shape.sessionFamilyId, deps, now);
    return delayedFailure("SESSION_REFRESH_REPLAY", 401);
  }
  const nextRefreshToken = await generatedToken(deps);
  const encryptedNextToken = await deps.encryptSecret(
    nextRefreshToken,
    cryptoOptions(deps, deps.keyVersion)
  );
  const nextIdleExpiresAt = new Date(Math.min(
    now.getTime() + IDLE_TTL_MS,
    absoluteExpiresAt.getTime()
  ));
  const updatedRows = await rowsFrom(query(
    transaction,
    [
      `UPDATE auth_sessions
          SET encrypted_refresh_token = `,
      `, refresh_token_key_version = `,
      `, rotation_version = rotation_version + 1,
             last_seen_at = `,
      `, idle_expires_at = LEAST(absolute_expires_at, `,
      `)
        WHERE session_id_hash = `,
      ` AND rotation_version = `,
      ` AND environment_id = `,
      ` AND site_id = `,
      ` AND revoked_at IS NULL
        RETURNING session_id, auth_source, environment_id, site_id, session_family_id, account_id, logto_subject,
                  legacy_netlify_user_id, migration_id, issued_at,
                  last_seen_at, idle_expires_at, absolute_expires_at,
                  authz_version, rotation_version`
    ],
    [
      encryptedNextToken,
      String(deps.keyVersion),
      now,
      nextIdleExpiresAt,
      sessionHash,
      rotationVersion,
      deps.environmentId,
      deps.siteId
    ]
  ));
  if (updatedRows.length !== 1) {
    await revokeFamilyInTransaction(transaction, shape.accountId, shape.sessionFamilyId, deps, now);
    return delayedFailure("SESSION_REFRESH_REPLAY", 401);
  }
  const merged = { ...row, ...updatedRows[0] };
  const output = sessionRowShape(merged, false, deps.environmentId, deps.siteId);
  output.refreshToken = nextRefreshToken;
  return output;
}

function headerValue(request, name) {
  const headers = request?.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) ?? "");
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return String(value ?? "");
  }
  return "";
}

function cookieValue(request) {
  const header = headerValue(request, "cookie");
  if (!header) return null;
  let found = null;
  for (const segment of header.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1);
    if (name !== SESSION_COOKIE_NAME) continue;
    if (found !== null) return null;
    try {
      found = opaqueToken(value, "AUTH_TOKEN_INVALID", 400);
    } catch {
      return null;
    }
  }
  return found;
}

async function readValidSession(input, deps) {
  const token = cookieValue(input);
  if (token === null) return null;
  const now = nowValue(deps);
  const proposedIdleExpiry = new Date(now.getTime() + IDLE_TTL_MS);
  const rows = await rowsFrom(query(
    deps.sql,
    [
      `UPDATE auth_sessions
          SET last_seen_at = `,
      `, idle_expires_at = LEAST(absolute_expires_at, `,
      `)
        WHERE session_id_hash = `,
      ` AND environment_id = `,
      ` AND site_id = `,
      ` AND revoked_at IS NULL
          AND idle_expires_at > `,
      ` AND absolute_expires_at > `,
      `
        RETURNING session_id, auth_source, environment_id, site_id, session_family_id, account_id, logto_subject,
                  legacy_netlify_user_id, migration_id, issued_at,
                  last_seen_at, idle_expires_at, absolute_expires_at,
                  authz_version, rotation_version, revoked_at`
    ],
    [
      now,
      proposedIdleExpiry,
      await hashToken(deps, token),
      deps.environmentId,
      deps.siteId,
      now,
      now
    ]
  ));
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (field(row, "revokedAt", "revoked_at") !== undefined &&
      field(row, "revokedAt", "revoked_at") !== null) return null;
  let session;
  try {
    session = sessionRowShape(row, false, deps.environmentId, deps.siteId);
  } catch (error) {
    if (error?.code === "AUTH_ENV_MISMATCH") return null;
    throw error;
  }
  if (!session.idleExpiresAt || !session.absoluteExpiresAt ||
      now.getTime() >= session.idleExpiresAt.getTime() ||
      now.getTime() >= session.absoluteExpiresAt.getTime()) return null;
  return task3SessionShape(row, deps);
}

/**
 * Revoke the session family represented by a browser cookie and return the
 * refresh token only to the server-side logout caller. The token is never
 * included in the public Task 3 session shape or an HTTP response.
 */
async function revokeFromCookie(input, deps) {
  const request = input && typeof input === "object" && input.request
    ? input.request
    : input;
  const token = cookieValue(request);
  if (token === null) return null;
  const now = nowValue(deps);
  return deps.withTransaction(async (rawTransaction) => {
    const transaction = assertTransaction(rawTransaction);
    const rows = await rowsFrom(query(
      transaction,
      [
        `SELECT session_id, auth_source, environment_id, site_id, session_id_hash,
                session_family_id, account_id, logto_subject, legacy_netlify_user_id,
                migration_id, encrypted_refresh_token, refresh_token_key_version,
                issued_at, last_seen_at, idle_expires_at, absolute_expires_at,
                authz_version, rotation_version, revoked_at
         FROM auth_sessions
         WHERE session_id_hash = `,
        ` AND environment_id = `,
        ` AND site_id = `,
        `
         FOR UPDATE`
      ],
      [await hashToken(deps, token), deps.environmentId, deps.siteId]
    ));
    if (rows.length !== 1) return null;
    const shape = sessionRowShape(rows[0], true, deps.environmentId, deps.siteId);
    let refreshToken = null;
    if (shape.authSource === "logto" && shape.encryptedRefreshToken && !shape.revokedAt) {
      try {
        refreshToken = await deps.decryptSecret(
          shape.encryptedRefreshToken,
          cryptoOptions(deps, positiveInteger(shape.refreshTokenKeyVersion, "SESSION_INVALID", 401))
        );
      } catch {
        // Local revocation remains authoritative even if an old key can no
        // longer decrypt the provider grant.
        refreshToken = null;
      }
    }
    await revokeFamilyInTransaction(
      transaction,
      shape.accountId,
      shape.sessionFamilyId,
      deps,
      now
    );
    return {
      sessionId: shape.sessionId,
      sessionFamilyId: shape.sessionFamilyId,
      accountId: shape.accountId,
      authSource: shape.authSource,
      refreshToken
    };
  });
}

/** Create a Logto OAuth transaction. Raw state/nonce/PKCE are returned once. */
export async function createOAuthTransaction(input, deps = {}) {
  return createSessionRepository(deps).createOAuthTransaction(input);
}

/** Create a five-minute legacy bridge transaction. */
export async function createBridgeTransaction(input, deps = {}) {
  return createSessionRepository(deps).createBridgeTransaction(input);
}

/** Consume an OAuth transaction exactly once. */
export async function consumeOAuthTransaction(input, deps = {}) {
  return createSessionRepository(deps).consumeOAuthTransaction(input);
}

/** Consume a cancelled OAuth transaction exactly once. */
export async function cancelOAuthTransaction(input, deps = {}) {
  return createSessionRepository(deps).cancelOAuthTransaction(input);
}

/** Consume a legacy bridge transaction exactly once. */
export async function consumeBridgeTransaction(input, deps = {}) {
  return createSessionRepository(deps).consumeBridgeTransaction(input);
}

/** Consume a bridge transaction and issue its first-party session atomically. */
export async function consumeBridgeAndCreateAppSession(input, deps = {}) {
  return createSessionRepository(deps).consumeBridgeAndCreateAppSession(input);
}

/** Create an opaque app session with source-specific expiry rules. */
export async function createAppSession(input, deps = {}) {
  return createSessionRepository(deps).createAppSession(input);
}

/** Rotate a Logto refresh token and return its replacement exactly once. */
export async function rotateSession(input, deps = {}) {
  return createSessionRepository(deps).rotateSession(input);
}

/** Revoke every active session belonging to the account/session family. */
export async function revokeSessionFamily(input, deps = {}) {
  return createSessionRepository(deps).revokeSessionFamily(input);
}

/** Read and renew a valid opaque session from the strict Host-only cookie. */
export async function readValidSessionFromCookie(input, deps = {}) {
  return createSessionRepository(deps).readValidSessionFromCookie(input);
}

/** Revoke the cookie's session family and return a server-only grant handle. */
export async function revokeSessionFromCookie(input, deps = {}) {
  return createSessionRepository(deps).revokeSessionFromCookie(input);
}

/** Primary composition boundary for production and fake adapters. */
export function createSessionRepository(overrides = {}) {
  const deps = dependencies(overrides);
  return {
    createOAuthTransaction(input) {
      return insertOAuthTransaction(input, deps);
    },
    createBridgeTransaction(input) {
      return insertBridgeTransaction(input, deps);
    },
    consumeOAuthTransaction(input) {
      return deps.withTransaction((transaction) =>
        consumeOAuth(input, assertTransaction(transaction), deps)
      );
    },
    cancelOAuthTransaction(input) {
      return deps.withTransaction((transaction) =>
        cancelOAuth(input, assertTransaction(transaction), deps)
      );
    },
    consumeBridgeTransaction(input) {
      return deps.withTransaction((transaction) =>
        consumeBridge(input, assertTransaction(transaction), deps)
      );
    },
    consumeBridgeAndCreateAppSession(input) {
      return consumeBridgeAndCreateAppSessionWithDeps(input, deps);
    },
    createAppSession(input) {
      return insertAppSession(input, deps);
    },
    rotateSession(input) {
      return deps.withTransaction((transaction) =>
        rotateInTransaction(assertTransaction(transaction), input, deps)
      ).then((result) => {
        if (result?.__sessionFailure) throw result.__sessionFailure;
        return result;
      });
    },
    revokeSessionFamily(input = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw fail("SESSION_INVALID", 401);
      }
      const accountId = uuid(input.accountId, "SESSION_INVALID", 401);
      const sessionFamilyId = uuid(input.sessionFamilyId, "SESSION_INVALID", 401);
      const now = nowValue(deps);
      return deps.withTransaction((transaction) =>
        revokeFamilyInTransaction(
          assertTransaction(transaction),
          accountId,
          sessionFamilyId,
          deps,
          now
        )
      ).then(() => ({ sessionFamilyId, revokedAt: now }));
    },
    readValidSessionFromCookie(input) {
      return readValidSession(input, deps);
    },
    revokeSessionFromCookie(input) {
      return revokeFromCookie(input, deps);
    }
  };
}
