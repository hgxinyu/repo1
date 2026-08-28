import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertExpectedConstraintError,
  canonicalDisposableSocket,
  canonicalMigrationChain,
  canonicalMigrationPath,
  createDisposablePreBatchBase,
  derivePreBatchBaseMigration,
  validatePsqlBinary
} from "./postgres-schema-smoke.mjs";

const smokeSource = readFileSync(new URL("./postgres-schema-smoke.mjs", import.meta.url), "utf8");
const testDirectory = dirname(fileURLToPath(import.meta.url));
const batchTableStatement = [
  "CREATE TABLE auth_migration_batches (",
  "  batch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),",
  "  status auth_migration_status NOT NULL",
  ");"
].join("\n");
const batchRevokeStatement = "REVOKE ALL ON TABLE public.auth_migration_batches FROM PUBLIC;";
const batchCommentStatement = [
  "COMMENT ON TABLE public.auth_migration_batches",
  "  IS 'Migration readiness metadata';"
].join("\n");
const preBatchFixture = [
  "BEGIN;",
  "",
  "CREATE TYPE auth_migration_status AS ENUM ('pending', 'reconciled');",
  "",
  batchTableStatement,
  "",
  "CREATE TABLE accounts (account_id UUID PRIMARY KEY);",
  "",
  batchRevokeStatement,
  "",
  batchCommentStatement,
  "",
  "COMMIT;",
  ""
].join("\n");

