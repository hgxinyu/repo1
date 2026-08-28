import { timingSafeEqual } from "node:crypto";
import { getMigrationWriteMode } from "../../netlify/functions/_shared/migration-write-gate.mjs";
import { dryRunSnapshot } from "./dry-run.mjs";
import { lockMigrationScope, readScopedMigrationBatchForUpdate } from "./migration-scope.mjs";
import { deepFreeze, reconcileCommittedMigrationInTransaction } from "./reconcile.mjs";
import { deriveAccountId } from "./transform.mjs";

const FINALIZABLE_SOURCE = "netlify_identity";

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function migrationError(code, message = code, status = 503) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.statusCode = status;
  return error;
}

function field(value, names) {
  if (!value || typeof value !== "object") return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(value, name) && value[name] !== undefined) return value[name];
  }
  return undefined;
}

function hashHex(value, code = "AUTH_MIGRATION_REPORT_INVALID") {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 32) throw migrationError(code);
    return value.toString("hex");
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength !== 32) throw migrationError(code);
    return Buffer.from(value).toString("hex");
  }
  const normalized = text(value)?.toLowerCase();
  if (!normalized || !/^[a-f0-9]{64}$/u.test(normalized)) throw migrationError(code);
  return normalized;
}

function countValue(value, code = "AUTH_MIGRATION_COUNTS_INVALID") {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  throw migrationError(code);
}

function timestamp(value, code) {
  if (value === null || value === undefined ||
      (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date))) {
    throw migrationError(code);
  }
  if (typeof value === "string" && value.trim() === "") throw migrationError(code);
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw migrationError(code);
  return parsed;
}

function validateFreezeAt(value, { now } = {}) {
  const raw = text(field(value, ["freezeAt", "freeze_at"]));
  if (!raw) throw migrationError("AUTH_MIGRATION_FREEZE_AT_REQUIRED");
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw migrationError("AUTH_MIGRATION_FREEZE_AT_INVALID");
  const clock = timestamp(now ?? new Date(), "AUTH_MIGRATION_COMPLETION_AT_INVALID").getTime();
  const minimum = Date.UTC(2000, 0, 1);
  if (parsed < minimum || parsed > clock + 5 * 60 * 1000) {
    throw migrationError("AUTH_MIGRATION_FREEZE_AT_INVALID");
  }
  return new Date(parsed).toISOString();
}

function reportValue(input) {
  if (!input || typeof input !== "object") throw migrationError("AUTH_MIGRATION_REPORT_REQUIRED");
  const report = input.report && typeof input.report === "object" ? input.report : input;
  if (!report || typeof report !== "object") throw migrationError("AUTH_MIGRATION_REPORT_REQUIRED");
  return report;
}

function reviewedValue(input) {
  if (!input || typeof input !== "object") return null;
  const report = input.report && typeof input.report === "object" ? input.report : null;
  const snapshot = input.snapshot && typeof input.snapshot === "object" ? input.snapshot : input;
  if (report && text(report.snapshotId) && (report.snapshotHash || report.sourceSnapshotHash)) {
    return {
      snapshotId: text(report.snapshotId),
      snapshotHash: hashHex(report.snapshotHash || report.sourceSnapshotHash, "AUTH_MIGRATION_REVIEW_MISMATCH"),
      migrationId: text(snapshot.migrationId ?? snapshot.migration_id ?? input.migrationId ?? input.migration_id),
      freezeAt: field(snapshot, ["freezeAt", "freeze_at"]) ?? field(input, ["freezeAt", "freeze_at"]),
      completedAt: field(report, ["completedAt", "completed_at"]) ??
        field(snapshot, ["completedAt", "completed_at"]) ??
        field(input, ["completedAt", "completed_at"])
    };
  }
  if (Array.isArray(snapshot.profiles) && Array.isArray(snapshot.identityUsers)) {
    const derived = dryRunSnapshot(snapshot);
    const suppliedHash = field(snapshot, ["snapshotHash", "snapshot_hash"]);
    if (suppliedHash !== undefined && !hashesEqual(suppliedHash, derived.snapshotHash)) {
      throw migrationError("AUTH_MIGRATION_REVIEW_MISMATCH");
    }
    return {
      snapshotId: derived.snapshotId,
      snapshotHash: hashHex(derived.snapshotHash, "AUTH_MIGRATION_REVIEW_MISMATCH"),
      migrationId: text(snapshot.migrationId ?? snapshot.migration_id),
      freezeAt: field(snapshot, ["freezeAt", "freeze_at"]),
      completedAt: field(snapshot, ["completedAt", "completed_at"])
    };
  }
  const snapshotId = text(field(snapshot, ["snapshotId", "snapshot_id"]));
  const snapshotHash = field(snapshot, ["snapshotHash", "snapshot_hash", "sourceSnapshotHash", "source_snapshot_hash"]);
  if (!snapshotId || snapshotHash === undefined) return null;
  return {
    snapshotId,
    snapshotHash: hashHex(snapshotHash, "AUTH_MIGRATION_REVIEW_MISMATCH"),
    migrationId: text(snapshot.migrationId ?? snapshot.migration_id ?? input.migrationId ?? input.migration_id),
    freezeAt: field(snapshot, ["freezeAt", "freeze_at"]) ?? field(input, ["freezeAt", "freeze_at"]),
    completedAt: field(snapshot, ["completedAt", "completed_at"]) ?? field(input, ["completedAt", "completed_at"])
  };
}

