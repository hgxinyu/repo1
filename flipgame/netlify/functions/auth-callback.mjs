import { timingSafeEqual } from "node:crypto";
import {
  createAccountRepository
} from "./_shared/auth/account-repository.mjs";
import {
  emailLookupHash,
  encryptSecret,
  randomToken,
  tokenHash
} from "./_shared/auth/crypto.mjs";
import { canonicalIssuer as canonicalIssuerValue } from "./_shared/auth/config.mjs";
import {
  createSessionRepository
} from "./_shared/auth/session-repository.mjs";
import {
  createLogtoClient
} from "./_shared/auth/logto-client.mjs";
import { profileCompleteForAccount } from "./_shared/auth/account-profile.mjs";
import {
  authJson,
  authRedirect,
  assertPreauthState,
  clearPreauthCookie,
  csrfCookie,
  safeNextPath,
  sessionCookie
} from "./_shared/auth/http.mjs";

const MAX_EMAIL_LENGTH = 320;
const SESSION_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

export function onboardingPath(nextPath, options = {}) {
  let safePath;
  try {
    safePath = safeNextPath(nextPath, options);
  } catch {
    safePath = "/index.html";
  }
  const rawPath = safePath.split(/[?#]/u, 1)[0];
  if (rawPath === "/Register.html" && safePath.includes("#")) {
    return "/Register.html";
  }
  const parsed = new URL(safePath, "https://auth.invalid");
  const path = parsed.pathname;
  if (path === "/" || path === "/index.html") {
    return "/Register.html";
  }
  if (path === "/Register.html") {
    if (!parsed.search && !parsed.hash) return "/Register.html";
    const searchEntries = [...parsed.searchParams.entries()];
    if (parsed.hash || searchEntries.length !== 1 ||
        searchEntries[0]?.[0] !== "return_to" ||
        parsed.search !== `?${parsed.searchParams.toString()}`) {
      return "/Register.html";
    }
    const returnTo = searchEntries[0][1];
    if (!returnTo || /[/\\?#]/u.test(returnTo)) return "/Register.html";
    let safeReturnTo;
    try {
      safeReturnTo = safeNextPath(`/${returnTo}`, options);
    } catch {
      return "/Register.html";
    }
    if (safeReturnTo !== `/${returnTo}`) return "/Register.html";
    if (safeReturnTo === "/" || safeReturnTo === "/index.html" || safeReturnTo === "/Register.html") {
      return "/Register.html";
    }
    return `/Register.html?return_to=${encodeURIComponent(safeReturnTo.slice(1))}`;
  }
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return basename ? `/Register.html?return_to=${encodeURIComponent(basename)}` : "/Register.html";
}

function errorWith(code, status = 401) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function canonicalIssuer(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return canonicalIssuerValue(value);
  } catch {
    return null;
  }
}

function safeText(value, code, maxLength = 512) {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength ||
      /[\u0000-\u001f\u007f]/u.test(value)) throw errorWith(code, 401);
  return value.trim();
}

function claimEmail(claim) {
  const email = claim?.email;
  if (typeof email !== "string" || email.trim() === "" || email.length > MAX_EMAIL_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(email)) throw errorWith("LOGTO_EMAIL_INVALID", 401);
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@") || normalized.startsWith("@") || normalized.endsWith("@")) {
    throw errorWith("LOGTO_EMAIL_INVALID", 401);
  }
  if (claim.email_verified !== true && claim.emailVerified !== true) {
    throw errorWith("LOGTO_EMAIL_UNVERIFIED", 401);
  }
  return normalized;
}

function expectedClientId(overrides, logtoClient) {
  if (typeof overrides.clientId === "string" && overrides.clientId.trim()) return overrides.clientId.trim();
  if (typeof overrides.logtoClientOptions?.clientId === "string" && overrides.logtoClientOptions.clientId.trim()) {
    return overrides.logtoClientOptions.clientId.trim();
  }
  try {
    if (typeof logtoClient.clientId === "string" && logtoClient.clientId.trim()) return logtoClient.clientId.trim();
  } catch {
    return null;
  }
  return process.env.LOGTO_APP_ID ? String(process.env.LOGTO_APP_ID).trim() || null : null;
}

function nonceHashMatches(nonce, expectedHash) {
  if (expectedHash === undefined || expectedHash === null) return false;
  const actual = tokenHash(nonce);
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validateClaims(rawClaims, transaction, overrides, logtoClient) {
  if (!rawClaims || typeof rawClaims !== "object") throw errorWith("LOGTO_TOKEN_INVALID", 401);
  const configuredIssuer = canonicalIssuer(
    overrides.issuerOrTenant || overrides.logtoClientOptions?.issuer || process.env.LOGTO_ENDPOINT
  );
  const iss = canonicalIssuer(rawClaims.iss);
  if (!configuredIssuer || !iss || configuredIssuer !== iss) throw errorWith("LOGTO_ISSUER_MISMATCH", 401);
  const clientId = expectedClientId(overrides, logtoClient);
  if (clientId !== null) {
    const audience = rawClaims.aud;
    const matches = typeof audience === "string"
      ? audience === clientId
      : Array.isArray(audience) && audience.every((value) => typeof value === "string") && audience.includes(clientId);
    if (!matches) throw errorWith("LOGTO_AUDIENCE_MISMATCH", 401);
  }
  const sub = safeText(rawClaims.sub, "LOGTO_SUB_INVALID");
  const email = claimEmail(rawClaims);
  const nonce = safeText(rawClaims.nonce, "LOGTO_NONCE_INVALID", 4096);
  if (transaction.nonce !== undefined && transaction.nonce !== nonce) {
    throw errorWith("LOGTO_NONCE_INVALID", 401);
  }
  if (transaction.nonce === undefined && !nonceHashMatches(nonce, transaction.nonceHash)) {
    throw errorWith("LOGTO_NONCE_INVALID", 401);
  }
  return {
    iss: configuredIssuer,
    aud: rawClaims.aud,
    sub,
    email,
    emailVerified: true,
    nonce,
    connectorScope: "logto"
  };
}

function accountBlocked(account) {
  const role = String(account?.role ?? "").trim().toLowerCase();
  const status = String(account?.status ?? "").trim().toLowerCase();
  return [role, status].some((value) => ["blocked", "disabled", "merged"].includes(value));
}

function accountVersion(account) {
  const value = account?.authzVersion ?? account?.authz_version;
  const text = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/u.test(text)) throw errorWith("ACCOUNT_INVALID", 500);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw errorWith("ACCOUNT_INVALID", 500);
  return parsed;
}

function responseForError(error, fallbackStatus = 401, headers = {}) {
  const code = String(error?.code || "");
  let status = Number(error?.status);
  if (![400, 401, 403, 409, 429, 500, 502, 503].includes(status)) status = fallbackStatus;
  if (code === "ACCOUNT_BLOCKED") status = 403;
  if (code === "ACCOUNT_CLAIM_CONFLICT") status = 409;
  if (code === "MIGRATION_NOT_READY") {
    return authJson({ error: code }, { status: 503, headers });
  }
  if (status >= 500) return authJson({ error: "Authentication service unavailable" }, { status, headers });
  if (status === 403) return authJson({ error: "认证被拒绝" }, { status, headers });
  if (status === 409) return authJson({ error: "账号需要恢复" }, { status, headers });
  return authJson({ error: "认证失败" }, { status, headers });
}

function callbackError(error, fallbackStatus = 401, headers = {}) {
  return responseForError(error, fallbackStatus, {
    ...headers,
    "Set-Cookie": [clearPreauthCookie(), ...(Array.isArray(headers["Set-Cookie"]) ? headers["Set-Cookie"] : [])]
  });
}

function cancelledLocation(path, mode) {
  const url = new URL(path, "https://auth.invalid");
  url.searchParams.set("auth", mode);
  return `${url.pathname}${url.search}${url.hash}`;
}

function buildDefaultAccountRepository(overrides, issuerOrTenant) {
  if (overrides.accountRepository) return overrides.accountRepository;
  const cryptoOptions = {
    ...overrides.cryptoOptions,
    environmentId: overrides.environmentId ?? process.env.AUTH_ENV_ID,
    siteId: overrides.siteId ?? process.env.NETLIFY_SITE_ID,
    keyVersion: overrides.keyVersion ?? process.env.AUTH_ENCRYPTION_KEY_VERSION
  };
  return createAccountRepository({
    ...(overrides.accountRepositoryOptions || {}),
    issuerOrTenant,
    emailLookupHash: overrides.emailLookupHash || ((email) => emailLookupHash(email, cryptoOptions)),
    encryptSecret: overrides.encryptSecret || ((email, options) => encryptSecret(email, { ...cryptoOptions, ...options }))
  });
}

export function createAuthCallbackHandler(overrides = {}) {
  const sessionRepository = overrides.sessionRepository ||
    createSessionRepository(overrides.sessionRepositoryOptions || {});
  const logtoClient = overrides.logtoClient ||
    createLogtoClient(overrides.logtoClientOptions || {});
  let issuerOrTenant = overrides.issuerOrTenant || overrides.logtoClientOptions?.issuer;
  if (!issuerOrTenant) {
    try {
      issuerOrTenant = logtoClient.issuerOrTenant;
    } catch {
      issuerOrTenant = process.env.LOGTO_ENDPOINT;
    }
  }
  issuerOrTenant = canonicalIssuer(issuerOrTenant);
  const accountRepository = buildDefaultAccountRepository(overrides, issuerOrTenant);
  const nextPath = overrides.safeNextPath || safeNextPath;

  return async function authCallback(request) {
    if (request?.method !== "GET") {
      return callbackError(errorWith("METHOD_NOT_ALLOWED", 405), 405, { Allow: "GET" });
    }

    let url;
    try {
      url = new URL(request.url);
    } catch {
      return callbackError(errorWith("AUTH_CALLBACK_INVALID", 400), 400);
    }
    const state = url.searchParams.get("state");
    const providerError = url.searchParams.get("error");
    try {
      assertPreauthState(request, state);
    } catch {
      return callbackError(errorWith("INVALID_PREAUTH", 401), 401);
    }
    if (providerError) {
      if (providerError === "access_denied" && state && typeof sessionRepository.cancelOAuthTransaction === "function") {
        try {
          const cancelled = await sessionRepository.cancelOAuthTransaction({ state });
          const safePath = nextPath(cancelled?.nextPath || "/Login.html", {
            allowedPaths: overrides.allowedPaths
          });
          return authRedirect(cancelledLocation(safePath, "cancelled"), 302, {
            "Set-Cookie": [clearPreauthCookie()]
          });
        } catch {
          // A malformed/expired transaction must not reveal provider details.
        }
      }
      return callbackError(errorWith("AUTH_CANCELLED", 401), 401);
    }
    const code = url.searchParams.get("code");
    if (!state || !code) return callbackError(errorWith("AUTH_CALLBACK_INVALID", 400), 400);

    try {
      if (typeof sessionRepository.consumeOAuthTransaction !== "function") {
        throw errorWith("AUTH_DEPENDENCY_MISSING", 500);
      }
      const consumed = await sessionRepository.consumeOAuthTransaction({ state });
      const transaction = {
        ...consumed,
        state
      };
      if (typeof transaction.nonce !== "string" || transaction.nonce.length === 0 ||
          typeof transaction.pkceVerifier !== "string" || transaction.pkceVerifier.length === 0 ||
          transaction.nonceHash === undefined || transaction.nonceHash === null) {
        throw errorWith("TRANSACTION_INVALID", 401);
      }
      const exchanged = await logtoClient.exchangeAuthorizationCode({
        currentUrl: url,
        transaction
      });
      const validatedClaims = validateClaims(exchanged?.claims, transaction, overrides, logtoClient);

      let account = await accountRepository.findAccountByLogtoSubject(validatedClaims.sub);
      if (!account) {
        const claimResult = await accountRepository.claimLegacyAccountByVerifiedEmail({
          logtoSubject: validatedClaims.sub,
          issuerOrTenant,
          connectorScope: validatedClaims.connectorScope,
          normalizedEmail: validatedClaims.email
        });
        if (claimResult?.kind === "claimed") {
          account = claimResult.account || await accountRepository.findAccountByLogtoSubject(validatedClaims.sub);
        } else if (claimResult?.kind === "new_account") {
          if (typeof accountRepository.findReconciledMigrationBatch !== "function") {
            throw errorWith("AUTH_DEPENDENCY_MISSING", 500);
          }
          const batch = await accountRepository.findReconciledMigrationBatch({
            source: "netlify_identity"
          });
          if (!batch) throw errorWith("MIGRATION_NOT_READY", 503);
          const create = accountRepository.createAccountWithLogtoIdentity ||
            accountRepository.createLogtoAccount || accountRepository.createAccount;
          if (typeof create !== "function") throw errorWith("ACCOUNT_CREATE_FAILED", 500);
          account = await create.call(accountRepository, {
            role: "free",
            status: "active",
            normalizedEmail: validatedClaims.email,
            logtoSubject: validatedClaims.sub,
            issuerOrTenant,
            connectorScope: validatedClaims.connectorScope,
            emailVerified: true
          });
        } else {
          throw errorWith("ACCOUNT_CLAIM_CONFLICT", 409);
        }
      }
      if (!account || accountBlocked(account)) throw errorWith("ACCOUNT_BLOCKED", 403);
      const refreshToken = exchanged?.refreshToken;
      if (typeof refreshToken !== "string" || refreshToken.length === 0) {
        throw errorWith("LOGTO_REFRESH_TOKEN_MISSING", 502);
      }
      const createdSession = await sessionRepository.createAppSession({
        authSource: "logto",
        accountId: account.accountId,
        logtoSubject: validatedClaims.sub,
        authzVersion: accountVersion(account),
        refreshToken
      });
      if (!createdSession || typeof createdSession.sessionToken !== "string" || createdSession.sessionToken.length === 0) {
        throw errorWith("SESSION_CREATE_FAILED", 500);
      }
      let validatedNext;
      try {
        validatedNext = nextPath(consumed?.nextPath || transaction.nextPath || "/", {
          allowedPaths: overrides.allowedPaths
        });
      } catch {
        validatedNext = "/index.html";
      }
      const now = typeof overrides.now === "function" ? overrides.now() : new Date();
      let maxAge = SESSION_MAX_AGE_SECONDS;
      if (createdSession.idleExpiresAt) {
        const expires = new Date(createdSession.idleExpiresAt).getTime();
        const current = new Date(now).getTime();
        if (Number.isFinite(expires) && Number.isFinite(current)) {
          maxAge = Math.max(1, Math.min(SESSION_MAX_AGE_SECONDS, Math.floor((expires - current) / 1000)));
        }
      }
      const csrfGenerator = overrides.csrfTokenGenerator || randomToken;
      const csrfToken = await csrfGenerator();
      const cookies = [
        sessionCookie(createdSession.sessionToken, maxAge),
        csrfCookie(csrfToken, maxAge),
        clearPreauthCookie()
      ];
      const destination = profileCompleteForAccount(account)
        ? validatedNext
        : onboardingPath(validatedNext, { allowedPaths: overrides.allowedPaths });
      return authRedirect(destination, 302, { "Set-Cookie": cookies });
    } catch (error) {
      return callbackError(error, 401);
    }
  };
}

export default async function authCallback(request) {
  return createAuthCallbackHandler()(request);
}

export const config = {
  path: "/api/auth/callback"
};
