import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { getMigrationWriteMode } from "../../netlify/functions/_shared/migration-write-gate.mjs";
import { dryRunSnapshot, redactedDryRunSummary } from "./dry-run.mjs";
import { finalizeMigrationBatch } from "./finalize.mjs";
import { lockMigrationScope, readScopedMigrationBatchForUpdate } from "./migration-scope.mjs";
import { verifyPersistedMigrationGraph } from "./persisted-state.mjs";
import { deriveAccountId, stableStringify } from "./transform.mjs";

const ROLES = new Set(["pending", "free", "vip", "admin", "blocked"]);
const STATUSES = new Set(["active", "blocked"]);

function compareStrings(left, right) {
  const first = String(left);
  const second = String(right);
  return first < second ? -1 : first > second ? 1 : 0;
}

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rowKey(row) {
  const source = text(row && row.source);
  const sourceUserId = text(row && (row.source_user_id ?? row.sourceUserId));
  return source && sourceUserId ? `${source}\u0000${sourceUserId}` : null;
}

function assertVerifiedImportRow(row) {
  if (!row || row.email_verified !== true || !text(row.email_confirmed_at)) {
    throw migrationError("AUTH_MIGRATION_EMAIL_UNVERIFIED", "Verified legacy email evidence is required", 409);
  }
  return row;
}

function query(adapter, parts, values = []) {
  const strings = Array.from(parts);
  strings.raw = Array.from(parts);
  if (typeof adapter === "function") return adapter(strings, ...values);
  if (adapter && typeof adapter.query === "function") {
    const textValue = strings.reduce(
      (result, part, index) => `${result}${part}${index < values.length ? `$${index + 1}` : ""}`,
      ""
    );
    return adapter.query(textValue, values);
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

function rowField(row, names) {
  if (!row || typeof row !== "object") return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name) && row[name] !== undefined) return row[name];
  }
  return undefined;
}

function canonicalUuid(value) {
  const result = text(value);
  if (!result || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(result)) {
    throw migrationError("AUTH_MIGRATION_ROW_INVALID", "Invalid account identifier", 400);
  }
  return result;
}

function hashBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  const result = text(value);
  if (!result || !/^[a-f0-9]{64}$/u.test(result)) throw migrationError("AUTH_MIGRATION_ROW_INVALID", "Invalid snapshot hash", 400);
  return Buffer.from(result, "hex");
}

function bytesEqual(left, right) {
  const first = Buffer.isBuffer(left) ? left : Buffer.from(left || []);
  const second = Buffer.isBuffer(right) ? right : Buffer.from(right || []);
  return first.length === second.length && first.equals(second);
}

function migrationRecordId(row) {
  const provided = rowField(row, ["migration_record_id", "migrationRecordId"]);
  if (provided) return canonicalUuid(provided);
  const migrationId = text(row.migration_id ?? row.migrationId) || "migration";
  return deriveAccountId(`${migrationId}:record`, `${row.source}:${row.source_user_id}`);
}

function freezeAtFrom(value) {
  if (!value || typeof value !== "object") return null;
  return text(value.freezeAt ?? value.freeze_at);
}

function reviewedIdentity(value) {
  if (!value || typeof value !== "object") return null;
  const source = value.snapshot && typeof value.snapshot === "object" ? value.snapshot : value;
  let report = value.report && typeof value.report === "object" ? value.report : null;
  if (!report && Array.isArray(source.importable) && source.snapshotHash) report = source;
  if (!report && Array.isArray(source.profiles) && Array.isArray(source.identityUsers)) {
    report = dryRunSnapshot(source);
  }
  if (!report || !text(report.snapshotId) || !text(report.snapshotHash)) return null;
  const migrationId = text(source.migrationId ?? source.migration_id ?? value.migrationId ?? value.migration_id);
  const freezeAt = freezeAtFrom(source) || freezeAtFrom(value);
  return {
    snapshotId: text(report.snapshotId),
    snapshotHash: text(report.snapshotHash)?.toLowerCase() || null,
    migrationId,
    freezeAt
  };
}