const REQUIRED_REPORT_ARRAYS = [
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

const REQUIRED_EMPTY_REPORT_ARRAYS = [
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

const REQUIRED_NULL_REPORT_FIELDS = [
  "hashMismatch",
  "sourceReportHashMismatch"
];

const REQUIRED_ROLES = ["pending", "free", "vip", "admin", "blocked"];

function hasOwn(value, name) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, name));
}

function reportCount(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw migrationError("AUTH_MIGRATION_RECONCILIATION_REQUIRED");
}

function sourceCount(report) {
  return reportCount(report.sourceCount);
}

function importedCount(report) {
  return reportCount(report.importedCount);
}

function conflictCount(report) {
  return reportCount(report.conflictCount);
}

function snapshotHashForReport(report) {
  const snapshotHash = field(report, ["snapshotHash", "snapshot_hash"]);
  const sourceSnapshotHash = field(report, ["sourceSnapshotHash", "source_snapshot_hash"]);
  const primary = snapshotHash !== undefined ? hashHex(snapshotHash, "AUTH_MIGRATION_REPORT_INVALID") :
    hashHex(sourceSnapshotHash, "AUTH_MIGRATION_REPORT_INVALID");
  if (snapshotHash !== undefined && sourceSnapshotHash !== undefined &&
      !hashesEqual(sourceSnapshotHash, primary)) {
    throw migrationError("AUTH_MIGRATION_REVIEW_MISMATCH");
  }
  return primary;
}

