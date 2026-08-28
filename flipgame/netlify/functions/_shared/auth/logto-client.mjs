import {
  authorizationCodeGrant as defaultAuthorizationCodeGrant,
  buildAuthorizationUrl as defaultBuildAuthorizationUrl,
  buildEndSessionUrl as defaultBuildEndSessionUrl,
  calculatePKCECodeChallenge as defaultCalculatePKCECodeChallenge,
  discovery as defaultDiscovery,
  tokenRevocation as defaultTokenRevocation
} from "openid-client";
import { canonicalIssuer } from "./config.mjs";

const ALLOWED_CONNECTOR_HINTS = new Set(["google", "email"]);
const LOGTO_CONNECTOR_SCOPE = "logto";
const DEFAULT_SCOPE = "openid profile email offline_access";
const MAX_CLAIM_TEXT = 512;

export class LogtoClientError extends Error {
  constructor(code, status = 502, cause = undefined) {
    super(code);
    this.name = "LogtoClientError";
    this.code = code;
    this.status = status;
    this.statusCode = status;
    if (cause !== undefined) this.cause = cause;
  }
}

function fail(code, status = 502, cause) {
  return new LogtoClientError(code, status, cause);
}

function requiredText(value, code, status = 500, maxLength = MAX_CLAIM_TEXT) {
  if (typeof value !== "string" || value.trim() === "") throw fail(code, status);
  const normalized = value.trim();
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw fail(code, status);
  }
  return normalized;
}

function requiredSecret(value, code = "AUTH_CONFIG_MISSING:LOGTO_APP_SECRET") {
  if (typeof value !== "string" || value.length === 0 ||
      /[\u0000-\u001f\u007f]/u.test(value)) throw fail(code, 500);
  return value;
}

function issuerUrl(value) {
  const raw = requiredText(value, "AUTH_CONFIG_MISSING:LOGTO_ENDPOINT", 500, 2048);
  let parsed;
  try {
    parsed = new URL(canonicalIssuer(raw));
  } catch (error) {
    throw fail("AUTH_CONFIG_INVALID:LOGTO_ENDPOINT", 500, error);
  }
  if (parsed.protocol !== "https:" || !parsed.hostname.toLowerCase().endsWith(".logto.app") ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw fail("AUTH_CONFIG_INVALID:LOGTO_ENDPOINT", 500);
  }
  return parsed;
}

function redirectUrl(value) {
  const raw = requiredText(value, "AUTH_CONFIG_MISSING:LOGTO_REDIRECT_URI", 500, 2048);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw fail("AUTH_CONFIG_INVALID:LOGTO_REDIRECT_URI", 500, error);
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if ((local ? !["http:", "https:"].includes(parsed.protocol) : parsed.protocol !== "https:") ||
      parsed.pathname !== "/api/auth/callback" || parsed.username || parsed.password ||
      parsed.search || parsed.hash) {
    throw fail("AUTH_CONFIG_INVALID:LOGTO_REDIRECT_URI", 500);
  }
  return parsed.href;
}

function localHost(value) {
  return value === "localhost" || value === "127.0.0.1";
}

function postLogoutRedirectUrl(value, redirectUri) {
  const raw = requiredText(
    value,
    "AUTH_CONFIG_MISSING:LOGTO_POST_LOGOUT_REDIRECT_URI",
    500,
    2048
  );
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw fail("AUTH_CONFIG_INVALID:LOGTO_POST_LOGOUT_REDIRECT_URI", 500, error);
  }
  const local = localHost(parsed.hostname);
  if ((local ? !["http:", "https:"].includes(parsed.protocol) : parsed.protocol !== "https:") ||
      parsed.pathname !== "/Login.html" || parsed.search !== "?auth=logged-out" ||
      parsed.hash || parsed.username || parsed.password || parsed.origin !== new URL(redirectUri).origin) {
    throw fail("AUTH_CONFIG_INVALID:LOGTO_POST_LOGOUT_REDIRECT_URI", 500);
  }
  return parsed.href;
}