test("smoke target rejects traversal and missing or escaping socket paths", () => {
  assert.throws(
    () => canonicalDisposableSocket("/private/tmp/shinegame-auth-pg.fake/socket/../socket"),
    /path traversal/
  );
  assert.throws(
    () => canonicalDisposableSocket("/private/tmp/shinegame-auth-pg.missing/socket"),
    /does not exist/
  );

  const root = mkdtempSync("/private/tmp/shinegame-auth-pg.");
  try {
    symlinkSync("/private/tmp", join(root, "socket"));
    assert.throws(
      () => canonicalDisposableSocket(join(root, "socket")),
      /symlink/
    );

    symlinkSync(join(root, "socket"), join(root, "socket-link"));
    assert.throws(
      () => canonicalDisposableSocket(join(root, "socket-link")),
      /symlink/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("smoke target rejects migration traversal, missing, and symlink paths", () => {
  assert.throws(
    () => canonicalMigrationPath("/private/tmp/shinegame-auth-migration.red/../migration.sql"),
    /path traversal/
  );

  const root = mkdtempSync("/private/tmp/shinegame-auth-migration.");
  const migration = join(root, "migration.sql");
  const migrationLink = join(root, "migration-link.sql");
  try {
    writeFileSync(migration, "BEGIN;\nCOMMIT;\n");
    assert.throws(
      () => canonicalMigrationPath(join(root, "missing.sql")),
      /does not exist|not found/
    );
    symlinkSync(migration, migrationLink);
    assert.throws(
      () => canonicalMigrationPath(migrationLink),
      /symlink/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("smoke target rejects fake psql binaries before connecting", () => {
  const root = mkdtempSync("/private/tmp/shinegame-auth-psql.");
  const bin = join(root, "bin");
  const fakePsql = join(bin, "psql");
  try {
    mkdirSync(bin);
    writeFileSync(fakePsql, "#!/bin/sh\necho 'psql (PostgreSQL) 17.11'\n", { mode: 0o755 });
    chmodSync(fakePsql, 0o755);
    assert.throws(
      () => validatePsqlBinary(fakePsql),
      /trusted|native|PostgreSQL psql version/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("smoke target rejects a wrong constraint name rather than any SQL error", () => {
  assert.throws(
    () => assertExpectedConstraintError(
      { status: 3, output: 'ERROR: duplicate key value violates unique constraint "other_constraint"' },
      "account_emails_lookup_uidx",
      "duplicate email"
    ),
    /account_emails_lookup_uidx/
  );
  assert.throws(
    () => assertExpectedConstraintError(
      { status: 3, output: "ERROR: syntax error at or near INSERT" },
      "auth_identities_scope_subject_uidx",
      "duplicate identity"
    ),
    /auth_identities_scope_subject_uidx/
  );
});

test("schema smoke probes the 186-byte PKCE envelope and generated session family", () => {
  assert.match(smokeSource, /pkce_verifier_encrypted[\s\S]*repeat\('cc', 186\)/u);
  assert.match(smokeSource, /session_family_id/u);
  assert.match(smokeSource, /SELECT session_family_id INTO/u);
  assert.match(smokeSource, /encrypted_email[\s\S]*repeat\('ee', 8192\)/u);
  assert.match(smokeSource, /encrypted email upper bound[\s\S]*repeat\('ee', 8193\)/u);
});

test("schema smoke verifies legacy session uniqueness within an environment and site", () => {
  assert.match(
    smokeSource,
    /duplicate active legacy session[\s\S]*environment_id[\s\S]*site_id[\s\S]*legacy-user-duplicate/u
  );
  assert.match(
    smokeSource,
    /legacy-user-cross-environment[\s\S]*production[\s\S]*site-production[\s\S]*ROLLBACK/u
  );
});

test("schema smoke exposes an explicit pre-task base migration chain", () => {
  const baseMigration = join(
    testDirectory,
    "../../netlify/database/migrations/202608250001_auth_accounts.sql"
  );
  const incrementalMigrations = [
    join(testDirectory, "../../netlify/database/migrations/202608260001_auth_hardening.sql"),
    join(testDirectory, "../../netlify/database/migrations/202608270001_fix_request_account_vip_role_variable.sql"),
    join(testDirectory, "../../netlify/database/migrations/202608270002_auth_migration_batches.sql")
  ];
  const fixtureRoot = mkdtempSync("/private/tmp/shinegame-auth-migration.");
  const derivedBaseMigration = join(fixtureRoot, "pre-batch-base.sql");
  try {
    const derivedSql = derivePreBatchBaseMigration(readFileSync(baseMigration, "utf8"));
    writeFileSync(derivedBaseMigration, derivedSql);
    assert.doesNotMatch(derivedSql, /auth_migration_batches/iu);
    assert.deepEqual(
      canonicalMigrationChain(derivedBaseMigration, incrementalMigrations),
      [derivedBaseMigration, ...incrementalMigrations].map(canonicalMigrationPath)
    );
    assert.match(smokeSource, /--base-migration/u);
    assert.match(smokeSource, /--additional-migration/u);
    assert.match(smokeSource, /--derive-pre-batch-base/u);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("pre-batch derivation removes exactly the batch statements and preserves the schema transaction", () => {
  const derived = derivePreBatchBaseMigration(preBatchFixture);
  const expected = preBatchFixture
    .replace(batchTableStatement, "")
    .replace(batchRevokeStatement, "")
    .replace(batchCommentStatement, "");

  assert.equal(derived, expected);
  assert.doesNotMatch(derived, /auth_migration_batches/iu);
  assert.match(derived, /^\s*BEGIN;\s*/iu);
  assert.match(derived, /CREATE TYPE auth_migration_status/iu);
  assert.match(derived, /CREATE TABLE accounts/iu);
  assert.match(derived, /COMMIT;\s*$/iu);
});

test("pre-batch derivation uses a portable repository base and removes batch metadata", () => {
  const baseMigration = join(
    testDirectory,
    "../../netlify/database/migrations/202608250001_auth_accounts.sql"
  );
  const derived = derivePreBatchBaseMigration(readFileSync(baseMigration, "utf8"));

  assert.doesNotMatch(derived, /auth_migration_batches/iu);
  assert.match(derived, /^\s*BEGIN;\s*/iu);
  assert.match(derived, /CREATE TYPE auth_migration_status/iu);
  assert.match(derived, /CREATE TABLE accounts/iu);
  assert.match(derived, /COMMIT;\s*$/iu);
  assert.match(smokeSource, /--derive-pre-batch-base/u);
});

test("pre-batch derivation fails closed for missing, duplicate, or malformed statements", () => {
  assert.throws(
    () => derivePreBatchBaseMigration(preBatchFixture.replace(batchTableStatement, "")),
    /CREATE TABLE.*exactly one|expected exactly one.*CREATE TABLE/iu
  );
  assert.throws(
    () => derivePreBatchBaseMigration(preBatchFixture + "\n" + batchTableStatement),
    /CREATE TABLE.*exactly one|expected exactly one.*CREATE TABLE/iu
  );
  assert.throws(
    () => derivePreBatchBaseMigration(
      preBatchFixture.replace(batchRevokeStatement, batchRevokeStatement + "\n" + batchRevokeStatement)
    ),
    /REVOKE.*exactly one|expected exactly one.*REVOKE/iu
  );
  assert.throws(
    () => derivePreBatchBaseMigration(preBatchFixture.replace(batchCommentStatement, "")),
    /COMMENT.*exactly one|expected exactly one.*COMMENT/iu
  );
  assert.throws(
    () => derivePreBatchBaseMigration(
      preBatchFixture.replace(batchCommentStatement, batchCommentStatement + "\n" + batchCommentStatement)
    ),
    /COMMENT.*exactly one|expected exactly one.*COMMENT/iu
  );
  assert.throws(
    () => derivePreBatchBaseMigration(preBatchFixture.replace(
      batchTableStatement + "\n\n",
      batchTableStatement.slice(0, -2) + "\n\n"
    )),
    /malformed.*CREATE TABLE|CREATE TABLE.*malformed/iu
  );
  assert.throws(
    () => derivePreBatchBaseMigration(preBatchFixture.replace(batchRevokeStatement, batchRevokeStatement.slice(0, -1))),
    /malformed.*REVOKE|REVOKE.*malformed/iu
  );
});

test("pre-batch derivation rejects an unterminated batch comment before a later legal statement", () => {
  const malformed = preBatchFixture.replace(
    batchCommentStatement,
    batchCommentStatement.slice(0, -1) + "\nREVOKE ALL ON TABLE public.accounts FROM PUBLIC;"
  );

  assert.throws(
    () => derivePreBatchBaseMigration(malformed),
    /malformed.*COMMENT|COMMENT.*malformed/iu
  );
});

test("pre-batch derivation rejects quoted or dollar-quoted content before an immediate terminator", () => {
  assert.throws(
    () => derivePreBatchBaseMigration(preBatchFixture.replace(
      batchTableStatement,
      batchTableStatement.slice(0, -1) + " 'unexpected';"
    )),
    /malformed.*CREATE TABLE|CREATE TABLE.*malformed/iu
  );
  assert.throws(
    () => derivePreBatchBaseMigration(preBatchFixture.replace(
      batchRevokeStatement,
      batchRevokeStatement.slice(0, -1) + " $tag$unexpected$tag$;"
    )),
    /malformed.*REVOKE|REVOKE.*malformed/iu
  );
});

test("pre-batch fixture cleanup removes the exact file when canonicalization fails after write", () => {
  const fixtureRoot = mkdtempSync("/private/tmp/shinegame-auth-migration.");
  const realClusterRoot = join(fixtureRoot, "real-cluster");
  const linkedClusterRoot = join(fixtureRoot, "linked-cluster");
  const derivedPath = join(linkedClusterRoot, "pre-batch-auth-accounts.sql");
  try {
    mkdirSync(realClusterRoot);
    symlinkSync(realClusterRoot, linkedClusterRoot);

    assert.throws(
      () => createDisposablePreBatchBase(
        new URL("../../netlify/database/migrations/202608250001_auth_accounts.sql", import.meta.url),
        linkedClusterRoot
      ),
      /symlink/iu
    );
    assert.equal(existsSync(derivedPath), false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