export function validateFreezeAt(value, { now = Date.now() } = {}) {
  const raw = freezeAtFrom(value);
  if (!raw) throw migrationError("AUTH_MIGRATION_FREEZE_AT_REQUIRED");
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) throw migrationError("AUTH_MIGRATION_FREEZE_AT_INVALID");
  const minimum = Date.UTC(2000, 0, 1);
  const maximum = Number(now) + 5 * 60 * 1000;
  if (!Number.isFinite(maximum) || timestamp < minimum || timestamp > maximum) {
    throw migrationError("AUTH_MIGRATION_FREEZE_AT_INVALID");
  }
  return new Date(timestamp).toISOString();
}

function requiredRow(row) {
  if (!row || typeof row !== "object") throw migrationError("AUTH_MIGRATION_ROW_INVALID", "Invalid migration row", 400);
  assertVerifiedImportRow(row);
  const source = text(row.source);
  const sourceUserId = text(row.source_user_id ?? row.sourceUserId);
  const accountId = canonicalUuid(row.account_id ?? row.accountId);
  const email = text(row.normalized_email ?? row.normalizedEmail);
  const role = text(row.role)?.toLowerCase();
  const status = text(row.status)?.toLowerCase();
  const migrationId = text(row.migration_id ?? row.migrationId);
  if (!source || !sourceUserId || !email || !role || !status || !migrationId) {
    throw migrationError("AUTH_MIGRATION_ROW_INVALID", "Invalid migration row", 400);
  }
  if (!ROLES.has(role) || !STATUSES.has(status)) {
    throw migrationError("AUTH_MIGRATION_ROW_INVALID", "Invalid migration row", 400);
  }
  if (source.length > 255 || sourceUserId.length > 255 || /[\u0000-\u001f\u007f]/u.test(sourceUserId) || !email.includes("@")) {
    throw migrationError("AUTH_MIGRATION_ROW_INVALID", "Invalid migration row", 400);
  }
  return {
    source,
    sourceUserId,
    accountId,
    email,
    role,
    status,
    migrationId,
    snapshotHash: hashBytes(row.snapshot_hash ?? row.snapshotHash)
  };
}

export function assertReviewedSnapshot({ snapshot, report, reviewedSnapshot, snapshotId, snapshotHash, env, now } = {}) {
  const mode = getMigrationWriteMode(env);
  if (mode !== "frozen") throw migrationError("AUTH_MIGRATION_IMPORT_MODE_REQUIRED");
  if (String(env?.AUTH_ENV_ID || "").trim() !== "production") {
    throw migrationError("AUTH_MIGRATION_PRODUCTION_REQUIRED");
  }
  const freezeAt = validateFreezeAt(snapshot, { now });
  const reviewed = reviewedIdentity(reviewedSnapshot);
  if (!reviewed) throw migrationError("AUTH_MIGRATION_REVIEW_REQUIRED");
  if (reviewed.snapshotId !== text(report?.snapshotId) ||
      reviewed.snapshotHash !== text(report?.snapshotHash)?.toLowerCase() ||
      reviewed.migrationId !== text(snapshot?.migrationId ?? snapshot?.migration_id) ||
      validateFreezeAt(reviewedSnapshot, { now }) !== freezeAt) {
    throw migrationError("AUTH_MIGRATION_REVIEW_MISMATCH");
  }
  const expectedId = text(snapshotId);
  const expectedHash = text(snapshotHash)?.toLowerCase();
  if (!expectedId || !expectedHash || expectedId !== report.snapshotId || expectedHash !== report.snapshotHash) {
    throw migrationError("AUTH_MIGRATION_SNAPSHOT_MISMATCH");
  }
  if (!/^[a-f0-9]{64}$/u.test(expectedHash)) throw migrationError("AUTH_MIGRATION_SNAPSHOT_MISMATCH");
  if (report.conflicts.length > 0) throw migrationError("AUTH_MIGRATION_CONFLICTS_PRESENT");
}

