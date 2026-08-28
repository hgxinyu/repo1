import { createAccountRepository } from "./_shared/auth/account-repository.mjs";
import { createAuthContextResolver } from "./_shared/auth/auth-context.mjs";
import { createSessionRepository } from "./_shared/auth/session-repository.mjs";
import { canonicalIssuer } from "./_shared/auth/config.mjs";
import {
  authJson,
  clearCsrfCookie,
  clearSessionCookie
} from "./_shared/auth/http.mjs";

const ANONYMOUS_CAPABILITIES = Object.freeze({
  authenticated: false,
  role: "anonymous",
  blocked: false,
  canAccessRegistered: false,
  canAccessPremium: false,
  isAdmin: false
});

function contextResponse(context) {
  const account = context?.account;
  const capabilities = context?.capabilities;
  if (!account || !capabilities || typeof context.accountId !== "string") {
    const error = new Error("AUTH_CONTEXT_INVALID");
    error.code = "AUTH_CONTEXT_INVALID";
    error.status = 500;
    throw error;
  }
  return {
    authenticated: true,
    accountId: context.accountId,
    role: account.role,
    status: account.status,
    capabilities,
    authSource: context.authSource
  };
}

function errorResponse() {
  return authJson({ error: "Authentication unavailable" }, {
    status: 401,
    headers: { "Set-Cookie": [clearSessionCookie(), clearCsrfCookie()] }
  });
}

function configuredIssuer(overrides) {
  const value = overrides.issuerOrTenant ?? process.env.LOGTO_ENDPOINT;
  if (value === undefined || value === null || value === "") return value;
  return canonicalIssuer(value);
}

function defaultResolver(overrides, sessionRepository) {
  if (overrides.resolveAuthContext) return overrides.resolveAuthContext;
  const issuerOrTenant = configuredIssuer(overrides);
  const accountRepository = overrides.accountRepository || createAccountRepository({
    ...(overrides.accountRepositoryOptions || {}),
    issuerOrTenant
  });
  const resolver = createAuthContextResolver({
    readValidSessionFromCookie: (request) => sessionRepository.readValidSessionFromCookie(request),
    findAccountByLogtoSubject: (subject) => accountRepository.findAccountByLogtoSubject(subject),
    findAccountByLegacyUserId: (legacyId) => accountRepository.findAccountByLegacyUserId(legacyId),
    capabilitiesForAccount: overrides.capabilitiesForAccount,
    issuerOrTenant
  });
  return (request) => resolver(request);
}

export function createAuthSessionHandler(overrides = {}) {
  const sessionRepository = overrides.resolveAuthContext
    ? null
    : overrides.sessionRepository || createSessionRepository(overrides.sessionRepositoryOptions || {});
  const resolveAuthContext = overrides.resolveAuthContext || defaultResolver(overrides, sessionRepository);

  return async function authSession(request) {
    if (request?.method !== "GET") {
      return authJson({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET" } });
    }
    try {
      const context = await resolveAuthContext(request);
      if (!context) return authJson({ authenticated: false, capabilities: ANONYMOUS_CAPABILITIES });
      return authJson(contextResponse(context));
    } catch {
      return errorResponse();
    }
  };
}

export default async function authSession(request) {
  return createAuthSessionHandler()(request);
}

export const config = {
  path: "/api/auth/session"
};
