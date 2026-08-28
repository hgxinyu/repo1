import test from "node:test";
import assert from "node:assert/strict";
import { assertAuthEnvironment, canonicalIssuer } from "../../netlify/functions/_shared/auth/config.mjs";

function validEnvironment(overrides = {}) {
  return {
    AUTH_ENV_ID: "stage",
    AUTH_EXPECTED_SITE_ID: "site-stage",
    NETLIFY_SITE_ID: "site-stage",
    AUTH_DATABASE_URL: "postgresql://localhost/auth_stage",
    LOGTO_ENDPOINT: "https://stage.logto.app",
    LOGTO_APP_ID: "app-stage",
    ...overrides
  };
}

test("accepts a complete matching auth environment and returns a frozen identity", () => {
  const identity = assertAuthEnvironment(validEnvironment());

  assert.deepEqual(identity, { environmentId: "stage", siteId: "site-stage" });
  assert.equal(Object.isFrozen(identity), true);
});

test("rejects a tenant/site/database mismatch", () => {
  assert.throws(() => assertAuthEnvironment({
    AUTH_ENV_ID: "stage",
    AUTH_EXPECTED_SITE_ID: "site-stage",
    NETLIFY_SITE_ID: "site-production",
    LOGTO_ENDPOINT: "https://prod.logto.app"
  }), /AUTH_ENV_MISMATCH/);
});

test("rejects every missing required auth setting with its setting name", () => {
  const names = [
    "AUTH_ENV_ID",
    "AUTH_EXPECTED_SITE_ID",
    "NETLIFY_SITE_ID",
    "AUTH_DATABASE_URL",
    "LOGTO_ENDPOINT",
    "LOGTO_APP_ID"
  ];

  for (const name of names) {
    assert.throws(
      () => assertAuthEnvironment(validEnvironment({ [name]: "  " })),
      new RegExp(`AUTH_CONFIG_MISSING:${name}`)
    );
  }
});

test("rejects the legacy generic database URL as the auth database boundary", () => {
  const environment = validEnvironment();
  delete environment.AUTH_DATABASE_URL;
  environment.NETLIFY_DB_URL = "postgresql://localhost/netlify_managed";
  assert.throws(
    () => assertAuthEnvironment(environment),
    /AUTH_CONFIG_MISSING:AUTH_DATABASE_URL/
  );
});

test("rejects malformed or non-Logto endpoints before database use", () => {
  assert.throws(
    () => assertAuthEnvironment(validEnvironment({ LOGTO_ENDPOINT: "not-a-url" })),
    /AUTH_ENV_MISMATCH:LOGTO/
  );
  assert.throws(
    () => assertAuthEnvironment(validEnvironment({ LOGTO_ENDPOINT: "https://accounts.example.com" })),
    /AUTH_ENV_MISMATCH:LOGTO/
  );
});

test("canonicalIssuer normalizes URL-based tenant identifiers to URL.href", () => {
  assert.equal(canonicalIssuer("https://stage.logto.app"), "https://stage.logto.app/");
  assert.equal(canonicalIssuer("https://stage.logto.app/"), "https://stage.logto.app/");
  assert.equal(canonicalIssuer("tenant-dev"), "tenant-dev");
});