/** A local-only idempotent adapter for fixtures and rehearsal tests. */
export function createMemoryImportAdapter(initialRows = []) {
  const records = new Map();
  for (const row of initialRows) {
    const key = rowKey(row);
    if (!key) throw migrationError("AUTH_MIGRATION_ROW_INVALID", "Invalid initial migration row", 400);
    records.set(key, clone(row));
  }
  return {
    async importRows(rows) {
      const pending = new Map([...records].map(([key, value]) => [key, clone(value)]));
      let imported = 0;
      let skipped = 0;
      for (const row of rows) {
        assertVerifiedImportRow(row);
        const key = rowKey(row);
        if (!key) throw migrationError("AUTH_MIGRATION_ROW_INVALID", "Invalid migration row", 400);
        const existing = pending.get(key);
        if (existing) {
          if (stableStringify(existing) !== stableStringify(row)) throw migrationError("AUTH_MIGRATION_IDEMPOTENCY_CONFLICT");
          skipped += 1;
          continue;
        }
        pending.set(key, clone(row));
        imported += 1;
      }
      records.clear();
      for (const [key, value] of pending) records.set(key, value);
      return { imported, skipped, rows: [...records.values()].map(clone) };
    },
    rows() {
      return [...records.values()]
        .sort((left, right) => compareStrings(rowKey(left), rowKey(right)))
        .map(clone);
    }
  };
}

async function invokeAdapter(adapter, rows, context) {
  if (!adapter || typeof adapter !== "object") throw migrationError("AUTH_MIGRATION_ADAPTER_REQUIRED");
  if (typeof adapter.importRows === "function") return adapter.importRows(rows, context);
  if (typeof adapter.withTransaction === "function") {
    return adapter.withTransaction(async (transaction) => invokeRowAdapter(transaction, rows, context));
  }
  return invokeRowAdapter(adapter, rows, context);
}

async function invokeRowAdapter(adapter, rows, context) {
  const importRow = typeof adapter.importRow === "function"
    ? adapter.importRow.bind(adapter)
    : typeof adapter.upsertMigrationRecord === "function"
      ? adapter.upsertMigrationRecord.bind(adapter)
      : null;
  if (!importRow) throw migrationError("AUTH_MIGRATION_ADAPTER_INVALID");
  let imported = 0;
  let skipped = 0;
  for (const row of rows) {
    const result = await importRow(row, context);
    if (result?.skipped) skipped += 1;
    else imported += 1;
  }
  return { imported, skipped };
}

