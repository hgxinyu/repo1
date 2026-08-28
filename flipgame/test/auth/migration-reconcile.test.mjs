import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReconciliationReport,
  reconcileCommittedMigration,
  reconcileMigration
} from "../../scripts/auth-migration/reconcile.mjs";
import { createNetlifyReadOnlyReaders, createSnapshot } from "../../scripts/auth-migration/snapshot.mjs";
import { dryRunSnapshot, runDryRun } from "../../scripts/auth-migration/dry-run.mjs";
import {
  createMemoryImportAdapter,
  importSnapshot,
  runImport
} from "../../scripts/auth-migration/import.mjs";
import {
  finalizeMigrationBatch,
  upsertMigrationBatchInTransaction
} from "../../scripts/auth-migration/finalize.mjs";
import { deriveAccountId, transformLegacySnapshot } from "../../scripts/auth-migration/transform.mjs";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function identity(id, email, overrides = {}) {
  return {
    id,
    email,
    email_verified: true,
    confirmed_at: "2026-08-25T00:00:00.000Z",
    ...overrides
  };
}

function snapshot() {
  return {
    snapshotId: "snapshot-reconcile",
    migrationId: "migration-reconcile",
    freezeAt: "2026-08-25T01:00:00.000Z",
    profiles: [
      { email: "vip@example.com", role: "vip", status: "approved", guild: "Shine", gameName: "VIP" },
      { email: "free@example.com", role: "free", status: "approved", guild: "Shine", gameName: "Free" }
    ],
    identityUsers: [
      { id: "legacy-vip", email: "vip@example.com", email_verified: true },
      { id: "legacy-free", email: "free@example.com", email_verified: true }
    ],
    adminEmails: []
  };
}

const PRODUCTION_ENV = {
  MIGRATION_WRITE_MODE: "frozen",
  AUTH_ENV_ID: "production",
  NETLIFY_SITE_ID: "site-production",
  AUTH_EXPECTED_SITE_ID: "site-production"
};

function assertLegalParameterizedInsert(strings, values) {
  const parts = Array.from(strings.raw || strings);
  assert.equal(parts.length, values.length + 1, `parameterized SQL must have one trailing part: ${parts.length} parts for ${values.length} values`);
  const rendered = parts.reduce(
    (result, part, index) => `${result}${part}${index < values.length ? `$${index + 1}` : ""}`,
    ""
  );
  const match = rendered.match(/INSERT\s+INTO\s+(accounts|migration_records|account_emails|auth_identities)[\s\S]*?VALUES\s*\(([^)]*)\)/iu);
  if (!match) return null;
  const placeholders = match[2].split(",").map((value) => value.trim());
  assert.ok(placeholders.every((value) => /^\$\d+$/u.test(value)), `invalid INSERT placeholders: ${rendered}`);
  assert.equal(placeholders.length, values.length, `invalid INSERT arity: ${rendered}`);
  return match[1].toLowerCase();
}

function assertLegalParameterizedStatement(strings, values) {
  const parts = Array.from(strings.raw || strings);
  assert.equal(parts.length, values.length + 1, `parameterized SQL must have one trailing part: ${parts.length} parts for ${values.length} values`);
  const rendered = parts.reduce(
    (result, part, index) => `${result}${part}${index < values.length ? `$${index + 1}` : ""}`,
    ""
  );
  const placeholders = [...rendered.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1]));
  assert.deepEqual(placeholders, values.map((_, index) => index + 1), `SQL placeholders must bind every value: ${rendered}`);
}

function successfulImportResponse(text, values, state = new Map()) {
  if (/pg_advisory_xact_lock/iu.test(text)) return [];
  if (/FROM auth_migration_batches/iu.test(text)) return [];
  if (/FROM migration_records m/iu.test(text)) {
    const migration = state.migration;
    const account = migration ? state.get(migration.account_id) : null;
    return migration && account ? [{
      ...migration,
      migration_status: migration.status,
      account_role: account.role,
      account_status: account.status,
      account_guild: account.guild,
      account_game_name: account.game_name,
      account_authz_version: account.authz_version,
      account_merged_into_account_id: account.merged_into_account_id,
      account_migration_id: account.migration_id,
      account_blocked_at: account.blocked_at
    }] : [];
  }
  if (/SELECT email_id[\s\S]*FROM account_emails/iu.test(text)) return state.email ? [state.email] : [];
  if (/SELECT identity_id[\s\S]*FROM auth_identities/iu.test(text)) return state.identity ? [state.identity] : [];
  if (/SELECT migration_id/iu.test(text)) return [];
  if (/SELECT account_id, role/iu.test(text)) return [];
  if (/INSERT INTO accounts/iu.test(text)) {
    const row = {
      account_id: values[0], role: values[1], status: values[2],
      guild: values[3], game_name: values[4], authz_version: "1",
      merged_into_account_id: null, migration_id: null, blocked_at: values[5]
    };
    state.set(values[0], row);
    return [row];
  }
  if (/INSERT INTO migration_records/iu.test(text)) {
    state.migration = {
      migration_id: values[0], source: values[1], source_user_id: values[2],
      legacy_netlify_user_id: values[3], account_id: values[4],
      legacy_email_lookup_hash: values[5], snapshot_hash: values[6], status: values[7],
      error_code: null, freeze_at: values[8], created_at: values[9], completed_at: values[10]
    };
    return [state.migration];
  }
  if (/UPDATE accounts SET migration_id/iu.test(text)) {
    const account = state.get(values[1]);
    const updated = { ...account, account_id: values[1], migration_id: values[0] };
    state.set(values[1], updated);
    return [updated];
  }
  if (/SELECT account_id FROM account_emails/iu.test(text)) return [];
  if (/INSERT INTO account_emails/iu.test(text)) {
    state.email = {
      email_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      account_id: values[0], email_lookup_hash: values[1], encrypted_email: values[2],
      encryption_key_version: values[3], is_primary: values[4], verified_at: values[5], removed_at: null
    };
    return [state.email];
  }
  if (/SELECT account_id FROM auth_identities/iu.test(text)) return [];
  if (/INSERT INTO auth_identities/iu.test(text)) {
    state.identity = {
      identity_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      account_id: values[0], issuer_or_tenant: values[1], connector_scope: values[2],
      provider_subject: values[3], subject_type: values[4], logto_user_id: null,
      status: values[5], revoked_at: null
    };
    return [state.identity];
  }
  return [];
}

async function finalizedEvidence(overrides = {}) {
  const source = snapshot();
  const transformed = transformLegacySnapshot(source);
  const report = reconcileMigration(source, transformed.importable, {
    sourceReport: transformed,
    sourceSnapshotHash: transformed.snapshotHash
  });
  const completedAt = "2026-08-25T03:00:00.000Z";
  Object.assign(report, {
    status: "reconciled",
    sourceCount: 2,
    importedCount: 2,
    conflictCount: 0,
    freezeAt: source.freezeAt,
    completedAt,
    databaseConflicts: [],
    ...overrides
  });
  return {
    report,
    reviewedSnapshot: {
      snapshotId: report.snapshotId,
      snapshotHash: report.sourceSnapshotHash,
      migrationId: report.migrationId,
      freezeAt: source.freezeAt,
      completedAt
    }
  };
}

function batchMemoryAdapter(initialRows = []) {
  const rows = initialRows.map((row) => ({ ...row }));
  let transactions = 0;
  let writes = initialRows.length;
  return {
    rows,
    get writes() {
      return writes;
    },
    get transactions() {
      return transactions;
    },
    async withTransaction(callback) {
      transactions += 1;
      const transaction = (strings, ...values) => {
        const text = Array.from(strings.raw || strings).join("");
        if (/SELECT[\s\S]*FROM auth_migration_batches/iu.test(text)) {
          const [source, environmentId, siteId] = values;
          const row = rows.find((candidate) => candidate.source === source &&
            candidate.environmentId === environmentId && candidate.siteId === siteId);
          if (!row) return Promise.resolve([]);
          return Promise.resolve([{
            source: row.source,
            environment_id: row.environmentId,
            site_id: row.siteId,
            snapshot_id: row.snapshotId,
            snapshot_hash: Buffer.from(row.snapshotHash),
            status: row.status,
            source_count: row.sourceCount,
            imported_count: row.importedCount,
            conflict_count: row.conflictCount,
            freeze_at: row.freezeAt,
            completed_at: row.completedAt
          }]);
        }
        if (/INSERT INTO auth_migration_batches/iu.test(text)) {
          const [source, environmentId, siteId, snapshotId, snapshotHash, status,
            sourceCount, importedCount, conflictCount, freezeAt, completedAt] = values;
          const existing = rows.find((candidate) => candidate.source === source &&
            candidate.environmentId === environmentId && candidate.siteId === siteId);
          if (existing) return Promise.resolve([]);
          const row = {
            source,
            environmentId,
            siteId,
            snapshotId,
            snapshotHash: Buffer.from(snapshotHash),
            status,
            sourceCount,
            importedCount,
            conflictCount,
            freezeAt,
            completedAt
          };
          rows.push(row);
          writes += 1;
          return Promise.resolve([{
            source: row.source,
            environment_id: row.environmentId,
            site_id: row.siteId,
            snapshot_id: row.snapshotId,
            snapshot_hash: Buffer.from(row.snapshotHash),
            status: row.status,
            source_count: row.sourceCount,
            imported_count: row.importedCount,
            conflict_count: row.conflictCount,
            freeze_at: row.freezeAt,
            completed_at: row.completedAt
          }]);
        }
        throw new Error("unexpected batch SQL");
      };
      return callback(transaction);
    }
  };
}

test("finalization rejects caller-supplied report evidence before calling its adapter", async () => {
  const invalidCases = [
    ["reviewed snapshot mismatch", { reviewedSnapshot: { snapshotId: "wrong", snapshotHash: "0".repeat(64), freezeAt: "2026-08-25T01:00:00.000Z" } }, "AUTH_MIGRATION_REVIEW_MISMATCH"],
    ["non-reconciled report", { report: { status: "conflict" } }, "AUTH_MIGRATION_RECONCILIATION_REQUIRED"],
    ["unequal counts", { report: { sourceCount: 3 } }, "AUTH_MIGRATION_COUNTS_MISMATCH"],
    ["conflicts", { report: { conflictCount: 1 } }, "AUTH_MIGRATION_CONFLICTS_PRESENT"],
    ["invalid freeze timestamp", { report: { freezeAt: "not-a-time" }, reviewedFreezeAt: "not-a-time" }, "AUTH_MIGRATION_FREEZE_AT_INVALID"],
    ["invalid completion timestamp", { now: "not-a-time" }, "AUTH_MIGRATION_COMPLETION_AT_INVALID"],
    ["non-production mode", { env: { MIGRATION_WRITE_MODE: "legacy", AUTH_ENV_ID: "production" } }, "AUTH_MIGRATION_IMPORT_MODE_REQUIRED"]
  ];
  for (const [name, overrides, code] of invalidCases) {
    const evidence = await finalizedEvidence(overrides.report);
    const adapter = batchMemoryAdapter();
    const input = {
      reconciliationReport: evidence.report,
      reviewedSnapshot: overrides.reviewedSnapshot ||
        (overrides.reviewedFreezeAt ? { ...evidence.reviewedSnapshot, freezeAt: overrides.reviewedFreezeAt } : evidence.reviewedSnapshot),
      source: "netlify_identity",
      environmentId: "production",
      siteId: "site-production",
      adapter,
      env: overrides.env || PRODUCTION_ENV,
      now: overrides.now || new Date("2026-08-25T03:00:00.000Z")
    };
    await assert.rejects(
      () => finalizeMigrationBatch(input),
      (error) => error.code === code || error.code === "AUTH_MIGRATION_DATABASE_EVIDENCE_REQUIRED",
      name
    );
    assert.equal(adapter.transactions, 0, `${name} must reject before adapter calls`);
  }
});

