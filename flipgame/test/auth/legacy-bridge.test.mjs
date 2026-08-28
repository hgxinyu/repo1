import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createAuthLegacyBridgeHandler } from "../../netlify/functions/auth-legacy-bridge.mjs";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const MIGRATION_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const FAMILY_ID = "44444444-4444-4444-8444-444444444444";
const LEGACY_USER_ID = "legacy-user-immutable-1";
const OTHER_LEGACY_USER_ID = "legacy-user-attacker";
const LEGACY_SESSION = "legacy-session-cookie-value";
const STATE = Buffer.alloc(32, 0xa1).toString("base64url");
const TRANSACTION_CSRF = Buffer.alloc(32, 0xa2).toString("base64url");
const CSRF = Buffer.alloc(32, 0xa3).toString("base64url");
const SESSION_TOKEN = Buffer.alloc(32, 0xa4).toString("base64url");
const ORIGIN = "https://stage.example.com";
const NOW = new Date("2026-08-26T00:00:00.000Z");
const MIGRATION_WINDOW_ENDS_AT = new Date("2026-09-25T00:00:00.000Z");

const account = {
  accountId: ACCOUNT_ID,
  role: "vip",
  status: "active",
  authzVersion: 7,
  migrationId: MIGRATION_ID
};

function request(path = "/api/auth/legacy-bridge?next=/AIAsk.html", options = {}) {
  const headers = {
    origin: ORIGIN,
    cookie: `__Host-shinegame_csrf=${CSRF}; nf_jwt=${LEGACY_SESSION}`,
    "x-csrf-token": CSRF,
    ...(options.headers || {})
  };
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.csrfHeader !== undefined) headers["x-csrf-token"] = options.csrfHeader;
  return new Request(`${ORIGIN}${path}`, {
    method: options.method || "POST",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
}

function bridgeTransaction(overrides = {}) {
  return {
    transactionId: "tx-bridge",
    state: STATE,
    csrfToken: TRANSACTION_CSRF,
    nextPath: "/AIAsk.html",
    accountId: ACCOUNT_ID,
    migrationId: MIGRATION_ID,
    ...overrides
  };
}

function session(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    sessionFamilyId: FAMILY_ID,
    sessionToken: SESSION_TOKEN,
    authSource: "legacy_bridge",
    accountId: ACCOUNT_ID,
    legacyNetlifyUserId: LEGACY_USER_ID,
    migrationId: MIGRATION_ID,
    authzVersion: 7,
    idleExpiresAt: new Date("2026-09-09T00:00:00.000Z"),
    absoluteExpiresAt: MIGRATION_WINDOW_ENDS_AT,
    ...overrides
  };
}

function makeDeps(overrides = {}) {
  const calls = [];
  const { sessionRepository: sessionOverrides = {}, ...otherOverrides } = overrides;
  const sessionRepository = {
    async createBridgeTransaction(input) {
      calls.push(["create-transaction", input]);
      return bridgeTransaction();
    },
    async consumeBridgeTransaction(input) {
      calls.push(["consume-transaction", input]);
      return {
        transactionId: "tx-bridge",
        nextPath: "/AIAsk.html",
        accountId: ACCOUNT_ID,
        migrationId: MIGRATION_ID
      };
    },
    async createAppSession(input) {
      calls.push(["create-session", input]);
      return session();
    },
    ...sessionOverrides
  };
  if (typeof sessionOverrides.consumeBridgeAndCreateAppSession !== "function") {
    sessionRepository.consumeBridgeAndCreateAppSession = async (input) => {
      const consumed = await sessionRepository.consumeBridgeTransaction({
        state: input.state,
        legacySessionId: input.legacySessionId,
        csrfToken: input.csrfToken
      });
      const createdSession = await sessionRepository.createAppSession(input.sessionInput);
      return { consumed, session: createdSession };
    };
  }
  const deps = {
    now: () => NOW,
    trustedOrigin: ORIGIN,
    migrationWindowEndsAt: MIGRATION_WINDOW_ENDS_AT,
    legacySessionVerifier: async () => {
      calls.push(["verify"]);
      return {
        id: LEGACY_USER_ID,
        email: "attacker-controlled@example.com",
        expiresAt: new Date("2026-08-27T00:00:00.000Z")
      };
    },
    accountRepository: {
      async findAccountByLegacyUserId(id) {
        calls.push(["lookup", id]);
        return account;
      }
    },
    sessionRepository,
    ...otherOverrides
  };
  return { deps, calls };
}