function assertReconciledReport(report) {
  if (!report || typeof report !== "object" || !hasOwn(report, "ok") || !hasOwn(report, "status") ||
      report.ok !== true || report.status !== "reconciled") {
    throw migrationError("AUTH_MIGRATION_RECONCILIATION_REQUIRED");
  }
  const requiredIdentityFields = [
    "snapshotId",
    "migrationId",
    "snapshotHash",
    "sourceSnapshotHash",
    "reviewedSnapshotHash",
    "freezeAt",
    "completedAt",
    "sourceCounts",
    "importedCounts",
    "sourceCount",
    "importedCount",
    "conflictCount",
    "roleDistribution"
  ];
  if (requiredIdentityFields.some((name) => !hasOwn(report, name))) {
    throw migrationError("AUTH_MIGRATION_RECONCILIATION_REQUIRED");
  }
  if (!text(report.snapshotId) || !text(report.migrationId) || !text(report.freezeAt) || !text(report.completedAt)) {
    throw migrationError("AUTH_MIGRATION_RECONCILIATION_REQUIRED");
  }
  timestamp(report.completedAt, "AUTH_MIGRATION_COMPLETION_AT_INVALID");
  if (!report.sourceCounts || typeof report.sourceCounts !== "object" || Array.isArray(report.sourceCounts) ||
      !report.importedCounts || typeof report.importedCounts !== "object" || Array.isArray(report.importedCounts) ||
      !hasOwn(report.sourceCounts, "profiles") || !hasOwn(report.sourceCounts, "identityUsers") ||
      !hasOwn(report.importedCounts, "accounts") || !hasOwn(report.importedCounts, "identities")) {
    throw migrationError("AUTH_MIGRATION_RECONCILIATION_REQUIRED");
  }
  const sourceProfiles = reportCount(report.sourceCounts.profiles);
  const sourceIdentities = reportCount(report.sourceCounts.identityUsers);
  const importedAccounts = reportCount(report.importedCounts.accounts);
  const importedIdentities = reportCount(report.importedCounts.identities);
  const sourceTotal = sourceCount(report);
  const importedTotal = importedCount(report);
  if (sourceTotal !== sourceProfiles || sourceTotal !== sourceIdentities ||
      importedTotal !== importedAccounts || importedTotal !== importedIdentities ||
      sourceTotal !== importedTotal) {
    throw migrationError("AUTH_MIGRATION_COUNTS_MISMATCH");
  }
  if (conflictCount(report) !== 0) {
    throw migrationError("AUTH_MIGRATION_CONFLICTS_PRESENT");
  }
  if (REQUIRED_REPORT_ARRAYS.some((name) => !hasOwn(report, name) || !Array.isArray(report[name])) ||
      REQUIRED_EMPTY_REPORT_ARRAYS.some((name) => report[name].length !== 0) ||
      REQUIRED_NULL_REPORT_FIELDS.some((name) => !hasOwn(report, name) || report[name] !== null) ||
      !hasOwn(report, "sourceReportMismatch") || report.sourceReportMismatch !== false) {
    throw migrationError("AUTH_MIGRATION_RECONCILIATION_REQUIRED");
  }
  if (report.sourceAccountIds.length !== sourceProfiles ||
      report.importedAccountIds.length !== importedAccounts) {
    throw migrationError("AUTH_MIGRATION_COUNTS_MISMATCH");
  }
  const sourceAccountIds = report.sourceAccountIds.map((value) => text(value));
  const importedAccountIds = report.importedAccountIds.map((value) => text(value));
  if (sourceAccountIds.some((value, index) => !value || value !== report.sourceAccountIds[index]) ||
      importedAccountIds.some((value, index) => !value || value !== report.importedAccountIds[index]) ||
      new Set(sourceAccountIds).size !== sourceAccountIds.length ||
      new Set(importedAccountIds).size !== importedAccountIds.length ||
      JSON.stringify([...sourceAccountIds].sort()) !== JSON.stringify([...importedAccountIds].sort())) {
    throw migrationError("AUTH_MIGRATION_COUNTS_MISMATCH");
  }
  if (!report.roleDistribution || typeof report.roleDistribution !== "object" || Array.isArray(report.roleDistribution) ||
      !hasOwn(report.roleDistribution, "source") || !hasOwn(report.roleDistribution, "imported") ||
      !report.roleDistribution.source || typeof report.roleDistribution.source !== "object" ||
      Array.isArray(report.roleDistribution.source) ||
      !report.roleDistribution.imported || typeof report.roleDistribution.imported !== "object" ||
      Array.isArray(report.roleDistribution.imported)) {
    throw migrationError("AUTH_MIGRATION_RECONCILIATION_REQUIRED");
  }
  let sourceRoleTotal = 0;
  let importedRoleTotal = 0;
  for (const role of REQUIRED_ROLES) {
    if (!hasOwn(report.roleDistribution.source, role) || !hasOwn(report.roleDistribution.imported, role) ||
        reportCount(report.roleDistribution.source[role]) !==
        reportCount(report.roleDistribution.imported[role])) {
      throw migrationError("AUTH_MIGRATION_RECONCILIATION_REQUIRED");
    }
    sourceRoleTotal += report.roleDistribution.source[role];
    importedRoleTotal += report.roleDistribution.imported[role];
  }
  if (sourceRoleTotal !== sourceProfiles || importedRoleTotal !== importedAccounts) {
    throw migrationError("AUTH_MIGRATION_COUNTS_MISMATCH");
  }
  const reportHash = snapshotHashForReport(report);
  if (!hashesEqual(reportHash, report.reviewedSnapshotHash) ||
      !hashesEqual(reportHash, report.sourceSnapshotHash)) {
    throw migrationError("AUTH_MIGRATION_RECONCILIATION_REQUIRED");
  }
}

