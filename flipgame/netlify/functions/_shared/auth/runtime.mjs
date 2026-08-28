import { createAccountRepository } from "./account-repository.mjs";
import { AuthError, createAuthContextResolver, requireCapability } from "./auth-context.mjs";
import { createSessionRepository } from "./session-repository.mjs";
import { canonicalIssuer } from "./config.mjs";
import { assertCsrf, assertTrustedOrigin } from "./http.mjs";

const PUBLIC_ERROR_STATUSES = new Set([400, 401, 403, 404, 409, 429, 500, 502, 503]);

function configuredIssuer(overrides) {
  const value = overrides?.issuerOrTenant ?? overrides?.accountRepositoryOptions?.issuerOrTenant ??
    process.env.LOGTO_ENDPOINT;
  if (value === undefined || value === null || value === "") return value;
  return canonicalIssuer(value);
}

function repositoryOptions(overrides, name) {
  const options = { ...(overrides?.[name] || {}) };
  const shared = [
    "environmentId",
    "siteId",
    "expectedSiteId",
    "keyVersion",
    "encryptionKeyVersion",
    "hmacKey",
    "authHmacKey",
    "encryptionKey",
    "authEncryptionKey"
  ];
  for (const key of shared) {
    if (options[key] === undefined && overrides?.[key] !== undefined) options[key] = overrides[key];
  }
  return options;
}

/**
 * Compose the request auth boundary once for every protected function.
 * Production callers get the session/account repositories from the same
 * environment-bound configuration; tests may inject both repositories or a
 * resolver without changing the authorization rules.
 */
export function createAuthRuntime(overrides = {}) {
  if (!overrides || typeof overrides !== "object") {
    throw new TypeError("auth runtime dependencies must be an object");
  }

  const issuerOrTenant = configuredIssuer(overrides);
  const sessionRepository = overrides.resolveAuthContext
    ? null
    : overrides.sessionRepository || createSessionRepository(
      repositoryOptions(overrides, "sessionRepositoryOptions")
    );
  const accountRepository = overrides.resolveAuthContext
    ? (overrides.accountRepository || null)
    : overrides.accountRepository || createAccountRepository({
      ...repositoryOptions(overrides, "accountRepositoryOptions"),
      issuerOrTenant: overrides.accountRepositoryOptions?.issuerOrTenant ?? issuerOrTenant
    });

  const resolveAuthContext = overrides.resolveAuthContext || createAuthContextResolver({
    readValidSessionFromCookie: (request) => sessionRepository.readValidSessionFromCookie(request),
    findAccountByLogtoSubject: (subject) => accountRepository.findAccountByLogtoSubject(subject),
    findAccountByLegacyUserId: (legacyId) => accountRepository.findAccountByLegacyUserId(legacyId),
    capabilitiesForAccount: overrides.capabilitiesForAccount,
    issuerOrTenant
  });

  return {
    accountRepository,
    sessionRepository,
    resolveAuthContext,
    requireCapability: overrides.requireCapability
  };
}

export function authErrorResponse(error, json, fallbackStatus = 500) {
  const status = PUBLIC_ERROR_STATUSES.has(Number(error?.status))
    ? Number(error.status)
    : fallbackStatus;
  const code = error instanceof AuthError || typeof error?.code === "string"
    ? String(error.code)
    : "AUTH_UNAVAILABLE";
  const safeCode = /^AUTH_|^CAPABILITY_|^SESSION_|^ACCOUNT_|^TRANSACTION_|^MIGRATION_NOT_READY$/u.test(code)
    ? code
    : "AUTH_UNAVAILABLE";
  return json({ error: safeCode }, { status });
}

export async function requireRequestCapability(runtime, request, capability) {
  const context = await runtime.resolveAuthContext(request);
  if (!context) throw new AuthError("AUTH_REQUIRED", 401);
  const guard = typeof runtime.requireCapability === "function"
    ? runtime.requireCapability
    : requireCapability;
  return { context, authorized: guard(context, capability) };
}

export async function requireRequestAuthentication(runtime, request) {
  const context = await runtime.resolveAuthContext(request);
  if (!context) throw new AuthError("AUTH_REQUIRED", 401);
  return context;
}

/**
 * Browser cookie writes must be same-origin and carry a double-submit token.
 * Keep this check beside request authentication so every protected POST uses
 * the same fail-closed boundary and tests can inject the trusted origin.
 */
export function assertBrowserWriteRequest(request, overrides = {}) {
  try {
    assertTrustedOrigin(request, {
      trustedOrigins: overrides.trustedOrigins ?? overrides.trustedOrigin ?? overrides.allowedOrigins
    });
  } catch {
    throw new AuthError("AUTH_ORIGIN_INVALID", 403);
  }
  try {
    assertCsrf(request);
  } catch {
    throw new AuthError("AUTH_CSRF_INVALID", 403);
  }
}
