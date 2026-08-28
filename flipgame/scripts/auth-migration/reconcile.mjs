import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { verifyPersistedMigrationGraph } from "./persisted-state.mjs";
import { deriveAccountId, hashSnapshot, stableStringify, transformLegacySnapshot } from "./transform.mjs";

const ROLES = ["pending", "free", "vip", "admin", "blocked"];

function compareStrings(left, right) {
  const first = String(left);
  const second = String(right);
  return first < second ? -1 : first > second ? 1 : 0;
}

function field(row, names) {
  if (!row || typeof row !== "object") return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name) && row[name] !== undefined) return row[name];
  }
  return undefined;
}

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function emptyRoleCounts() {
  return Object.fromEntries(ROLES.map((role) => [role, 0]));
}

function sorted(values) {
  return [...values].sort(compareStrings);
}

function sortedEntries(entries, keyNames = []) {
  return [...entries].sort((left, right) => {
    for (const key of keyNames) {
      const comparison = compareStrings(left[key] ?? "", right[key] ?? "");
      if (comparison !== 0) return comparison;
    }
    return compareStrings(stableStringify(left), stableStringify(right));
  });
}

function reportFingerprint(report) {
  return stableStringify({
    snapshotId: report?.snapshotId,
    snapshotHash: report?.snapshotHash,
    sourceCounts: report?.sourceCounts,
    roleCounts: report?.roleCounts,
    importable: report?.importable,
    conflicts: report?.conflicts,
    warnings: report?.warnings
  });
}

function importedSourceKey(row) {
  const source = text(field(row, ["source"]));
  const sourceUserId = text(field(row, ["source_user_id", "sourceUserId", "legacy_netlify_user_id", "legacyNetlifyUserId"]));
  return source && sourceUserId ? `${source}\u0000${sourceUserId}` : null;
}

function importedAccountId(row) {
  return text(field(row, ["account_id", "accountId"]));
}

function importedSnapshotHash(row) {
  const value = field(row, ["snapshot_hash", "snapshotHash"]);
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  const normalized = text(value);
  return normalized ? normalized.toLowerCase() : null;
}

function importedRole(row) {
  const role = text(field(row, ["role"]));
  return ROLES.includes(role) ? role : null;
}

function roleDistribution(rows) {
  const counts = emptyRoleCounts();
  for (const row of rows) {
    const role = importedRole(row);
    if (role) counts[role] += 1;
  }
  return counts;
}