test("production finalization rejects a serialized imported-file report without DB evidence", async () => {
  const evidence = await finalizedEvidence();
  const serializedReport = JSON.parse(JSON.stringify(evidence.report));
  const adapter = batchMemoryAdapter();
  await assert.rejects(
    () => finalizeMigrationBatch({
      reconciliationReport: serializedReport,
      reviewedSnapshot: evidence.reviewedSnapshot,
      source: "netlify_identity",
      environmentId: "production",
      siteId: "site-production",
      adapter,
      env: PRODUCTION_ENV,
      now: new Date("2026-08-25T03:00:00.000Z")
    }),
    (error) => error.code === "AUTH_MIGRATION_DATABASE_EVIDENCE_REQUIRED"
  );
  assert.equal(adapter.transactions, 0);
});

test("DB-derived reconciliation fails closed when committed account linkage differs", async () => {
  const source = oneRowSnapshot();
  const graph = exactLegacyGraph(source);
  graph.account.migration_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const report = await reconcileCommittedMigration(source, {
    adapter: {
      async withReadOnlyTransaction(callback) {
        return callback((strings) => {
          const sql = Array.from(strings.raw || strings).join("");
          if (/FROM migration_records m[\s\S]*JOIN accounts a/iu.test(sql)) {
            return [{
              ...graph.migration,
              migration_status: graph.migration.status,
              account_role: graph.account.role,
              account_status: graph.account.status,
              account_guild: graph.account.guild,
              account_game_name: graph.account.game_name,
              account_authz_version: graph.account.authz_version,
              account_merged_into_account_id: graph.account.merged_into_account_id,
              account_migration_id: graph.account.migration_id,
              account_blocked_at: graph.account.blocked_at
            }];
          }
          if (/FROM account_emails/iu.test(sql)) return [graph.email];
          if (/FROM auth_identities/iu.test(sql)) return [graph.identity];
          throw new Error(`unexpected reconciliation query: ${sql}`);
        });
      }
    },
    sourceReport: graph.report,
    sourceSnapshotHash: graph.report.snapshotHash,
    emailLookupHash: async () => Buffer.from(graph.emailHash),
    encryptionKeyVersion: 3
  });
  assert.equal(report.ok, false);
  assert.equal(report.status, "conflict");
  assert.equal(report.databaseConflicts.length, 1);
});

test("finalization writes one reconciled batch transactionally and replays the same snapshot idempotently", async () => {
  const source = oneRowSnapshot();
  const graph = exactLegacyGraph(source);
  const adapter = atomicOwnerAdapter(graph);
  const input = {
    snapshot: source,
    sourceReport: graph.report,
    reviewedSnapshot: source,
    source: "netlify_identity",
    environmentId: "production",
    siteId: "site-production",
    adapter,
    emailLookupHash: async () => Buffer.from(graph.emailHash),
    encryptionKeyVersion: 3,
    env: PRODUCTION_ENV,
    now: new Date("2026-08-25T03:00:00.000Z")
  };
  const first = await finalizeMigrationBatch(input);
  const replay = await finalizeMigrationBatch({
    ...input,
    now: new Date("2026-08-25T04:00:00.000Z")
  });
  assert.equal(first.finalized, true);
  assert.equal(replay.idempotent, true);
  assert.equal(adapter.transactions, 2);
  assert.equal(adapter.storedBatch.source_count, 1);
  assert.equal(adapter.storedBatch.imported_count, 1);
  assert.equal(adapter.storedBatch.conflict_count, 0);
  assert.equal(replay.batch.completedAt, first.batch.completedAt);
  assert.equal(Object.isFrozen(first.batch), true);
});

test("finalization rejects a different snapshot for an existing source scope", async () => {
  const evidence = await finalizedEvidence();
  const adapter = batchMemoryAdapter();
  await assert.rejects(
    () => finalizeMigrationBatch({
      reconciliationReport: { ...evidence.report, snapshotId: "snapshot-different" },
      reviewedSnapshot: evidence.reviewedSnapshot,
      source: "netlify_identity",
      environmentId: "production",
      siteId: "site-production",
      adapter,
      env: PRODUCTION_ENV,
      now: new Date("2026-08-25T03:00:00.000Z")
    }),
    (error) => error.code === "AUTH_MIGRATION_DATABASE_EVIDENCE_REQUIRED"
  );
  assert.equal(adapter.transactions, 0);
});

test("finalization requires a complete genuine reconciliation report", async () => {
  const evidence = await finalizedEvidence();
  const requiredFields = [
    "ok",
    "status",
    "snapshotId",
    "migrationId",
    "snapshotHash",
    "sourceSnapshotHash",
    "reviewedSnapshotHash",
    "sourceCounts",
    "importedCounts",
    "sourceCount",
    "importedCount",
    "conflictCount",
    "freezeAt",
    "completedAt",
    "hashMismatch",
    "sourceReportHashMismatch",
    "sourceReportMismatch",
    "roleDistribution",
    "sourceAccountIds",
    "importedAccountIds",
    "missingAccountIds",
    "extraAccountIds",
    "missingSourceKeys",
    "extraSourceKeys",
    "mappingMismatches",
    "snapshotHashMismatches",
    "duplicateSourceKeys",
    "duplicateAccountIds",
    "unresolvedConflicts"
  ];
  for (const field of requiredFields) {
    const report = { ...evidence.report };
    delete report[field];
    const adapter = batchMemoryAdapter();
    await assert.rejects(
      () => finalizeMigrationBatch({
        reconciliationReport: report,
        reviewedSnapshot: evidence.reviewedSnapshot,
        source: "netlify_identity",
        environmentId: "production",
        siteId: "site-production",
        adapter,
        env: PRODUCTION_ENV,
        now: new Date("2026-08-25T03:00:00.000Z")
      }),
      (error) => error.code === "AUTH_MIGRATION_RECONCILIATION_REQUIRED" ||
        error.code === "AUTH_MIGRATION_REVIEW_MISMATCH" ||
        error.code === "AUTH_MIGRATION_DATABASE_EVIDENCE_REQUIRED",
      `missing report field ${field}`
    );
    assert.equal(adapter.transactions, 0, `missing report field ${field} must reject before adapter calls`);
  }

  const contradictions = [
    ["source total does not match detailed profiles", { sourceCount: 1 }, "AUTH_MIGRATION_COUNTS_MISMATCH"],
    ["imported total does not match detailed accounts", { importedCount: 1 }, "AUTH_MIGRATION_COUNTS_MISMATCH"],
    ["detailed identity totals differ", { sourceCounts: { ...evidence.report.sourceCounts, identityUsers: 3 } }, "AUTH_MIGRATION_COUNTS_MISMATCH"],
    ["jointly inflated identity totals", {
      sourceCounts: { ...evidence.report.sourceCounts, identityUsers: 3 },
      importedCounts: { ...evidence.report.importedCounts, identities: 3 }
    }, "AUTH_MIGRATION_COUNTS_MISMATCH"],
    ["unresolved conflict list is not empty", { unresolvedConflicts: [{ code: "CONFLICT" }] }, "AUTH_MIGRATION_RECONCILIATION_REQUIRED"],
    ["reconciliation ok flag is false", { ok: false }, "AUTH_MIGRATION_RECONCILIATION_REQUIRED"],
    ["mismatch array is not empty", { mappingMismatches: [{ sourceKey: "mismatch" }] }, "AUTH_MIGRATION_RECONCILIATION_REQUIRED"]
  ];
  for (const [name, override, code] of contradictions) {
    const adapter = batchMemoryAdapter();
    await assert.rejects(
      () => finalizeMigrationBatch({
        reconciliationReport: { ...evidence.report, ...override },
        reviewedSnapshot: evidence.reviewedSnapshot,
        source: "netlify_identity",
        environmentId: "production",
        siteId: "site-production",
        adapter,
        env: PRODUCTION_ENV,
        now: new Date("2026-08-25T03:00:00.000Z")
      }),
      (error) => error.code === code || error.code === "AUTH_MIGRATION_DATABASE_EVIDENCE_REQUIRED",
      name
    );
    assert.equal(adapter.transactions, 0, `${name} must reject before adapter calls`);
  }
});

test("finalization requires both production site sentinels", async () => {
  const evidence = await finalizedEvidence();
  const cases = [
    ["missing Netlify site", { ...PRODUCTION_ENV, NETLIFY_SITE_ID: undefined }],
    ["missing expected site", { ...PRODUCTION_ENV, AUTH_EXPECTED_SITE_ID: undefined }],
    ["site sentinels differ", { ...PRODUCTION_ENV, AUTH_EXPECTED_SITE_ID: "other-site" }],
    ["input site differs", PRODUCTION_ENV, "other-site"]
  ];
  for (const [name, env, siteId = "site-production"] of cases) {
    const adapter = batchMemoryAdapter();
    await assert.rejects(
      () => finalizeMigrationBatch({
        reconciliationReport: evidence.report,
        reviewedSnapshot: evidence.reviewedSnapshot,
        source: "netlify_identity",
        environmentId: "production",
        siteId,
        adapter,
        env,
        now: new Date("2026-08-25T03:00:00.000Z")
      }),
      (error) => error.code === "AUTH_MIGRATION_SITE_MISMATCH",
      name
    );
    assert.equal(adapter.transactions, 0, `${name} must reject before adapter calls`);
  }
});

test("finalization rejects inconsistent reviewed freeze and completion evidence", async () => {
  const evidence = await finalizedEvidence({ completedAt: "2026-08-25T02:30:00.000Z" });
  const cases = [
    ["reviewed completion omitted", { reviewedSnapshot: { ...evidence.reviewedSnapshot } }],
    ["reviewed completion differs", { reviewedSnapshot: { ...evidence.reviewedSnapshot, completedAt: "2026-08-25T02:31:00.000Z" } }],
    ["report completion omitted", {
      report: (() => { const report = { ...evidence.report }; delete report.completedAt; return report; })(),
      reviewedSnapshot: { ...evidence.reviewedSnapshot, completedAt: "2026-08-25T02:30:00.000Z" }
    }],
    ["reviewed freeze differs", { reviewedSnapshot: { ...evidence.reviewedSnapshot, freezeAt: "2026-08-25T00:00:00.000Z" } }]
  ];
  for (const [name, overrides] of cases) {
    const adapter = batchMemoryAdapter();
    await assert.rejects(
      () => finalizeMigrationBatch({
        reconciliationReport: overrides.report || evidence.report,
        reviewedSnapshot: overrides.reviewedSnapshot || evidence.reviewedSnapshot,
        source: "netlify_identity",
        environmentId: "production",
        siteId: "site-production",
        adapter,
        env: PRODUCTION_ENV,
        now: new Date("2026-08-25T03:00:00.000Z")
      }),
      (error) => error.code === "AUTH_MIGRATION_REVIEW_MISMATCH" ||
        error.code === "AUTH_MIGRATION_DATABASE_EVIDENCE_REQUIRED" ||
        (name === "report completion omitted" && [
          "AUTH_MIGRATION_RECONCILIATION_REQUIRED",
          "AUTH_MIGRATION_DATABASE_EVIDENCE_REQUIRED"
        ].includes(error.code)),
      name
    );
    assert.equal(adapter.transactions, 0, `${name} must reject before adapter calls`);
  }
});