function configFrom(overrides, { requirePostLogout = false } = {}) {
  const environment = overrides.environment || process.env;
  const issuer = issuerUrl(overrides.issuer ?? environment.LOGTO_ENDPOINT);
  const clientId = requiredText(
    overrides.clientId ?? environment.LOGTO_APP_ID,
    "AUTH_CONFIG_MISSING:LOGTO_APP_ID",
    500
  );
  const clientSecret = requiredSecret(
    overrides.clientSecret ?? environment.LOGTO_APP_SECRET
  );
  const configuredRedirect = overrides.redirectUri ??
    environment.LOGTO_REDIRECT_URI ?? environment.AUTH_STAGE_CALLBACK_URL ?? environment.AUTH_CALLBACK_URL;
  const redirectUri = redirectUrl(configuredRedirect);
  const configuredPostLogoutRedirect = overrides.postLogoutRedirectUri ??
    environment.LOGTO_POST_LOGOUT_REDIRECT_URI;
  const callback = new URL(redirectUri);
  const localOrTest = localHost(callback.hostname) ||
    String(environment.NODE_ENV || "").toLowerCase() === "test" ||
    String(environment.NETLIFY_DEV || "").toLowerCase() === "true";
  const postLogoutCandidate = configuredPostLogoutRedirect ??
    (localOrTest ? `${callback.origin}/Login.html?auth=logged-out` : undefined);
  const postLogoutRedirectUri = postLogoutCandidate === undefined && !requirePostLogout
    ? null
    : postLogoutRedirectUrl(postLogoutCandidate, redirectUri);
  return Object.freeze({ issuer, clientId, clientSecret, redirectUri, postLogoutRedirectUri });
}

function safeConnectorHint(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !ALLOWED_CONNECTOR_HINTS.has(value)) {
    throw fail("AUTH_CONNECTOR_UNAVAILABLE", 400);
  }
  return value;
}

function safeLocale(value) {
  if (value === undefined || value === null || value === "") return "en-US";
  if (typeof value !== "string" || !/^[A-Za-z]{2}(?:-[A-Za-z0-9]{2,8})?$/u.test(value)) {
    throw fail("AUTH_LOCALE_INVALID", 400);
  }
  return value;
}

function transactionValue(transaction, name) {
  if (!transaction || typeof transaction !== "object") throw fail("TRANSACTION_INVALID", 401);
  return requiredText(transaction[name], "TRANSACTION_INVALID", 401, 4096);
}

function audienceContains(audience, clientId) {
  if (typeof audience === "string") return audience === clientId;
  return Array.isArray(audience) && audience.every((value) => typeof value === "string") &&
    audience.includes(clientId);
}

function exactIssuer(value, expected) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).href === expected.href;
  } catch {
    return false;
  }
}

function claimsFromTokens(tokens) {
  if (!tokens || typeof tokens !== "object") throw fail("LOGTO_TOKEN_INVALID", 401);
  try {
    const value = typeof tokens.claims === "function" ? tokens.claims() : tokens.claims;
    if (!value || typeof value !== "object") throw new Error("missing claims");
    return value;
  } catch (error) {
    throw fail("LOGTO_TOKEN_INVALID", 401, error);
  }
}

