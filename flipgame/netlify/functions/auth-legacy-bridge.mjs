import { randomToken } from "./_shared/auth/crypto.mjs";
import {
  createAccountRepository
} from "./_shared/auth/account-repository.mjs";
import {
  createSessionRepository
} from "./_shared/auth/session-repository.mjs";
import {
  authJson,
  authRedirect,
  assertCsrf,
  assertTrustedOrigin,
  csrfCookie,
  PRIVATE_RESPONSE_HEADERS,
  safeNextPath,
  sessionCookie
} from "./_shared/auth/http.mjs";

const LEGACY_COOKIE_NAMES = Object.freeze(["gotrue.user", "nf_jwt", "nf_refresh"]);
const LEGACY_SESSION_COOKIE = "nf_jwt";
const MAX_LEGACY_USER_ID_LENGTH = 255;
const MAX_LEGACY_SESSION_LENGTH = 4096;
const BRIDGE_IDLE_TTL_SECONDS = 14 * 24 * 60 * 60;
const MIGRATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const LEGACY_IDENTITY_TIMEOUT_MS = 5000;

function bridgeError(code, status = 401) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.statusCode = status;
  return error;
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

function cookieValue(request, name) {
  const header = headerValue(request, "cookie");
  let found = null;
  for (const segment of header.split(";")) {
    const trimmed = segment.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0 || trimmed.slice(0, separator).trim() !== name) continue;
    if (found !== null) return null;
    found = trimmed.slice(separator + 1);
  }
  return found;
}

function decodeLegacySessionCookie(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.length > MAX_LEGACY_SESSION_LENGTH ||
        /[^\u0021-\u007e]/u.test(decoded)) throw new Error("invalid cookie");
    return decoded;
  } catch {
    throw bridgeError("LEGACY_SESSION_INVALID", 401);
  }
}

function configuredIdentityUserUrl(overrides) {
  const explicit = optionalText(
    overrides.legacyIdentityUserUrl ?? process.env.AUTH_LEGACY_IDENTITY_USER_URL
  );
  const configuredOrigin = optionalText(
    overrides.legacyIdentityOrigin ??
      process.env.AUTH_LEGACY_IDENTITY_ORIGIN ??
      process.env.URL ??
      process.env.DEPLOY_PRIME_URL
  );
  const raw = explicit || (configuredOrigin
    ? `${configuredOrigin.replace(/\/$/u, "")}/.netlify/identity/user`
    : "");
  if (!raw) throw bridgeError("LEGACY_IDENTITY_ENDPOINT_MISSING", 503);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw bridgeError("LEGACY_IDENTITY_ENDPOINT_INVALID", 503);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      parsed.search || parsed.hash || !parsed.pathname.endsWith("/.netlify/identity/user")) {
    throw bridgeError("LEGACY_IDENTITY_ENDPOINT_INVALID", 503);
  }
  return parsed.href;
}

function identityTimeoutMs(overrides) {
  const configured = overrides.legacyIdentityTimeoutMs ?? process.env.AUTH_LEGACY_IDENTITY_TIMEOUT_MS;
  if (configured === undefined || configured === null || configured === "") {
    return LEGACY_IDENTITY_TIMEOUT_MS;
  }
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 100 || value > 15000) {
    throw bridgeError("LEGACY_IDENTITY_TIMEOUT_INVALID", 503);
  }
  return value;
}

