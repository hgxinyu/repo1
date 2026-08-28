import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizedExportToken,
  createMigrationExportHandler,
  listIdentityUsers,
  normalizeIdentityExportUser
} from "../netlify/functions/auth-migration-export.mjs";

const SITE_ID = "34bfd812-74b4-4f9c-ac20-97ab0cefe996";
const TOKEN = "a".repeat(64);

function request({ method = "GET", token = TOKEN } = {}) {
  return new Request("https://shinegame.pro/api/auth-migration-export", {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
}

function environment(overrides = {}) {
  const values = {
    AUTH_ENV_ID: "production",
    MIGRATION_WRITE_MODE: "frozen",
    AUTH_EXPECTED_SITE_ID: SITE_ID,
    NETLIFY_SITE_ID: SITE_ID,
    AUTH_MIGRATION_EXPORT_TOKEN: TOKEN,
    ...overrides
  };
  return (name) => values[name] || "";
}

test("migration export token requires an exact long bearer token", () => {
  const token = "a".repeat(64);
  assert.equal(authorizedExportToken(`Bearer ${token}`, token), true);
  assert.equal(authorizedExportToken(`Bearer ${"b".repeat(64)}`, token), false);
  assert.equal(authorizedExportToken("", token), false);
  assert.equal(authorizedExportToken("Bearer short", "short"), false);
});

test("migration export whitelists identity fields and derives verification", () => {
  assert.deepEqual(normalizeIdentityExportUser({
    id: "synthetic-id",
    email: "USER@EXAMPLE.INVALID",
    confirmed_at: "2026-01-01T00:00:00.000Z",
    token: "must-not-escape",
    app_metadata: { roles: ["admin"] }
  }), {
    id: "synthetic-id",
    email: "user@example.invalid",
    email_verified: true,
    confirmed_at: "2026-01-01T00:00:00.000Z"
  });
  assert.deepEqual(normalizeIdentityExportUser({ id: "id", user_metadata: { email: "mutable@example.invalid" } }), {
    id: "id",
    email: "",
    email_verified: false,
    confirmed_at: null
  });
});

test("migration export paginates and rejects duplicate or malformed users", async () => {
  const pages = [
    Array.from({ length: 100 }, (_, index) => ({ id: `id-${index}`, email: `u${index}@example.invalid` })),
    [{ id: "id-100", email: "u100@example.invalid", email_verified: true }]
  ];
  const calls = [];
  const rows = await listIdentityUsers({
    async listUsers(options) {
      calls.push(options);
      return pages.shift();
    }
  });
  assert.equal(rows.length, 101);
  assert.deepEqual(calls, [{ page: 1, perPage: 100 }, { page: 2, perPage: 100 }]);

  await assert.rejects(
    () => listIdentityUsers({ listUsers: async () => [{ id: "same", email: "one@example.invalid" }, { id: "same", email: "two@example.invalid" }] }),
    /IDENTITY_USER_DUPLICATE/u
  );
  await assert.rejects(
    () => listIdentityUsers({ listUsers: async () => [{ id: "id", user_metadata: { email: "mutable@example.invalid" } }] }),
    /IDENTITY_USER_INVALID/u
  );
});

test("handler requires every production freeze gate and disables caching on all responses", async () => {
  const admin = { listUsers: async () => [] };
  for (const [name, value] of [
    ["AUTH_ENV_ID", "local-test"],
    ["MIGRATION_WRITE_MODE", "account"],
    ["AUTH_EXPECTED_SITE_ID", "wrong-site"],
    ["NETLIFY_SITE_ID", "wrong-site"]
  ]) {
    const response = await createMigrationExportHandler({ identityAdminClient: admin, envReader: environment({ [name]: value }) })(request());
    assert.equal(response.status, 404, name);
    assert.match(response.headers.get("cache-control"), /no-store/u);
  }

  const unauthorized = await createMigrationExportHandler({ identityAdminClient: admin, envReader: environment() })(request({ token: "b".repeat(64) }));
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("cache-control"), /no-store/u);

  const method = await createMigrationExportHandler({ identityAdminClient: admin, envReader: environment() })(request({ method: "POST" }));
  assert.equal(method.status, 405);
  assert.match(method.headers.get("cache-control"), /no-store/u);
});

test("handler returns a redacted no-store 503 for provider failure", async () => {
  const handler = createMigrationExportHandler({
    identityAdminClient: { listUsers: async () => { throw new Error("provider secret details"); } },
    envReader: environment()
  });
  const response = await handler(request());
  assert.equal(response.status, 503);
  assert.match(response.headers.get("cache-control"), /no-store/u);
  const body = await response.json();
  assert.deepEqual(body, { error: "Identity export temporarily unavailable" });
  assert.doesNotMatch(JSON.stringify(body), /provider secret details/u);
});