function responseCookies(response) {
  return response.headers.getSetCookie?.() || [response.headers.get("set-cookie") || ""];
}

test("valid immutable Netlify user ID bridges to a window-limited first-party session", async () => {
  const { deps, calls } = makeDeps();
  const response = await createAuthLegacyBridgeHandler(deps)(request());

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/AIAsk.html");
  assert.deepEqual(calls.map(([name]) => name), [
    "verify",
    "lookup",
    "create-transaction",
    "consume-transaction",
    "create-session"
  ]);
  assert.equal(calls[1][1], LEGACY_USER_ID);
  assert.deepEqual(calls[2][1], {
    legacySessionId: LEGACY_SESSION,
    accountId: ACCOUNT_ID,
    migrationId: MIGRATION_ID,
    nextPath: "/AIAsk.html"
  });
  assert.deepEqual(calls[3][1], {
    state: STATE,
    legacySessionId: LEGACY_SESSION,
    csrfToken: TRANSACTION_CSRF
  });
  assert.equal(calls[4][1].authSource, "legacy_bridge");
  assert.equal(calls[4][1].accountId, ACCOUNT_ID);
  assert.equal(calls[4][1].legacyNetlifyUserId, LEGACY_USER_ID);
  assert.equal(calls[4][1].migrationId, MIGRATION_ID);
  assert.equal(calls[4][1].migrationWindowEndsAt.getTime(), MIGRATION_WINDOW_ENDS_AT.getTime());
  assert.equal("refreshToken" in calls[4][1], false);
  assert.equal("logtoSubject" in calls[4][1], false);

  const cookies = responseCookies(response).join("\n");
  assert.match(cookies, /__Host-shinegame_session=/);
  assert.match(cookies, /__Host-shinegame_csrf=/);
  assert.match(cookies, /(?:^|\n)nf_jwt=;[^\n]*Max-Age=0/);
  assert.match(cookies, /(?:^|\n)nf_refresh=;[^\n]*Max-Age=0/);
  assert.match(cookies, /(?:^|\n)gotrue\.user=;[^\n]*Max-Age=0/);
});