function normalizedClaims(raw, config, transaction) {
  if (!exactIssuer(raw.iss, config.issuer)) throw fail("LOGTO_ISSUER_MISMATCH", 401);
  if (!audienceContains(raw.aud, config.clientId)) throw fail("LOGTO_AUDIENCE_MISMATCH", 401);
  const sub = requiredText(raw.sub, "LOGTO_SUB_INVALID", 401);
  const email = requiredText(raw.email, "LOGTO_EMAIL_INVALID", 401, 320).toLowerCase();
  if (!email.includes("@") || email.startsWith("@") || email.endsWith("@")) {
    throw fail("LOGTO_EMAIL_INVALID", 401);
  }
  if (raw.email_verified !== true && raw.emailVerified !== true) {
    throw fail("LOGTO_EMAIL_UNVERIFIED", 401);
  }
  const nonce = requiredText(raw.nonce, "LOGTO_NONCE_INVALID", 401, 4096);
  if (transaction.nonce !== undefined && transaction.nonce !== nonce) {
    throw fail("LOGTO_NONCE_INVALID", 401);
  }
  return Object.freeze({
    iss: config.issuer.href,
    aud: raw.aud,
    sub,
    email,
    emailVerified: true,
    nonce,
    connectorScope: LOGTO_CONNECTOR_SCOPE
  });
}

function metadataOf(configuration) {
  const metadata = configuration && typeof configuration.serverMetadata === "function"
    ? configuration.serverMetadata()
    : configuration?.serverMetadata;
  if (!metadata || typeof metadata !== "object") throw fail("LOGTO_DISCOVERY_INVALID", 502);
  return metadata;
}

function ensureIssuer(configuration, config) {
  const metadata = metadataOf(configuration);
  if (!exactIssuer(metadata.issuer, config.issuer)) throw fail("LOGTO_ISSUER_MISMATCH", 502);
  return metadata;
}