function testBatch(evidence) {
  return Object.freeze({
    source: "netlify_identity",
    environmentId: "production",
    siteId: "site-production",
    snapshotId: evidence.report.snapshotId,
    snapshotHash: evidence.report.snapshotHash,
    status: "reconciled",
    sourceCount: 2,
    importedCount: 2,
    conflictCount: 0,
    freezeAt: "2026-08-25T01:00:00.000Z",
    completedAt: "2026-08-25T03:00:00.000Z"
  });
}

test("finalization PostgreSQL upsert binds every batch value", async () => {
  const evidence = await finalizedEvidence();
  const batch = testBatch(evidence);
  const calls = [];
  const sql = (strings, ...values) => {
    assertLegalParameterizedStatement(strings, values);
    const raw = Array.from(strings.raw || strings);
    calls.push({ strings: raw, values });
    return Promise.resolve(/INSERT INTO auth_migration_batches/iu.test(raw.join(""))
      ? [existingBatch(evidence)] : []);
  };
  await upsertMigrationBatchInTransaction(sql, batch);
  assert.equal(calls.length, 2);
  const inserts = calls.filter(({ strings }) => strings.join("").includes("INSERT INTO auth_migration_batches"));
  assert.equal(inserts.length, 1);
  assert.match(inserts[0].strings.join(""), /ON CONFLICT[\s\S]*DO NOTHING/iu);
  assert.doesNotMatch(inserts[0].strings.join(""), /DO UPDATE/iu);
});

test("finalization fails closed when neither INSERT RETURNING nor the conflict post-read proves persistence", async () => {
  const evidence = await finalizedEvidence();
  const batch = testBatch(evidence);
  const calls = [];
  const sql = (strings, ...values) => {
    assertLegalParameterizedStatement(strings, values);
    calls.push(Array.from(strings.raw || strings).join(""));
    return Promise.resolve([]);
  };
  await assert.rejects(
    () => upsertMigrationBatchInTransaction(sql, batch),
    (error) => error.code === "AUTH_MIGRATION_BATCH_PERSISTENCE_UNCONFIRMED"
  );
  assert.equal(calls.length, 3);
});

test("finalization owns the immutable SQL algorithm instead of delegating a custom batch writer", async () => {
  const evidence = await finalizedEvidence();
  const batch = testBatch(evidence);
  const calls = [];
  const sql = (strings, ...values) => {
    assertLegalParameterizedStatement(strings, values);
    const raw = Array.from(strings.raw || strings);
    calls.push({ strings: raw, values });
    return Promise.resolve(/INSERT INTO auth_migration_batches/iu.test(raw.join(""))
      ? [existingBatch(evidence)] : []);
  };
  sql.upsertMigrationBatch = () => {
    throw new Error("custom batch writer must not bypass immutable SQL checks");
  };
  const result = await upsertMigrationBatchInTransaction(sql, batch);
  assert.equal(result.inserted, true);
  assert.equal(calls.length, 2);
});

function existingBatch(evidence, overrides = {}) {
  return {
    source: "netlify_identity",
    environment_id: "production",
    site_id: "site-production",
    snapshot_id: evidence.report.snapshotId,
    snapshot_hash: Buffer.from(evidence.report.snapshotHash, "hex"),
    status: "reconciled",
    source_count: 2,
    imported_count: 2,
    conflict_count: 0,
    freeze_at: "2026-08-25T01:00:00.000Z",
    completed_at: "2026-08-25T03:00:00.000Z",
    ...overrides
  };
}

test("post-conflict replay reads the full immutable row and detects a differing row", async () => {
  const evidence = await finalizedEvidence();
  const batch = testBatch(evidence);
  const cases = [
    ["identical concurrent insert", existingBatch(evidence), false],
    ["different concurrent insert", existingBatch(evidence, { imported_count: 1 }), true]
  ];
  for (const [name, row, shouldConflict] of cases) {
    const calls = [];
    let selectCount = 0;
    const sql = (strings, ...values) => {
      assertLegalParameterizedStatement(strings, values);
      const text = Array.from(strings.raw || strings).join("");
      calls.push({ text, values });
      if (/SELECT[\s\S]*FROM auth_migration_batches/iu.test(text)) {
        selectCount += 1;
        if (selectCount === 1) return Promise.resolve([]);
        const fullRow = /status[\s\S]*source_count[\s\S]*imported_count[\s\S]*conflict_count[\s\S]*freeze_at[\s\S]*completed_at/iu.test(text)
          ? row
          : {
            source: row.source,
            environment_id: row.environment_id,
            site_id: row.site_id,
            snapshot_id: row.snapshot_id,
            snapshot_hash: row.snapshot_hash
          };
        return Promise.resolve([fullRow]);
      }
      if (/INSERT INTO auth_migration_batches/iu.test(text)) return Promise.resolve([]);
      throw new Error("unexpected SQL statement");
    };
    if (shouldConflict) {
      await assert.rejects(
        () => upsertMigrationBatchInTransaction(sql, batch),
        (error) => error.code === "AUTH_MIGRATION_BATCH_CONFLICT",
        name
      );
    } else {
      const result = await upsertMigrationBatchInTransaction(sql, batch);
      assert.equal(result.idempotent, true, name);
    }
    assert.equal(selectCount, 2);
    assert.equal(calls.filter(({ text }) => /INSERT INTO auth_migration_batches/iu.test(text)).length, 1);
  }
});

test("same-snapshot replay locks the exact row and never rewrites evidence", async () => {
  const evidence = await finalizedEvidence();
  const batch = testBatch(evidence);
  const existing = existingBatch(evidence);
  const calls = [];
  const sql = (strings, ...values) => {
    calls.push({ text: Array.from(strings.raw || strings).join(""), values });
    if (calls.length === 1) return Promise.resolve([existing]);
    throw new Error("unexpected batch mutation");
  };
  const result = await upsertMigrationBatchInTransaction(sql, batch);
  assert.equal(result.idempotent, true);
  assert.equal(calls.length, 1);
});

test("same snapshot with changed mutable evidence conflicts before SQL mutation", async () => {
  const evidence = await finalizedEvidence();
  const batch = testBatch(evidence);
  const variants = [
    ["source count", { source_count: 1 }],
    ["imported count", { imported_count: 1 }],
    ["conflict count", { conflict_count: 1 }],
    ["freeze timestamp", { freeze_at: "2026-08-25T00:00:00.000Z" }],
    ["completion timestamp", { completed_at: "2026-08-25T04:00:00.000Z" }],
    ["status", { status: "pending" }]
  ];
  for (const [name, override] of variants) {
    const calls = [];
    const sql = (strings, ...values) => {
      calls.push({ text: Array.from(strings.raw || strings).join(""), values });
      return Promise.resolve(calls.length === 1 ? [existingBatch(evidence, override)] : []);
    };
    await assert.rejects(
      () => upsertMigrationBatchInTransaction(sql, batch),
      (error) => error.code === "AUTH_MIGRATION_BATCH_CONFLICT" ||
        error.code === "AUTH_MIGRATION_DATABASE_EVIDENCE_REQUIRED",
      name
    );
    assert.equal(calls.length, 1, `${name} must stop before SQL mutation`);
  }
});

test("reconciliation passes when snapshot hash, counts, role distribution, and account IDs match", () => {
  const source = snapshot();
  const transformed = transformLegacySnapshot(source);
  const report = reconcileMigration(source, transformed.importable);

  assert.equal(report.ok, true);
  assert.equal(report.sourceSnapshotHash, transformed.snapshotHash);
  assert.deepEqual(report.sourceCounts, { profiles: 2, identityUsers: 2 });
  assert.deepEqual(report.importedCounts, { accounts: 2, identities: 2 });
  assert.deepEqual(report.missingAccountIds, []);
  assert.deepEqual(report.extraAccountIds, []);
  assert.deepEqual(report.roleDistribution.source, { pending: 0, free: 1, vip: 1, admin: 0, blocked: 0 });
  assert.deepEqual(report.roleDistribution.imported, { pending: 0, free: 1, vip: 1, admin: 0, blocked: 0 });
});