function uniqueWithDuplicates(rows, getValue) {
  const counts = new Map();
  for (const row of rows) {
    const value = getValue(row);
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return {
    values: new Set(counts.keys()),
    duplicates: sorted([...counts].filter(([, count]) => count > 1).map(([value]) => value))
  };
}

/**
 * Build a deterministic reconciliation report from a read-only snapshot and
 * imported local rows. No database or network adapter is consulted here.
 */
export function buildReconciliationReport({ snapshot, sourceReport, importedRows = [], sourceSnapshotHash } = {}) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("MIGRATION_SNAPSHOT_INVALID");
  if (!Array.isArray(importedRows)) throw new Error("MIGRATION_IMPORT_ROWS_INVALID");
  const transformedSnapshot = transformLegacySnapshot(snapshot);
  const report = sourceReport || transformedSnapshot;
  const actualSourceHash = transformedSnapshot.snapshotHash;
  const reportSourceHash = text(report.snapshotHash) || actualSourceHash;
  const expectedSourceHash = text(sourceSnapshotHash) || reportSourceHash;
  const sourceReportMismatch = Boolean(sourceReport && reportFingerprint(sourceReport) !== reportFingerprint(transformedSnapshot));
  const expectedRows = transformedSnapshot.importable;
  const expectedKeys = new Set(expectedRows.map(importedSourceKey).filter(Boolean));
  const actualKeysResult = uniqueWithDuplicates(importedRows, importedSourceKey);
  const actualKeys = actualKeysResult.values;
  const expectedAccountIds = new Set(expectedRows.map(importedAccountId).filter(Boolean));
  const actualAccountIdsResult = uniqueWithDuplicates(importedRows, importedAccountId);
  const actualAccountIds = actualAccountIdsResult.values;
  const missingSourceKeys = sorted([...expectedKeys].filter((key) => !actualKeys.has(key)));
  const extraSourceKeys = sorted([...actualKeys].filter((key) => !expectedKeys.has(key)));
  const missingAccountIds = sorted([...expectedAccountIds].filter((id) => !actualAccountIds.has(id)));
  const extraAccountIds = sorted([...actualAccountIds].filter((id) => !expectedAccountIds.has(id)));
  const hashMismatch = expectedSourceHash !== actualSourceHash
    ? { expected: expectedSourceHash, actual: actualSourceHash }
    : null;
  const sourceReportHashMismatch = reportSourceHash !== actualSourceHash
    ? { expected: reportSourceHash, actual: actualSourceHash }
    : null;
  const expectedBySourceKey = new Map(expectedRows
    .map((row) => [importedSourceKey(row), row])
    .filter(([key]) => key));
  const actualBySourceKey = new Map();
  for (const row of importedRows) {
    const key = importedSourceKey(row);
    if (key && !actualBySourceKey.has(key)) actualBySourceKey.set(key, row);
  }
  const mappingMismatches = [];
  const snapshotHashMismatches = [];
  for (const [sourceKey, expectedRow] of expectedBySourceKey) {
    const actualRow = actualBySourceKey.get(sourceKey);
    if (!actualRow) continue;
    const expectedAccountId = importedAccountId(expectedRow);
    const actualAccountId = importedAccountId(actualRow);
    if (expectedAccountId !== actualAccountId) {
      mappingMismatches.push({ sourceKey, expectedAccountId, actualAccountId });
    }
    const expectedRowHash = importedSnapshotHash(expectedRow) || actualSourceHash;
    const actualRowHash = importedSnapshotHash(actualRow);
    if (expectedRowHash !== actualRowHash) {
      snapshotHashMismatches.push({
        sourceKey,
        expected: expectedRowHash,
        actual: actualRowHash
      });
    }
  }
  const importedAccounts = new Set(importedRows.map(importedAccountId).filter(Boolean));
  const importedIdentities = new Set(importedRows.map(importedSourceKey).filter(Boolean));
  const sourceCounts = {
    profiles: Number(transformedSnapshot.sourceCounts?.profiles || 0),
    identityUsers: Number(transformedSnapshot.sourceCounts?.identityUsers || 0)
  };
  const importedCounts = {
    accounts: importedAccounts.size,
    identities: importedIdentities.size
  };
  const conflicts = Array.isArray(transformedSnapshot.conflicts) ? transformedSnapshot.conflicts : [];
  // A migration batch represents account rows, while the identity count is
  // retained separately for the detailed reconciliation report. Every
  // importable legacy profile must have one immutable identity, so a
  // reconciled batch can only be finalized from equal account/profile totals.
  const sourceCount = sourceCounts.profiles;
  const importedCount = importedCounts.accounts;
  const conflictCount = conflicts.length;
  const roleDistributionSource = {
    ...emptyRoleCounts(),
    ...(transformedSnapshot.roleCounts || {})
  };
  const roleDistributionImported = roleDistribution(importedRows);
  const duplicateSourceKeys = actualKeysResult.duplicates;
  const duplicateAccountIds = actualAccountIdsResult.duplicates;
  const ok = !hashMismatch &&
    !sourceReportHashMismatch &&
    !sourceReportMismatch &&
    conflicts.length === 0 &&
    duplicateSourceKeys.length === 0 &&
    duplicateAccountIds.length === 0 &&
    missingSourceKeys.length === 0 &&
    extraSourceKeys.length === 0 &&
    missingAccountIds.length === 0 &&
    extraAccountIds.length === 0 &&
    mappingMismatches.length === 0 &&
    snapshotHashMismatches.length === 0 &&
    sourceCount === importedCount &&
    conflictCount === 0 &&
    stableStringify(roleDistributionSource) === stableStringify(roleDistributionImported);

  return {
    ok,
    status: ok ? "reconciled" : "conflict",
    snapshotId: transformedSnapshot.snapshotId,
    migrationId: snapshot.migrationId || snapshot.migration_id || null,
    freezeAt: snapshot.freezeAt || snapshot.freeze_at || null,
    snapshotHash: actualSourceHash,
    sourceSnapshotHash: actualSourceHash,
    reviewedSnapshotHash: expectedSourceHash,
    hashMismatch,
    sourceReportHashMismatch,
    sourceReportMismatch,
    sourceCounts,
    importedCounts,
    sourceCount,
    importedCount,
    conflictCount,
    roleDistribution: {
      source: roleDistributionSource,
      imported: roleDistributionImported
    },
    sourceAccountIds: sorted(expectedAccountIds),
    importedAccountIds: sorted(actualAccountIds),
    missingAccountIds,
    extraAccountIds,
    missingSourceKeys,
    extraSourceKeys,
    mappingMismatches: sortedEntries(mappingMismatches, ["sourceKey"]),
    snapshotHashMismatches: sortedEntries(snapshotHashMismatches, ["sourceKey"]),
    duplicateSourceKeys,
    duplicateAccountIds,
    unresolvedConflicts: conflicts.map((entry) => ({ ...entry }))
  };
}

