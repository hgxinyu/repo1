import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createAuthSignInHandler } from "../../netlify/functions/auth-sign-in.mjs";
import { createAuthCallbackHandler } from "../../netlify/functions/auth-callback.mjs";
import { createAuthSessionHandler } from "../../netlify/functions/auth-session.mjs";
import { createAuthLogoutHandler } from "../../netlify/functions/auth-logout.mjs";
import { createLogtoClient } from "../../netlify/functions/_shared/auth/logto-client.mjs";
import { tokenHash } from "../../netlify/functions/_shared/auth/crypto.mjs";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const FAMILY_ID = "33333333-3333-4333-8333-333333333333";
const TX_ID = "44444444-4444-4444-8444-444444444444";
const STATE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NONCE = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const PKCE = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const SESSION_TOKEN = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const CSRF_TOKEN = "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
const TOKEN_FOR_OTHER_BROWSER = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
const REFRESH_TOKEN = "refresh-token-from-logto";
const ORIGIN = "https://stage.example.com";
const POST_LOGOUT_REDIRECT = `${ORIGIN}/Login.html?auth=logged-out`;

const account = {
  accountId: ACCOUNT_ID,
  role: "vip",
  status: "active",
  guild: "Shine",
  gameName: "Player One",
  authzVersion: 7,
  migrationId: null
};

function request(path, { method = "GET", origin = ORIGIN, cookie = "", body, headers: extraHeaders = {} } = {}) {
  const headers = {};
  if (origin !== null) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  Object.assign(headers, extraHeaders);
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function oauthTransaction(overrides = {}) {
  return {
    transactionId: TX_ID,
    state: STATE,
    nonce: NONCE,
    pkceVerifier: PKCE,
    nonceHash: tokenHash(NONCE),
    nextPath: "/AIAsk.html",
    ...overrides
  };
}

function preauthCookie(state = STATE) {
  return `__Host-shinegame_preauth=${state}`;
}

function consumedTransaction(overrides = {}) {
  return {
    transactionId: TX_ID,
    nextPath: "/AIAsk.html",
    nonce: NONCE,
    nonceHash: tokenHash(NONCE),
    pkceVerifier: PKCE,
    ...overrides
  };
}

function claims(overrides = {}) {
  return {
    iss: "https://tenant.logto.app/",
    aud: "logto-app",
    sub: "logto-user-1",
    email: "vip@example.com",
    email_verified: true,
    nonce: NONCE,
    ...overrides
  };
}

function session(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    sessionFamilyId: FAMILY_ID,
    accountId: ACCOUNT_ID,
    authSource: "logto",
    logtoSubject: "logto-user-1",
    migrationId: null,
    authzVersion: 7,
    idleExpiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    ...overrides
  };
}

function responseHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  return response.headers;
}

