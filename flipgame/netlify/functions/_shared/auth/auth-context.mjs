import {
  AuthError,
  findAccountByLogtoSubject as defaultFindAccountByLogtoSubject,
  findAccountByLegacyUserId as defaultFindAccountByLegacyUserId
} from "./account-repository.mjs";
import { capabilitiesForAccount as defaultCapabilitiesForAccount } from "./capabilities.mjs";

export { AuthError };

const AUTH_CONTEXTS = new WeakSet();
const CONTEXT_CAPABILITY_RESOLVERS = new WeakMap();
const ALLOWED_CAPABILITIES = Object.freeze([
  "canAccessRegistered",
  "canAccessPremium",
  "isAdmin"
]);
const ALLOWED_CAPABILITY_SET = new Set(ALLOWED_CAPABILITIES);
const ALLOWED_ACCOUNT_FIELDS = new Set([
  "accountId",
  "role",
  "status",
  "guild",
  "gameName",
  "authzVersion",
  "mergedIntoAccountId",
  "migrationId",
  "blockedAt",
  "createdAt",
  "updatedAt"
]);
const CONTEXT_FIELDS = new Set([
  "authSource",
  "accountId",
  "sessionId",
  "authnSubject",
  "authzVersion",
  "migrationId",
  "account",
  "capabilities"
]);

function requiredDependency(value) {
  if (typeof value !== "function") throw new AuthError("AUTH_DEPENDENCY_MISSING", 500);
  return value;
}

function ownValue(value, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(value, name)) return value[name];
  }
  return undefined;
}

function requiredText(value, code = "SESSION_INVALID", status = 401) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AuthError(code, status);
  }
  return value.trim();
}

function optionalText(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim();
}

function sourceValue(session) {
  return ownValue(session, ["authSource", "auth_source"]);
}

function sessionIdValue(session) {
  return ownValue(session, ["sessionId", "id", "session_id"]);
}

function sessionAccountIdValue(session) {
  return ownValue(session, ["accountId", "account_id"]);
}

function sessionVersionValue(session) {
  return ownValue(session, ["authzVersion", "authz_version"]);
}

function positiveVersion(value) {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/u.test(normalized) ? normalized : null;
}

function sameAuthzVersion(sessionVersion, accountVersion) {
  const sessionText = positiveVersion(sessionVersion);
  const accountText = positiveVersion(accountVersion);
  return sessionText !== null && accountText !== null && sessionText === accountText;
}

function accountValue(account, camelName, snakeName) {
  if (Object.prototype.hasOwnProperty.call(account, camelName)) return account[camelName];
  return account[snakeName];
}

function sanitizeAccount(account) {
  if (!account || typeof account !== "object") return null;
  const accountId = accountValue(account, "accountId", "account_id");
  const role = accountValue(account, "role", "role");
  const status = accountValue(account, "status", "status");
  const authzVersion = accountValue(account, "authzVersion", "authz_version");
  if (typeof accountId !== "string" || accountId.trim() === "" ||
      typeof role !== "string" || role.trim() === "" ||
      typeof status !== "string" || status.trim() === "" ||
      positiveVersion(authzVersion) === null) {
    return null;
  }

  const output = {
    accountId: accountId.trim(),
    role: role.trim(),
    status: status.trim(),
    authzVersion
  };
  const fields = [
    ["guild", "guild"],
    ["gameName", "game_name"],
    ["mergedIntoAccountId", "merged_into_account_id"],
    ["migrationId", "migration_id"],
    ["blockedAt", "blocked_at"],
    ["createdAt", "created_at"],
    ["updatedAt", "updated_at"]
  ];
  for (const [camelName, snakeName] of fields) {
    const value = accountValue(account, camelName, snakeName);
    if (value !== undefined) output[camelName] = value;
  }
  return output;
}

