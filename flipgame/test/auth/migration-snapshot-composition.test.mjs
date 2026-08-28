import test from "node:test";
import assert from "node:assert/strict";
import {
  assertProductionSnapshotBoundary,
  createNetlifyProductionSnapshotComposition,
  createNetlifyRuntimeSnapshotComposition
} from "../../scripts/auth-migration/snapshot.mjs";

const PRODUCTION_ENV = {
  AUTH_ENV_ID: "production",
  AUTH_EXPECTED_SITE_ID: "site-production",
  NETLIFY_SITE_ID: "site-production",
  SITE_ID: "site-production",
  CONTEXT: "production",
  URL: "https://shinegame.pro"
};

function approvedBoundary(overrides = {}) {
  return {
    confirmProductionRead: true,
    sourceFrozen: true,
    runtimeSiteId: "site-production",
    ...overrides,
    env: { ...PRODUCTION_ENV, ...overrides.env }
  };
}

test("production snapshot composition requires explicit read approval and a frozen legacy source before loading adapters", () => {
  let storeLoaded = false;
  let identityLoaded = false;
  const options = {
    env: PRODUCTION_ENV,
    getStore: () => {
      storeLoaded = true;
      return {};
    },
    identityAdmin: {
      listUsers: async () => {
        identityLoaded = true;
        return [];
      }
    }
  };

  assert.throws(
    () => createNetlifyProductionSnapshotComposition(options),
    (error) => error.message === "AUTH_MIGRATION_PRODUCTION_READ_CONFIRMATION_REQUIRED"
  );
  assert.equal(storeLoaded, false);
  assert.equal(identityLoaded, false);

  assert.throws(
    () => createNetlifyProductionSnapshotComposition({
      ...options,
      confirmProductionRead: true
    }),
    (error) => error.message === "AUTH_MIGRATION_SOURCE_FREEZE_REQUIRED"
  );
  assert.equal(storeLoaded, false);
  assert.equal(identityLoaded, false);
});

test("production snapshot boundary rejects non-production or mismatched site sentinels", () => {
  for (const [name, overrides, expected] of [
    ["environment", { env: { AUTH_ENV_ID: "local-test" } }, "AUTH_MIGRATION_PRODUCTION_REQUIRED"],
    ["missing site", { env: { NETLIFY_SITE_ID: undefined } }, "AUTH_MIGRATION_SITE_MISMATCH"],
    ["different sentinels", { env: { AUTH_EXPECTED_SITE_ID: "other-site" } }, "AUTH_MIGRATION_SITE_MISMATCH"],
    ["runtime site", { runtimeSiteId: "other-site" }, "AUTH_MIGRATION_SITE_MISMATCH"],
    ["non-production context", { env: { CONTEXT: "deploy-preview" } }, "AUTH_MIGRATION_PRODUCTION_CONTEXT_REQUIRED"],
    ["non-production context alias", { env: { CONTEXT: "", NETLIFY_CONTEXT: "deploy-preview" } }, "AUTH_MIGRATION_PRODUCTION_CONTEXT_REQUIRED"],
    ["non-production URL alias", { env: { URL: "", DEPLOY_PRIME_URL: "http://localhost:8888" } }, "AUTH_MIGRATION_PRODUCTION_CONTEXT_REQUIRED"],
    ["runtime site fallback", { runtimeSiteId: "", env: { SITE_ID: "other-site" } }, "AUTH_MIGRATION_SITE_MISMATCH"]
  ]) {
    assert.throws(
      () => assertProductionSnapshotBoundary(approvedBoundary(overrides)),
      (error) => error.message === expected,
      name
    );
  }

  const boundary = assertProductionSnapshotBoundary(approvedBoundary());
  assert.deepEqual(boundary, {
    environmentId: "production",
    siteId: "site-production",
    source: "netlify_identity"
  });
  assert.equal(Object.isFrozen(boundary), true);
});

