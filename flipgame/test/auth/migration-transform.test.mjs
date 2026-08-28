import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveAccountId,
  stableStringify,
  transformLegacySnapshot
} from "../../scripts/auth-migration/transform.mjs";
import {
  assertLegacyWriteAllowed,
  getMigrationWriteMode
} from "../../netlify/functions/_shared/migration-write-gate.mjs";
import { capabilitiesForAccount } from "../../netlify/functions/_shared/auth/capabilities.mjs";

const migrationId = "migration-task-7";

function identity(id, email, overrides = {}) {
  return {
    id,
    email,
    email_verified: true,
    confirmed_at: "2026-08-25T00:00:00.000Z",
    ...overrides
  };
}

function profile(email, role, overrides = {}) {
  return {
    email,
    role,
    status: role === "blocked" ? "blocked" : "approved",
    guild: "Shine",
    gameName: `${role} player`,
    createdAt: "2026-08-20T00:00:00.000Z",
    ...overrides
  };
}

function fixture(overrides = {}) {
  return {
    snapshotId: "snapshot-task-7",
    migrationId,
    freezeAt: "2026-08-25T01:00:00.000Z",
    adminEmails: ["admin@example.com", "blocked-admin@example.com"],
    profiles: [
      profile("pending@example.com", "pending"),
      profile("free@example.com", "free"),
      profile("vip@example.com", "vip"),
      profile("admin@example.com", "admin"),
      profile("blocked@example.com", "blocked"),
      profile("unknown-confirmation@example.com", "free"),
      profile("profile-only@example.com", "free"),
      profile("missing-id@example.com", "free"),
      profile("Admin-Mismatch@example.com", "admin"),
      profile("blocked-admin@example.com", "admin", { status: "blocked" }),
      profile("Duplicate@example.com", "free"),
      profile("duplicate@example.com", "vip")
    ],
    identityUsers: [
      identity("legacy-pending", "pending@example.com"),
      identity("legacy-free", "free@example.com"),
      identity("legacy-vip", "vip@example.com"),
      identity("legacy-admin", "admin@example.com"),
      identity("legacy-blocked", "blocked@example.com"),
      identity("legacy-unknown", "unknown-confirmation@example.com", {
        email_verified: undefined,
        confirmed_at: undefined
      }),
      identity("legacy-missing-id", "missing-id@example.com", { id: "" }),
      identity("legacy-admin-mismatch", "Admin-Mismatch@example.com"),
      identity("legacy-blocked-admin", "blocked-admin@example.com"),
      identity("legacy-duplicate-one", "Duplicate@example.com"),
      identity("legacy-duplicate-two", "duplicate@example.com"),
      identity("legacy-orphan", "identity-only@example.com")
    ],
    ...overrides
  };
}