function validateCompletionAt(value, { freezeAt, now } = {}) {
  const parsed = timestamp(value, "AUTH_MIGRATION_COMPLETION_AT_INVALID");
  const freezeTime = timestamp(freezeAt, "AUTH_MIGRATION_FREEZE_AT_INVALID").getTime();
  const clock = timestamp(now ?? new Date(), "AUTH_MIGRATION_COMPLETION_AT_INVALID").getTime();
  const minimum = Date.UTC(2000, 0, 1);
  if (parsed.getTime() < minimum || parsed.getTime() < freezeTime || parsed.getTime() > clock + 5 * 60 * 1000) {
    throw migrationError("AUTH_MIGRATION_COMPLETION_AT_INVALID");
  }
  return parsed.toISOString();
}

function reportCompletion(report, options) {
  const value = field(report, ["completedAt", "completed_at"]);
  if (value === undefined) throw migrationError("AUTH_MIGRATION_RECONCILIATION_REQUIRED");
  return validateCompletionAt(value, options);
}

function reportFreeze(report) {
  return timestamp(field(report, ["freezeAt", "freeze_at"]), "AUTH_MIGRATION_FREEZE_AT_INVALID").toISOString();
}

function sameTimestamp(left, right) {
  return timestamp(left, "AUTH_MIGRATION_COMPLETION_AT_INVALID").getTime() ===
    timestamp(right, "AUTH_MIGRATION_COMPLETION_AT_INVALID").getTime();
}

function existingBatchMatches(existing, batch) {
  if (!scopeEqual(existing, batch) ||
      text(dbValue(existing, ["snapshot_id", "snapshotId"])) !== batch.snapshotId ||
      !hashesEqual(dbValue(existing, ["snapshot_hash", "snapshotHash"]), batch.snapshotHash) ||
      text(dbValue(existing, ["status"]))?.toLowerCase() !== batch.status) {
    return false;
  }
  try {
    return countValue(dbValue(existing, ["source_count", "sourceCount"]), "AUTH_MIGRATION_BATCH_CONFLICT") === batch.sourceCount &&
      countValue(dbValue(existing, ["imported_count", "importedCount"]), "AUTH_MIGRATION_BATCH_CONFLICT") === batch.importedCount &&
      countValue(dbValue(existing, ["conflict_count", "conflictCount"]), "AUTH_MIGRATION_BATCH_CONFLICT") === batch.conflictCount &&
      reportFreeze(existing) === batch.freezeAt &&
      sameTimestamp(dbValue(existing, ["completed_at", "completedAt"]), batch.completedAt);
  } catch {
    return false;
  }
}

function ensureOwnerApply(env, environmentId, siteId) {
  const mode = getMigrationWriteMode(env);
  if (mode !== "frozen") throw migrationError("AUTH_MIGRATION_IMPORT_MODE_REQUIRED");
  const configuredEnvironment = text(hasOwn(env, "AUTH_ENV_ID") ? env.AUTH_ENV_ID : undefined);
  if (configuredEnvironment !== "production") throw migrationError("AUTH_MIGRATION_PRODUCTION_REQUIRED");
  if (text(environmentId) !== configuredEnvironment) throw migrationError("AUTH_MIGRATION_ENVIRONMENT_MISMATCH");
  const configuredSite = text(hasOwn(env, "NETLIFY_SITE_ID") ? env.NETLIFY_SITE_ID : undefined);
  const expectedSite = text(hasOwn(env, "AUTH_EXPECTED_SITE_ID") ? env.AUTH_EXPECTED_SITE_ID : undefined);
  if (!configuredSite || !expectedSite || configuredSite !== expectedSite || configuredSite !== text(siteId)) {
    throw migrationError("AUTH_MIGRATION_SITE_MISMATCH");
  }
}