export function createLogtoClient(overrides = {}) {
  if (!overrides || typeof overrides !== "object") throw new TypeError("Logto client options must be an object");
  const deps = {
    ...overrides,
    discover: overrides.discover || defaultDiscovery,
    buildAuthorizationUrl: overrides.buildAuthorizationUrl || defaultBuildAuthorizationUrl,
    buildEndSessionUrl: overrides.buildEndSessionUrl || defaultBuildEndSessionUrl,
    authorizationCodeGrant: overrides.authorizationCodeGrant || defaultAuthorizationCodeGrant,
    calculatePKCECodeChallenge: overrides.calculatePKCECodeChallenge || defaultCalculatePKCECodeChallenge,
    tokenRevocation: overrides.tokenRevocation || defaultTokenRevocation
  };

  async function configuration(options = {}) {
    const config = configFrom(deps, options);
    let result;
    try {
      result = await deps.discover(
        config.issuer,
        config.clientId,
        { client_secret: config.clientSecret }
      );
    } catch (error) {
      if (error instanceof LogtoClientError) throw error;
      throw fail("LOGTO_DISCOVERY_FAILED", 502, error);
    }
    const metadata = ensureIssuer(result, config);
    return { config, client: result, metadata };
  }

  return Object.freeze({
    get issuerOrTenant() {
      return configFrom(deps).issuer.href;
    },
    get clientId() {
      return configFrom(deps).clientId;
    },
    async buildAuthorizationUrl(input = {}) {
      const transaction = input.transaction;
      const state = transactionValue(transaction, "state");
      const nonce = transactionValue(transaction, "nonce");
      const pkceVerifier = transactionValue(transaction, "pkceVerifier");
      const locale = safeLocale(input.locale);
      const connectorHint = safeConnectorHint(input.connectorHint);
      const { config, client, metadata } = await configuration();
      let codeChallenge;
      try {
        codeChallenge = await deps.calculatePKCECodeChallenge(pkceVerifier);
      } catch (error) {
        throw fail("LOGTO_PKCE_INVALID", 500, error);
      }
      if (typeof codeChallenge !== "string" || codeChallenge.length < 1) {
        throw fail("LOGTO_PKCE_INVALID", 500);
      }
      const parameters = {
        redirect_uri: config.redirectUri,
        response_type: "code",
        client_id: config.clientId,
        scope: DEFAULT_SCOPE,
        prompt: "consent",
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        ui_locales: locale
      };
      if (connectorHint === "google") parameters.direct_sign_in = "social:google";
      let result;
      try {
        result = deps.buildAuthorizationUrl(client, parameters);
      } catch (error) {
        throw fail("LOGTO_AUTHORIZATION_URL_FAILED", 502, error);
      }
      if (!(result instanceof URL) || result.protocol !== "https:" ||
          result.origin !== config.issuer.origin) {
        throw fail("LOGTO_AUTHORIZATION_URL_INVALID", 502);
      }
      return result;
    },
    async buildEndSessionUrl() {
      const { config, client, metadata } = await configuration({ requirePostLogout: true });
      const parameters = {
        client_id: config.clientId,
        post_logout_redirect_uri: config.postLogoutRedirectUri
      };
      let result;
      try {
        result = deps.buildEndSessionUrl(client, parameters);
      } catch (error) {
        throw fail("LOGTO_END_SESSION_URL_FAILED", 502, error);
      }
      if (!(result instanceof URL) || result.protocol !== "https:" ||
          result.origin !== config.issuer.origin) {
        throw fail("LOGTO_END_SESSION_URL_INVALID", 502);
      }
      let endpoint;
      try {
        endpoint = new URL(metadata.end_session_endpoint);
      } catch {
        throw fail("LOGTO_END_SESSION_URL_INVALID", 502);
      }
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash ||
          endpoint.origin !== config.issuer.origin || endpoint.pathname !== result.pathname) {
        throw fail("LOGTO_END_SESSION_URL_INVALID", 502);
      }
      const keys = [...result.searchParams.keys()];
      const keySet = new Set(keys);
      if (keys.length !== 2 || !keySet.has("client_id") || !keySet.has("post_logout_redirect_uri") ||
          result.searchParams.get("client_id") !== config.clientId ||
          result.searchParams.get("post_logout_redirect_uri") !== config.postLogoutRedirectUri ||
          result.searchParams.has("id_token_hint")) {
        throw fail("LOGTO_END_SESSION_URL_INVALID", 502);
      }
      return result;
    },
    async exchangeAuthorizationCode(input = {}) {
      const transaction = input.transaction;
      const state = transactionValue(transaction, "state");
      const pkceVerifier = transactionValue(transaction, "pkceVerifier");
      if (!(input.currentUrl instanceof URL)) throw fail("AUTH_CALLBACK_INVALID", 400);
      const { config, client } = await configuration();
      const checks = { pkceCodeVerifier: pkceVerifier, expectedState: state };
      if (transaction.nonce !== undefined) checks.expectedNonce = transaction.nonce;
      let tokens;
      try {
        tokens = await deps.authorizationCodeGrant(client, input.currentUrl, checks);
      } catch (error) {
        throw fail("LOGTO_CODE_EXCHANGE_FAILED", 401, error);
      }
      const rawClaims = claimsFromTokens(tokens);
      const validated = normalizedClaims(rawClaims, config, transaction);
      const refreshToken = tokens.refresh_token;
      if (typeof refreshToken !== "string" || refreshToken.length === 0) {
        throw fail("LOGTO_REFRESH_TOKEN_MISSING", 502);
      }
      return Object.freeze({ claims: validated, refreshToken });
    },
    async revokeLogtoGrant(input = {}) {
      const refreshToken = requiredSecret(input.refreshToken, "AUTH_TOKEN_INVALID");
      const { client } = await configuration();
      try {
        await deps.tokenRevocation(client, refreshToken, { token_type_hint: "refresh_token" });
      } catch (error) {
        throw fail("LOGTO_REVOKE_FAILED", 502, error);
      }
    }
  });
}

/** Production convenience exports; tests and handlers should prefer the factory. */
export async function buildAuthorizationUrl(input) {
  return createLogtoClient().buildAuthorizationUrl(input);
}

export async function exchangeAuthorizationCode(input) {
  return createLogtoClient().exchangeAuthorizationCode(input);
}

export async function buildEndSessionUrl() {
  return createLogtoClient().buildEndSessionUrl();
}

export async function revokeLogtoGrant(input) {
  return createLogtoClient().revokeLogtoGrant(input);
}