test("sign-in only accepts GET and redirects with state, nonce, and PKCE", async () => {
  let transactionInput;
  let buildInput;
  const handler = createAuthSignInHandler({
    sessionRepository: {
      async createOAuthTransaction(input) {
        transactionInput = input;
        return oauthTransaction();
      }
    },
    logtoClient: {
      async buildAuthorizationUrl(input) {
        buildInput = input;
        return new URL("https://tenant.logto.app/oidc/auth?state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
      }
    },
    trustedOrigin: ORIGIN
  });

  const methodResponse = await handler(request("/api/auth/sign-in", { method: "POST", body: {} }));
  assert.equal(methodResponse.status, 405);

  const response = await handler(request("/api/auth/sign-in?next=AIAsk.html&locale=zh-CN&connector=google"));
  assert.equal(response.status, 302);
  assert.equal(responseHeaders(response).get("location"), "https://tenant.logto.app/oidc/auth?state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.deepEqual(transactionInput, { nextPath: "/AIAsk.html" });
  assert.equal(buildInput.transaction.state, STATE);
  assert.equal(buildInput.transaction.nonce, NONCE);
  assert.equal(buildInput.transaction.pkceVerifier, PKCE);
  assert.equal(buildInput.connectorHint, "google");
  assert.equal(buildInput.locale, "zh-CN");
  const setCookies = response.headers.getSetCookie?.() || [response.headers.get("set-cookie") || ""];
  assert.equal(setCookies.length, 1);
  assert.match(setCookies[0], new RegExp(`^__Host-shinegame_preauth=${STATE};`));
  assert.match(setCookies[0], /Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(setCookies[0], /Domain=/i);
});

test("sign-in rejects QQ and malicious next before creating a transaction", async () => {
  let created = 0;
  const handler = createAuthSignInHandler({
    sessionRepository: { async createOAuthTransaction() { created += 1; return oauthTransaction(); } },
    logtoClient: { async buildAuthorizationUrl() { return new URL("https://tenant.logto.app/"); } }
  });

  for (const path of [
    "/api/auth/sign-in?connector=qq",
    "/api/auth/sign-in?next=https%3A%2F%2Fevil.example",
    "/api/auth/sign-in?next=%2F%2Fevil.example"
  ]) {
    const response = await handler(request(path));
    assert.equal(response.status, 400);
    assert.match(await response.text(), /invalid|登录|认证/i);
  }
  assert.equal(created, 0);
});

test("callback rejects a missing or cross-browser preauth cookie before consuming state", async () => {
  let consumed = 0;
  const handler = createAuthCallbackHandler({
    issuerOrTenant: "https://tenant.logto.app/",
    sessionRepository: {
      async consumeOAuthTransaction() {
        consumed += 1;
        return consumedTransaction();
      }
    },
    logtoClient: {
      async exchangeAuthorizationCode() {
        throw new Error("must not exchange without preauth cookie");
      }
    },
    accountRepository: { async findAccountByLogtoSubject() { return account; } }
  });

  for (const cookie of ["", preauthCookie(TOKEN_FOR_OTHER_BROWSER)]) {
    const response = await handler(request(`/api/auth/callback?code=provider-code&state=${STATE}`, { cookie }));
    assert.equal(response.status, 401);
    assert.match(response.headers.get("set-cookie"), /__Host-shinegame_preauth=;.*Max-Age=0/);
  }
  assert.equal(consumed, 0);
});

test("logto authorization URL maps only phase-one connector hints", async () => {
  const calls = [];
  const client = createLogtoClient({
    issuer: "https://tenant.logto.app/",
    clientId: "logto-app",
    clientSecret: "test-secret",
    redirectUri: `${ORIGIN}/api/auth/callback`,
    postLogoutRedirectUri: POST_LOGOUT_REDIRECT,
    discover: async () => ({
      serverMetadata: () => ({
        issuer: "https://tenant.logto.app/",
        authorization_endpoint: "https://tenant.logto.app/oidc/auth"
      })
    }),
    buildAuthorizationUrl(config, parameters) {
      calls.push({ config, parameters });
      return new URL(`https://tenant.logto.app/oidc/auth?${new URLSearchParams(parameters)}`);
    }
  });

  const googleUrl = await client.buildAuthorizationUrl({
    transaction: oauthTransaction(),
    locale: "en-US",
    connectorHint: "google"
  });
  assert.equal(googleUrl.searchParams.get("direct_sign_in"), "social:google");
  assert.equal(googleUrl.searchParams.get("ui_locales"), "en-US");
  assert.equal(googleUrl.searchParams.get("scope"), "openid profile email offline_access");
  assert.equal(googleUrl.searchParams.get("prompt"), "consent");
  assert.equal(googleUrl.searchParams.get("code_challenge_method"), "S256");

  const emailUrl = await client.buildAuthorizationUrl({
    transaction: oauthTransaction(),
    locale: "zh-CN",
    connectorHint: "email"
  });
  assert.equal(emailUrl.searchParams.get("direct_sign_in"), null);
  assert.equal(emailUrl.searchParams.get("ui_locales"), "zh-CN");

  await assert.rejects(
    () => client.buildAuthorizationUrl({ transaction: oauthTransaction(), locale: "en", connectorHint: "qq" }),
    (error) => error.code === "AUTH_CONNECTOR_UNAVAILABLE"
  );
  assert.equal(calls.length, 2);

  const unsafeClient = createLogtoClient({
    issuer: "https://tenant.logto.app/",
    clientId: "logto-app",
    clientSecret: "test-secret",
    redirectUri: `${ORIGIN}/api/auth/callback`,
    postLogoutRedirectUri: POST_LOGOUT_REDIRECT,
    discover: async () => ({
      serverMetadata: () => ({ issuer: "https://tenant.logto.app/" })
    }),
    buildAuthorizationUrl() {
      return new URL("https://evil.example/authorize");
    }
  });
  await assert.rejects(
    () => unsafeClient.buildAuthorizationUrl({ transaction: oauthTransaction(), locale: "en-US" }),
    (error) => error.code === "LOGTO_AUTHORIZATION_URL_INVALID"
  );
});

test("Logto end-session URL uses only the fixed client and post-logout redirect parameters", async () => {
  let received;
  const discovered = {
    serverMetadata: () => ({
      issuer: "https://tenant.logto.app/",
      end_session_endpoint: "https://tenant.logto.app/oidc/session/end"
    })
  };
  const client = createLogtoClient({
    issuer: "https://tenant.logto.app/",
    clientId: "logto-app",
    clientSecret: "test-secret",
    redirectUri: `${ORIGIN}/api/auth/callback`,
    postLogoutRedirectUri: POST_LOGOUT_REDIRECT,
    discover: async () => discovered,
    buildEndSessionUrl(configuration, parameters) {
      assert.equal(configuration, discovered);
      received = parameters;
      return new URL(`https://tenant.logto.app/oidc/session/end?${new URLSearchParams(parameters)}`);
    }
  });

  const result = await client.buildEndSessionUrl();

  assert.equal(result.href, "https://tenant.logto.app/oidc/session/end?client_id=logto-app&post_logout_redirect_uri=https%3A%2F%2Fstage.example.com%2FLogin.html%3Fauth%3Dlogged-out");
  assert.deepEqual(received, {
    client_id: "logto-app",
    post_logout_redirect_uri: POST_LOGOUT_REDIRECT
  });
});

test("Logto end-session URL rejects a generated path different from discovery metadata", async () => {
  const client = createLogtoClient({
    issuer: "https://tenant.logto.app/",
    clientId: "logto-app",
    clientSecret: "test-secret",
    redirectUri: `${ORIGIN}/api/auth/callback`,
    postLogoutRedirectUri: POST_LOGOUT_REDIRECT,
    discover: async () => ({ serverMetadata: () => ({
      issuer: "https://tenant.logto.app/",
      end_session_endpoint: "https://tenant.logto.app/oidc/session/end"
    }) }),
    buildEndSessionUrl: () => new URL("https://tenant.logto.app/oidc/other?client_id=logto-app&post_logout_redirect_uri=https%3A%2F%2Fstage.example.com%2FLogin.html%3Fauth%3Dlogged-out")
  });

  await assert.rejects(
    () => client.buildEndSessionUrl(),
    (error) => error.code === "LOGTO_END_SESSION_URL_INVALID"
  );
});

test("Logto end-session URL rejects a discovery endpoint outside the configured issuer origin", async () => {
  const client = createLogtoClient({
    issuer: "https://tenant.logto.app/",
    clientId: "logto-app",
    clientSecret: "test-secret",
    redirectUri: `${ORIGIN}/api/auth/callback`,
    postLogoutRedirectUri: POST_LOGOUT_REDIRECT,
    discover: async () => ({ serverMetadata: () => ({
      issuer: "https://tenant.logto.app/",
      end_session_endpoint: "https://evil.example/oidc/session/end"
    }) }),
    buildEndSessionUrl: () => new URL("https://tenant.logto.app/oidc/session/end?client_id=logto-app&post_logout_redirect_uri=https%3A%2F%2Fstage.example.com%2FLogin.html%3Fauth%3Dlogged-out")
  });

  await assert.rejects(
    () => client.buildEndSessionUrl(),
    (error) => error.code === "LOGTO_END_SESSION_URL_INVALID"
  );
});

test("Logto end-session configuration rejects a post-logout origin different from the callback origin", async () => {
  const client = createLogtoClient({
      issuer: "https://tenant.logto.app/",
      clientId: "logto-app",
      clientSecret: "test-secret",
      redirectUri: `${ORIGIN}/api/auth/callback`,
      postLogoutRedirectUri: "https://shinegame.pro/Login.html?auth=logged-out",
      discover: async () => ({ serverMetadata: () => ({ issuer: "https://tenant.logto.app/" }) })
    });
  assert.throws(
    () => client.issuerOrTenant,
    (error) => error.code === "AUTH_CONFIG_INVALID:LOGTO_POST_LOGOUT_REDIRECT_URI"
  );
});

test("missing post-logout configuration does not block login but blocks provider sign-out URL construction", async () => {
  const client = createLogtoClient({
    issuer: "https://tenant.logto.app/",
    clientId: "logto-app",
    clientSecret: "test-secret",
    redirectUri: "https://shinegame.pro/api/auth/callback",
    discover: async () => ({ serverMetadata: () => ({
      issuer: "https://tenant.logto.app/",
      authorization_endpoint: "https://tenant.logto.app/oidc/auth",
      end_session_endpoint: "https://tenant.logto.app/oidc/session/end"
    }) }),
    calculatePKCECodeChallenge: async () => "challenge",
    buildAuthorizationUrl: () => new URL("https://tenant.logto.app/oidc/auth")
  });

  await assert.doesNotReject(() => client.buildAuthorizationUrl({ transaction: oauthTransaction() }));
  await assert.rejects(
    () => client.buildEndSessionUrl(),
    (error) => error.code === "AUTH_CONFIG_MISSING:LOGTO_POST_LOGOUT_REDIRECT_URI"
  );
});

test("Logto claims never select an identity connector from untrusted connector claims", async () => {
  const client = createLogtoClient({
    issuer: "https://tenant.logto.app",
    clientId: "logto-app",
    clientSecret: "test-secret",
    redirectUri: `${ORIGIN}/api/auth/callback`,
    postLogoutRedirectUri: POST_LOGOUT_REDIRECT,
    discover: async (issuer) => {
      assert.equal(issuer.href, "https://tenant.logto.app/");
      return {
        serverMetadata: () => ({ issuer: "https://tenant.logto.app/" })
      };
    },
    authorizationCodeGrant: async (_configuration, _currentUrl, checks) => {
      assert.equal(checks.expectedNonce, NONCE);
      return {
        claims: () => claims({ connectorScope: "qq", connector: "attacker-controlled" }),
        refresh_token: REFRESH_TOKEN
      };
    }
  });

  const result = await client.exchangeAuthorizationCode({
    currentUrl: new URL(`${ORIGIN}/api/auth/callback?code=provider-code&state=${STATE}`),
    transaction: oauthTransaction()
  });

  assert.equal(result.claims.connectorScope, "logto");
});

test("Logto callback configuration accepts the supported redirect aliases and canonical issuer", async () => {
  const aliases = ["LOGTO_REDIRECT_URI", "AUTH_STAGE_CALLBACK_URL", "AUTH_CALLBACK_URL"];
  for (const alias of aliases) {
    let parameters;
    const client = createLogtoClient({
      environment: {
        LOGTO_ENDPOINT: "https://tenant.logto.app",
        LOGTO_APP_ID: "logto-app",
        LOGTO_APP_SECRET: "test-secret",
        LOGTO_POST_LOGOUT_REDIRECT_URI: POST_LOGOUT_REDIRECT,
        [alias]: `${ORIGIN}/api/auth/callback`
      },
      discover: async (issuer) => {
        assert.equal(issuer.href, "https://tenant.logto.app/");
        return { serverMetadata: () => ({ issuer: "https://tenant.logto.app/" }) };
      },
      calculatePKCECodeChallenge: async () => "challenge",
      buildAuthorizationUrl: (_configuration, input) => {
        parameters = input;
        return new URL("https://tenant.logto.app/oidc/auth");
      }
    });

    await client.buildAuthorizationUrl({ transaction: oauthTransaction(), locale: "en-US" });
    assert.equal(parameters.redirect_uri, `${ORIGIN}/api/auth/callback`);
  }

  const localClient = createLogtoClient({
    environment: {
      LOGTO_ENDPOINT: "https://tenant.logto.app",
      LOGTO_APP_ID: "logto-app",
      LOGTO_APP_SECRET: "test-secret",
      LOGTO_POST_LOGOUT_REDIRECT_URI: "http://localhost:8888/Login.html?auth=logged-out",
      AUTH_CALLBACK_URL: "http://localhost:8888/api/auth/callback"
    },
    discover: async () => ({ serverMetadata: () => ({ issuer: "https://tenant.logto.app/" }) }),
    calculatePKCECodeChallenge: async () => "challenge",
    buildAuthorizationUrl: () => new URL("https://tenant.logto.app/oidc/auth")
  });
  await assert.doesNotReject(() => localClient.buildAuthorizationUrl({ transaction: oauthTransaction() }));

  for (const invalidRedirect of [
    "http://stage.example.com/api/auth/callback",
    "https://stage.example.com/login/callback",
    "https://stage.example.com/api/auth/callback?next=/AIAsk.html"
  ]) {
    const invalidClient = createLogtoClient({
      environment: {
        LOGTO_ENDPOINT: "https://tenant.logto.app",
        LOGTO_APP_ID: "logto-app",
        LOGTO_APP_SECRET: "test-secret",
        AUTH_STAGE_CALLBACK_URL: invalidRedirect
      },
      discover: async () => ({ serverMetadata: () => ({ issuer: "https://tenant.logto.app/" }) }),
      calculatePKCECodeChallenge: async () => "challenge",
      buildAuthorizationUrl: () => new URL("https://tenant.logto.app/oidc/auth")
    });
    await assert.rejects(
      () => invalidClient.buildAuthorizationUrl({ transaction: oauthTransaction() }),
      (error) => error.code === "AUTH_CONFIG_INVALID:LOGTO_REDIRECT_URI"
    );
  }
});

test("callback consumes OAuth state exactly once before exchanging code or resolving an account", async () => {
  const calls = [];
  const appSessionInput = [];
  const handler = createAuthCallbackHandler({
    issuerOrTenant: "https://tenant.logto.app/",
    sessionRepository: {
      async consumeOAuthTransaction(input) {
        calls.push(["consume", input]);
        return consumedTransaction();
      },
      async createAppSession(input) {
        appSessionInput.push(input);
        return session({ sessionToken: SESSION_TOKEN });
      }
    },
    logtoClient: {
      async exchangeAuthorizationCode(input) {
        calls.push(["exchange", input]);
        assert.equal(input.transaction.pkceVerifier, PKCE);
        assert.equal(input.transaction.state, STATE);
        return { claims: claims(), refreshToken: REFRESH_TOKEN };
      }
    },
    accountRepository: {
      async findAccountByLogtoSubject() { return account; },
      async findReconciledMigrationBatch() {
        throw new Error("existing subjects must not check migration readiness");
      }
    },
    trustedOrigin: ORIGIN,
    now: () => new Date("2026-08-26T00:00:00.000Z")
  });

  const response = await handler(request(`/api/auth/callback?code=provider-code&state=${STATE}`, {
    cookie: preauthCookie()
  }));
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get("location"), ORIGIN).pathname, "/AIAsk.html");
  responseHeaders(response);
  assert.deepEqual(calls.map(([name]) => name), ["consume", "exchange"]);
  assert.deepEqual(calls[0][1], { state: STATE });
  assert.equal(appSessionInput.length, 1);
  assert.deepEqual(appSessionInput[0], {
    authSource: "logto",
    accountId: ACCOUNT_ID,
    logtoSubject: "logto-user-1",
    authzVersion: 7,
    refreshToken: REFRESH_TOKEN
  });
  assert.match(response.headers.get("set-cookie"), /__Host-shinegame_session=/);
  assert.match(response.headers.get("set-cookie"), /__Host-shinegame_csrf=/);
  assert.match(response.headers.get("set-cookie"), /__Host-shinegame_preauth=;.*Max-Age=0/);
  assert.doesNotMatch(await response.text(), /refresh-token|provider-code|nonce|pkce/i);
});

test("callback uses verified email to claim a legacy account without creating a duplicate", async () => {
  const claimInputs = [];
  let created = 0;
  const handler = createAuthCallbackHandler({
    issuerOrTenant: "https://tenant.logto.app/",
    sessionRepository: {
      async consumeOAuthTransaction() { return consumedTransaction({ nextPath: "/" }); },
      async createAppSession(input) { created += 1; return session({ accountId: input.accountId, sessionToken: SESSION_TOKEN }); }
    },
    logtoClient: {
      async exchangeAuthorizationCode() { return { claims: claims({ connectorScope: "google" }), refreshToken: REFRESH_TOKEN }; }
    },
    accountRepository: {
      async findAccountByLogtoSubject() { return claimInputs.length ? account : null; },
      async claimLegacyAccountByVerifiedEmail(input) {
        claimInputs.push(input);
        return { kind: "claimed", accountId: ACCOUNT_ID };
      },
      async findAccountByAccountId() { return account; },
      async findReconciledMigrationBatch() {
        throw new Error("claimed legacy accounts must not check migration readiness");
      }
    },
    trustedOrigin: ORIGIN
  });

  const response = await handler(request(`/api/auth/callback?code=provider-code&state=${STATE}`, {
    cookie: preauthCookie()
  }));
  assert.equal(response.status, 302);
  assert.equal(created, 1);
  assert.deepEqual(claimInputs, [{
    logtoSubject: "logto-user-1",
    issuerOrTenant: "https://tenant.logto.app/",
    connectorScope: "logto",
    normalizedEmail: "vip@example.com"
  }]);
});

test("callback returns conflict and creates no durable identity/session when an imported email lacks verification", async () => {
  const calls = [];
  const conflict = Object.assign(new Error("database detail"), {
    code: "ACCOUNT_CLAIM_CONFLICT",
    status: 409,
    statusCode: 409
  });
  const handler = createAuthCallbackHandler({
    issuerOrTenant: "https://tenant.logto.app/",
    sessionRepository: {
      async consumeOAuthTransaction() { calls.push("consume"); return consumedTransaction({ nextPath: "/" }); },
      async createAppSession() { calls.push("session"); throw new Error("session must not be created"); }
    },
    logtoClient: {
      async exchangeAuthorizationCode() { calls.push("exchange"); return { claims: claims(), refreshToken: REFRESH_TOKEN }; }
    },
    accountRepository: {
      async findAccountByLogtoSubject() { calls.push("subject"); return null; },
      async claimLegacyAccountByVerifiedEmail() { calls.push("claim"); throw conflict; },
      async createAccountWithLogtoIdentity() { calls.push("account"); throw new Error("account must not be created"); }
    },
    trustedOrigin: ORIGIN
  });

  const response = await handler(request(`/api/auth/callback?code=provider-code&state=${STATE}`, {
    cookie: preauthCookie()
  }));
  assert.equal(response.status, 409);
  assert.deepEqual(calls, ["consume", "exchange", "subject", "claim"]);
  assert.doesNotMatch(await response.text(), /database detail|vip@example\.com/i);
});

test("callback blocks an unmatched verified email until migration readiness is reconciled", async () => {
  const calls = [];
  let created = 0;
  let sessions = 0;
  const handler = createAuthCallbackHandler({
    issuerOrTenant: "https://tenant.logto.app/",
    sessionRepository: {
      async consumeOAuthTransaction() { calls.push("consume"); return consumedTransaction({ nextPath: "/" }); },
      async createAppSession() { calls.push("session"); sessions += 1; return session({ authzVersion: 1, sessionToken: SESSION_TOKEN }); }
    },
    logtoClient: {
      async exchangeAuthorizationCode() { calls.push("exchange"); return { claims: claims({ email: "new@example.com" }), refreshToken: REFRESH_TOKEN }; }
    },
    accountRepository: {
      async findAccountByLogtoSubject() { calls.push("subject"); return null; },
      async claimLegacyAccountByVerifiedEmail() { calls.push("claim"); return { kind: "new_account" }; },
      async findReconciledMigrationBatch(input) {
        calls.push(["readiness", input]);
        return null;
      },
      async createAccountWithLogtoIdentity() { created += 1; calls.push("create"); return { ...account, role: "free", authzVersion: 1 }; }
    },
    trustedOrigin: ORIGIN
  });

  const response = await handler(request(`/api/auth/callback?code=provider-code&state=${STATE}`, {
    cookie: preauthCookie()
  }));
  assert.equal(response.status, 503);
  assert.deepEqual(calls, [
    "consume",
    "exchange",
    "subject",
    "claim",
    ["readiness", { source: "netlify_identity" }]
  ]);
  assert.equal(created, 0);
  assert.equal(sessions, 0);
  assert.deepEqual(await response.json(), { error: "MIGRATION_NOT_READY" });
});

test("callback creates a free account only after an exact reconciled migration batch", async () => {
  let createInput;
  let sessionInput;
  const calls = [];
  const newAccount = { ...account, role: "free", authzVersion: 1 };
  const handler = createAuthCallbackHandler({
    issuerOrTenant: "https://tenant.logto.app/",
    sessionRepository: {
      async consumeOAuthTransaction() { calls.push("consume"); return consumedTransaction({ nextPath: "/" }); },
      async createAppSession(input) { calls.push("session"); sessionInput = input; return session({ accountId: input.accountId, authzVersion: 1, sessionToken: SESSION_TOKEN }); }
    },
    logtoClient: {
      async exchangeAuthorizationCode() { calls.push("exchange"); return { claims: claims({ email: "new@example.com" }), refreshToken: REFRESH_TOKEN }; }
    },
    accountRepository: {
      async findAccountByLogtoSubject() { calls.push("subject"); return null; },
      async claimLegacyAccountByVerifiedEmail() { calls.push("claim"); return { kind: "new_account" }; },
      async findReconciledMigrationBatch(input) {
        calls.push(["readiness", input]);
        return Object.freeze({
          batchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          source: "netlify_identity",
          snapshotId: "snapshot-2026-08-27",
          sourceCount: 1,
          importedCount: 1,
          conflictCount: 0,
          freezeAt: "2026-08-27T00:00:00.000Z",
          completedAt: "2026-08-27T00:05:00.000Z"
        });
      },
      async createAccountWithLogtoIdentity(input) { calls.push("create"); createInput = input; return newAccount; }
    },
    trustedOrigin: ORIGIN
  });

  const response = await handler(request(`/api/auth/callback?code=provider-code&state=${STATE}`, {
    cookie: preauthCookie()
  }));
  assert.equal(response.status, 302);
  assert.deepEqual(createInput, {
    role: "free",
    status: "active",
    normalizedEmail: "new@example.com",
    logtoSubject: "logto-user-1",
    issuerOrTenant: "https://tenant.logto.app/",
    connectorScope: "logto",
    emailVerified: true
  });
  assert.deepEqual(sessionInput, {
    authSource: "logto",
    accountId: newAccount.accountId,
    logtoSubject: "logto-user-1",
    authzVersion: 1,
    refreshToken: REFRESH_TOKEN
  });
  assert.deepEqual(calls, [
    "consume",
    "exchange",
    "subject",
    "claim",
    ["readiness", { source: "netlify_identity" }],
    "create",
    "session"
  ]);
});

test("callback stops before account or session creation when readiness lookup conflicts", async () => {
  const calls = [];
  const conflict = Object.assign(new Error("database scope detail"), {
    code: "AUTH_MIGRATION_BATCH_CONFLICT",
    status: 409
  });
  const handler = createAuthCallbackHandler({
    issuerOrTenant: "https://tenant.logto.app/",
    sessionRepository: {
      async consumeOAuthTransaction() { calls.push("consume"); return consumedTransaction({ nextPath: "/" }); },
      async createAppSession() { calls.push("session"); return session({ authzVersion: 1, sessionToken: SESSION_TOKEN }); }
    },
    logtoClient: {
      async exchangeAuthorizationCode() { calls.push("exchange"); return { claims: claims({ email: "new@example.com" }), refreshToken: REFRESH_TOKEN }; }
    },
    accountRepository: {
      async findAccountByLogtoSubject() { calls.push("subject"); return null; },
      async claimLegacyAccountByVerifiedEmail() { calls.push("claim"); return { kind: "new_account" }; },
      async findReconciledMigrationBatch() { calls.push("readiness"); throw conflict; },
      async createAccountWithLogtoIdentity() { calls.push("create"); return { ...account, role: "free", authzVersion: 1 }; }
    },
    trustedOrigin: ORIGIN
  });

  const response = await handler(request(`/api/auth/callback?code=provider-code&state=${STATE}`, {
    cookie: preauthCookie()
  }));
  assert.equal(response.status, 409);
  assert.deepEqual(calls, ["consume", "exchange", "subject", "claim", "readiness"]);
  assert.doesNotMatch(await response.text(), /database scope detail|provider-code|refresh-token|new@example\.com/i);
});

test("callback denies blocked account before issuing a first-party session", async () => {
  let sessions = 0;
  const handler = createAuthCallbackHandler({
    issuerOrTenant: "https://tenant.logto.app/",
    sessionRepository: {
      async consumeOAuthTransaction() { return consumedTransaction({ nextPath: "/" }); },
      async createAppSession() { sessions += 1; return session(); }
    },
    logtoClient: {
      async exchangeAuthorizationCode() { return { claims: claims(), refreshToken: REFRESH_TOKEN }; }
    },
    accountRepository: {
      async findAccountByLogtoSubject() { return { ...account, role: "blocked", status: "blocked" }; }
    },
    trustedOrigin: ORIGIN
  });

  const response = await handler(request(`/api/auth/callback?code=provider-code&state=${STATE}`, {
    cookie: preauthCookie()
  }));
  assert.equal(response.status, 403);
  assert.equal(sessions, 0);
  const body = await response.text();
  assert.match(body, /unable|认证|登录/i);
  assert.doesNotMatch(body, /provider-code|refresh-token|vip@example.com/i);
});

test("callback cancellation consumes the transaction and returns its safe page", async () => {
  let cancelled;
  let exchanged = 0;
  const handler = createAuthCallbackHandler({
    sessionRepository: {
      async cancelOAuthTransaction(input) { cancelled = input; return { nextPath: "/AIAsk.html" }; }
    },
    logtoClient: { async exchangeAuthorizationCode() { exchanged += 1; throw new Error("must not exchange"); } }
  });
  const response = await handler(request(`/api/auth/callback?error=access_denied&error_description=secret-provider-detail&state=${STATE}`, {
    cookie: preauthCookie()
  }));
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get("location"), ORIGIN).search, "?auth=cancelled");
  assert.deepEqual(cancelled, { state: STATE });
  assert.equal(exchanged, 0);
  assert.doesNotMatch(await response.text(), /secret-provider-detail|access_denied/i);
  assert.match(response.headers.get("set-cookie"), /__Host-shinegame_preauth=;.*Max-Age=0/);
});