test("default legacy verification calls the trusted Identity user endpoint with the request cookie", async () => {
  let observed;
  const { deps } = makeDeps({
    legacySessionVerifier: undefined,
    legacyIdentityUserUrl: "https://identity.stage.example.com/.netlify/identity/user",
    legacyIdentityFetch: async (url, options) => {
      observed = { url, options };
      return new Response(JSON.stringify({ id: LEGACY_USER_ID }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const response = await createAuthLegacyBridgeHandler(deps)(request());

  assert.equal(response.status, 302);
  assert.equal(observed.url, "https://identity.stage.example.com/.netlify/identity/user");
  assert.equal(observed.options.method, "GET");
  assert.equal(observed.options.redirect, "error");
  assert.equal(observed.options.headers.Authorization, `Bearer ${LEGACY_SESSION}`);
  assert.equal(observed.options.headers.Accept, "application/json");
});

test("bridge uses the atomic consume-and-issue repository boundary", async () => {
  let atomicInput;
  const { deps } = makeDeps({
    sessionRepository: {
      async createBridgeTransaction() {
        return bridgeTransaction();
      },
      async consumeBridgeAndCreateAppSession(input) {
        atomicInput = input;
        return {
          consumed: {
            transactionId: "tx-bridge",
            nextPath: "/AIAsk.html",
            accountId: ACCOUNT_ID,
            migrationId: MIGRATION_ID
          },
          session: session()
        };
      }
    }
  });

  const response = await createAuthLegacyBridgeHandler(deps)(request());

  assert.equal(response.status, 302);
  assert.equal(atomicInput.state, STATE);
  assert.equal(atomicInput.legacySessionId, LEGACY_SESSION);
  assert.equal(atomicInput.csrfToken, TRANSACTION_CSRF);
  assert.equal(atomicInput.sessionInput.authSource, "legacy_bridge");
  assert.equal(atomicInput.sessionInput.accountId, ACCOUNT_ID);
  assert.equal(atomicInput.sessionInput.legacyNetlifyUserId, LEGACY_USER_ID);
});

test("bridge returns a real no-content response for JSON fetch clients", async () => {
  const { deps } = makeDeps();
  const response = await createAuthLegacyBridgeHandler(deps)(request(
    "/api/auth/legacy-bridge?next=/AIAsk.html",
    { headers: { accept: "application/json" } }
  ));

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.getSetCookie().join("\n"), /__Host-shinegame_session=/);
  assert.equal(await response.text(), "");
});

test("bridge verifies the server-side legacy session and rejects an invalid or expired session", async () => {
  for (const legacyUser of [null, { id: LEGACY_USER_ID, expiresAt: NOW }]) {
    let lookups = 0;
    const { deps } = makeDeps({
      legacySessionVerifier: async () => legacyUser,
      accountRepository: {
        async findAccountByLegacyUserId() {
          lookups += 1;
          return account;
        }
      }
    });
    const response = await createAuthLegacyBridgeHandler(deps)(request());
    assert.equal(response.status, 401);
    assert.equal(lookups, 0);
  }
});

test("bridge rejects an explicitly invalid server verification result", async () => {
  let lookups = 0;
  const { deps } = makeDeps({
    legacySessionVerifier: async () => ({
      valid: false,
      user: { id: LEGACY_USER_ID, expiresAt: new Date("2026-08-27T00:00:00.000Z") }
    }),
    accountRepository: {
      async findAccountByLegacyUserId() {
        lookups += 1;
        return account;
      }
    }
  });
  const response = await createAuthLegacyBridgeHandler(deps)(request());
  assert.equal(response.status, 401);
  assert.equal(lookups, 0);
});

test("bridge treats a future numeric-string expiry claim as a timestamp", async () => {
  let lookups = 0;
  const { deps } = makeDeps({
    legacySessionVerifier: async () => ({
      id: LEGACY_USER_ID,
      exp: String(Math.floor(new Date("2026-08-27T00:00:00.000Z").getTime() / 1000))
    }),
    accountRepository: {
      async findAccountByLegacyUserId() {
        lookups += 1;
        return account;
      }
    }
  });
  const response = await createAuthLegacyBridgeHandler(deps)(request());
  assert.equal(response.status, 302);
  assert.equal(lookups, 1);
});

test("bridge rejects an email-only legacy session without performing an email fallback lookup", async () => {
  let lookedUp = false;
  const { deps } = makeDeps({
    legacySessionVerifier: async () => ({ email: "user@example.com" }),
    accountRepository: {
      async findAccountByLegacyUserId() {
        lookedUp = true;
        return account;
      }
    }
  });
  const response = await createAuthLegacyBridgeHandler(deps)(request("/api/auth/legacy-bridge", {
    body: { email: "user@example.com", legacyUserId: LEGACY_USER_ID }
  }));
  assert.equal(response.status, 401);
  assert.equal(lookedUp, false);
});

test("bridge rejects missing, mismatched, and cross-origin CSRF before reading the legacy session", async () => {
  for (const options of [
    { csrfHeader: "" },
    { cookie: `nf_jwt=${LEGACY_SESSION}`, csrfHeader: CSRF },
    { headers: { origin: "https://evil.example.com" } }
  ]) {
    let verified = 0;
    const { deps } = makeDeps({
      legacySessionVerifier: async () => {
        verified += 1;
        return { id: LEGACY_USER_ID };
      }
    });
    const response = await createAuthLegacyBridgeHandler(deps)(request(undefined, options));
    assert.equal(response.status, 403);
    assert.equal(verified, 0);
  }
});

test("bridge rejects a missing migration mapping and never creates a session", async () => {
  let created = 0;
  const { deps } = makeDeps({
    accountRepository: { async findAccountByLegacyUserId() { return null; } },
    sessionRepository: {
      async createBridgeTransaction() { created += 1; return bridgeTransaction(); },
      async consumeBridgeTransaction() { created += 1; return {}; },
      async createAppSession() { created += 1; return session(); }
    }
  });
  const response = await createAuthLegacyBridgeHandler(deps)(request());
  assert.equal(response.status, 401);
  assert.equal(created, 0);
});

test("bridge requires the default account migration record contract before creating a transaction", async () => {
  let migrationLookups = 0;
  let transactions = 0;
  const { deps } = makeDeps({
    accountRepository: {
      async findAccountByLegacyUserId() {
        return account;
      },
      async findMigrationRecordByLegacyUserId() {
        migrationLookups += 1;
        return null;
      }
    },
    sessionRepository: {
      async createBridgeTransaction() {
        transactions += 1;
        return bridgeTransaction();
      }
    }
  });

  const response = await createAuthLegacyBridgeHandler(deps)(request());

  assert.equal(response.status, 401);
  assert.equal(migrationLookups, 1);
  assert.equal(transactions, 0);
});

test("bridge rejects a migration record that is not imported or reconciled", async () => {
  let created = 0;
  const { deps } = makeDeps({
    findMigrationRecord: async () => ({
      migrationId: MIGRATION_ID,
      legacyNetlifyUserId: LEGACY_USER_ID,
      status: "pending",
      migrationWindowEndsAt: MIGRATION_WINDOW_ENDS_AT
    }),
    sessionRepository: {
      async createBridgeTransaction() {
        created += 1;
        return bridgeTransaction();
      }
    }
  });
  const response = await createAuthLegacyBridgeHandler(deps)(request());
  assert.equal(response.status, 401);
  assert.equal(created, 0);
});

test("bridge ignores client identity fields and maps only the verified immutable ID", async () => {
  let lookedUpId;
  const { deps } = makeDeps({
    accountRepository: {
      async findAccountByLegacyUserId(id) {
        lookedUpId = id;
        return account;
      }
    }
  });
  const response = await createAuthLegacyBridgeHandler(deps)(request("/api/auth/legacy-bridge", {
    body: { email: "attacker@example.com", legacyUserId: OTHER_LEGACY_USER_ID }
  }));
  assert.equal(response.status, 302);
  assert.equal(lookedUpId, LEGACY_USER_ID);
});

test("bridge fails closed on a wrong environment mapping", async () => {
  const { deps } = makeDeps({
    environmentId: "stage",
    accountRepository: {
      async findAccountByLegacyUserId() {
        return { ...account, environmentId: "production" };
      }
    }
  });
  const response = await createAuthLegacyBridgeHandler(deps)(request());
  assert.equal(response.status, 401);
});

test("bridge fails closed when the created session reports a different environment", async () => {
  const { deps } = makeDeps({
    environmentId: "stage",
    sessionRepository: {
      async createBridgeTransaction() { return bridgeTransaction(); },
      async consumeBridgeTransaction() { return bridgeTransaction(); },
      async createAppSession() {
        return session({ environmentId: "production" });
      }
    }
  });
  const response = await createAuthLegacyBridgeHandler(deps)(request());
  assert.equal(response.status, 401);
});

test("bridge replay denial does not issue a second first-party session", async () => {
  const consumedLegacySessions = new Set();
  let sessions = 0;
  const { deps } = makeDeps({
    sessionRepository: {
      async consumeBridgeAndCreateAppSession(input) {
        if (consumedLegacySessions.has(input.legacySessionId)) {
          const replay = new Error("TRANSACTION_REPLAY");
          replay.code = "TRANSACTION_REPLAY";
          replay.status = 401;
          throw replay;
        }
        consumedLegacySessions.add(input.legacySessionId);
        sessions += 1;
        return {
          consumed: {
            transactionId: "tx-bridge",
            nextPath: "/AIAsk.html",
            accountId: ACCOUNT_ID,
            migrationId: MIGRATION_ID
          },
          session: session()
        };
      }
    }
  });
  const handler = createAuthLegacyBridgeHandler(deps);
  const firstResponse = await handler(request());
  const replayResponse = await handler(request());
  assert.equal(firstResponse.status, 302);
  assert.equal(replayResponse.status, 401);
  assert.equal(consumedLegacySessions.size, 1);
  assert.equal(sessions, 1);
});

test("bridge rejects a malicious next path before verifying or creating a transaction", async () => {
  let calls = 0;
  const { deps } = makeDeps({
    legacySessionVerifier: async () => {
      calls += 1;
      return { id: LEGACY_USER_ID };
    },
    sessionRepository: {
      async createBridgeTransaction() {
        calls += 1;
        return bridgeTransaction();
      }
    }
  });
  const response = await createAuthLegacyBridgeHandler(deps)(request(
    "/api/auth/legacy-bridge?next=https%3A%2F%2Fevil.example.com"
  ));
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test("bridge refuses a migration window that is already expired", async () => {
  let created = 0;
  const { deps } = makeDeps({
    migrationWindowEndsAt: new Date("2026-08-25T23:59:59.000Z"),
    sessionRepository: {
      async createBridgeTransaction() {
        created += 1;
        return bridgeTransaction();
      }
    }
  });
  const response = await createAuthLegacyBridgeHandler(deps)(request());
  assert.equal(response.status, 401);
  assert.equal(created, 0);
});

test("bridge never accepts a session expiry beyond the migration window", async () => {
  const { deps } = makeDeps({
    sessionRepository: {
      async createBridgeTransaction() { return bridgeTransaction(); },
      async consumeBridgeTransaction() { return bridgeTransaction(); },
      async createAppSession() {
        return session({
          absoluteExpiresAt: new Date("2026-10-01T00:00:00.000Z")
        });
      }
    }
  });
  const response = await createAuthLegacyBridgeHandler(deps)(request());
  assert.equal(response.status, 503);
});

test("bridge rejects any created session that carries an encrypted refresh token", async () => {
  const { deps } = makeDeps({
    sessionRepository: {
      async createBridgeTransaction() { return bridgeTransaction(); },
      async consumeBridgeTransaction() { return bridgeTransaction(); },
      async createAppSession() {
        return session({ encryptedRefreshToken: Buffer.from("must-not-exist") });
      }
    }
  });
  const response = await createAuthLegacyBridgeHandler(deps)(request());
  assert.equal(response.status, 503);
});

test("bridge rejects a created session whose source subject is not the verified legacy ID", async () => {
  const { deps } = makeDeps({
    sessionRepository: {
      async createBridgeTransaction() { return bridgeTransaction(); },
      async consumeBridgeTransaction() { return bridgeTransaction(); },
      async createAppSession() {
        return session({ legacyNetlifyUserId: OTHER_LEGACY_USER_ID });
      }
    }
  });
  const response = await createAuthLegacyBridgeHandler(deps)(request());
  assert.equal(response.status, 503);
});

test("bridge rejects an immutable legacy ID that cannot fit the first-party session column", async () => {
  const oversizedId = "x".repeat(256);
  let lookups = 0;
  const { deps } = makeDeps({
    legacySessionVerifier: async () => ({ id: oversizedId }),
    accountRepository: {
      async findAccountByLegacyUserId() {
        lookups += 1;
        return account;
      }
    }
  });
  const response = await createAuthLegacyBridgeHandler(deps)(request());
  assert.equal(response.status, 401);
  assert.equal(lookups, 0);
});

test("auth-session no longer contains a client-side access or refresh token copy path", () => {
  const source = readFileSync(resolve("assets/auth-session.js"), "utf8");
  assert.doesNotMatch(source, /access_token|refresh_token/);
  assert.doesNotMatch(source, /document\.cookie\s*=\s*`(?:\$\{)?(?:nf_jwt|nf_refresh)/);
});