/** Construct a Postgres adapter from injected dependencies only after import gating. */
function createPostgresImportAdapter({
  sql,
  withTransaction,
  environmentId,
  siteId,
  emailLookupHash,
  encryptEmail,
  encryptionKeyVersion,
  issuerOrTenant = "netlify_identity",
  connectorScope = "legacy",
  clock = () => new Date()
} = {}) {
  if (typeof sql !== "function" && !(sql && typeof sql.query === "function")) throw migrationError("AUTH_MIGRATION_ADAPTER_DEPENDENCY_INVALID");
  if (typeof withTransaction !== "function" || !text(environmentId) || !text(siteId) ||
      typeof emailLookupHash !== "function" || typeof encryptEmail !== "function" || typeof clock !== "function") {
    throw migrationError("AUTH_MIGRATION_ADAPTER_DEPENDENCY_INVALID");
  }
  const environment = text(environmentId);
  const site = text(siteId);
  const issuer = text(issuerOrTenant);
  const connector = text(connectorScope);
  if (!issuer || !connector) throw migrationError("AUTH_MIGRATION_ADAPTER_DEPENDENCY_INVALID");
  const keyVersion = Number(encryptionKeyVersion);
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1 || String(encryptionKeyVersion ?? "").trim() === "") {
    throw migrationError("AUTH_MIGRATION_ENCRYPTION_KEY_VERSION_INVALID", "Positive encryption key version is required", 400);
  }

  async function importOne(transaction, rawRow, context) {
    const row = requiredRow(rawRow);
    const migrationId = migrationRecordId(rawRow);
    const blockedAt = row.status === "blocked" ? text(context?.freezeAt) : null;
    if (row.status === "blocked" && (!blockedAt || !Number.isFinite(Date.parse(blockedAt)))) {
      throw migrationError("AUTH_MIGRATION_BLOCKED_AT_REQUIRED");
    }
    await rowsFrom(query(
      transaction,
      [
        `SELECT pg_advisory_xact_lock(hashtextextended(CAST(`,
        ` AS text) || chr(31) || CAST(`,
        ` AS text), 624783))`
      ],
      [row.source, row.sourceUserId]
    ));
    const emailHash = await emailLookupHash(row.email);
    if (!(emailHash instanceof Uint8Array) || emailHash.byteLength < 16 || emailHash.byteLength > 128) {
      throw migrationError("AUTH_MIGRATION_CRYPTO_INVALID");
    }
    const verifyExactWinner = () => verifyPersistedMigrationGraph(transaction, rawRow, {
      migrationId,
      emailLookupHash: Buffer.from(emailHash),
      encryptionKeyVersion: keyVersion,
      freezeAt: context?.freezeAt || null,
      issuerOrTenant: issuer,
      connectorScope: connector,
      lock: true
    });
    const existingRecords = await rowsFrom(query(
      transaction,
      [
        `SELECT migration_id, account_id, snapshot_hash, status FROM migration_records WHERE source = `,
        ` AND source_user_id = `,
        ` FOR UPDATE`
      ],
      [row.source, row.sourceUserId]
    ));
    if (existingRecords.length > 0) {
      await verifyExactWinner();
      return { skipped: true };
    }

    const existingAccounts = await rowsFrom(query(
      transaction,
      [
        `SELECT account_id, role, status, guild, game_name, migration_id, blocked_at FROM accounts WHERE account_id = `,
        ` FOR UPDATE`
      ],
      [row.accountId]
    ));
    if (existingAccounts.length > 0) {
      await verifyExactWinner();
      return { skipped: true };
    } else {
      const insertedAccounts = await rowsFrom(query(
        transaction,
        parameterParts(
          `INSERT INTO accounts (account_id, role, status, guild, game_name, blocked_at) VALUES (`,
          `) ON CONFLICT (account_id) DO NOTHING
             RETURNING account_id, role, status, guild, game_name, migration_id, blocked_at`,
          6
        ),
        [row.accountId, row.role, row.status, rawRow.guild ?? null, rawRow.game_name ?? rawRow.gameName ?? null, blockedAt]
      ));
      if (insertedAccounts.length > 1) throw migrationError("AUTH_MIGRATION_ACCOUNT_CONFLICT");
      if (insertedAccounts.length === 0) {
        await verifyExactWinner();
        return { skipped: true };
      }
    }

    const encryptedEmail = await encryptEmail(row.email, {
      environmentId: environment,
      siteId: site,
      keyVersion
    });
    if (!(encryptedEmail instanceof Uint8Array) ||
        encryptedEmail.byteLength < 1 || encryptedEmail.byteLength > 8192) {
      throw migrationError("AUTH_MIGRATION_CRYPTO_INVALID");
    }
    const completedAt = clock();
    if (!(completedAt instanceof Date) || Number.isNaN(completedAt.getTime())) throw migrationError("AUTH_MIGRATION_CLOCK_INVALID");

    const insertedMigrationRows = await rowsFrom(query(
      transaction,
      parameterParts(
        `INSERT INTO migration_records (
           migration_id, source, source_user_id, legacy_netlify_user_id,
           account_id, legacy_email_lookup_hash, snapshot_hash, status,
           freeze_at, created_at, completed_at
         ) VALUES (`,
        `) ON CONFLICT (source, source_user_id) DO NOTHING
           RETURNING migration_id, account_id, snapshot_hash, status`,
        11
      ),
      [
        migrationId,
        row.source,
        row.sourceUserId,
        row.sourceUserId,
        row.accountId,
        Buffer.from(emailHash),
        row.snapshotHash,
        "imported",
        context?.freezeAt || null,
        completedAt,
        completedAt
      ]
    ));
    let persistedMigrationRows = insertedMigrationRows;
    if (insertedMigrationRows.length === 0) {
      await verifyExactWinner();
      return { skipped: true };
    }
    if (persistedMigrationRows.length !== 1 ||
        text(rowField(persistedMigrationRows[0], ["migration_id", "migrationId"])) !== migrationId ||
        text(rowField(persistedMigrationRows[0], ["account_id", "accountId"])) !== row.accountId ||
        !bytesEqual(rowField(persistedMigrationRows[0], ["snapshot_hash", "snapshotHash"]), row.snapshotHash) ||
        text(rowField(persistedMigrationRows[0], ["status"]))?.toLowerCase() !== "imported") {
      throw migrationError("AUTH_MIGRATION_IDEMPOTENCY_CONFLICT");
    }
    const updatedAccounts = await rowsFrom(query(
      transaction,
      [
        `UPDATE accounts SET migration_id = `,
        ` WHERE account_id = `,
        ` RETURNING account_id, role, status, migration_id`
      ],
      [migrationId, row.accountId]
    ));
    if (updatedAccounts.length !== 1 ||
        text(rowField(updatedAccounts[0], ["account_id", "accountId"])) !== row.accountId ||
        text(rowField(updatedAccounts[0], ["role"]))?.toLowerCase() !== row.role ||
        text(rowField(updatedAccounts[0], ["status"]))?.toLowerCase() !== row.status ||
        text(rowField(updatedAccounts[0], ["migration_id", "migrationId"])) !== migrationId) {
      throw migrationError("AUTH_MIGRATION_ACCOUNT_CONFLICT");
    }

    const emailRows = await rowsFrom(query(
      transaction,
      [
        `SELECT account_id FROM account_emails WHERE email_lookup_hash = `,
        ` AND removed_at IS NULL FOR UPDATE`
      ],
      [Buffer.from(emailHash)]
    ));
    if (emailRows.length > 0) {
      await verifyExactWinner();
      return { skipped: true };
    } else {
      const verifiedAt = rawRow.email_verified === true && text(rawRow.email_confirmed_at) ? rawRow.email_confirmed_at : null;
      const insertedEmails = await rowsFrom(query(
        transaction,
        parameterParts(
          `INSERT INTO account_emails (
             account_id, email_lookup_hash, encrypted_email, encryption_key_version, is_primary, verified_at
           ) VALUES (`,
          `) RETURNING account_id, encryption_key_version, verified_at`,
          6
        ),
        [row.accountId, Buffer.from(emailHash), Buffer.from(encryptedEmail), keyVersion, true, verifiedAt]
      ));
      if (insertedEmails.length !== 1 ||
          text(rowField(insertedEmails[0], ["account_id", "accountId"])) !== row.accountId ||
          Number(rowField(insertedEmails[0], ["encryption_key_version", "encryptionKeyVersion"])) !== keyVersion ||
          !text(rowField(insertedEmails[0], ["verified_at", "verifiedAt"]))) {
        throw migrationError("AUTH_MIGRATION_EMAIL_CONFLICT");
      }
    }

    const identityRows = await rowsFrom(query(
      transaction,
      [
        `SELECT account_id FROM auth_identities WHERE issuer_or_tenant = `,
        ` AND connector_scope = `,
        ` AND provider_subject = `,
        ` AND revoked_at IS NULL FOR UPDATE`
      ],
      [issuer, connector, row.sourceUserId]
    ));
    if (identityRows.length > 0) {
      await verifyExactWinner();
      return { skipped: true };
    } else {
      const insertedIdentities = await rowsFrom(query(
        transaction,
        parameterParts(
          `INSERT INTO auth_identities (account_id, issuer_or_tenant, connector_scope, provider_subject, subject_type, status) VALUES (`,
          `) RETURNING account_id, issuer_or_tenant, connector_scope, provider_subject, status`,
          6
        ),
        [row.accountId, issuer, connector, row.sourceUserId, "netlify_user_id", "active"]
      ));
      if (insertedIdentities.length !== 1 ||
          text(rowField(insertedIdentities[0], ["account_id", "accountId"])) !== row.accountId ||
          text(rowField(insertedIdentities[0], ["issuer_or_tenant", "issuerOrTenant"])) !== issuer ||
          text(rowField(insertedIdentities[0], ["connector_scope", "connectorScope"])) !== connector ||
          text(rowField(insertedIdentities[0], ["provider_subject", "providerSubject"])) !== row.sourceUserId ||
          text(rowField(insertedIdentities[0], ["status"]))?.toLowerCase() !== "active") {
        throw migrationError("AUTH_MIGRATION_IDENTITY_CONFLICT");
      }
    }
    await verifyExactWinner();
    return { imported: true };
  }

  return {
    async importRows(rows, context) {
      if (!Array.isArray(rows)) throw migrationError("AUTH_MIGRATION_ROWS_INVALID", "Invalid migration rows", 400);
      return withTransaction(async (transaction) => {
        const sources = new Set(rows.map((row) => requiredRow(row).source));
        if (sources.size > 1) throw migrationError("AUTH_MIGRATION_SOURCE_INVALID", "Import rows must share one source", 400);
        if (sources.size === 1) {
          const source = [...sources][0];
          const scope = { source, environmentId: environment, siteId: site };
          await lockMigrationScope(transaction, scope);
          const batch = await readScopedMigrationBatchForUpdate(transaction, scope);
          const batchStatus = text(rowField(batch, ["status"]))?.toLowerCase();
          const batchCompletedAt = rowField(batch, ["completed_at", "completedAt"]);
          if (batch && (batchStatus === "reconciled" || batchCompletedAt !== null && batchCompletedAt !== undefined)) {
            throw migrationError(
              "AUTH_MIGRATION_BATCH_ALREADY_FINALIZED",
              "Migration batch is already finalized",
              409
            );
          }
        }
        let imported = 0;
        let skipped = 0;
        for (const row of rows) {
          const result = await importOne(transaction, row, context);
          if (result.skipped) skipped += 1;
          else imported += 1;
        }
        return { imported, skipped };
      });
    }
  };
}