function canonicalBatch({ report, reviewed, source, environmentId, siteId, now }) {
  if (text(source) !== FINALIZABLE_SOURCE) throw migrationError("AUTH_MIGRATION_SOURCE_INVALID", "Unsupported migration source", 400);
  assertReconciledReport(report);
  if (!text(reviewed?.snapshotId) || !text(reviewed?.snapshotHash) ||
      !text(reviewed?.migrationId) || !text(reviewed?.freezeAt)) {
    throw migrationError("AUTH_MIGRATION_REVIEW_MISMATCH");
  }
  const snapshotId = text(field(report, ["snapshotId", "snapshot_id"]));
  if (!snapshotId || snapshotId !== reviewed.snapshotId) throw migrationError("AUTH_MIGRATION_REVIEW_MISMATCH");
  const reportHash = snapshotHashForReport(report);
  if (!hashesEqual(reportHash, reviewed.snapshotHash)) throw migrationError("AUTH_MIGRATION_REVIEW_MISMATCH");
  const reportMigrationId = text(field(report, ["migrationId", "migration_id"]));
  if (!reportMigrationId || reportMigrationId !== reviewed.migrationId) {
    throw migrationError("AUTH_MIGRATION_REVIEW_MISMATCH");
  }
  const sourceTotal = sourceCount(report);
  const importedTotal = importedCount(report);
  if (sourceTotal !== importedTotal) throw migrationError("AUTH_MIGRATION_COUNTS_MISMATCH");
  if (conflictCount(report) !== 0) throw migrationError("AUTH_MIGRATION_CONFLICTS_PRESENT");

  const reportFreezeValue = field(report, ["freezeAt", "freeze_at"]);
  const reviewedFreezeValue = reviewed.freezeAt;
  const freezeValue = reportFreezeValue ?? reviewedFreezeValue;
  const freezeAt = validateFreezeAt({ freezeAt: freezeValue }, { now });
  const reviewedFreezeAt = validateFreezeAt({ freezeAt: reviewedFreezeValue }, { now });
  if (reviewedFreezeAt !== freezeAt) throw migrationError("AUTH_MIGRATION_REVIEW_MISMATCH");
  const reportCompletedAt = reportCompletion(report, { freezeAt, now });

  const batch = deepFreeze({
    source: FINALIZABLE_SOURCE,
    environmentId: text(environmentId),
    siteId: text(siteId),
    snapshotId,
    snapshotHash: reportHash,
    status: "reconciled",
    sourceCount: sourceTotal,
    importedCount: importedTotal,
    conflictCount: 0,
    freezeAt,
    completedAt: reportCompletedAt
  });
  return batch;
}

function query(adapter, parts, values = []) {
  const strings = Array.from(parts);
  strings.raw = Array.from(parts);
  if (typeof adapter === "function") return adapter(strings, ...values);
  if (adapter && typeof adapter.query === "function") {
    const queryText = strings.reduce(
      (result, part, index) => `${result}${part}${index < values.length ? `$${index + 1}` : ""}`,
      ""
    );
    return adapter.query(queryText, values);
  }
  throw migrationError("AUTH_MIGRATION_ADAPTER_INVALID");
}

function parameterParts(prefix, suffix, count) {
  if (!Number.isInteger(count) || count < 1) throw migrationError("AUTH_MIGRATION_SQL_SHAPE_INVALID");
  return [prefix, ...Array.from({ length: count - 1 }, () => ", "), suffix];
}

async function rowsFrom(result) {
  const value = await result;
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.rows)) return value.rows;
  return [];
}

function dbValue(row, names) {
  const value = field(row, names);
  return value;
}

function hashesEqual(left, right) {
  try {
    const first = Buffer.from(hashHex(left), "hex");
    const second = Buffer.from(hashHex(right), "hex");
    return first.length === second.length && timingSafeEqual(first, second);
  } catch {
    return false;
  }
}

function scopeEqual(row, batch) {
  return text(dbValue(row, ["source"])) === batch.source &&
    text(dbValue(row, ["environmentId", "environment_id"])) === batch.environmentId &&
    text(dbValue(row, ["siteId", "site_id"])) === batch.siteId;
}