test("callback validates issuer, audience, nonce, and verified email claims", async () => {
  const base = {
    sessionRepository: {
      async consumeOAuthTransaction() { return consumedTransaction({ nextPath: "/" }); },
      async createAppSession() { return session({ sessionToken: SESSION_TOKEN }); }
    },
    accountRepository: { async findAccountByLogtoSubject() { return account; } }
  };
  for (const bad of [
    { iss: "https://evil.example/" },
    { aud: "other-app" },
    { nonce: "wrong-nonce" },
    { email_verified: false },
    { sub: "" }
  ]) {
    const handler = createAuthCallbackHandler({
      ...base,
      issuerOrTenant: "https://tenant.logto.app/",
      clientId: "logto-app",
      logtoClient: { async exchangeAuthorizationCode() { return { claims: claims(bad), refreshToken: REFRESH_TOKEN }; } }
    });
    const response = await handler(request(`/api/auth/callback?code=provider-code&state=${STATE}`, {
      cookie: preauthCookie()
    }));
    assert.equal(response.status, 401);
    assert.doesNotMatch(await response.text(), /evil\.example|other-app|wrong-nonce|vip@example\.com/i);
  }
});

test("session returns canonical capabilities with no-store and no email", async () => {
  const handler = createAuthSessionHandler({
    async resolveAuthContext() {
      return {
        authSource: "logto",
        accountId: ACCOUNT_ID,
        sessionId: SESSION_ID,
        authnSubject: "logto-user-1",
        authzVersion: 7,
        migrationId: null,
        account: { accountId: ACCOUNT_ID, role: "vip", status: "active", authzVersion: 7 },
        capabilities: {
          authenticated: true,
          role: "vip",
          blocked: false,
          canAccessRegistered: true,
          canAccessPremium: true,
          isAdmin: false
        },
        email: "must-not-leak@example.com"
      };
    }
  });
  const response = await handler(request("/api/auth/session"));
  assert.equal(response.status, 200);
  responseHeaders(response);
  const body = await response.json();
  assert.deepEqual(body, {
    authenticated: true,
    accountId: ACCOUNT_ID,
    role: "vip",
    status: "active",
    capabilities: {
      authenticated: true,
      role: "vip",
      blocked: false,
      canAccessRegistered: true,
      canAccessPremium: true,
      isAdmin: false
    },
    authSource: "logto"
  });
  assert.doesNotMatch(JSON.stringify(body), /must-not-leak|logto-user-1/);
});