/** Transform and optionally import. A no-apply run never touches the adapter. */
export async function importSnapshot(snapshot, options = {}) {
  const report = dryRunSnapshot(snapshot);
  if (options.apply !== true) return { applied: false, report };
  assertReviewedSnapshot({
    report,
    snapshot,
    reviewedSnapshot: options.reviewedSnapshot || options.reviewedReport,
    snapshotId: options.snapshotId ?? options.reviewedSnapshotId,
    snapshotHash: options.snapshotHash ?? options.reviewedSnapshotHash,
    env: options.env || process.env,
    now: options.now
  });
  const adapter = options.adapter || (options.postgresAdapterOptions
    ? createPostgresImportAdapter(options.postgresAdapterOptions)
    : null);
  if (!adapter) throw migrationError("AUTH_MIGRATION_ADAPTER_REQUIRED");
  const result = await invokeAdapter(adapter, report.importable, {
    migrationId: snapshot.migrationId || snapshot.migration_id,
    snapshotId: report.snapshotId,
    snapshotHash: report.snapshotHash,
    freezeAt: snapshot.freezeAt || snapshot.freeze_at || null
  });
  return {
    applied: true,
    report,
    imported: Number(result?.imported || 0),
    skipped: Number(result?.skipped || 0)
  };
}