function batchConflict() {
  return migrationError("AUTH_MIGRATION_BATCH_CONFLICT", "Migration batch already finalized with a different snapshot", 409);
}

/**
 * Execute a single owner transaction's batch upsert. Kept separate so the
 * fixture can compose its account, email, identity, migration, and batch
 * writes in one transaction without opening a second transaction.
 */
export async function upsertMigrationBatchInTransaction(transaction, batch) {
  const existingRows = await rowsFrom(query(
    transaction,
    [
      `SELECT source, environment_id, site_id, snapshot_id, snapshot_hash, status,
              source_count, imported_count, conflict_count, freeze_at, completed_at
       FROM auth_migration_batches
       WHERE source = `,
      ` AND environment_id = `,
      ` AND site_id = `,
      ` FOR UPDATE`
    ],
    [batch.source, batch.environmentId, batch.siteId]
  ));
  if (existingRows.length > 1) throw batchConflict();
  if (existingRows.length === 1) {
    const existing = existingRows[0];
    if (!existingBatchMatches(existing, batch)) throw batchConflict();
    return { skipped: true, idempotent: true, batch };
  }

  const resultRows = await rowsFrom(query(
    transaction,
    parameterParts(
      `INSERT INTO auth_migration_batches (
         source, environment_id, site_id, snapshot_id, snapshot_hash, status,
         source_count, imported_count, conflict_count, freeze_at, completed_at
       ) VALUES (`,
      `) ON CONFLICT (source, environment_id, site_id) DO NOTHING
       RETURNING source, environment_id, site_id, snapshot_id, snapshot_hash, status,
                 source_count, imported_count, conflict_count, freeze_at, completed_at`,
      11
    ),
    [
      batch.source,
      batch.environmentId,
      batch.siteId,
      batch.snapshotId,
      Buffer.from(hashHex(batch.snapshotHash), "hex"),
      batch.status,
      batch.sourceCount,
      batch.importedCount,
      batch.conflictCount,
      batch.freezeAt,
      batch.completedAt
    ]
  ));
  if (resultRows.length > 1) throw batchConflict();
  if (resultRows.length === 1) {
    if (!existingBatchMatches(resultRows[0], batch)) throw batchConflict();
    return { inserted: true, batch };
  }
  if (resultRows.length === 0 && existingRows.length === 0) {
    const afterRows = await rowsFrom(query(
      transaction,
      [
        `SELECT source, environment_id, site_id, snapshot_id, snapshot_hash, status,
                source_count, imported_count, conflict_count, freeze_at, completed_at
         FROM auth_migration_batches
         WHERE source = `,
        ` AND environment_id = `,
        ` AND site_id = `,
        ` FOR UPDATE`
      ],
      [batch.source, batch.environmentId, batch.siteId]
    ));
    if (afterRows.length === 0) {
      throw migrationError(
        "AUTH_MIGRATION_BATCH_PERSISTENCE_UNCONFIRMED",
        "Migration batch persistence could not be confirmed"
      );
    }
    if (afterRows.length !== 1 || !existingBatchMatches(afterRows[0], batch)) {
      throw batchConflict();
    }
    return { skipped: true, idempotent: true, batch };
  }
  return { inserted: true, batch };
}