test("session method restriction and unauthenticated response are stable", async () => {
  const handler = createAuthSessionHandler({ async resolveAuthContext() { return null; } });
  assert.equal((await handler(request("/api/auth/session", { method: "POST" }))).status, 405);
  const response = await handler(request("/api/auth/session"));
  assert.equal(response.status, 200);
  responseHeaders(response);
  assert.deepEqual(await response.json(), {
    authenticated: false,
    capabilities: {
      authenticated: false,
      role: "anonymous",
      blocked: false,
      canAccessRegistered: false,
      canAccessPremium: false,
      canAccessSvip: false,
      isAdmin: false
    }
  });
});

test("session failures clear both the app session and CSRF cookies", async () => {
  const handler = createAuthSessionHandler({
    async resolveAuthContext() {
      throw new Error("database secret detail");
    }
  });
  const response = await handler(request("/api/auth/session"));
  assert.equal(response.status, 401);
  responseHeaders(response);
  const cookies = response.headers.getSetCookie?.() || [];
  assert.deepEqual(cookies, [
    "__Host-shinegame_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
    "__Host-shinegame_csrf=; Path=/; Max-Age=0; Secure; SameSite=Lax"
  ]);
  assert.doesNotMatch(await response.text(), /database secret detail/i);
});

test("logout requires trusted Origin, revokes local family and Logto grant, and clears cookie", async () => {
  const calls = [];
  const handler = createAuthLogoutHandler({
    sessionRepository: {
      async revokeSessionFromCookie(input) {
        calls.push(["local", input]);
        return { accountId: ACCOUNT_ID, sessionFamilyId: FAMILY_ID, authSource: "logto", refreshToken: REFRESH_TOKEN };
      }
    },
    logtoClient: {
      async revokeLogtoGrant(input) { calls.push(["logto", input]); }
    },
    trustedOrigin: ORIGIN
  });
  const response = await handler(request("/api/auth/logout", {
    method: "POST",
    cookie: `__Host-shinegame_session=${SESSION_TOKEN}; __Host-shinegame_csrf=${CSRF_TOKEN}`,
    headers: { "x-csrf-token": CSRF_TOKEN }
  }));
  assert.equal(response.status, 200);
  responseHeaders(response);
  assert.deepEqual(calls, [
    ["local", { request: request("/api/auth/logout", {
      method: "POST",
      cookie: `__Host-shinegame_session=${SESSION_TOKEN}; __Host-shinegame_csrf=${CSRF_TOKEN}`,
      headers: { "x-csrf-token": CSRF_TOKEN }
    }) }],
    ["logto", { refreshToken: REFRESH_TOKEN }]
  ]);
  assert.match(response.headers.get("set-cookie"), /__Host-shinegame_session=.*Max-Age=0/);
  assert.doesNotMatch(await response.text(), /refresh-token|provider-code/i);

  const missingCsrf = await handler(request("/api/auth/logout", {
    method: "POST",
    cookie: `__Host-shinegame_session=${SESSION_TOKEN}; __Host-shinegame_csrf=${CSRF_TOKEN}`
  }));
  assert.equal(missingCsrf.status, 403);
  assert.equal(calls.length, 2);

  const denied = await handler(request("/api/auth/logout", { method: "POST", origin: "https://evil.example", cookie: `__Host-shinegame_session=${SESSION_TOKEN}` }));
  assert.equal(denied.status, 403);
  assert.equal(calls.length, 2);
});