function sanitizeCapabilities(value, account) {
  if (!value || typeof value !== "object") {
    throw new AuthError("AUTH_CONTEXT_INVALID", 500);
  }
  const booleans = ["authenticated", "blocked", ...ALLOWED_CAPABILITIES];
  if (booleans.some((name) => typeof value[name] !== "boolean")) {
    throw new AuthError("AUTH_CONTEXT_INVALID", 500);
  }
  if (value.authenticated !== true) throw new AuthError("AUTH_CONTEXT_INVALID", 500);

  const role = requiredText(value.role, "AUTH_CONTEXT_INVALID", 500).toLowerCase();
  const accountRole = String(account.role).trim().toLowerCase();
  const accountStatus = String(account.status || "").trim().toLowerCase();
  const accountBlocked = accountRole === "blocked" ||
    ["blocked", "disabled", "merged"].includes(accountStatus);
  if (role !== accountRole || value.blocked !== accountBlocked) {
    throw new AuthError("AUTH_CONTEXT_INVALID", 500);
  }

  return Object.freeze({
    authenticated: true,
    role,
    blocked: accountBlocked,
    canAccessRegistered: accountBlocked ? false : value.canAccessRegistered,
    canAccessPremium: accountBlocked ? false : value.canAccessPremium,
    isAdmin: accountBlocked ? false : value.isAdmin
  });
}

function resolverDependencies(overrides = {}) {
  if (!overrides || typeof overrides !== "object") {
    throw new TypeError("auth context dependencies must be an object");
  }
  const repository = overrides.repository && typeof overrides.repository === "object"
    ? overrides.repository
    : {};
  const findLogto = overrides.findAccountByLogtoSubject ||
    repository.findAccountByLogtoSubject || defaultFindAccountByLogtoSubject;
  const findLegacy = overrides.findAccountByLegacyUserId ||
    repository.findAccountByLegacyUserId || defaultFindAccountByLegacyUserId;

  // The repository factory owns issuer/tenant configuration. This optional
  // value is retained as trusted dependency metadata only; it is never read
  // from a session and never replaced by a session-provided connector scope.
  const issuerOrTenant = overrides.issuerOrTenant ?? repository.issuerOrTenant;
  if (issuerOrTenant !== undefined && issuerOrTenant !== null) {
    requiredText(issuerOrTenant, "AUTH_DEPENDENCY_MISSING", 500);
  }

  return {
    readValidSessionFromCookie: requiredDependency(overrides.readValidSessionFromCookie),
    findAccountByLogtoSubject: requiredDependency(findLogto),
    findAccountByLegacyUserId: requiredDependency(findLegacy),
    capabilitiesForAccount: requiredDependency(
      overrides.capabilitiesForAccount || defaultCapabilitiesForAccount
    ),
    issuerOrTenant: issuerOrTenant === undefined || issuerOrTenant === null
      ? null
      : String(issuerOrTenant).trim()
  };
}

function hasNonNullSessionField(session, names) {
  return names.some((name) => {
    const value = ownValue(session, [name]);
    return value !== undefined && value !== null;
  });
}

function parseSession(session) {
  if (!session || typeof session !== "object") {
    throw new AuthError("SESSION_INVALID", 401);
  }
  const authSource = sourceValue(session);
  if (authSource !== "logto" && authSource !== "legacy_bridge") {
    throw new AuthError("SESSION_INVALID", 401);
  }

  const sessionId = requiredText(sessionIdValue(session));
  const accountId = requiredText(sessionAccountIdValue(session));
  const authzVersion = sessionVersionValue(session);
  if (positiveVersion(authzVersion) === null) throw new AuthError("SESSION_INVALID", 401);

  const logtoSubject = ownValue(session, ["logtoSubject", "logto_subject"]);
  const legacyNetlifyUserId = ownValue(session, ["legacyNetlifyUserId", "legacy_netlify_user_id"]);
  if (authSource === "logto") {
    if (hasNonNullSessionField(session, ["legacyNetlifyUserId", "legacy_netlify_user_id"])) {
      throw new AuthError("SESSION_INVALID", 401);
    }
    return {
      authSource,
      sessionId,
      accountId,
      authzVersion,
      sourceSubject: requiredText(logtoSubject),
      migrationId: optionalText(ownValue(session, ["migrationId", "migration_id"]))
    };
  }

  if (hasNonNullSessionField(session, ["logtoSubject", "logto_subject"])) {
    throw new AuthError("SESSION_INVALID", 401);
  }
  return {
    authSource,
    sessionId,
    accountId,
    authzVersion,
    sourceSubject: requiredText(legacyNetlifyUserId),
    migrationId: optionalText(ownValue(session, ["migrationId", "migration_id"]))
  };
}

function hasAllowedKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasExactKeys(value, allowed) {
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function isBrandedAuthContext(context) {
  if (!context || typeof context !== "object" || !AUTH_CONTEXTS.has(context)) {
    return false;
  }
  if (!hasExactKeys(context, CONTEXT_FIELDS) ||
      (context.authSource !== "logto" && context.authSource !== "legacy_bridge") ||
      typeof context.accountId !== "string" || context.accountId.trim() === "" ||
      typeof context.sessionId !== "string" || context.sessionId.trim() === "" ||
      typeof context.authnSubject !== "string" || context.authnSubject.trim() === "" ||
      positiveVersion(context.authzVersion) === null ||
      !context.account || typeof context.account !== "object" ||
      !context.capabilities || typeof context.capabilities !== "object") {
    return false;
  }
  if (!hasAllowedKeys(context.account, ALLOWED_ACCOUNT_FIELDS) ||
      context.account.accountId !== context.accountId ||
      !sameAuthzVersion(context.authzVersion, context.account.authzVersion)) {
    return false;
  }
  const expectedCapabilityKeys = new Set(["authenticated", "role", "blocked", ...ALLOWED_CAPABILITIES]);
  if (!hasExactKeys(context.capabilities, expectedCapabilityKeys) ||
      context.capabilities.authenticated !== true ||
      typeof context.capabilities.role !== "string" ||
      typeof context.capabilities.blocked !== "boolean" ||
      ALLOWED_CAPABILITIES.some((name) => typeof context.capabilities[name] !== "boolean")) {
    return false;
  }
  return true;
}

async function resolveWithDependencies(req, deps) {
  const session = await deps.readValidSessionFromCookie(req);
  if (session === null || session === undefined || session === false) return null;
  const parsed = parseSession(session);

  const account = parsed.authSource === "logto"
    ? await deps.findAccountByLogtoSubject(parsed.sourceSubject)
    : await deps.findAccountByLegacyUserId(parsed.sourceSubject);
  const safeAccount = sanitizeAccount(account);
  if (!safeAccount) throw new AuthError("ACCOUNT_MAPPING_MISSING", 401);
  if (safeAccount.accountId !== parsed.accountId) {
    throw new AuthError("SESSION_INVALID", 401);
  }
  if (!sameAuthzVersion(parsed.authzVersion, safeAccount.authzVersion)) {
    throw new AuthError("SESSION_STALE", 401);
  }

  const capabilities = sanitizeCapabilities(
    deps.capabilitiesForAccount(safeAccount),
    safeAccount
  );
  const safeAccountOutput = Object.freeze(safeAccount);
  const context = {
    authSource: parsed.authSource,
    accountId: safeAccountOutput.accountId,
    sessionId: parsed.sessionId,
    authnSubject: parsed.sourceSubject,
    authzVersion: safeAccountOutput.authzVersion,
    migrationId: parsed.migrationId ?? optionalText(safeAccountOutput.migrationId),
    account: safeAccountOutput,
    capabilities
  };
  const frozenContext = Object.freeze(context);
  AUTH_CONTEXTS.add(frozenContext);
  CONTEXT_CAPABILITY_RESOLVERS.set(frozenContext, deps.capabilitiesForAccount);
  return frozenContext;
}

export function createAuthContextResolver(overrides = {}) {
  const deps = resolverDependencies(overrides);
  return (req) => resolveWithDependencies(req, deps);
}

export async function resolveAuthContext(req, overrides = {}) {
  return createAuthContextResolver(overrides)(req);
}

export function requireCapability(context, capability) {
  if (!isBrandedAuthContext(context)) throw new AuthError("AUTH_REQUIRED", 401);
  const name = typeof capability === "string" ? capability.trim() : "";
  if (!ALLOWED_CAPABILITY_SET.has(name)) throw new AuthError("CAPABILITY_UNKNOWN", 400);

  const capabilityResolver = CONTEXT_CAPABILITY_RESOLVERS.get(context);
  if (typeof capabilityResolver !== "function") throw new AuthError("AUTH_REQUIRED", 401);
  let canonicalCapabilities;
  try {
    canonicalCapabilities = sanitizeCapabilities(
      capabilityResolver(context.account),
      context.account
    );
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("AUTH_CONTEXT_INVALID", 500);
  }
  if (["authenticated", "role", "blocked", ...ALLOWED_CAPABILITIES]
    .some((key) => canonicalCapabilities[key] !== context.capabilities[key])) {
    throw new AuthError("AUTH_CONTEXT_INVALID", 500);
  }
  if (context.capabilities.blocked || context.capabilities[name] !== true) {
    throw new AuthError("CAPABILITY_DENIED", 403);
  }
  return context;
}