async function verifyCommittedMigrationPopulation(transaction, snapshot, source) {
  const transformed = dryRunSnapshot(snapshot);
  const expectedRows = transformed.importable.map((row) => ({
    migrationId: deriveAccountId(`${row.migration_id}:record`, `${row.source}:${row.source_user_id}`),
    sourceUserId: text(row.source_user_id),
    accountId: text(row.account_id),
    snapshotHash: hashHex(row.snapshot_hash)
  }));
  if (expectedRows.some((row) => !row.sourceUserId || !row.accountId)) {
    throw migrationError("AUTH_MIGRATION_POPULATION_CONFLICT");
  }
  const snapshotHash = hashHex(transformed.snapshotHash);
  const persistedRows = await rowsFrom(query(
    transaction,
    [
      `SELECT migration_id, source_user_id, account_id, snapshot_hash
       FROM migration_records
       WHERE source = `,
      ` AND snapshot_hash = `,
      ` ORDER BY source_user_id, migration_id
       FOR UPDATE`
    ],
    [source, Buffer.from(snapshotHash, "hex")]
  ));
  const expected = expectedRows.map((row) =>
    `${row.migrationId}\u0000${row.sourceUserId}\u0000${row.accountId}\u0000${row.snapshotHash}`).sort();
  const persisted = persistedRows.map((row) => {
    const migrationId = text(dbValue(row, ["migration_id", "migrationId"]));
    const sourceUserId = text(dbValue(row, ["source_user_id", "sourceUserId"]));
    const accountId = text(dbValue(row, ["account_id", "accountId"]));
    const rowHash = hashHex(dbValue(row, ["snapshot_hash", "snapshotHash"]), "AUTH_MIGRATION_POPULATION_CONFLICT");
    if (!migrationId || !sourceUserId || !accountId) throw migrationError("AUTH_MIGRATION_POPULATION_CONFLICT");
    return `${migrationId}\u0000${sourceUserId}\u0000${accountId}\u0000${rowHash}`;
  }).sort();
  if (expected.length !== persisted.length || JSON.stringify(expected) !== JSON.stringify(persisted)) {
    throw migrationError("AUTH_MIGRATION_POPULATION_CONFLICT");
  }
}

/** Finalize one reviewed, reconciled migration batch as an owner-only write. */
export async function finalizeMigrationBatch({
  reconciliationReport,
  snapshot,
  sourceReport,
  reviewedSnapshot,
  source = FINALIZABLE_SOURCE,
  environmentId,
  siteId,
  adapter,
  emailLookupHash,
  encryptionKeyVersion,
  env = process.env,
  now = new Date()
} = {}) {
  const environment = text(environmentId);
  const site = text(siteId);
  if (!environment || !site) throw migrationError("AUTH_MIGRATION_SCOPE_REQUIRED", "Migration environment and site are required", 400);
  ensureOwnerApply(env, environment, site);
  if (!snapshot || typeof snapshot !== "object" || reconciliationReport || typeof emailLookupHash !== "function" ||
      !Number.isSafeInteger(Number(encryptionKeyVersion)) || Number(encryptionKeyVersion) < 1) {
    throw migrationError("AUTH_MIGRATION_DATABASE_EVIDENCE_REQUIRED");
  }
  const reviewed = reviewedValue(reviewedSnapshot);
  if (!reviewed) throw migrationError("AUTH_MIGRATION_REVIEW_REQUIRED");
  if (!adapter || typeof adapter.withTransaction !== "function") {
    throw migrationError("AUTH_MIGRATION_TRANSACTION_REQUIRED");
  }
  return adapter.withTransaction(async (transaction) => {
    const owner = transaction || adapter;
    const scope = { source, environmentId: environment, siteId: site };
    await lockMigrationScope(owner, scope);
    const existing = await readScopedMigrationBatchForUpdate(owner, scope);
    const freezeAt = validateFreezeAt(snapshot, { now });
    const completedAt = existing
      ? validateCompletionAt(dbValue(existing, ["completed_at", "completedAt"]), { freezeAt, now })
      : timestamp(now, "AUTH_MIGRATION_COMPLETION_AT_INVALID").toISOString();
    await verifyCommittedMigrationPopulation(owner, snapshot, source);
    const report = await reconcileCommittedMigrationInTransaction(snapshot, {
      transaction: owner,
      sourceReport,
      sourceSnapshotHash: sourceReport?.snapshotHash,
      emailLookupHash,
      encryptionKeyVersion: Number(encryptionKeyVersion),
      completedAt,
      lock: true
    });
    const batch = canonicalBatch({
      report,
      reviewed,
      source,
      environmentId: environment,
      siteId: site,
      now
    });
    const result = await upsertMigrationBatchInTransaction(owner, batch);
    return deepFreeze({
      finalized: true,
      idempotent: Boolean(result?.skipped || result?.idempotent),
      report,
      batch
    });
  });
}