export async function runImport({
  snapshotFile,
  reviewedSnapshotFile = null,
  snapshotId = null,
  snapshotHash = null,
  reviewedSnapshot = null,
  apply = false,
  env = process.env,
  adapter = null,
  adapterLoader = null,
  postgresAdapterOptions = null,
  finalize = false,
  finalizeBatch = false,
  batchAdapter = null,
  finalizationAdapter = null,
  evidenceAdapter = null,
  emailLookupHash = null,
  encryptionKeyVersion = null,
  environmentId = null,
  siteId = null,
  source = "netlify_identity",
  now
} = {}) {
  if (!snapshotFile) throw migrationError("MIGRATION_SNAPSHOT_FILE_REQUIRED", "Snapshot file is required", 400);
  const snapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
  const report = dryRunSnapshot(snapshot);
  let reviewed = reviewedSnapshot;
  if (reviewedSnapshotFile) reviewed = JSON.parse(await readFile(reviewedSnapshotFile, "utf8"));
  if (apply && !reviewed) throw migrationError("AUTH_MIGRATION_REVIEW_FILE_REQUIRED");
  if (apply) {
    // Validate mode, production sentinel, reviewed ID/hash, and conflicts
    // before loading an adapter module that might have side effects.
    assertReviewedSnapshot({ snapshot, report, reviewedSnapshot: reviewed, snapshotId, snapshotHash, env, now });
    const ownerFinalizationAdapter = finalizationAdapter || batchAdapter || evidenceAdapter;
    const finalizationEmailLookupHash = emailLookupHash || postgresAdapterOptions?.emailLookupHash;
    const finalizationKeyVersion = encryptionKeyVersion ?? postgresAdapterOptions?.encryptionKeyVersion;
    if ((finalize === true || finalizeBatch === true) &&
        (!ownerFinalizationAdapter || typeof ownerFinalizationAdapter.withTransaction !== "function" ||
         typeof finalizationEmailLookupHash !== "function" ||
         !Number.isSafeInteger(Number(finalizationKeyVersion)) || Number(finalizationKeyVersion) < 1)) {
      throw migrationError("AUTH_MIGRATION_DATABASE_EVIDENCE_REQUIRED");
    }
    if (!adapter && typeof adapterLoader === "function") adapter = await adapterLoader();
  }
  const result = await importSnapshot(snapshot, {
    env,
    apply,
    snapshotId,
    snapshotHash,
    reviewedSnapshot: reviewed,
    adapter,
    postgresAdapterOptions,
    now
  });
  if (apply && (finalize === true || finalizeBatch === true)) {
    const finalized = await finalizeMigrationBatch({
      snapshot,
      sourceReport: report,
      reviewedSnapshot: reviewed,
      source,
      environmentId: environmentId || env?.AUTH_ENV_ID,
      siteId: siteId || env?.NETLIFY_SITE_ID || env?.AUTH_EXPECTED_SITE_ID,
      adapter: finalizationAdapter || batchAdapter || evidenceAdapter,
      emailLookupHash: emailLookupHash || postgresAdapterOptions?.emailLookupHash,
      encryptionKeyVersion: encryptionKeyVersion ?? postgresAdapterOptions?.encryptionKeyVersion,
      env,
      now
    });
    return { ...result, finalized };
  }
  return result;
}