async function verifyLegacySessionFromRequest(request, overrides) {
  const cookie = cookieValue(request, LEGACY_SESSION_COOKIE);
  if (typeof cookie !== "string" || cookie.length < 1 || cookie.length > MAX_LEGACY_SESSION_LENGTH) {
    throw bridgeError("LEGACY_SESSION_MISSING", 401);
  }
  const bearer = decodeLegacySessionCookie(cookie);
  const fetchImpl = overrides.legacyIdentityFetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw bridgeError("LEGACY_IDENTITY_VERIFIER_MISSING", 503);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), identityTimeoutMs(overrides));
  try {
    const response = await fetchImpl(configuredIdentityUserUrl(overrides), {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${bearer}`
      },
      signal: controller.signal
    });
    if (!response || response.ok !== true || typeof response.json !== "function") {
      throw bridgeError("LEGACY_SESSION_INVALID", 401);
    }
    try {
      return await response.json();
    } catch {
      throw bridgeError("LEGACY_SESSION_INVALID", 401);
    }
  } catch (error) {
    if (error?.code) throw error;
    throw bridgeError("LEGACY_IDENTITY_VERIFIER_UNAVAILABLE", 503);
  } finally {
    clearTimeout(timeout);
  }
}

function requiredText(value, code, maxLength = MAX_LEGACY_USER_ID_LENGTH) {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw bridgeError(code, 401);
  }
  return value.trim();
}

function optionalText(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim();
}

function own(value, names) {
  if (!value || typeof value !== "object") return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(value, name)) return value[name];
  }
  return undefined;
}

function field(value, camelName, snakeName = camelName) {
  return own(value, [camelName, snakeName]);
}

function parseTimestamp(value, kind = "timestamp") {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (Number.isFinite(timestamp)) return timestamp;
    throw bridgeError(`LEGACY_${kind.toUpperCase()}_INVALID`, 401);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const timestamp = value > 100000000000 ? value : value * 1000;
    if (Number.isFinite(timestamp)) return timestamp;
    throw bridgeError(`LEGACY_${kind.toUpperCase()}_INVALID`, 401);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const normalized = value.trim();
    if (/^[0-9]+(?:\.[0-9]+)?$/u.test(normalized)) {
      const numeric = Number(normalized);
      if (Number.isFinite(numeric)) {
        const timestamp = numeric > 100000000000 ? numeric : numeric * 1000;
        if (Number.isFinite(timestamp)) return timestamp;
      }
    }
    const timestamp = Date.parse(normalized);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  throw bridgeError(`LEGACY_${kind.toUpperCase()}_INVALID`, 401);
}

function nowValue(overrides) {
  const value = typeof overrides.now === "function" ? overrides.now() : new Date();
  const timestamp = parseTimestamp(value, "clock");
  return new Date(timestamp);
}

function isExpiredLegacySession(user, now) {
  const nested = own(user, ["session", "sessionData", "token"]);
  const candidates = [
    field(user, "expiresAt", "expires_at"),
    field(user, "sessionExpiresAt", "session_expires_at"),
    field(nested, "expiresAt", "expires_at"),
    field(nested, "sessionExpiresAt", "session_expires_at")
  ];
  for (const value of candidates) {
    if (value === undefined || value === null || value === "") continue;
    if (parseTimestamp(value, "session_expiry") <= now.getTime()) return true;
  }
  const exp = field(user, "exp") ?? field(nested, "exp");
  if (exp !== undefined && exp !== null && exp !== "") {
    if (parseTimestamp(exp, "session_expiry") <= now.getTime()) return true;
  }
  return false;
}

function verifiedLegacyUser(value, now) {
  if (value && typeof value === "object" &&
      (value.valid === false || value.authenticated === false)) {
    throw bridgeError("LEGACY_SESSION_INVALID", 401);
  }
  const user = value && typeof value === "object" && value.user && typeof value.user === "object"
    ? value.user
    : value;
  if (!user || typeof user !== "object") throw bridgeError("LEGACY_SESSION_INVALID", 401);
  const legacyUserId = requiredText(
    own(user, ["id"]),
    "LEGACY_USER_ID_MISSING"
  );
  if (isExpiredLegacySession(user, now)) throw bridgeError("LEGACY_SESSION_EXPIRED", 401);
  return { user, legacyUserId };
}

function configuredBoundary(overrides, name, envName) {
  const value = overrides[name] ?? process.env[envName];
  return optionalText(value);
}

function assertBoundary(record, overrides) {
  if (!record || typeof record !== "object") return;
  const expectedEnvironmentId = configuredBoundary(overrides, "environmentId", "AUTH_ENV_ID");
  const expectedSiteId = configuredBoundary(overrides, "siteId", "NETLIFY_SITE_ID");
  const environmentId = field(record, "environmentId", "environment_id");
  const siteId = field(record, "siteId", "site_id");
  if (expectedEnvironmentId && environmentId !== undefined && String(environmentId) !== expectedEnvironmentId) {
    throw bridgeError("AUTH_ENV_MISMATCH", 401);
  }
  if (expectedSiteId && siteId !== undefined && String(siteId) !== expectedSiteId) {
    throw bridgeError("AUTH_ENV_MISMATCH", 401);
  }
}

function firstValue(records, names) {
  for (const record of records) {
    const value = own(record, names);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function migrationLookup(overrides) {
  if (typeof overrides.findMigrationRecordByLegacyUserId === "function") {
    return overrides.findMigrationRecordByLegacyUserId;
  }
  if (typeof overrides.findMigrationRecord === "function") return overrides.findMigrationRecord;
  const repository = overrides.migrationRepository || overrides.accountRepository;
  if (repository && typeof repository.findMigrationRecordByLegacyUserId === "function") {
    return repository.findMigrationRecordByLegacyUserId.bind(repository);
  }
  if (repository && typeof repository.findByLegacyNetlifyUserId === "function") {
    return repository.findByLegacyNetlifyUserId.bind(repository);
  }
  if (repository && typeof repository.findByLegacyUserId === "function") {
    return repository.findByLegacyUserId.bind(repository);
  }
  if (repository && typeof repository.findMigrationByLegacyUserId === "function") {
    return repository.findMigrationByLegacyUserId.bind(repository);
  }
  return null;
}

async function resolveMigration(legacyUserId, account, overrides, now) {
  let migration = firstValue([account], ["migrationRecord", "migration_record"]);
  const lookup = migrationLookup(overrides);
  if (lookup) {
    migration = await lookup(legacyUserId, field(account, "migrationId", "migration_id"));
    if (!migration || typeof migration !== "object") {
      throw bridgeError("MIGRATION_MAPPING_MISSING", 401);
    }
  }
  if (migration && typeof migration !== "object") migration = null;
  assertBoundary(account, overrides);
  assertBoundary(migration, overrides);

  const migrationStatus = field(migration, "status");
  if ((lookup && (migrationStatus === undefined || migrationStatus === null)) ||
      (migrationStatus !== undefined && migrationStatus !== null &&
      !["imported", "reconciled"].includes(String(migrationStatus).trim().toLowerCase()))) {
    throw bridgeError("MIGRATION_MAPPING_UNAVAILABLE", 401);
  }
  const migrationSource = field(migration, "source");
  if ((lookup && (migrationSource === undefined || migrationSource === null)) ||
      (migrationSource !== undefined && migrationSource !== null &&
      String(migrationSource).trim() !== "netlify_identity")) {
    throw bridgeError("MIGRATION_MAPPING_CONFLICT", 401);
  }

  const accountId = requiredText(
    field(account, "accountId", "account_id"),
    "ACCOUNT_MAPPING_INVALID"
  );
  const migrationId = requiredText(
    firstValue([migration, account], ["migrationId", "migration_id"]),
    "MIGRATION_MAPPING_MISSING"
  );
  const mappedLegacyUserId = firstValue(
    [migration, account],
    ["legacyNetlifyUserId", "legacy_netlify_user_id", "sourceUserId", "source_user_id"]
  );
  if ((lookup && mappedLegacyUserId === undefined) ||
      (mappedLegacyUserId !== undefined && String(mappedLegacyUserId) !== legacyUserId)) {
    throw bridgeError("ACCOUNT_MAPPING_CONFLICT", 401);
  }
  const migrationAccountId = field(migration, "accountId", "account_id");
  if ((lookup && (migrationAccountId === undefined || migrationAccountId === null)) ||
      (migrationAccountId !== undefined && migrationAccountId !== null &&
      String(migrationAccountId) !== String(accountId))) {
    throw bridgeError("ACCOUNT_MAPPING_CONFLICT", 401);
  }
  const accountMigrationId = field(account, "migrationId", "migration_id");
  if (accountMigrationId !== undefined && accountMigrationId !== null &&
      String(accountMigrationId) !== migrationId) {
    throw bridgeError("ACCOUNT_MAPPING_CONFLICT", 401);
  }
  const migrationAccountMigrationId = field(migration, "accountMigrationId", "account_migration_id");
  if ((lookup && (migrationAccountMigrationId === undefined || migrationAccountMigrationId === null)) ||
      (migrationAccountMigrationId !== undefined && migrationAccountMigrationId !== null &&
      String(migrationAccountMigrationId) !== String(migrationId))) {
    throw bridgeError("ACCOUNT_MAPPING_CONFLICT", 401);
  }

  let windowValue = overrides.migrationWindowEndsAt;
  if (typeof windowValue === "function") windowValue = await windowValue({ account, migration, legacyUserId });
  if (windowValue === undefined || windowValue === null || windowValue === "") {
    windowValue = firstValue(
      [migration, account],
      ["migrationWindowEndsAt", "migration_window_ends_at", "windowEndsAt", "window_ends_at"]
    );
  }
  const freezeAt = firstValue([migration, account], ["freezeAt", "freeze_at"]);
  let freezeTimestamp = null;
  if (freezeAt !== undefined && freezeAt !== null && freezeAt !== "") {
    freezeTimestamp = parseTimestamp(freezeAt, "freeze_at");
  }
  if (windowValue === undefined || windowValue === null || windowValue === "") {
    windowValue = process.env.AUTH_MIGRATION_WINDOW_ENDS_AT ?? process.env.MIGRATION_WINDOW_ENDS_AT;
  }
  if ((windowValue === undefined || windowValue === null || windowValue === "") && freezeTimestamp !== null) {
    windowValue = new Date(freezeTimestamp + MIGRATION_WINDOW_MS);
  }
  if (windowValue === undefined || windowValue === null || windowValue === "") {
    throw bridgeError("MIGRATION_WINDOW_MISSING", 503);
  }
  let windowTimestamp = parseTimestamp(windowValue, "migration_window");
  if (freezeTimestamp !== null) windowTimestamp = Math.min(windowTimestamp, freezeTimestamp + MIGRATION_WINDOW_MS);
  if (windowTimestamp <= now.getTime()) throw bridgeError("MIGRATION_WINDOW_EXPIRED", 401);
  return {
    accountId,
    migrationId,
    migration,
    migrationWindowEndsAt: new Date(windowTimestamp)
  };
}

function accountVersion(account) {
  const value = field(account, "authzVersion", "authz_version");
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/u.test(normalized)) throw bridgeError("ACCOUNT_MAPPING_INVALID", 401);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw bridgeError("ACCOUNT_MAPPING_INVALID", 401);
  return parsed;
}

function isBlocked(account) {
  return String(field(account, "role") ?? "").trim().toLowerCase() === "blocked" ||
    String(field(account, "status") ?? "").trim().toLowerCase() === "blocked";
}

function transactionText(value, code) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 4096) {
    throw bridgeError(code, 503);
  }
  return value;
}

function assertSameIfPresent(actual, expected, code) {
  if (actual !== undefined && actual !== null && String(actual) !== String(expected)) {
    throw bridgeError(code, 401);
  }
}

function dateValue(value, code) {
  if (value === undefined || value === null || value === "") throw bridgeError(code, 503);
  const timestamp = parseTimestamp(value, code.toLowerCase());
  return timestamp;
}

function sessionMaxAge(session, now, migrationWindowEndsAt, expected = {}) {
  if (field(session, "authSource", "auth_source") !== "legacy_bridge") {
    throw bridgeError("SESSION_SOURCE_INVALID", 503);
  }
  for (const [names, expectedValue] of [
    [["legacyNetlifyUserId", "legacy_netlify_user_id"], expected.legacyNetlifyUserId],
    [["accountId", "account_id"], expected.accountId],
    [["migrationId", "migration_id"], expected.migrationId]
  ]) {
    const actualValue = field(session, names[0], names[1]);
    if (expectedValue === undefined || expectedValue === null ||
        actualValue === undefined || actualValue === null ||
        String(actualValue) !== String(expectedValue)) {
      throw bridgeError("SESSION_SOURCE_INVALID", 503);
    }
  }
  const idleExpiresAt = dateValue(
    field(session, "idleExpiresAt", "idle_expires_at"),
    "SESSION_EXPIRY_MISSING"
  );
  const absoluteExpiresAt = dateValue(
    field(session, "absoluteExpiresAt", "absolute_expires_at"),
    "SESSION_EXPIRY_MISSING"
  );
  if (absoluteExpiresAt > migrationWindowEndsAt.getTime() ||
      idleExpiresAt > absoluteExpiresAt ||
      idleExpiresAt <= now.getTime()) {
    throw bridgeError("SESSION_EXPIRY_INVALID", 503);
  }
  if (own(session, ["refreshToken", "refresh_token"]) !== undefined &&
      own(session, ["refreshToken", "refresh_token"]) !== null) {
    throw bridgeError("SESSION_REFRESH_NOT_ALLOWED", 503);
  }
  if (own(session, ["encryptedRefreshToken", "encrypted_refresh_token"]) !== undefined &&
      own(session, ["encryptedRefreshToken", "encrypted_refresh_token"]) !== null) {
    throw bridgeError("SESSION_REFRESH_NOT_ALLOWED", 503);
  }
  if (optionalText(field(session, "logtoSubject", "logto_subject"))) {
    throw bridgeError("SESSION_SOURCE_INVALID", 503);
  }
  const seconds = Math.floor((idleExpiresAt - now.getTime()) / 1000);
  return Math.max(1, Math.min(BRIDGE_IDLE_TTL_SECONDS, seconds));
}

function clearLegacyCookie(name, request) {
  let secure = "";
  try {
    if (new URL(request.url).protocol === "https:") secure = "; Secure";
  } catch {
    // The handler's URL is validated by the caller before this helper runs.
  }
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

function trustedOrigins(overrides) {
  return overrides.trustedOrigins ?? overrides.trustedOrigin ?? process.env.AUTH_TRUSTED_ORIGIN ??
    process.env.SITE_ORIGIN ?? process.env.URL ?? "";
}

function acceptsBridgeNoContent(request) {
  const accept = headerValue(request, "accept").toLowerCase();
  const acceptsJson = accept.split(",").some((value) => value.trim().split(";", 1)[0] === "application/json");
  const explicitFetch = headerValue(request, "x-shinegame-bridge").trim().toLowerCase() === "fetch";
  return acceptsJson || explicitFetch;
}

function authNoContent(headers = {}) {
  const responseHeaders = new Headers(PRIVATE_RESPONSE_HEADERS);
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "set-cookie" && Array.isArray(value)) {
      for (const cookie of value) responseHeaders.append(name, cookie);
    } else {
      responseHeaders.set(name, value);
    }
  }
  return new Response(null, { status: 204, headers: responseHeaders });
}

function publicError(error, fallbackStatus = 503) {
  const candidate = Number(error?.status ?? error?.statusCode);
  const status = [400, 401, 403, 409, 429, 500, 502, 503].includes(candidate)
    ? candidate
    : fallbackStatus;
  if (status === 403) return authJson({ error: "请求来源不可信" }, { status });
  if (status >= 500) return authJson({ error: "Authentication service unavailable" }, { status });
  return authJson({ error: "认证失败" }, { status });
}

function defaultAccountRepository(overrides) {
  if (overrides.accountRepository) return overrides.accountRepository;
  const options = { ...(overrides.accountRepositoryOptions || {}) };
  for (const name of ["environmentId", "siteId", "expectedSiteId", "sql", "withTransaction"]) {
    if (overrides[name] !== undefined && options[name] === undefined) options[name] = overrides[name];
  }
  return createAccountRepository(options);
}

function defaultSessionRepository(overrides) {
  if (overrides.sessionRepository) return overrides.sessionRepository;
  const options = { ...(overrides.sessionRepositoryOptions || {}) };
  for (const name of [
    "environmentId", "siteId", "expectedSiteId", "keyVersion", "encryptionKeyVersion",
    "hmacKey", "encryptionKey", "sql", "withTransaction"
  ]) {
    if (overrides[name] !== undefined && options[name] === undefined) options[name] = overrides[name];
  }
  return createSessionRepository(options);
}

export function createAuthLegacyBridgeHandler(overrides = {}) {
  const accountRepository = defaultAccountRepository(overrides);
  const sessionRepository = defaultSessionRepository(overrides);
  const migrationOverrides = { ...overrides, accountRepository };
  const verifyLegacySession = overrides.legacySessionVerifier ||
    overrides.verifyLegacySession ||
    ((request) => verifyLegacySessionFromRequest(request, overrides));
  const nextPath = overrides.safeNextPath || safeNextPath;

  return async function authLegacyBridge(request) {
    if (request?.method !== "POST") {
      return authJson({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
    }

    try {
      assertTrustedOrigin(request, { trustedOrigins: trustedOrigins(overrides) });
      assertCsrf(request);
    } catch (error) {
      return publicError({ ...error, status: 403 }, 403);
    }

    const now = nowValue(overrides);
    const legacySessionId = cookieValue(request, LEGACY_SESSION_COOKIE);
    if (typeof legacySessionId !== "string" || legacySessionId.length < 1 ||
        legacySessionId.length > MAX_LEGACY_SESSION_LENGTH ||
        /[^\u0021-\u007e]/u.test(legacySessionId)) {
      return publicError(bridgeError("LEGACY_SESSION_MISSING", 401), 401);
    }

    let safePath;
    try {
      const url = new URL(request.url);
      const rawNext = url.searchParams.get("next") || "/";
      safePath = nextPath(rawNext, overrides.allowedPaths === undefined ? {} : {
        allowedPaths: overrides.allowedPaths
      });
    } catch (error) {
      return publicError(bridgeError("INVALID_NEXT", 400), 400);
    }

    try {
      const verified = verifiedLegacyUser(await verifyLegacySession(request), now);
      const account = await accountRepository.findAccountByLegacyUserId(
        verified.legacyUserId,
        {
          environmentId: configuredBoundary(overrides, "environmentId", "AUTH_ENV_ID"),
          siteId: configuredBoundary(overrides, "siteId", "NETLIFY_SITE_ID")
        }
      );
      if (!account) throw bridgeError("ACCOUNT_MAPPING_MISSING", 401);
      assertBoundary(account, overrides);
      if (isBlocked(account)) throw bridgeError("ACCOUNT_BLOCKED", 403);

      const migration = await resolveMigration(verified.legacyUserId, account, migrationOverrides, now);
      const transaction = await sessionRepository.createBridgeTransaction({
        legacySessionId,
        accountId: migration.accountId,
        migrationId: migration.migrationId,
        nextPath: safePath
      });
      assertBoundary(transaction, overrides);
      const state = transactionText(transaction?.state, "TRANSACTION_INVALID");
      const transactionCsrf = transactionText(transaction?.csrfToken, "TRANSACTION_INVALID");
      const bridgeResult = await sessionRepository.consumeBridgeAndCreateAppSession({
        state,
        legacySessionId,
        csrfToken: transactionCsrf,
        sessionInput: {
          authSource: "legacy_bridge",
          accountId: migration.accountId,
          legacyNetlifyUserId: verified.legacyUserId,
          migrationId: migration.migrationId,
          migrationWindowEndsAt: migration.migrationWindowEndsAt,
          authzVersion: accountVersion(account)
        }
      });
      const consumed = bridgeResult?.consumed;
      const createdSession = bridgeResult?.session;
      assertBoundary(consumed, overrides);
      assertSameIfPresent(consumed?.accountId, migration.accountId, "ACCOUNT_MAPPING_CONFLICT");
      assertSameIfPresent(consumed?.migrationId, migration.migrationId, "ACCOUNT_MAPPING_CONFLICT");
      assertBoundary(createdSession, overrides);
      const sessionToken = transactionText(createdSession?.sessionToken, "SESSION_CREATE_FAILED");
      const maxAge = sessionMaxAge(createdSession, now, migration.migrationWindowEndsAt, {
        legacyNetlifyUserId: verified.legacyUserId,
        accountId: migration.accountId,
        migrationId: migration.migrationId
      });
      const csrfToken = await (overrides.csrfTokenGenerator || randomToken)();
      const validatedNext = nextPath(consumed?.nextPath || transaction?.nextPath || safePath, {
        allowedPaths: overrides.allowedPaths
      });
      const cookies = [
        sessionCookie(sessionToken, maxAge),
        csrfCookie(csrfToken, maxAge),
        ...LEGACY_COOKIE_NAMES.map((name) => clearLegacyCookie(name, request))
      ];
      if (acceptsBridgeNoContent(request)) return authNoContent({ "Set-Cookie": cookies });
      return authRedirect(validatedNext, 302, { "Set-Cookie": cookies });
    } catch (error) {
      return publicError(error, 503);
    }
  };
}

export default async function authLegacyBridge(request) {
  return createAuthLegacyBridgeHandler()(request);
}

export const config = {
  path: "/api/auth/legacy-bridge"
};