test("logout remains successful when Logto revocation is unavailable after local revoke", async () => {
  let revoked = 0;
  const handler = createAuthLogoutHandler({
    sessionRepository: {
      async revokeSessionFromCookie() { revoked += 1; return { authSource: "logto", refreshToken: REFRESH_TOKEN }; }
    },
    logtoClient: { async revokeLogtoGrant() { throw new Error("provider secret detail"); } },
    trustedOrigin: ORIGIN
  });
  const response = await handler(request("/api/auth/logout", {
    method: "POST",
    cookie: `__Host-shinegame_session=${SESSION_TOKEN}; __Host-shinegame_csrf=${CSRF_TOKEN}`,
    headers: { "x-csrf-token": CSRF_TOKEN }
  }));
  assert.equal(response.status, 200);
  assert.equal(revoked, 1);
  assert.doesNotMatch(await response.text(), /provider secret detail|refresh-token/i);
});

test("logout returns a safe Logto end-session URL after local revocation", async () => {
  const calls = [];
  const endSessionUrl = "https://tenant.logto.app/oidc/session/end?client_id=logto-app&post_logout_redirect_uri=https%3A%2F%2Fstage.example.com%2FLogin.html%3Fauth%3Dlogged-out";
  const handler = createAuthLogoutHandler({
    sessionRepository: {
      async revokeSessionFromCookie() {
        calls.push("local");
        return { authSource: "logto", refreshToken: REFRESH_TOKEN };
      }
    },
    logtoClient: {
      issuerOrTenant: "https://tenant.logto.app/",
      async revokeLogtoGrant() { calls.push("grant"); },
      async buildEndSessionUrl() {
        calls.push("end-session");
        return new URL(endSessionUrl);
      }
    },
    trustedOrigin: ORIGIN
  });

  const response = await handler(request("/api/auth/logout", {
    method: "POST",
    cookie: `__Host-shinegame_session=${SESSION_TOKEN}; __Host-shinegame_csrf=${CSRF_TOKEN}`,
    headers: { "x-csrf-token": CSRF_TOKEN }
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, endSessionUrl });
  assert.deepEqual(calls, ["local", "grant", "end-session"]);
});

test("logout keeps local success when Logto end-session URL cannot be built", async () => {
  let localRevoked = 0;
  const handler = createAuthLogoutHandler({
    sessionRepository: {
      async revokeSessionFromCookie() {
        localRevoked += 1;
        return { authSource: "logto", refreshToken: REFRESH_TOKEN };
      }
    },
    logtoClient: {
      async revokeLogtoGrant() {},
      async buildEndSessionUrl() { throw new Error("discovery unavailable"); }
    },
    trustedOrigin: ORIGIN
  });

  const response = await handler(request("/api/auth/logout", {
    method: "POST",
    cookie: `__Host-shinegame_session=${SESSION_TOKEN}; __Host-shinegame_csrf=${CSRF_TOKEN}`,
    headers: { "x-csrf-token": CSRF_TOKEN }
  }));

  assert.equal(response.status, 200);
  assert.equal(localRevoked, 1);
  assert.deepEqual(await response.json(), { ok: true, endSessionUrl: null });
});

test("all four auth routes are explicitly mapped in Netlify redirects", () => {
  const source = readFileSync(resolve(process.cwd(), "../netlify.toml"), "utf8");
  for (const route of ["auth/sign-in", "auth/callback", "auth/session", "auth/logout"]) {
    assert.match(source, new RegExp(`from = "/api/${route}"`));
    assert.match(source, new RegExp(`to = "/\\.netlify/functions/auth-${route.split("/").at(-1)}"`));
  }
});