function argumentValue(argv, names) {
  for (const name of names) {
    const index = argv.indexOf(name);
    if (index !== -1) return argv[index + 1] || null;
  }
  return null;
}

async function loadAdapter(file) {
  if (!file) throw migrationError("AUTH_MIGRATION_ADAPTER_REQUIRED");
  const module = await import(pathToFileURL(file).href);
  const factory = module.createAdapter || module.default;
  if (typeof factory === "function") return factory();
  if (factory && typeof factory === "object") return factory;
  throw migrationError("AUTH_MIGRATION_ADAPTER_INVALID");
}

async function main(argv = process.argv.slice(2)) {
  const snapshotFile = argumentValue(argv, ["--snapshot-file"]);
  if (!snapshotFile) throw new Error("Usage: node import.mjs --snapshot-file <file> --snapshot-id <id> --snapshot-hash <sha256> [--apply]");
  const apply = argv.includes("--apply");
  const result = await runImport({
    snapshotFile,
    reviewedSnapshotFile: argumentValue(argv, ["--reviewed-file", "--reviewed-snapshot-file"]),
    snapshotId: argumentValue(argv, ["--snapshot-id"]),
    snapshotHash: argumentValue(argv, ["--snapshot-hash"]),
    apply,
    env: process.env,
    adapterLoader: apply
      ? () => loadAdapter(argumentValue(argv, ["--adapter-module"]))
      : null
  });
  if (apply) {
    process.stdout.write(`${JSON.stringify({
      applied: result.applied,
      imported: result.imported,
      skipped: result.skipped,
      snapshotId: result.report.snapshotId,
      snapshotHash: result.report.snapshotHash
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(redactedDryRunSummary(result.report))}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