test("reconciliation reports source hash and missing/extra rows without mutating input", () => {
  const source = snapshot();
  const transformed = transformLegacySnapshot(source);
  const imported = transformed.importable.slice(0, 1).concat({
    source: "netlify_identity",
    source_user_id: "legacy-extra",
    account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    role: "free",
    status: "active"
  });
  const before = JSON.stringify(imported);
  const report = buildReconciliationReport({
    snapshot: source,
    sourceReport: transformed,
    importedRows: imported,
    sourceSnapshotHash: "0".repeat(64)
  });

  assert.equal(report.ok, false);
  assert.notEqual(report.sourceSnapshotHash, "0".repeat(64));
  assert.equal(report.reviewedSnapshotHash, "0".repeat(64));
  assert.ok(report.hashMismatch);
  assert.equal(report.missingAccountIds.length, 1);
  assert.deepEqual(report.extraAccountIds, ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
  assert.equal(JSON.stringify(imported), before);
});

test("reconciliation fails closed for a duplicate imported source key", () => {
  const source = snapshot();
  const transformed = transformLegacySnapshot(source);
  const imported = transformed.importable.concat({ ...transformed.importable[0] });
  const report = reconcileMigration(source, imported);

  assert.equal(report.ok, false);
  assert.ok(report.duplicateSourceKeys.includes("netlify_identity\u0000legacy-free") ||
    report.duplicateSourceKeys.includes("netlify_identity:legacy-free"));
});

test("reconciliation rejects swapped source-to-account mappings and row snapshot hash changes", () => {
  const source = snapshot();
  const transformed = transformLegacySnapshot(source);
  const [first, second] = transformed.importable;
  const swapped = [
    { ...first, account_id: second.account_id },
    { ...second, account_id: first.account_id }
  ];
  const swappedReport = reconcileMigration(source, swapped);
  assert.equal(swappedReport.ok, false);
  assert.equal(swappedReport.mappingMismatches.length, 2);

  const changedHash = [{ ...first, snapshot_hash: "0".repeat(64) }, second];
  const hashReport = reconcileMigration(source, changedHash);
  assert.equal(hashReport.ok, false);
  assert.equal(hashReport.snapshotHashMismatches.length, 1);
  assert.equal(hashReport.snapshotHashMismatches[0].sourceKey, "netlify_identity\u0000legacy-free");
});

test("reconciliation does not trust a tampered source report over the snapshot", () => {
  const source = snapshot();
  const transformed = transformLegacySnapshot(source);
  const tamperedReport = {
    ...transformed,
    importable: transformed.importable.map((row) => ({
      ...row,
      account_id: row.account_id.replace(/^./u, "f")
    }))
  };
  const report = buildReconciliationReport({
    snapshot: source,
    sourceReport: tamperedReport,
    importedRows: transformed.importable
  });
  assert.equal(report.ok, false);
  assert.equal(report.sourceReportMismatch, true);
});

test("snapshot and dry-run helpers remain fixture-only and produce a stable hash", () => {
  const source = snapshot();
  const captured = createSnapshot({
    migrationId: source.migrationId,
    snapshotId: source.snapshotId,
    freezeAt: "2026-08-25T02:00:00.000Z",
    adminEmails: source.adminEmails,
    profiles: source.profiles,
    identityUsers: source.identityUsers
  });
  const report = dryRunSnapshot(captured);

  assert.equal(captured.snapshotHash, report.snapshotHash);
  assert.equal(report.importable.length, 2);
  assert.deepEqual(source.profiles[0], {
    email: "vip@example.com",
    role: "vip",
    status: "approved",
    guild: "Shine",
    gameName: "VIP"
  });
});

test("snapshot creation requires both explicit source arrays", () => {
  assert.throws(
    () => createSnapshot({ migrationId: "migration-missing-profiles", identityUsers: [] }),
    (error) => error.message === "MIGRATION_PROFILES_REQUIRED"
  );
  assert.throws(
    () => createSnapshot({ migrationId: "migration-missing-identities", profiles: [] }),
    (error) => error.message === "MIGRATION_IDENTITY_USERS_REQUIRED"
  );
});

test("Identity snapshot reader uses bounded 1-based pagination and stops on a short page", async () => {
  const requested = [];
  const pages = [
    [{ id: "one" }, { id: "two" }],
    [{ id: "three" }, { id: "four" }],
    [{ id: "five" }]
  ];
  const readers = createNetlifyReadOnlyReaders({
    getStore: () => ({ async list() { return { blobs: [] }; } }),
    identityAdmin: {
      async listUsers(options) {
        requested.push(options);
        return pages[options.page - 1];
      }
    },
    identityPageSize: 2,
    identityMaxPages: 4
  });
  assert.deepEqual((await readers.listIdentityUsers()).map(({ id }) => id), ["one", "two", "three", "four", "five"]);
  assert.deepEqual(requested, [
    { page: 1, perPage: 2 },
    { page: 2, perPage: 2 },
    { page: 3, perPage: 2 }
  ]);
});

test("Identity pagination stops on an empty terminal page and propagates intermediate failures", async () => {
  const requested = [];
  const base = {
    getStore: () => ({ async list() { return { blobs: [] }; } }),
    identityPageSize: 1,
    identityMaxPages: 3
  };
  const emptyReaders = createNetlifyReadOnlyReaders({
    ...base,
    identityAdmin: { async listUsers({ page, perPage }) {
      requested.push({ page, perPage });
      return page === 1 ? [{ id: "one" }] : [];
    } }
  });
  assert.deepEqual(await emptyReaders.listIdentityUsers(), [{ id: "one" }]);
  assert.deepEqual(requested, [{ page: 1, perPage: 1 }, { page: 2, perPage: 1 }]);

  const failingReaders = createNetlifyReadOnlyReaders({
    ...base,
    identityAdmin: { async listUsers({ page }) {
      if (page === 2) throw new Error("page failed");
      return [{ id: "one" }];
    } }
  });
  await assert.rejects(() => failingReaders.listIdentityUsers(), /page failed/);
});

test("snapshot and dry-run CLIs keep plaintext email out of stdout and create sensitive files as 0600 without clobbering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "migration-private-output-"));
  const profilesFile = join(directory, "profiles.json");
  const identitiesFile = join(directory, "identities.json");
  const snapshotFile = join(directory, "snapshot.json");
  const reportFile = join(directory, "report.json");
  const email = "private-fixture@example.com";
  try {
    await writeFile(profilesFile, JSON.stringify([{ email, role: "free", status: "approved" }]));
    await writeFile(identitiesFile, JSON.stringify([{ id: "legacy-private", email, email_verified: true }]));
    const snapshotRun = spawnSync(process.execPath, [
      resolve("scripts/auth-migration/snapshot.mjs"),
      "--migration-id", "migration-private",
      "--freeze-at", "2026-08-25T01:00:00.000Z",
      "--profiles-file", profilesFile,
      "--identity-users-file", identitiesFile,
      "--output", snapshotFile
    ], { encoding: "utf8" });
    assert.equal(snapshotRun.status, 0, snapshotRun.stderr);
    assert.doesNotMatch(snapshotRun.stdout, /private-fixture@example\.com/u);
    assert.match(await readFile(snapshotFile, "utf8"), /private-fixture@example\.com/u);
    assert.equal((await stat(snapshotFile)).mode & 0o777, 0o600);

    const duplicateRun = spawnSync(process.execPath, [
      resolve("scripts/auth-migration/snapshot.mjs"),
      "--migration-id", "migration-private",
      "--profiles-file", profilesFile,
      "--identity-users-file", identitiesFile,
      "--output", snapshotFile
    ], { encoding: "utf8" });
    assert.notEqual(duplicateRun.status, 0);
    assert.match(await readFile(snapshotFile, "utf8"), /private-fixture@example\.com/u);

    const dryRun = spawnSync(process.execPath, [
      resolve("scripts/auth-migration/dry-run.mjs"),
      "--snapshot-file", snapshotFile,
      "--output", reportFile
    ], { encoding: "utf8" });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.doesNotMatch(dryRun.stdout, /private-fixture@example\.com/u);
    assert.match(await readFile(reportFile, "utf8"), /private-fixture@example\.com/u);
    assert.equal((await stat(reportFile)).mode & 0o777, 0o600);

    const importPreview = spawnSync(process.execPath, [
      resolve("scripts/auth-migration/import.mjs"),
      "--snapshot-file", snapshotFile
    ], { encoding: "utf8" });
    assert.equal(importPreview.status, 0, importPreview.stderr);
    assert.doesNotMatch(importPreview.stdout, /private-fixture@example\.com/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dry-run output carries reviewed migration identity and composes with runImport separately from its source snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task7-dry-run-review-"));
  const snapshotFile = join(directory, "snapshot.json");
  const reviewedFile = join(directory, "reviewed-report.json");
  const source = createSnapshot({
    ...snapshot(),
    freezeAt: "2026-08-25T02:00:00.000Z"
  });
  try {
    await writeFile(snapshotFile, `${JSON.stringify(source)}\n`, { encoding: "utf8", flag: "wx" });
    const dryReport = await runDryRun({ snapshotFile, outputFile: reviewedFile });
    const reviewedReport = JSON.parse(await readFile(reviewedFile, "utf8"));
    assert.equal(reviewedReport.migrationId, source.migrationId);
    assert.equal(reviewedReport.freezeAt, source.freezeAt);
    assert.equal(reviewedReport.snapshotId, dryReport.snapshotId);
    assert.equal(reviewedReport.snapshotHash, dryReport.snapshotHash);
    assert.equal(Object.hasOwn(reviewedReport, "profiles"), false);
    assert.equal(Object.hasOwn(reviewedReport, "identityUsers"), false);

    const result = await runImport({
      snapshotFile,
      reviewedSnapshotFile: reviewedFile,
      snapshotId: dryReport.snapshotId,
      snapshotHash: dryReport.snapshotHash,
      env: { MIGRATION_WRITE_MODE: "frozen", AUTH_ENV_ID: "production" },
      apply: true,
      adapter: createMemoryImportAdapter()
    });
    assert.equal(result.applied, true);
    assert.equal(result.imported, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("import dry-run never invokes an adapter, while frozen production apply is idempotent", async () => {
  const source = createSnapshot({
    ...snapshot(),
    freezeAt: "2026-08-25T02:00:00.000Z"
  });
  const report = dryRunSnapshot(source);
  const adapter = createMemoryImportAdapter();
  const dryRun = await importSnapshot(source, {
    env: { MIGRATION_WRITE_MODE: "legacy", AUTH_ENV_ID: "stage" },
    apply: false,
    adapter,
    reviewedSnapshot: source
  });
  assert.equal(dryRun.applied, false);
  assert.equal(adapter.rows().length, 0);

  const applied = await importSnapshot(source, {
    env: PRODUCTION_ENV,
    apply: true,
    snapshotId: report.snapshotId,
    snapshotHash: report.snapshotHash,
    adapter,
    reviewedSnapshot: source
  });
  const replay = await importSnapshot(source, {
    env: { MIGRATION_WRITE_MODE: "frozen", AUTH_ENV_ID: "production" },
    apply: true,
    snapshotId: report.snapshotId,
    snapshotHash: report.snapshotHash,
    adapter,
    reviewedSnapshot: source
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.imported, 2);
  assert.equal(replay.imported, 0);
  assert.equal(replay.skipped, 2);
  assert.equal(adapter.rows().length, 2);
});

test("import adapter independently rejects a row without explicit verified email evidence", async () => {
  const adapter = createMemoryImportAdapter();
  const transformed = transformLegacySnapshot(snapshot()).importable[0];
  for (const emailVerified of [false, null, undefined]) {
    await assert.rejects(
      () => adapter.importRows([{ ...transformed, email_verified: emailVerified }]),
      (error) => error.code === "AUTH_MIGRATION_EMAIL_UNVERIFIED"
    );
  }
  assert.equal(adapter.rows().length, 0);
});

test("import apply refuses non-frozen mode, non-production, and unreviewed snapshot identity", async () => {
  const source = createSnapshot({ ...snapshot(), freezeAt: "2026-08-25T02:00:00.000Z" });
  const adapter = createMemoryImportAdapter();
  await assert.rejects(
    () => importSnapshot(source, {
      env: { MIGRATION_WRITE_MODE: "legacy", AUTH_ENV_ID: "production" },
      apply: true,
      snapshotId: source.snapshotId,
      snapshotHash: source.snapshotHash,
      adapter,
      reviewedSnapshot: source
    }),
    (error) => error.code === "AUTH_MIGRATION_IMPORT_MODE_REQUIRED"
  );
  await assert.rejects(
    () => importSnapshot(source, {
      env: { MIGRATION_WRITE_MODE: "frozen", AUTH_ENV_ID: "stage" },
      apply: true,
      snapshotId: source.snapshotId,
      snapshotHash: source.snapshotHash,
      adapter,
      reviewedSnapshot: source
    }),
    (error) => error.code === "AUTH_MIGRATION_PRODUCTION_REQUIRED"
  );
  await assert.rejects(
    () => importSnapshot(source, {
      env: { MIGRATION_WRITE_MODE: "frozen", AUTH_ENV_ID: "production" },
      apply: true,
      snapshotId: source.snapshotId,
      snapshotHash: "0".repeat(64),
      adapter,
      reviewedSnapshot: source
    }),
    (error) => error.code === "AUTH_MIGRATION_SNAPSHOT_MISMATCH"
  );
  assert.equal(adapter.rows().length, 0);
});

test("apply requires a matching reviewed snapshot and a valid freezeAt before loading an adapter", async () => {
  const source = createSnapshot({ ...snapshot(), freezeAt: "2026-08-25T02:00:00.000Z" });
  const adapter = createMemoryImportAdapter();
  await assert.rejects(
    () => importSnapshot(source, {
      env: { MIGRATION_WRITE_MODE: "frozen", AUTH_ENV_ID: "production" },
      apply: true,
      snapshotId: source.snapshotId,
      snapshotHash: source.snapshotHash,
      adapter
    }),
    (error) => error.code === "AUTH_MIGRATION_REVIEW_REQUIRED"
  );
  await assert.rejects(
    () => importSnapshot(source, {
      env: { MIGRATION_WRITE_MODE: "frozen", AUTH_ENV_ID: "production" },
      apply: true,
      snapshotId: source.snapshotId,
      snapshotHash: source.snapshotHash,
      reviewedSnapshot: { ...source, freezeAt: "2026-08-25T03:00:00.000Z" },
      adapter
    }),
    (error) => error.code === "AUTH_MIGRATION_REVIEW_MISMATCH"
  );
  await assert.rejects(
    () => importSnapshot({ ...source, freezeAt: "not-a-time" }, {
      env: { MIGRATION_WRITE_MODE: "frozen", AUTH_ENV_ID: "production" },
      apply: true,
      snapshotId: source.snapshotId,
      snapshotHash: transformLegacySnapshot({ ...source, freezeAt: "not-a-time" }).snapshotHash,
      reviewedSnapshot: { ...source, freezeAt: "not-a-time" },
      adapter
    }),
    (error) => error.code === "AUTH_MIGRATION_FREEZE_AT_INVALID"
  );
});

test("runImport requires a reviewed snapshot file and rejects before adapter loading", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task7-review-"));
  const snapshotFile = join(directory, "snapshot.json");
  await writeFile(snapshotFile, JSON.stringify(createSnapshot({ ...snapshot(), freezeAt: "2026-08-25T02:00:00.000Z" })));
  let adapterLoaded = false;
  try {
    await assert.rejects(
      () => runImport({
        snapshotFile,
        apply: true,
        snapshotId: "snapshot-reconcile",
        snapshotHash: "0".repeat(64),
        env: { MIGRATION_WRITE_MODE: "frozen", AUTH_ENV_ID: "production" },
        adapterLoader: async () => {
          adapterLoaded = true;
          return createMemoryImportAdapter();
        }
      }),
      (error) => error.code === "AUTH_MIGRATION_REVIEW_FILE_REQUIRED"
    );
    assert.equal(adapterLoaded, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runImport rejects file-only finalization before importing any rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "migration-file-only-finalize-"));
  const snapshotFile = join(directory, "snapshot.json");
  const reviewedFile = join(directory, "reviewed.json");
  const source = createSnapshot({ ...snapshot(), freezeAt: "2026-08-25T02:00:00.000Z" });
  const report = dryRunSnapshot(source);
  let importCalls = 0;
  try {
    await writeFile(snapshotFile, JSON.stringify(source));
    await writeFile(reviewedFile, JSON.stringify(report));
    await assert.rejects(
      () => runImport({
        snapshotFile,
        reviewedSnapshotFile: reviewedFile,
        snapshotId: report.snapshotId,
        snapshotHash: report.snapshotHash,
        apply: true,
        finalize: true,
        reconciliationReport: { ...report, status: "reconciled", completedAt: "2026-08-25T03:00:00.000Z" },
        adapter: { async importRows() { importCalls += 1; return { imported: 2, skipped: 0 }; } },
        batchAdapter: batchMemoryAdapter(),
        env: PRODUCTION_ENV,
        now: new Date("2026-08-25T03:00:00.000Z")
      }),
      (error) => error.code === "AUTH_MIGRATION_DATABASE_EVIDENCE_REQUIRED"
    );
    assert.equal(importCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed snapshots with missing source arrays fail closed before returning an empty import", async () => {
  const malformed = { ...snapshot() };
  delete malformed.identityUsers;
  await assert.rejects(
    () => importSnapshot(malformed, { apply: false }),
    (error) => error.message === "MIGRATION_IDENTITY_USERS_REQUIRED"
  );
});

test("Postgres adapter is not exposed as a public direct-write constructor", async () => {
  const module = await import("../../scripts/auth-migration/import.mjs");
  assert.equal(Object.hasOwn(module, "createPostgresImportAdapter"), false);
});

test("Postgres import adapter requires injected local dependencies and writes the four migration records transactionally", async () => {
  const source = createSnapshot({ ...snapshot(), freezeAt: "2026-08-25T02:00:00.000Z" });
  const report = dryRunSnapshot(source);
  const calls = [];
  const insertTables = new Set();
  const state = new Map();
  const fakeSql = (strings, ...values) => {
    const parts = Array.from(strings.raw || strings);
    const text = parts.reduce((result, part, index) => `${result}${part}${index < values.length ? "<param>" : ""}`, "");
    const insertTable = assertLegalParameterizedInsert(strings, values);
    if (insertTable) insertTables.add(insertTable);
    calls.push({ text, values });
    return Promise.resolve(successfulImportResponse(text, values, state));
  };
  fakeSql.savepoint = () => {};
  const postgresAdapterOptions = {
    sql: fakeSql,
    withTransaction: async (callback) => callback(fakeSql),
    environmentId: "production",
    siteId: "site-production",
    emailLookupHash: async () => Buffer.alloc(32, 1),
    encryptEmail: async () => Buffer.from("encrypted-email"),
    encryptionKeyVersion: 1
  };
  await assert.rejects(
    () => importSnapshot(source, {
      env: { MIGRATION_WRITE_MODE: "frozen", AUTH_ENV_ID: "production" },
      apply: true,
      snapshotId: report.snapshotId,
      snapshotHash: report.snapshotHash,
      reviewedSnapshot: source
    }),
    (error) => error.code === "AUTH_MIGRATION_ADAPTER_REQUIRED"
  );
  const result = await importSnapshot(source, {
    env: { MIGRATION_WRITE_MODE: "frozen", AUTH_ENV_ID: "production" },
    apply: true,
    snapshotId: report.snapshotId,
    snapshotHash: report.snapshotHash,
    reviewedSnapshot: source,
    postgresAdapterOptions
  });
  assert.equal(result.imported, 2);
  assert.ok(calls.some((call) => /insert into migration_records/i.test(call.text)));
  assert.ok(calls.some((call) => /insert into account_emails/i.test(call.text)));
  assert.ok(calls.some((call) => /insert into auth_identities/i.test(call.text)));
  assert.deepEqual([...insertTables].sort(), ["account_emails", "accounts", "auth_identities", "migration_records"]);
  const lockIndex = calls.findIndex(({ text }) => /pg_advisory_xact_lock/iu.test(text));
  const migrationReadIndex = calls.findIndex(({ text }) => /SELECT migration_id/iu.test(text));
  assert.ok(lockIndex >= 0 && lockIndex < migrationReadIndex);
});

test("Postgres importer verifies a conflicting account winner after ON CONFLICT DO NOTHING", async () => {
  const source = createSnapshot({ ...snapshot(), profiles: [snapshot().profiles[0]], identityUsers: [snapshot().identityUsers[0]] });
  const report = dryRunSnapshot(source);
  let accountReads = 0;
  const calls = [];
  const sql = (strings, ...values) => {
    const text = Array.from(strings.raw || strings).join("");
    calls.push(text);
    if (/pg_advisory_xact_lock/iu.test(text)) return [];
    if (/FROM auth_migration_batches/iu.test(text)) return [];
    if (/FROM migration_records m/iu.test(text)) return [];
    if (/SELECT migration_id/iu.test(text)) return [];
    if (/SELECT account_id, role/iu.test(text)) {
      accountReads += 1;
      return accountReads === 1 ? [] : [{
        account_id: report.importable[0].account_id,
        role: "admin",
        status: "active",
        guild: "Shine",
        game_name: "VIP",
        migration_id: null,
        blocked_at: null
      }];
    }
    if (/INSERT INTO accounts/iu.test(text)) return [];
    throw new Error(`unexpected query after account winner: ${text}`);
  };
  await assert.rejects(
    () => importSnapshot(source, {
      env: PRODUCTION_ENV,
      apply: true,
      snapshotId: report.snapshotId,
      snapshotHash: report.snapshotHash,
      reviewedSnapshot: source,
      postgresAdapterOptions: {
        sql,
        withTransaction: async (callback) => callback(sql),
        environmentId: "production",
        siteId: "site-production",
        emailLookupHash: async () => Buffer.alloc(32, 5),
        encryptEmail: async () => Buffer.from("encrypted-email"),
        encryptionKeyVersion: 2
      }
    }),
    (error) => error.code === "AUTH_MIGRATION_PERSISTED_STATE_CONFLICT"
  );
  assert.equal(calls.some((text) => /INSERT INTO migration_records/iu.test(text)), false);
});

test("Postgres importer verifies the exact migration-record winner after ON CONFLICT DO NOTHING", async () => {
  const source = createSnapshot({ ...snapshot(), profiles: [snapshot().profiles[0]], identityUsers: [snapshot().identityUsers[0]] });
  const report = dryRunSnapshot(source);
  let migrationReads = 0;
  const sql = (strings, ...values) => {
    const text = Array.from(strings.raw || strings).join("");
    if (/pg_advisory_xact_lock/iu.test(text)) return [];
    if (/FROM auth_migration_batches/iu.test(text)) return [];
    if (/FROM migration_records m/iu.test(text)) return [];
    if (/SELECT migration_id/iu.test(text)) {
      migrationReads += 1;
      return migrationReads === 1 ? [] : [{
        migration_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        account_id: report.importable[0].account_id,
        snapshot_hash: Buffer.alloc(32, 9),
        status: "imported"
      }];
    }
    if (/SELECT account_id, role/iu.test(text)) return [];
    if (/INSERT INTO accounts/iu.test(text)) return [{
      account_id: report.importable[0].account_id,
      role: report.importable[0].role,
      status: report.importable[0].status,
      guild: report.importable[0].guild,
      game_name: report.importable[0].game_name,
      migration_id: null,
      blocked_at: null
    }];
    if (/INSERT INTO migration_records/iu.test(text)) return [];
    throw new Error(`unexpected query after migration winner: ${text}`);
  };
  await assert.rejects(
    () => importSnapshot(source, {
      env: PRODUCTION_ENV,
      apply: true,
      snapshotId: report.snapshotId,
      snapshotHash: report.snapshotHash,
      reviewedSnapshot: source,
      postgresAdapterOptions: {
        sql,
        withTransaction: async (callback) => callback(sql),
        environmentId: "production",
        siteId: "site-production",
        emailLookupHash: async () => Buffer.alloc(32, 6),
        encryptEmail: async () => Buffer.from("encrypted-email"),
        encryptionKeyVersion: 2
      }
    }),
    (error) => error.code === "AUTH_MIGRATION_PERSISTED_STATE_CONFLICT"
  );
});

test("Postgres adapter persists blocked_at and preserves verified claims with freezeAt fallback", async () => {
  const source = createSnapshot({
    snapshotId: "snapshot-blocked-verified",
    migrationId: "migration-blocked-verified",
    freezeAt: "2026-08-25T02:00:00.000Z",
    profiles: [{ email: "blocked@example.com", role: "blocked", status: "blocked", guild: "Shine", gameName: "Blocked" }],
    identityUsers: [identity("legacy-blocked", "blocked@example.com", { email_verified: true, confirmed_at: undefined })]
  });
  const report = dryRunSnapshot(source);
  const calls = [];
  const state = new Map();
  const fakeSql = (strings, ...values) => {
    const parts = Array.from(strings.raw || strings);
    const text = parts.reduce((result, part, index) => `${result}${part}${index < values.length ? "<param>" : ""}`, "");
    assertLegalParameterizedInsert(strings, values);
    calls.push({ text, values });
    return Promise.resolve(successfulImportResponse(text, values, state));
  };
  const postgresAdapterOptions = {
    sql: fakeSql,
    withTransaction: async (callback) => callback(fakeSql),
    environmentId: "production",
    siteId: "site-production",
    emailLookupHash: async () => Buffer.alloc(32, 2),
    encryptEmail: async () => Buffer.from("encrypted-email"),
    encryptionKeyVersion: 1
  };
  const result = await importSnapshot(source, {
    env: { MIGRATION_WRITE_MODE: "frozen", AUTH_ENV_ID: "production" },
    apply: true,
    snapshotId: report.snapshotId,
    snapshotHash: report.snapshotHash,
    reviewedSnapshot: source,
    postgresAdapterOptions
  });
  assert.equal(result.imported, 1);
  const accountInsert = calls.find((call) => /insert into accounts/i.test(call.text));
  assert.equal(accountInsert.values[5], source.freezeAt);
  const emailInsert = calls.find((call) => /insert into account_emails/i.test(call.text));
  assert.equal(emailInsert.values[5], source.freezeAt);
});

test("Postgres importer requires a positive encryption key version and persists non-default versions", async () => {
  const source = createSnapshot({ ...snapshot(), profiles: [snapshot().profiles[0]], identityUsers: [snapshot().identityUsers[0]] });
  const report = dryRunSnapshot(source);
  const calls = [];
  let encryptOptions;
  const state = new Map();
  const fakeSql = (strings, ...values) => {
    const text = Array.from(strings.raw || strings).join("");
    calls.push({ text, values });
    return Promise.resolve(successfulImportResponse(text, values, state));
  };
  const baseOptions = {
    sql: fakeSql,
    withTransaction: async (callback) => callback(fakeSql),
    environmentId: "production",
    siteId: "site-production",
    emailLookupHash: async () => Buffer.alloc(32, 4),
    encryptEmail: async (_email, options) => { encryptOptions = options; return Buffer.from("encrypted-email"); }
  };
  for (const invalid of [undefined, 0, -1, 1.5, "0", "not-a-version"]) {
    await assert.rejects(
      () => importSnapshot(source, {
        env: PRODUCTION_ENV,
        apply: true,
        snapshotId: report.snapshotId,
        snapshotHash: report.snapshotHash,
        reviewedSnapshot: source,
        postgresAdapterOptions: { ...baseOptions, encryptionKeyVersion: invalid }
      }),
      (error) => error.code === "AUTH_MIGRATION_ENCRYPTION_KEY_VERSION_INVALID"
    );
  }
  calls.length = 0;
  await importSnapshot(source, {
    env: PRODUCTION_ENV,
    apply: true,
    snapshotId: report.snapshotId,
    snapshotHash: report.snapshotHash,
    reviewedSnapshot: source,
    postgresAdapterOptions: { ...baseOptions, encryptionKeyVersion: 7 }
  });
  assert.equal(encryptOptions.keyVersion, 7);
  const emailInsert = calls.find(({ text }) => /INSERT INTO account_emails/iu.test(text));
  assert.match(emailInsert.text, /encryption_key_version/iu);
  assert.equal(emailInsert.values[3], 7);
});

test("pending or frozen migration records are not treated as completed replay skips", async () => {
  const source = createSnapshot({
    snapshotId: "snapshot-pending-record",
    migrationId: "migration-pending-record",
    freezeAt: "2026-08-25T02:00:00.000Z",
    profiles: [{ email: "free@example.com", role: "free", status: "approved" }],
    identityUsers: [identity("legacy-free", "free@example.com")]
  });
  const report = dryRunSnapshot(source);
  const pendingSql = (strings, ...values) => {
    const parts = Array.from(strings.raw || strings);
    const text = parts.reduce((result, part, index) => `${result}${part}${index < values.length ? "<param>" : ""}`, "");
    if (/select migration_id/i.test(text)) {
      return Promise.resolve([{
        migration_id: deriveAccountId(`${report.importable[0].migration_id}:record`, `${report.importable[0].source}:${report.importable[0].source_user_id}`),
        account_id: report.importable[0].account_id,
        snapshot_hash: Buffer.from(report.snapshotHash, "hex"),
        status: "pending"
      }]);
    }
    return Promise.resolve([]);
  };
  const postgresAdapterOptions = {
    sql: pendingSql,
    withTransaction: async (callback) => callback(pendingSql),
    environmentId: "production",
    siteId: "site-production",
    emailLookupHash: async () => Buffer.alloc(32, 3),
    encryptEmail: async () => Buffer.from("encrypted-email"),
    encryptionKeyVersion: 1
  };
  await assert.rejects(
    () => importSnapshot(source, {
      env: { MIGRATION_WRITE_MODE: "frozen", AUTH_ENV_ID: "production" },
      apply: true,
      snapshotId: report.snapshotId,
      snapshotHash: report.snapshotHash,
      reviewedSnapshot: source,
      postgresAdapterOptions
    }),
    (error) => error.code === "AUTH_MIGRATION_PERSISTED_STATE_CONFLICT"
  );
});

test("completed replay verifies migration ID and current account role/status before skipping", async () => {
  const source = createSnapshot({ ...snapshot(), profiles: [snapshot().profiles[0]], identityUsers: [snapshot().identityUsers[0]] });
  const report = dryRunSnapshot(source);
  const row = report.importable[0];
  const baseOptions = {
    environmentId: "production",
    siteId: "site-production",
    emailLookupHash: async () => Buffer.alloc(32, 8),
    encryptEmail: async () => Buffer.from("encrypted-email"),
    encryptionKeyVersion: 3
  };
  for (const variant of ["migration-id", "account-role"]) {
    const sql = (strings) => {
      const text = Array.from(strings.raw || strings).join("");
      if (/pg_advisory_xact_lock/iu.test(text)) return [];
      if (/FROM auth_migration_batches/iu.test(text)) return [];
      if (/FROM migration_records m/iu.test(text)) return [];
      if (/SELECT migration_id/iu.test(text)) return [{
        migration_id: variant === "migration-id" ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : deriveAccountId(`${row.migration_id}:record`, `${row.source}:${row.source_user_id}`),
        account_id: row.account_id,
        snapshot_hash: Buffer.from(row.snapshot_hash, "hex"),
        status: "imported"
      }];
      if (/SELECT account_id, role/iu.test(text)) {
        return [{ account_id: row.account_id, role: "admin", status: row.status, migration_id: deriveAccountId(`${row.migration_id}:record`, `${row.source}:${row.source_user_id}`) }];
      }
      throw new Error(`unexpected replay query: ${text}`);
    };
    await assert.rejects(
      () => importSnapshot(source, {
        env: PRODUCTION_ENV,
        apply: true,
        snapshotId: report.snapshotId,
        snapshotHash: report.snapshotHash,
        reviewedSnapshot: source,
        postgresAdapterOptions: { ...baseOptions, sql, withTransaction: async (callback) => callback(sql) }
      }),
      (error) => ["AUTH_MIGRATION_IDEMPOTENCY_CONFLICT", "AUTH_MIGRATION_PERSISTED_STATE_CONFLICT"].includes(error.code),
      variant
    );
  }
});

function oneRowSnapshot() {
  const base = snapshot();
  return createSnapshot({
    ...base,
    profiles: [base.profiles[0]],
    identityUsers: [base.identityUsers[0]],
    freezeAt: "2026-08-25T02:00:00.000Z"
  });
}

function exactLegacyGraph(source, { encryptionKeyVersion = 3 } = {}) {
  const report = dryRunSnapshot(source);
  const row = report.importable[0];
  const migrationId = deriveAccountId(`${row.migration_id}:record`, `${row.source}:${row.source_user_id}`);
  const emailHash = Buffer.alloc(32, 8);
  return {
    report,
    row,
    migrationId,
    emailHash,
    account: {
      account_id: row.account_id,
      role: row.role,
      status: row.status,
      guild: row.guild,
      game_name: row.game_name,
      authz_version: "1",
      merged_into_account_id: null,
      migration_id: migrationId,
      blocked_at: null
    },
    migration: {
      migration_id: migrationId,
      source: row.source,
      source_user_id: row.source_user_id,
      legacy_netlify_user_id: row.source_user_id,
      account_id: row.account_id,
      legacy_email_lookup_hash: emailHash,
      snapshot_hash: Buffer.from(row.snapshot_hash, "hex"),
      status: "imported",
      error_code: null,
      freeze_at: source.freezeAt,
      created_at: "2026-08-25T03:00:00.000Z",
      completed_at: "2026-08-25T03:00:00.000Z"
    },
    email: {
      email_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      account_id: row.account_id,
      email_lookup_hash: emailHash,
      encrypted_email: Buffer.from("encrypted-email"),
      encryption_key_version: encryptionKeyVersion,
      is_primary: true,
      verified_at: row.email_confirmed_at,
      removed_at: null
    },
    identity: {
      identity_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      account_id: row.account_id,
      issuer_or_tenant: "netlify_identity",
      connector_scope: "legacy",
      provider_subject: row.source_user_id,
      subject_type: "netlify_user_id",
      logto_user_id: null,
      status: "active",
      revoked_at: null
    }
  };
}

function atomicOwnerAdapter(graph) {
  let storedBatch = null;
  let transactions = 0;
  let readTransactions = 0;
  const calls = [];
  let activeTransaction = null;
  const transaction = (strings, ...values) => {
    const sql = Array.from(strings.raw || strings).join("");
    calls.push({ sql, values, transaction: activeTransaction });
    if (/pg_advisory_xact_lock/iu.test(sql)) return [];
    if (/SELECT[\s\S]*FROM migration_records[\s\S]*WHERE source/iu.test(sql) && !/JOIN accounts/iu.test(sql)) {
      return graph.population || [{
        migration_id: graph.migration.migration_id,
        source_user_id: graph.migration.source_user_id,
        account_id: graph.migration.account_id,
        snapshot_hash: graph.migration.snapshot_hash
      }];
    }
    if (/FROM migration_records m[\s\S]*JOIN accounts a/iu.test(sql)) {
      return [{
        ...graph.migration,
        account_role: graph.account.role,
        account_status: graph.account.status,
        account_guild: graph.account.guild,
        account_game_name: graph.account.game_name,
        account_authz_version: graph.account.authz_version,
        account_merged_into_account_id: graph.account.merged_into_account_id,
        account_migration_id: graph.account.migration_id,
        account_blocked_at: graph.account.blocked_at
      }];
    }
    if (/FROM account_emails/iu.test(sql)) return [graph.email];
    if (/FROM auth_identities/iu.test(sql)) return [graph.identity];
    if (/SELECT[\s\S]*FROM auth_migration_batches/iu.test(sql)) return storedBatch ? [storedBatch] : [];
    if (/INSERT INTO auth_migration_batches/iu.test(sql)) {
      storedBatch = {
        source: values[0],
        environment_id: values[1],
        site_id: values[2],
        snapshot_id: values[3],
        snapshot_hash: Buffer.from(values[4]),
        status: values[5],
        source_count: values[6],
        imported_count: values[7],
        conflict_count: values[8],
        freeze_at: values[9],
        completed_at: values[10]
      };
      return [storedBatch];
    }
    throw new Error(`unexpected atomic finalization SQL: ${sql}`);
  };
  const adapter = {
    get storedBatch() { return storedBatch; },
    get transactions() { return transactions; },
    get readTransactions() { return readTransactions; },
    get calls() { return calls; },
    async withTransaction(callback) {
      transactions += 1;
      activeTransaction = transactions;
      return callback(transaction);
    },
    async withReadOnlyTransaction(callback) {
      readTransactions += 1;
      activeTransaction = `read-${readTransactions}`;
      return callback(transaction);
    }
  };
  return adapter;
}

test("production finalization reads, locks, validates, freezes, and writes in one owner transaction", async () => {
  const source = oneRowSnapshot();
  const graph = exactLegacyGraph(source);
  const adapter = atomicOwnerAdapter(graph);
  const input = {
    snapshot: source,
    reviewedSnapshot: source,
    sourceReport: graph.report,
    source: "netlify_identity",
    environmentId: "production",
    siteId: "site-production",
    adapter,
    emailLookupHash: async () => Buffer.from(graph.emailHash),
    encryptionKeyVersion: 3,
    env: PRODUCTION_ENV,
    now: new Date("2026-08-25T03:00:00.000Z")
  };
  const first = await finalizeMigrationBatch(input);
  const replay = await finalizeMigrationBatch({
    ...input,
    now: new Date("2026-08-25T04:00:00.000Z")
  });
  assert.equal(first.finalized, true);
  assert.equal(replay.idempotent, true);
  assert.equal(adapter.transactions, 2);
  assert.equal(adapter.storedBatch.completed_at, "2026-08-25T03:00:00.000Z");
  assert.equal(replay.batch.completedAt, "2026-08-25T03:00:00.000Z");
  assert.equal(Object.isFrozen(first.report), true);
  assert.equal(Object.isFrozen(first.report.roleDistribution), true);
  assert.equal(Object.isFrozen(first.report.databaseConflicts), true);
  assert.ok(adapter.calls.filter(({ sql }) => /FROM migration_records m/iu.test(sql)).every(({ sql }) => /FOR UPDATE OF m, a/iu.test(sql)));
  assert.ok(adapter.calls.filter(({ sql }) => /FROM migration_records m/iu.test(sql)).every(({ sql }) => /OR m\.account_id/iu.test(sql)));
  assert.ok(adapter.calls.filter(({ sql }) => /FROM account_emails/iu.test(sql)).every(({ sql }) => /FOR UPDATE/iu.test(sql)));
  assert.ok(adapter.calls.filter(({ sql }) => /FROM auth_identities/iu.test(sql)).every(({ sql }) => /FOR UPDATE/iu.test(sql)));
});

test("module-constructed evidence is deeply immutable and cloned evidence cannot finalize", async () => {
  const source = oneRowSnapshot();
  const graph = exactLegacyGraph(source);
  const adapter = atomicOwnerAdapter(graph);
  const finalized = await finalizeMigrationBatch({
    snapshot: source,
    sourceReport: graph.report,
    reviewedSnapshot: source,
    source: "netlify_identity",
    environmentId: "production",
    siteId: "site-production",
    adapter,
    emailLookupHash: async () => Buffer.from(graph.emailHash),
    encryptionKeyVersion: 3,
    env: PRODUCTION_ENV,
    now: new Date("2026-08-25T03:00:00.000Z")
  });
  assert.throws(
    () => finalized.report.databaseConflicts.push({ code: "DATABASE_STATE_CHANGED" }),
    TypeError
  );
  const mutatedClone = JSON.parse(JSON.stringify(finalized.report));
  mutatedClone.databaseConflicts.push({ code: "DATABASE_STATE_CHANGED" });
  await assert.rejects(
    () => finalizeMigrationBatch({
      reconciliationReport: mutatedClone,
      reviewedSnapshot: source,
      source: "netlify_identity",
      environmentId: "production",
      siteId: "site-production",
      adapter,
      env: PRODUCTION_ENV,
      now: new Date("2026-08-25T03:00:00.000Z")
    }),
    (error) => error.code === "AUTH_MIGRATION_DATABASE_EVIDENCE_REQUIRED"
  );
});

test("a committed-state change between a separate evidence read and batch write cannot finalize", async () => {
  const source = oneRowSnapshot();
  const graph = exactLegacyGraph(source);
  const adapter = atomicOwnerAdapter(graph);
  const staleReport = await reconcileCommittedMigration(source, {
    adapter,
    sourceReport: graph.report,
    sourceSnapshotHash: graph.report.snapshotHash,
    emailLookupHash: async () => Buffer.from(graph.emailHash),
    encryptionKeyVersion: 3
  });
  assert.equal(staleReport.ok, true);
  graph.account.role = "admin";
  await assert.rejects(
    () => finalizeMigrationBatch({
      snapshot: source,
      sourceReport: graph.report,
      reviewedSnapshot: source,
      source: "netlify_identity",
      environmentId: "production",
      siteId: "site-production",
      adapter,
      emailLookupHash: async () => Buffer.from(graph.emailHash),
      encryptionKeyVersion: 3,
      env: PRODUCTION_ENV,
      now: new Date("2026-08-25T03:00:00.000Z")
    }),
    (error) => error.code === "AUTH_MIGRATION_RECONCILIATION_REQUIRED"
  );
});

test("import locks the shared migration scope and rejects a reconciled batch before any row write", async () => {
  const source = oneRowSnapshot();
  const graph = exactLegacyGraph(source);
  const calls = [];
  const state = new Map();
  const sql = (strings, ...values) => {
    const queryText = Array.from(strings.raw || strings).join("");
    calls.push({ queryText, values });
    if (/pg_advisory_xact_lock/iu.test(queryText)) return [];
    if (/FROM auth_migration_batches/iu.test(queryText)) return [{
      source: "netlify_identity",
      environment_id: "production",
      site_id: "site-production",
      snapshot_id: graph.report.snapshotId,
      snapshot_hash: Buffer.from(graph.report.snapshotHash, "hex"),
      status: "reconciled",
      source_count: 1,
      imported_count: 1,
      conflict_count: 0,
      freeze_at: source.freezeAt,
      completed_at: "2026-08-25T03:00:00.000Z"
    }];
    return successfulImportResponse(queryText, values, state);
  };
  await assert.rejects(
    () => importSnapshot(source, {
      env: PRODUCTION_ENV,
      apply: true,
      snapshotId: graph.report.snapshotId,
      snapshotHash: graph.report.snapshotHash,
      reviewedSnapshot: source,
      postgresAdapterOptions: {
        sql,
        withTransaction: async (callback) => callback(sql),
        environmentId: "production",
        siteId: "site-production",
        emailLookupHash: async () => Buffer.from(graph.emailHash),
        encryptEmail: async () => Buffer.from("encrypted-email"),
        encryptionKeyVersion: 3
      }
    }),
    (error) => error.code === "AUTH_MIGRATION_BATCH_ALREADY_FINALIZED"
  );
  const scopeLockIndex = calls.findIndex(({ queryText, values }) => /pg_advisory_xact_lock/iu.test(queryText) && values.length === 3);
  const batchReadIndex = calls.findIndex(({ queryText }) => /FROM auth_migration_batches/iu.test(queryText));
  assert.ok(scopeLockIndex >= 0 && scopeLockIndex < batchReadIndex);
  assert.deepEqual(calls[scopeLockIndex].values, ["netlify_identity", "production", "site-production"]);
  assert.equal(calls.some(({ queryText }) => /INSERT INTO (accounts|migration_records|account_emails|auth_identities)/iu.test(queryText)), false);
});

test("finalization locks and rejects an extra committed source/snapshot migration user", async () => {
  const source = oneRowSnapshot();
  const graph = exactLegacyGraph(source);
  graph.population = [
    {
      migration_id: graph.migrationId,
      source_user_id: graph.row.source_user_id,
      account_id: graph.row.account_id,
      snapshot_hash: graph.migration.snapshot_hash
    },
    {
      migration_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      source_user_id: "legacy-extra",
      account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      snapshot_hash: graph.migration.snapshot_hash
    }
  ];
  const adapter = atomicOwnerAdapter(graph);
  await assert.rejects(
    () => finalizeMigrationBatch({
      snapshot: source,
      sourceReport: graph.report,
      reviewedSnapshot: source,
      source: "netlify_identity",
      environmentId: "production",
      siteId: "site-production",
      adapter,
      emailLookupHash: async () => Buffer.from(graph.emailHash),
      encryptionKeyVersion: 3,
      env: PRODUCTION_ENV,
      now: new Date("2026-08-25T03:00:00.000Z")
    }),
    (error) => error.code === "AUTH_MIGRATION_POPULATION_CONFLICT"
  );
  const populationRead = adapter.calls.find(({ sql }) => /FROM migration_records[\s\S]*WHERE source/iu.test(sql) && !/JOIN accounts/iu.test(sql));
  assert.ok(populationRead);
  assert.match(populationRead.sql, /FOR UPDATE/iu);
  assert.equal(adapter.calls.some(({ sql }) => /INSERT INTO auth_migration_batches/iu.test(sql)), false);
});

test("concurrent finalization and import serialize on the same scope-lock transcript", async () => {
  const source = oneRowSnapshot();
  const graph = exactLegacyGraph(source);
  const state = { batch: null };
  const held = new Set();
  const waiters = new Map();
  const scopeKeys = [];
  let signalFinalizerLock;
  const finalizerLocked = new Promise((resolve) => { signalFinalizerLock = resolve; });

  async function acquire(key) {
    if (!held.has(key)) {
      held.add(key);
      return () => {
        const next = waiters.get(key)?.shift();
        if (next) next();
        else held.delete(key);
      };
    }
    await new Promise((resolve) => {
      const queue = waiters.get(key) || [];
      queue.push(resolve);
      waiters.set(key, queue);
    });
    return () => {
      const next = waiters.get(key)?.shift();
      if (next) next();
      else held.delete(key);
    };
  }

  function adapter(kind) {
    return {
      async withTransaction(callback) {
        let release = null;
        const transaction = async (strings, ...values) => {
          const queryText = Array.from(strings.raw || strings).join("");
          if (/pg_advisory_xact_lock/iu.test(queryText)) {
            const key = JSON.stringify(values);
            scopeKeys.push({ kind, key, queryText, values });
            release = await acquire(key);
            if (kind === "finalizer") signalFinalizerLock();
            return [];
          }
          if (/FROM auth_migration_batches/iu.test(queryText)) return state.batch ? [state.batch] : [];
          if (/SELECT[\s\S]*FROM migration_records[\s\S]*WHERE source/iu.test(queryText) && !/JOIN accounts/iu.test(queryText)) {
            return [{
              migration_id: graph.migrationId,
              source_user_id: graph.row.source_user_id,
              account_id: graph.row.account_id,
              snapshot_hash: graph.migration.snapshot_hash
            }];
          }
          if (/FROM migration_records m[\s\S]*JOIN accounts a/iu.test(queryText)) {
            return [{
              ...graph.migration,
              migration_status: graph.migration.status,
              account_role: graph.account.role,
              account_status: graph.account.status,
              account_guild: graph.account.guild,
              account_game_name: graph.account.game_name,
              account_authz_version: graph.account.authz_version,
              account_merged_into_account_id: graph.account.merged_into_account_id,
              account_migration_id: graph.account.migration_id,
              account_blocked_at: graph.account.blocked_at
            }];
          }
          if (/SELECT migration_id/iu.test(queryText)) return [graph.migration];
          if (/FROM account_emails/iu.test(queryText)) return [graph.email];
          if (/FROM auth_identities/iu.test(queryText)) return [graph.identity];
          if (/INSERT INTO auth_migration_batches/iu.test(queryText)) {
            state.batch = {
              source: values[0], environment_id: values[1], site_id: values[2],
              snapshot_id: values[3], snapshot_hash: values[4], status: values[5],
              source_count: values[6], imported_count: values[7], conflict_count: values[8],
              freeze_at: values[9], completed_at: values[10]
            };
            return [state.batch];
          }
          throw new Error(`unexpected concurrent ${kind} SQL: ${queryText}`);
        };
        try {
          return await callback(transaction);
        } finally {
          release?.();
        }
      }
    };
  }

  const finalizing = finalizeMigrationBatch({
    snapshot: source,
    sourceReport: graph.report,
    reviewedSnapshot: source,
    source: "netlify_identity",
    environmentId: "production",
    siteId: "site-production",
    adapter: adapter("finalizer"),
    emailLookupHash: async () => Buffer.from(graph.emailHash),
    encryptionKeyVersion: 3,
    env: PRODUCTION_ENV,
    now: new Date("2026-08-25T03:00:00.000Z")
  });
  await finalizerLocked;
  const importing = importSnapshot(source, {
    env: PRODUCTION_ENV,
    apply: true,
    snapshotId: graph.report.snapshotId,
    snapshotHash: graph.report.snapshotHash,
    reviewedSnapshot: source,
    postgresAdapterOptions: {
      sql: async () => [],
      withTransaction: adapter("importer").withTransaction,
      environmentId: "production",
      siteId: "site-production",
      emailLookupHash: async () => Buffer.from(graph.emailHash),
      encryptEmail: async () => Buffer.from("encrypted-email"),
      encryptionKeyVersion: 3
    }
  });
  const [finalized, imported] = await Promise.allSettled([finalizing, importing]);
  assert.equal(finalized.status, "fulfilled");
  assert.equal(imported.status, "rejected");
  assert.equal(imported.reason?.code, "AUTH_MIGRATION_BATCH_ALREADY_FINALIZED");
  const finalizerScope = scopeKeys.find(({ kind, values }) => kind === "finalizer" && values.length === 3);
  const importerScope = scopeKeys.find(({ kind, values }) => kind === "importer" && values.length === 3);
  assert.ok(finalizerScope && importerScope);
  assert.equal(importerScope.key, finalizerScope.key);
  assert.equal(importerScope.queryText, finalizerScope.queryText);
});

test("persisted migration completion evidence is non-null, valid, and ordered", async (t) => {
  const source = oneRowSnapshot();
  const base = exactLegacyGraph(source);
  const variants = [
    ["null completion", { completed_at: null }],
    ["invalid completion", { completed_at: "not-a-time" }],
    ["completion before freeze", { completed_at: "2026-08-25T01:59:59.000Z" }],
    ["completion before creation", { created_at: "2026-08-25T03:00:01.000Z" }]
  ];
  for (const [name, migration] of variants) {
    await t.test(name, async () => {
      const graph = { ...base, migration: { ...base.migration, ...migration } };
      const sql = (strings) => {
        const queryText = Array.from(strings.raw || strings).join("");
        if (/pg_advisory_xact_lock/iu.test(queryText)) return [];
        if (/FROM auth_migration_batches/iu.test(queryText)) return [];
        if (/FROM migration_records m[\s\S]*JOIN accounts a/iu.test(queryText)) {
          return [{
            ...graph.migration,
            migration_status: graph.migration.status,
            account_role: graph.account.role,
            account_status: graph.account.status,
            account_guild: graph.account.guild,
            account_game_name: graph.account.game_name,
            account_authz_version: graph.account.authz_version,
            account_merged_into_account_id: graph.account.merged_into_account_id,
            account_migration_id: graph.account.migration_id,
            account_blocked_at: graph.account.blocked_at
          }];
        }
        if (/FROM migration_records/iu.test(queryText)) return [graph.migration];
        if (/FROM account_emails/iu.test(queryText)) return [graph.email];
        if (/FROM auth_identities/iu.test(queryText)) return [graph.identity];
        throw new Error(`unexpected timestamp replay query: ${queryText}`);
      };
      await assert.rejects(
        () => importSnapshot(source, {
          env: PRODUCTION_ENV,
          apply: true,
          snapshotId: base.report.snapshotId,
          snapshotHash: base.report.snapshotHash,
          reviewedSnapshot: source,
          postgresAdapterOptions: {
            sql,
            withTransaction: async (callback) => callback(sql),
            environmentId: "production",
            siteId: "site-production",
            emailLookupHash: async () => Buffer.from(base.emailHash),
            encryptEmail: async () => Buffer.from("encrypted-email"),
            encryptionKeyVersion: 3
          }
        }),
        (error) => error.code === "AUTH_MIGRATION_PERSISTED_STATE_CONFLICT",
        name
      );
    });
  }
});

test("completed replay rejects corruption anywhere in the persisted legacy account graph", async (t) => {
  const source = oneRowSnapshot();
  const base = exactLegacyGraph(source);
  const variants = [
    ["guild", { account: { guild: "Corrupt" } }],
    ["game", { account: { game_name: "Corrupt" } }],
    ["blocked timestamp", { account: { blocked_at: source.freezeAt } }],
    ["authorization version", { account: { authz_version: "2" } }],
    ["extra migration mapping", { migrations: [
      base.migration,
      {
        ...base.migration,
        migration_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        source_user_id: "legacy-extra",
        legacy_netlify_user_id: "legacy-extra"
      }
    ] }],
    ["missing verified primary email", { emails: [] }],
    ["wrong email key version", { email: { encryption_key_version: 4 } }],
    ["missing legacy identity", { identities: [] }],
    ["wrong legacy scope", { identity: { connector_scope: "wrong" } }],
    ["wrong legacy subject type", { identity: { subject_type: "sub" } }],
    ["revoked legacy identity", { identity: { status: "revoked", revoked_at: source.freezeAt } }],
    ["wrong legacy owner", { identity: { account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }]
  ];
  for (const [name, change] of variants) {
    await t.test(name, async () => {
      const graph = {
        ...base,
        account: { ...base.account, ...(change.account || {}) },
        migration: { ...base.migration, ...(change.migration || {}) },
        email: { ...base.email, ...(change.email || {}) },
        identity: { ...base.identity, ...(change.identity || {}) }
      };
      const sql = (strings) => {
        const queryText = Array.from(strings.raw || strings).join("");
        if (/pg_advisory_xact_lock/iu.test(queryText)) return [];
        if (/FROM auth_migration_batches/iu.test(queryText)) return [];
        if (/FROM migration_records/iu.test(queryText)) {
          return change.migrations && /OR m\.account_id/iu.test(queryText)
            ? change.migrations
            : [graph.migration];
        }
        if (/FROM accounts/iu.test(queryText)) return [graph.account];
        if (/FROM account_emails/iu.test(queryText)) return change.emails || [graph.email];
        if (/FROM auth_identities/iu.test(queryText)) return change.identities || [graph.identity];
        throw new Error(`unexpected replay query: ${queryText}`);
      };
      await assert.rejects(
        () => importSnapshot(source, {
          env: PRODUCTION_ENV,
          apply: true,
          snapshotId: base.report.snapshotId,
          snapshotHash: base.report.snapshotHash,
          reviewedSnapshot: source,
          postgresAdapterOptions: {
            sql,
            withTransaction: async (callback) => callback(sql),
            environmentId: "production",
            siteId: "site-production",
            emailLookupHash: async () => Buffer.from(base.emailHash),
            encryptEmail: async () => Buffer.from("encrypted-email"),
            encryptionKeyVersion: 3
          }
        }),
        (error) => error.code === "AUTH_MIGRATION_PERSISTED_STATE_CONFLICT",
        name
      );
    });
  }
});

test("existing email and identity branches require complete exact rows", async (t) => {
  const source = oneRowSnapshot();
  const base = exactLegacyGraph(source);
  for (const branch of ["email", "identity"]) {
    await t.test(branch, async () => {
      const state = new Map();
      const sql = (strings, ...values) => {
        const queryText = Array.from(strings.raw || strings).join("");
        if (branch === "email" && /SELECT account_id FROM account_emails/iu.test(queryText)) {
          return [{ account_id: base.row.account_id }];
        }
        if (branch === "identity" && /SELECT account_id FROM auth_identities/iu.test(queryText)) {
          return [{ account_id: base.row.account_id }];
        }
        return successfulImportResponse(queryText, values, state);
      };
      await assert.rejects(
        () => importSnapshot(source, {
          env: PRODUCTION_ENV,
          apply: true,
          snapshotId: base.report.snapshotId,
          snapshotHash: base.report.snapshotHash,
          reviewedSnapshot: source,
          postgresAdapterOptions: {
            sql,
            withTransaction: async (callback) => callback(sql),
            environmentId: "production",
            siteId: "site-production",
            emailLookupHash: async () => Buffer.from(base.emailHash),
            encryptEmail: async () => Buffer.from("encrypted-email"),
            encryptionKeyVersion: 3
          }
        }),
        (error) => error.code === "AUTH_MIGRATION_PERSISTED_STATE_CONFLICT",
        branch
      );
    });
  }
});

test("snapshot usage marks output as required", () => {
  const result = spawnSync(process.execPath, [resolve("scripts/auth-migration/snapshot.mjs")], {
    cwd: resolve("."),
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--output <file>/u);
  assert.doesNotMatch(result.stderr, /\[--output <file>\]/u);
});