test("production composition captures strong vip-users profiles and maps normalized Identity confirmation evidence", async () => {
  const storeCalls = [];
  const identityCalls = [];
  const profiles = new Map([
    ["users/legacy%40example.com.json", {
      email: "legacy@example.com",
      role: "vip",
      status: "approved",
      private_note: "synthetic-profile-secret-must-not-enter-snapshot"
    }],
    ["users/free%40example.com.json", { email: "free@example.com", role: "free", status: "approved" }]
  ]);
  const composition = createNetlifyProductionSnapshotComposition({
    ...approvedBoundary(),
    getStore(options) {
      storeCalls.push(options);
      return {
        async list(options) {
          storeCalls.push(options);
          return { blobs: [...profiles.keys()].map((key) => ({ key, etag: "redacted" })) };
        },
        async get(key, options) {
          storeCalls.push({ key, ...options });
          return profiles.get(key) ?? null;
        }
      };
    },
    identityAdmin: {
      async listUsers(options) {
        identityCalls.push(options);
        return [
          {
            id: "legacy-user-1",
            email: "legacy@example.com",
            confirmedAt: "2026-08-27T20:00:00.000Z",
            userMetadata: { full_name: "Legacy" },
            appMetadata: { provider: "email" },
            recovery_token: "synthetic-token-must-not-enter-snapshot"
          },
          {
            id: "legacy-user-2",
            email: "free@example.com",
            email_verified: false,
            confirmedAt: "2026-08-27T20:00:00.000Z"
          }
        ];
      }
    },
    identityPageSize: 100,
    identityMaxPages: 2
  });

  const snapshot = await composition.capture({
    migrationId: "migration-production-test",
    snapshotId: "snapshot-production-test",
    freezeAt: "2026-08-27T20:30:00.000Z",
    adminEmails: []
  });

  assert.deepEqual(storeCalls, [
    { name: "vip-users", consistency: "strong" },
    { prefix: "users/" },
    { key: "users/legacy%40example.com.json", type: "json" },
    { key: "users/free%40example.com.json", type: "json" }
  ]);
  assert.deepEqual(identityCalls, [{ page: 1, perPage: 100 }]);
  assert.deepEqual(snapshot.profiles, [
    { email: "free@example.com", role: "free", status: "approved", key: "users/free%40example.com.json" },
    { email: "legacy@example.com", role: "vip", status: "approved", key: "users/legacy%40example.com.json" }
  ]);
  assert.equal(Object.hasOwn(snapshot.profiles[1], "private_note"), false);
  const legacyIdentity = snapshot.identityUsers.find(({ id }) => id === "legacy-user-1");
  const freeIdentity = snapshot.identityUsers.find(({ id }) => id === "legacy-user-2");
  assert.equal(legacyIdentity.email_verified, true);
  assert.equal(legacyIdentity.confirmed_at, "2026-08-27T20:00:00.000Z");
  assert.equal(Object.hasOwn(legacyIdentity, "recovery_token"), false);
  assert.equal(Object.hasOwn(legacyIdentity, "userMetadata"), false);
  assert.equal(freeIdentity.email_verified, false);
  assert.equal(freeIdentity.confirmed_at, "2026-08-27T20:00:00.000Z");
  assert.deepEqual(snapshot.productionBoundary, {
    environmentId: "production",
    siteId: "site-production",
    source: "netlify_identity"
  });
});

test("production composition fails closed for malformed or disappearing profile blobs", async () => {
  const base = approvedBoundary();
  for (const [name, listing, getResult, expected] of [
    ["malformed listing", {}, {}, "MIGRATION_PROFILES_INVALID"],
    ["missing blob", { blobs: [{ key: "users/missing.json" }] }, null, "MIGRATION_PROFILE_RECORD_MISSING"],
    ["non-object blob", { blobs: [{ key: "users/text.json" }] }, "not-an-object", "MIGRATION_PROFILE_RECORD_INVALID"]
  ]) {
    const composition = createNetlifyProductionSnapshotComposition({
      ...base,
      getStore: () => ({
        async list() {
          return listing;
        },
        async get() {
          return getResult;
        }
      }),
      identityAdmin: { async listUsers() { return []; } }
    });
    await assert.rejects(
      () => composition.capture({
        migrationId: `migration-${name.replaceAll(" ", "-")}`,
        freezeAt: "2026-08-27T20:30:00.000Z"
      }),
      (error) => error.message === expected,
      name
    );
  }
});

test("runtime composition accepts injected Netlify modules without importing or exposing write APIs", async () => {
  let loaded = false;
  const composition = await createNetlifyRuntimeSnapshotComposition({
    ...approvedBoundary(),
    netlifyModules: {
      getStore: () => ({
        async list() { return { blobs: [] }; },
        async get() { return null; }
      }),
      admin: {
        async listUsers() { return []; },
        async deleteUser() { loaded = true; }
      }
    }
  });
  const snapshot = await composition.capture({
    migrationId: "migration-runtime-test",
    freezeAt: "2026-08-27T20:30:00.000Z"
  });
  assert.equal(snapshot.profiles.length, 0);
  assert.equal(snapshot.identityUsers.length, 0);
  assert.equal(loaded, false);
  assert.deepEqual(Object.keys(composition.readers).sort(), ["listIdentityUsers", "listProfiles"]);
});

test("runtime composition fails closed when a caller does not provide both read adapters", () => {
  assert.throws(
    () => createNetlifyRuntimeSnapshotComposition(approvedBoundary()),
    (error) => error.message === "MIGRATION_RUNTIME_ADAPTER_REQUIRED"
  );
});
