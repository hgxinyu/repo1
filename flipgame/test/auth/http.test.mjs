import test from "node:test";
import assert from "node:assert/strict";
import {
  safeNextPath,
  assertTrustedOrigin,
  assertPreauthState,
  authJson,
  clearCsrfCookie,
  clearPreauthCookie,
  csrfCookie,
  preauthCookie,
  sessionCookie,
  clearSessionCookie,
  PRIVATE_RESPONSE_HEADERS
} from "../../netlify/functions/_shared/auth/http.mjs";
import { authErrorResponse } from "../../netlify/functions/_shared/auth/runtime.mjs";

test("safeNextPath only accepts an allowlisted same-origin relative path", () => {
  assert.equal(safeNextPath("AIAsk.html"), "/AIAsk.html");
  assert.equal(safeNextPath("/AIAsk.html"), "/AIAsk.html");
  assert.throws(() => safeNextPath("//evil.example"), /INVALID_NEXT/);
  assert.throws(() => safeNextPath("https:%2f%2fevil.example"), /INVALID_NEXT/);
  assert.throws(() => safeNextPath("https://evil.example/AIAsk.html"), /INVALID_NEXT/);
  assert.throws(() => safeNextPath("/%5C%5Cevil.example"), /INVALID_NEXT/);
  assert.throws(() => safeNextPath("/AIAsk.html%0d%0aSet-Cookie:x"), /INVALID_NEXT/);
  assert.throws(() => safeNextPath("/not-allowlisted.html"), /INVALID_NEXT/);
});

test("safeNextPath accepts only an explicitly supplied allowlist extension", () => {
  assert.equal(
    safeNextPath("settings.html?tab=security", { allowedPaths: ["/settings.html"] }),
    "/settings.html?tab=security"
  );
  assert.throws(
    () => safeNextPath("other.html", { allowedPaths: ["/settings.html"] }),
    /INVALID_NEXT/
  );
});

test("assertTrustedOrigin fails closed for missing, null, and untrusted Origin", () => {
  const trustedOrigin = "https://stage.example.com";
  assert.equal(
    assertTrustedOrigin(
      { headers: { origin: trustedOrigin } },
      { trustedOrigin }
    ),
    trustedOrigin
  );
  for (const origin of [undefined, "null", "https://evil.example.com", `${trustedOrigin}, https://evil.example.com`]) {
    const headers = origin === undefined ? {} : { origin };
    assert.throws(
      () => assertTrustedOrigin({ headers }, { trustedOrigin }),
      /UNTRUSTED_ORIGIN/
    );
  }
});

test("session cookies use the exact Host-only secure attributes", () => {
  assert.equal(
    sessionCookie("opaque-token", 120),
    "__Host-shinegame_session=opaque-token; Path=/; Max-Age=120; Secure; HttpOnly; SameSite=Lax"
  );
  assert.equal(
    clearSessionCookie(),
    "__Host-shinegame_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax"
  );
  assert.deepEqual(PRIVATE_RESPONSE_HEADERS, {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Vary": "Cookie"
  });
});

test("preauth cookie is short-lived, Host-only, HttpOnly, and bound to the callback state", () => {
  const state = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.equal(
    preauthCookie(state),
    "__Host-shinegame_preauth=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax"
  );
  assert.equal(
    clearPreauthCookie(),
    "__Host-shinegame_preauth=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax"
  );
  assert.equal(
    assertPreauthState({ headers: { cookie: `__Host-shinegame_preauth=${state}` } }, state),
    true
  );
  assert.throws(
    () => assertPreauthState({ headers: { cookie: `__Host-shinegame_preauth=${state}` } }, "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
    /INVALID_PREAUTH/
  );
  assert.throws(
    () => assertPreauthState({ headers: {} }, state),
    /INVALID_PREAUTH/
  );
  assert.equal(csrfCookie(state, 600).startsWith("__Host-shinegame_csrf="), true);
  assert.match(clearCsrfCookie(), /^__Host-shinegame_csrf=;/);
});

test("authJson appends multiple Set-Cookie values instead of folding them into one cookie", () => {
  const response = authJson({ ok: true }, {
    headers: {
      "Set-Cookie": ["first=1; Path=/", "second=2; Path=/"]
    }
  });
  const cookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : (response.headers.get("set-cookie") || "").split(/, (?=[^;=]+=[^;]+)/u);
  assert.deepEqual(cookies, ["first=1; Path=/", "second=2; Path=/"]);
});

test("authErrorResponse exposes only the exact migration readiness code", () => {
  const json = (body, init) => ({ body, init });
  assert.deepEqual(
    authErrorResponse({ code: "MIGRATION_NOT_READY", status: 503 }, json),
    { body: { error: "MIGRATION_NOT_READY" }, init: { status: 503 } }
  );
  assert.deepEqual(
    authErrorResponse({ code: "MIGRATION_BATCH_CONFLICT", status: 503 }, json),
    { body: { error: "AUTH_UNAVAILABLE" }, init: { status: 503 } }
  );
  assert.deepEqual(
    authErrorResponse({ code: "MIGRATION_NOT_READY_SECRET", status: 503 }, json),
    { body: { error: "AUTH_UNAVAILABLE" }, init: { status: 503 } }
  );
});