export function reconcileMigration(snapshot, importedRows, options = {}) {
  return buildReconciliationReport({
    snapshot,
    importedRows,
    sourceReport: options.sourceReport,
    sourceSnapshotHash: options.sourceSnapshotHash
  });
}

/** Recursively freeze module-constructed reconciliation evidence. */
export function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

export async function reconcileCommittedMigrationInTransaction(snapshot, {
  transaction,
  sourceReport,
  sourceSnapshotHash,
  emailLookupHash,
  encryptionKeyVersion,
  completedAt = null,
  lock = true
} = {}) {
  if (!transaction || (typeof transaction !== "function" && typeof transaction.query !== "function") ||
      typeof emailLookupHash !== "function" || !Number.isSafeInteger(Number(encryptionKeyVersion)) ||
      Number(encryptionKeyVersion) < 1) {
    throw new Error("AUTH_MIGRATION_DATABASE_EVIDENCE_REQUIRED");
  }
  const transformed = transformLegacySnapshot(snapshot);
  const databaseConflicts = [];
  const importedRows = [];
  for (const row of transformed.importable) {
    try {
      const lookupHash = await emailLookupHash(row.normalized_email);
      importedRows.push(await verifyPersistedMigrationGraph(transaction, row, {
        migrationId: deriveAccountId(`${row.migration_id}:record`, `${row.source}:${row.source_user_id}`),
        emailLookupHash: lookupHash,
        encryptionKeyVersion: Number(encryptionKeyVersion),
        freezeAt: snapshot.freezeAt || snapshot.freeze_at || null,
        lock
      }));
    } catch (error) {
      databaseConflicts.push({
        source_user_id: row.source_user_id,
        code: error?.code === "AUTH_MIGRATION_PERSISTED_STATE_CONFLICT"
          ? "DATABASE_EVIDENCE_MISMATCH"
          : "DATABASE_EVIDENCE_READ_FAILED"
      });
    }
  }
  const report = buildReconciliationReport({
    snapshot,
    sourceReport,
    importedRows,
    sourceSnapshotHash
  });
  return deepFreeze({
    ...report,
    ok: report.ok && databaseConflicts.length === 0,
    status: report.ok && databaseConflicts.length === 0 ? "reconciled" : "conflict",
    conflictCount: report.conflictCount + databaseConflicts.length,
    freezeAt: snapshot.freezeAt || snapshot.freeze_at || null,
    completedAt,
    databaseConflicts: sortedEntries(databaseConflicts, ["source_user_id", "code"])
  });
}

export async function reconcileCommittedMigration(snapshot, {
  adapter,
  sourceReport,
  sourceSnapshotHash,
  emailLookupHash,
  encryptionKeyVersion
} = {}) {
  if (!adapter || typeof adapter.withReadOnlyTransaction !== "function") {
    throw new Error("AUTH_MIGRATION_DATABASE_EVIDENCE_REQUIRED");
  }
  return adapter.withReadOnlyTransaction((transaction) => reconcileCommittedMigrationInTransaction(snapshot, {
    transaction,
    sourceReport,
    sourceSnapshotHash,
    emailLookupHash,
    encryptionKeyVersion,
    lock: false
  }));
}

export async function reconcileSnapshotFile(snapshotFile, importedFile, options = {}) {
  const snapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
  const importedValue = importedFile ? JSON.parse(await readFile(importedFile, "utf8")) : [];
  const importedRows = Array.isArray(importedValue)
    ? importedValue
    : Array.isArray(importedValue.importable) ? importedValue.importable
      : Array.isArray(importedValue.rows) ? importedValue.rows : [];
  return reconcileMigration(snapshot, importedRows, options);
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] || null;
}

async function main(argv = process.argv.slice(2)) {
  const snapshotFile = argumentValue(argv, "--snapshot-file");
  const importedFile = argumentValue(argv, "--imported-file") || argumentValue(argv, "--target-file");
  if (!snapshotFile) throw new Error("Usage: node reconcile.mjs --snapshot-file <file> --imported-file <file>");
  if (!importedFile) throw new Error("Usage: node reconcile.mjs --snapshot-file <file> --imported-file <file>");
  const report = await reconcileSnapshotFile(snapshotFile, importedFile, {
    sourceSnapshotHash: argumentValue(argv, "--snapshot-hash")
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export { hashSnapshot };