test("transform preserves every role, joins immutable identities, and emits the fixed report schema", () => {
  const report = transformLegacySnapshot(fixture());

  assert.deepEqual(Object.keys(report), [
    "snapshotId",
    "snapshotHash",
    "sourceCounts",
    "roleCounts",
    "importable",
    "conflicts",
    "warnings"
  ]);
  assert.equal(report.snapshotId, "snapshot-task-7");
  assert.match(report.snapshotHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(report.sourceCounts, { profiles: 12, identityUsers: 12 });

  const importedRoles = new Set(report.importable.map((row) => row.role));
  assert.deepEqual(importedRoles, new Set(["pending", "free", "vip", "admin", "blocked"]));
  assert.equal(report.roleCounts.pending, 1);
  assert.equal(report.roleCounts.vip, 1);
  assert.equal(report.roleCounts.admin, 2);
  assert.equal(report.roleCounts.blocked, 1);
  assert.equal(report.importable.find((row) => row.source_user_id === "legacy-admin").account_id,
    deriveAccountId(migrationId, "legacy-admin"));
  assert.equal(report.importable.find((row) => row.source_user_id === "legacy-blocked-admin").role, "admin");
  const blockedAdmin = report.importable.find((row) => row.source_user_id === "legacy-blocked-admin");
  assert.equal(blockedAdmin.status, "blocked");
  assert.equal(capabilitiesForAccount(blockedAdmin).isAdmin, false);
  assert.equal(capabilitiesForAccount(blockedAdmin).canAccessPremium, false);
});

test("transform isolates profile-only, identity-only, missing-id, duplicate-email, and admin mismatch records", () => {
  const report = transformLegacySnapshot(fixture());
  const codes = new Set(report.conflicts.map((entry) => entry.code));

  assert.ok(codes.has("PROFILE_WITHOUT_IDENTITY"));
  assert.ok(codes.has("IDENTITY_WITHOUT_PROFILE"));
  assert.ok(codes.has("MISSING_IMMUTABLE_USER_ID"));
  assert.ok(codes.has("DUPLICATE_NORMALIZED_EMAIL"));
  assert.ok(codes.has("ADMIN_EMAIL_MISMATCH"));
  assert.equal(report.importable.some((row) => row.normalized_email === "admin-mismatch@example.com"), false);
  assert.equal(report.importable.some((row) => row.normalized_email === "duplicate@example.com"), false);
});

test("missing confirmation evidence is a conflict and is never importable", () => {
  const report = transformLegacySnapshot(fixture());
  assert.equal(report.importable.some((entry) => entry.source_user_id === "legacy-unknown"), false);
  assert.ok(report.conflicts.some((entry) =>
    entry.code === "EMAIL_NOT_VERIFIED" && entry.source_user_id === "legacy-unknown"));
});

test("false, null, and missing email_verified values all fail closed", () => {
  for (const [name, overrides] of [
    ["false", { email_verified: false, confirmed_at: undefined }],
    ["false-with-timestamp", { email_verified: false, confirmed_at: "2026-08-25T00:00:00.000Z" }],
    ["null", { email_verified: null, confirmed_at: undefined }],
    ["missing", { email_verified: undefined, confirmed_at: undefined }]
  ]) {
    const report = transformLegacySnapshot({
      snapshotId: `snapshot-unverified-${name}`,
      migrationId: `migration-unverified-${name}`,
      freezeAt: "2026-08-25T01:00:00.000Z",
      profiles: [profile(`${name}@example.com`, "free")],
      identityUsers: [identity(`legacy-${name}`, `${name}@example.com`, overrides)]
    });
    assert.equal(report.importable.length, 0, name);
    assert.ok(report.conflicts.some((entry) => entry.code === "EMAIL_NOT_VERIFIED"), name);
  }
});

test("transform and report ordering are deterministic and account IDs do not derive from email", () => {
  const first = transformLegacySnapshot(fixture());
  const second = transformLegacySnapshot(fixture({
    profiles: [...fixture().profiles].reverse(),
    identityUsers: [...fixture().identityUsers].reverse()
  }));
  assert.equal(stableStringify(first), stableStringify(second));

  const firstId = deriveAccountId(migrationId, "immutable-one");
  const secondId = deriveAccountId(migrationId, "immutable-two");
  const differentMigrationId = deriveAccountId("other-migration", "immutable-one");
  assert.match(firstId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.notEqual(firstId, secondId);
  assert.notEqual(firstId, differentMigrationId);
});

test("migration write mode must be explicit and legacy Blob writes fail closed in frozen/account modes", () => {
  assert.throws(
    () => getMigrationWriteMode({}),
    (error) => error.code === "AUTH_MIGRATION_MODE_INVALID"
  );
  assert.equal(getMigrationWriteMode({ MIGRATION_WRITE_MODE: "legacy" }), "legacy");
  assert.doesNotThrow(() => assertLegacyWriteAllowed("vip-request", {
    MIGRATION_WRITE_MODE: "legacy"
  }));
  assert.throws(
    () => assertLegacyWriteAllowed("vip-request", { MIGRATION_WRITE_MODE: "frozen" }),
    (error) => error.code === "AUTH_MIGRATION_FROZEN" && error.status === 503 && error.operation === "vip-request"
  );
  assert.throws(
    () => assertLegacyWriteAllowed("admin-role", { MIGRATION_WRITE_MODE: "account" }),
    (error) => error.code === "AUTH_MIGRATION_ACCOUNT_MODE" && error.status === 503
  );
});

test("transform fails closed for missing or unknown roles and unsafe status values", () => {
  const source = {
    snapshotId: "snapshot-role-safety",
    migrationId: "migration-role-safety",
    freezeAt: "2026-08-25T01:00:00.000Z",
    adminEmails: [],
    profiles: [
      { email: "missing-role@example.com", status: "pending" },
      { email: "unknown-role@example.com", role: "superuser", status: "approved" },
      { email: "vip-pending@example.com", role: "vip", status: "pending" },
      { email: "admin-garbage@example.com", role: "admin", status: "garbage" },
      { email: "free-garbage@example.com", role: "free", status: "garbage" },
      { email: "pending-safe@example.com", role: "pending", status: "pending" },
      { email: "free-safe@example.com", role: "free", status: "approved" },
      { email: "free-defaulted@example.com", role: "free" }
    ],
    identityUsers: [
      identity("missing-role", "missing-role@example.com", { email_verified: false, confirmed_at: undefined }),
      identity("unknown-role", "unknown-role@example.com", { email_verified: false, confirmed_at: undefined }),
      identity("vip-pending", "vip-pending@example.com", { email_verified: false, confirmed_at: undefined }),
      identity("admin-garbage", "admin-garbage@example.com", { email_verified: false, confirmed_at: undefined }),
      identity("free-garbage", "free-garbage@example.com", { email_verified: false, confirmed_at: undefined }),
      identity("pending-safe", "pending-safe@example.com"),
      identity("free-safe", "free-safe@example.com"),
      identity("free-defaulted", "free-defaulted@example.com")
    ]
  };

  const report = transformLegacySnapshot(source);
  const imported = new Set(report.importable.map((row) => row.source_user_id));
  assert.deepEqual(imported, new Set(["pending-safe", "free-safe", "free-defaulted"]));
  assert.equal(report.importable.find((row) => row.source_user_id === "pending-safe").status, "active");
  assert.equal(report.importable.find((row) => row.source_user_id === "free-safe").status, "active");
  assert.equal(report.importable.find((row) => row.source_user_id === "free-defaulted").status, "active");
  const codes = new Set(report.conflicts.map((entry) => entry.code));
  assert.ok(codes.has("MISSING_ROLE"));
  assert.ok(codes.has("UNKNOWN_ROLE"));
  assert.ok(codes.has("PRIVILEGED_STATUS_MISMATCH"));
  assert.ok(codes.has("UNKNOWN_STATUS"));
  assert.equal(report.importable.some((row) => row.role === "vip" || row.role === "admin"), false);
});

test("transform requires both source arrays instead of treating a malformed snapshot as empty", () => {
  const missingProfiles = fixture();
  delete missingProfiles.profiles;
  assert.throws(
    () => transformLegacySnapshot(missingProfiles),
    (error) => error.message === "MIGRATION_PROFILES_REQUIRED"
  );

  const missingIdentityUsers = fixture();
  delete missingIdentityUsers.identityUsers;
  assert.throws(
    () => transformLegacySnapshot(missingIdentityUsers),
    (error) => error.message === "MIGRATION_IDENTITY_USERS_REQUIRED"
  );
});

test("admin email allowlist is checked in both directions", () => {
  const source = {
    snapshotId: "snapshot-admin-bidirectional",
    migrationId: "migration-admin-bidirectional",
    freezeAt: "2026-08-25T01:00:00.000Z",
    adminEmails: ["listed-free@example.com", "orphan-admin@example.com", "valid-admin@example.com"],
    profiles: [
      { email: "admin-not-profile@example.com", role: "admin", status: "approved" },
      { email: "listed-free@example.com", role: "free", status: "approved" },
      { email: "valid-admin@example.com", role: "admin", status: "approved" }
    ],
    identityUsers: [
      identity("legacy-admin-not-profile", "admin-not-profile@example.com", { email_verified: false, confirmed_at: undefined }),
      identity("legacy-listed-free", "listed-free@example.com", { email_verified: false, confirmed_at: undefined }),
      identity("legacy-valid-admin", "valid-admin@example.com")
    ]
  };

  const report = transformLegacySnapshot(source);
  assert.deepEqual(report.importable.map((row) => row.source_user_id), ["legacy-valid-admin"]);
  const mismatchCodes = report.conflicts
    .filter((entry) => entry.code.includes("ADMIN_EMAIL"))
    .map((entry) => entry.code);
  assert.ok(mismatchCodes.includes("ADMIN_EMAIL_MISMATCH"));
  assert.ok(mismatchCodes.includes("ADMIN_EMAIL_ROLE_MISMATCH"));
  assert.ok(mismatchCodes.includes("ADMIN_EMAIL_WITHOUT_PROFILE"));
});

test("verified legacy email without a timestamp uses freezeAt, otherwise becomes a conflict", () => {
  const withFreeze = {
    snapshotId: "snapshot-verified-fallback",
    migrationId: "migration-verified-fallback",
    freezeAt: "2026-08-25T01:00:00.000Z",
    profiles: [{ email: "verified@example.com", role: "free", status: "approved" }],
    identityUsers: [identity("legacy-verified", "verified@example.com", {
      email_verified: true,
      confirmed_at: undefined
    })]
  };
  const fallbackReport = transformLegacySnapshot(withFreeze);
  const fallbackRow = fallbackReport.importable[0];
  assert.equal(fallbackRow.email_verified, true);
  assert.equal(fallbackRow.email_confirmed_at, withFreeze.freezeAt);
  assert.ok(fallbackReport.warnings.some((entry) => entry.code === "EMAIL_VERIFIED_TIMESTAMP_FALLBACK_FREEZE_AT"));

  const withoutFreeze = transformLegacySnapshot({ ...withFreeze, freezeAt: null });
  assert.equal(withoutFreeze.importable.length, 0);
  assert.ok(withoutFreeze.conflicts.some((entry) => entry.code === "VERIFIED_TIMESTAMP_REQUIRED"));
});
