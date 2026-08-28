import { sql as defaultSql, withTransaction as defaultWithTransaction } from "./db.mjs";
import {
  emailLookupHash as defaultEmailLookupHash,
  encryptSecret as defaultEncryptSecret,
  decryptSecret as defaultDecryptSecret
} from "./crypto.mjs";
import { canonicalIssuer } from "./config.mjs";

const ACCOUNT_COLUMNS = `
  a.account_id,
  a.role,
  a.status,
  a.guild,
  a.game_name,
  a.authz_version,
  a.merged_into_account_id,
  a.migration_id,
  a.blocked_at,
  a.created_at,
  a.updated_at
`;

const ACCOUNT_RETURNING_COLUMNS = `
  account_id,
  role,
  status,
  guild,
  game_name,
  authz_version,
  merged_into_account_id,
  migration_id,
  blocked_at,
  created_at,
  updated_at
`;

// A fixed seed keeps the transaction-scoped subject lock key stable across
// processes. Hash collisions only serialize unrelated subjects; correctness
// still comes from the identity rows and the database unique index.
const SUBJECT_SERIALIZATION_SEED = 20260825;
const EMAIL_SERIALIZATION_SEED = 20260826;
const NEW_ACCOUNT_CONNECTOR_SCOPES = new Set(["logto"]);
// PostgreSQL UUID accepts both cases and does not require a particular UUID
// version/variant. Keep the boundary strict about shape, then canonicalize
// before comparing or passing the identifier to SQL.
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isValidAccountId(value) {
  return typeof value === "string" && ACCOUNT_ID_PATTERN.test(value.trim());
}

/** Stable, non-sensitive error shape for auth boundary failures. */
export class AuthError extends Error {
  constructor(code, status = 401, message = code) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.httpStatus = status;
  }
}

function query(adapter, parts, values = []) {
  const strings = Array.from(parts);
  strings.raw = Array.from(parts);
  if (typeof adapter === "function") return adapter(strings, ...values);
  if (adapter && typeof adapter.query === "function") {
    const text = strings.reduce(
      (result, part, index) => `${result}${part}${index < values.length ? `$${index + 1}` : ""}`,
      ""
    );
    return adapter.query(text, values);
  }
  throw new TypeError("auth SQL adapter must be a tagged function or query object");
}

async function rowsFrom(result) {
  const value = await result;
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.rows)) return value.rows;
  return [];
}

function field(row, camelName, snakeName = camelName) {
  if (Object.prototype.hasOwnProperty.call(row, camelName)) return row[camelName];
  return row[snakeName];
}

/** Allow-list account fields at the repository boundary. */
export function mapAccountRow(row) {
  if (!row || typeof row !== "object") return null;
  const accountId = field(row, "accountId", "account_id");
  if (accountId === undefined || accountId === null || String(accountId).trim() === "") return null;
  return {
    accountId,
    role: field(row, "role"),
    status: field(row, "status"),
    guild: field(row, "guild") ?? null,
    gameName: field(row, "gameName", "game_name") ?? null,
    authzVersion: field(row, "authzVersion", "authz_version"),
    mergedIntoAccountId: field(row, "mergedIntoAccountId", "merged_into_account_id") ?? null,
    migrationId: field(row, "migrationId", "migration_id") ?? null,
    blockedAt: field(row, "blockedAt", "blocked_at") ?? null,
    createdAt: field(row, "createdAt", "created_at") ?? null,
    updatedAt: field(row, "updatedAt", "updated_at") ?? null
  };
}

function oneAccount(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const accounts = rows.map(mapAccountRow);
  if (accounts.some((account) => !account)) return null;
  const ids = new Set(accounts.map((account) => String(account.accountId)));
  return ids.size === 1 ? accounts[0] : null;
}

function exactlyOneAccount(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  return mapAccountRow(rows[0]);
}

function text(value, code = "AUTH_INPUT_INVALID", status = 400) {
  const result = String(value ?? "").trim();
  if (!result) throw new AuthError(code, status);
  return result;
}

function requiredText(value, code = "AUTH_INPUT_INVALID", status = 400) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AuthError(code, status);
  }
  return value.trim();
}

function canonicalConfiguredIssuer(value) {
  if (value === undefined || value === null) return value;
  try {
    return canonicalIssuer(value);
  } catch {
    throw new AuthError("AUTH_CONFIG_INVALID:LOGTO_ENDPOINT", 500);
  }
}

function dependencies(overrides = {}) {
  if (!overrides || typeof overrides !== "object") {
    throw new TypeError("auth repository dependencies must be an object");
  }
  return {
    sql: overrides.sql || defaultSql,
    withTransaction: overrides.withTransaction || defaultWithTransaction,
    emailLookupHash: overrides.emailLookupHash,
    issuerOrTenant: canonicalConfiguredIssuer(overrides.issuerOrTenant)
  };
}

function repositoryDependencies(overrides = {}) {
  if (!overrides || typeof overrides !== "object") {
    throw new TypeError("auth repository dependencies must be an object");
  }
  const hasSql = Object.prototype.hasOwnProperty.call(overrides, "sql") &&
    overrides.sql !== undefined;
  const hasWithTransaction = Object.prototype.hasOwnProperty.call(overrides, "withTransaction") &&
    overrides.withTransaction !== undefined;
  if (hasSql !== hasWithTransaction) {
    throw new AuthError("AUTH_REPOSITORY_DEPENDENCY_MISMATCH", 500);
  }

  const resolved = {
    sql: hasSql ? overrides.sql : defaultSql,
    withTransaction: hasWithTransaction ? overrides.withTransaction : defaultWithTransaction,
    emailLookupHash: overrides.emailLookupHash || defaultEmailLookupHash,
    encryptSecret: overrides.encryptSecret || defaultEncryptSecret,
    decryptSecret: overrides.decryptSecret || defaultDecryptSecret,
    issuerOrTenant: canonicalConfiguredIssuer(overrides.issuerOrTenant),
    environmentId: overrides.environmentId ?? process.env.AUTH_ENV_ID,
    siteId: overrides.siteId ?? overrides.expectedSiteId ?? process.env.NETLIFY_SITE_ID,
    keyVersion: overrides.keyVersion ?? overrides.encryptionKeyVersion ??
      process.env.AUTH_ENCRYPTION_KEY_VERSION ?? "1",
    hmacKey: overrides.hmacKey ?? overrides.authHmacKey,
    encryptionKey: overrides.encryptionKey ?? overrides.authEncryptionKey
  };
  if (!taggedAdapter(resolved.sql) || typeof resolved.withTransaction !== "function") {
    throw new AuthError("AUTH_REPOSITORY_DEPENDENCY_MISMATCH", 500);
  }
  return resolved;
}

function accountIdValue(value, code = "AUTH_INPUT_INVALID", status = 400) {
  const accountId = text(value, code, status);
  if (!isValidAccountId(accountId)) throw new AuthError(code, status);
  return accountId.toLowerCase();
}

function roleValue(value) {
  const role = text(value, "AUTH_INPUT_INVALID", 400).toLowerCase();
  if (!["pending", "free", "vip", "admin", "blocked"].includes(role)) {
    throw new AuthError("AUTH_INPUT_INVALID", 400);
  }
  return role;
}

function statusValue(value) {
  const status = text(value, "AUTH_INPUT_INVALID", 400).toLowerCase();
  if (!["active", "blocked", "merged", "disabled"].includes(status)) {
    throw new AuthError("AUTH_INPUT_INVALID", 400);
  }
  return status;
}

function metadataValue(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthError("AUTH_INPUT_INVALID", 400);
  }
  return value;
}

function maskedEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) return "";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.length <= 1 ? local : local.slice(0, 1);
  return `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

function cryptoOptions(deps, keyVersion = deps.keyVersion) {
  const options = {
    environmentId: deps.environmentId,
    siteId: deps.siteId,
    keyVersion
  };
  if (deps.hmacKey !== undefined) options.hmacKey = deps.hmacKey;
  if (deps.encryptionKey !== undefined) options.encryptionKey = deps.encryptionKey;
  return options;
}

function configuredIssuer(deps) {
  if (!deps.issuerOrTenant) throw new AuthError("AUTH_DEPENDENCY_MISSING", 500);
  return text(deps.issuerOrTenant, "AUTH_DEPENDENCY_MISSING", 500);
}

function taggedAdapter(value) {
  return typeof value === "function" || Boolean(value && typeof value.query === "function");
}

function assertTransaction(transaction) {
  if (!taggedAdapter(transaction) ||
      typeof transaction.begin === "function" ||
      typeof transaction.savepoint !== "function") {
    throw new AuthError("TRANSACTION_REQUIRED", 500);
  }
  return transaction;
}

async function createFreeAccountInTransaction(transaction, { guild = null, gameName = null } = {}) {
  assertTransaction(transaction);
  const rows = await rowsFrom(query(
    transaction,
    [
      `SELECT * FROM public.create_free_account(`,
      ", ",
      `)`
    ],
    [guild, gameName]
  ));
  const account = oneAccount(rows);
  if (!account) throw new AuthError("ACCOUNT_CREATE_FAILED", 500);
  return account;
}

async function insertAccount(transaction, input = {}) {
  assertTransaction(transaction);
  if (!input || typeof input !== "object") throw new AuthError("AUTH_INPUT_INVALID", 400);
  const role = String(input.role ?? "free").trim().toLowerCase() || "free";
  const status = String(input.status ?? "active").trim().toLowerCase() || "active";
  if (role !== "free" || status !== "active") throw new AuthError("AUTH_INPUT_INVALID", 400);
  return createFreeAccountInTransaction(transaction, {
    guild: input.guild ?? null,
    gameName: input.gameName ?? input.game_name ?? null
  });
}

async function findLogto(sql, subjectInput, deps) {
  const issuerOrTenant = configuredIssuer(deps);
  const subject = text(subjectInput);
  const rows = await rowsFrom(query(
    sql,
    [
      `SELECT ${ACCOUNT_COLUMNS}
       FROM auth_identities AS i
       JOIN accounts AS a ON a.account_id = i.account_id
       WHERE i.issuer_or_tenant = `,
      `
         AND i.provider_subject = `,
      `
         AND i.subject_type = 'sub'
         AND i.status = 'active'
         AND i.revoked_at IS NULL`
    ],
    [issuerOrTenant, subject]
  ));
  return oneAccount(rows);
}

async function findByAccountId(sql, accountIdInput) {
  const accountId = accountIdValue(accountIdInput, "AUTH_ACCOUNT_INVALID", 400);
  const rows = await rowsFrom(query(
    sql,
    [`SELECT ${ACCOUNT_COLUMNS}
       FROM accounts AS a
       WHERE a.account_id = `],
    [accountId]
  ));
  return exactlyOneAccount(rows);
}

function accountLimit(value) {
  if (value === undefined || value === null || value === "") return 200;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new AuthError("AUTH_LIMIT_INVALID", 400);
  return Math.min(limit, 1000);
}

async function listAllAccounts(sql, rawLimit) {
  const limit = accountLimit(rawLimit);
  const rows = await rowsFrom(query(
    sql,
    [`SELECT ${ACCOUNT_COLUMNS}
       FROM accounts AS a
       ORDER BY a.created_at DESC, a.account_id
       LIMIT `],
    [limit]
  ));
  const accounts = rows.map(mapAccountRow);
  if (accounts.some((account) => !account)) throw new AuthError("ACCOUNT_MAPPING_MISSING", 503);
  return accounts;
}

async function requestVipInTransaction(transaction, rawInput, deps) {
  assertTransaction(transaction);
  if (!rawInput || typeof rawInput !== "object") throw new AuthError("AUTH_INPUT_INVALID", 400);
  const accountId = accountIdValue(rawInput.accountId, "AUTH_ACCOUNT_INVALID", 400);
  const guild = text(rawInput.guild, "AUTH_INPUT_INVALID", 400);
  const gameName = text(rawInput.gameName, "AUTH_INPUT_INVALID", 400);
  const profileRows = await rowsFrom(query(
    transaction,
    [
      `UPDATE accounts
          SET guild = `,
      `, game_name = `,
      `, updated_at = now()
        WHERE account_id = `,
      ` AND status = 'active'
        RETURNING account_id`
    ],
    [guild, gameName, accountId]
  ));
  if (profileRows.length !== 1) throw new AuthError("ACCOUNT_NOT_FOUND", 404);

  const transitionRows = await rowsFrom(query(
    transaction,
    [
      `SELECT public.request_account_vip(`,
      `, `,
      `::jsonb) AS account_id`
    ],
    [accountId, { operation: "vip-request" }]
  ));
  if (transitionRows.length !== 1) throw new AuthError("ACCOUNT_UPDATE_FAILED", 500);
  const transitionedAccountId = field(transitionRows[0], "accountId", "account_id");
  if (String(transitionedAccountId).toLowerCase() !== accountId) {
    throw new AuthError("ACCOUNT_UPDATE_FAILED", 500);
  }

  const rows = await rowsFrom(query(
    transaction,
    [`SELECT ${ACCOUNT_RETURNING_COLUMNS}
       FROM accounts
       WHERE account_id = `],
    [accountId]
  ));
  const account = exactlyOneAccount(rows);
  if (!account) throw new AuthError("ACCOUNT_UPDATE_FAILED", 500);
  return account;
}

async function revokeActiveSessionsInTransaction(transaction, accountId, deps) {
  if (typeof deps.environmentId !== "string" || deps.environmentId.trim() === "") {
    throw new AuthError("AUTH_CONFIG_MISSING:AUTH_ENV_ID", 500);
  }
  if (typeof deps.siteId !== "string" || deps.siteId.trim() === "") {
    throw new AuthError("AUTH_CONFIG_MISSING:NETLIFY_SITE_ID", 500);
  }
  const rows = await rowsFrom(query(
    transaction,
    [
      `UPDATE auth_sessions
          SET revoked_at = now()
        WHERE environment_id = `,
      ` AND site_id = `,
      ` AND account_id = `,
      ` AND revoked_at IS NULL
        RETURNING session_id`
    ],
    [deps.environmentId, deps.siteId, accountId]
  ));
  return rows.length;
}

async function setAuthorizationInTransaction(transaction, rawInput, deps) {
  assertTransaction(transaction);
  if (!rawInput || typeof rawInput !== "object") throw new AuthError("AUTH_INPUT_INVALID", 400);
  const actorAccountId = accountIdValue(rawInput.actorAccountId, "AUTH_ACCOUNT_INVALID", 400);
  const targetAccountId = accountIdValue(rawInput.targetAccountId, "AUTH_ACCOUNT_INVALID", 400);
  const role = roleValue(rawInput.role);
  const status = statusValue(rawInput.status ?? (role === "blocked" ? "blocked" : "active"));
  if ((role === "blocked") !== (status === "blocked")) {
    throw new AuthError("AUTH_INPUT_INVALID", 400);
  }
  if (actorAccountId === targetAccountId && (role !== "admin" || status !== "active")) {
    throw new AuthError("CAPABILITY_SELF_MUTATION", 409);
  }
  const targetRows = await rowsFrom(query(
    transaction,
    [`SELECT ${ACCOUNT_RETURNING_COLUMNS}
       FROM accounts
       WHERE account_id = `, ` FOR UPDATE`],
    [targetAccountId]
  ));
  const before = exactlyOneAccount(targetRows);
  if (!before) throw new AuthError("ACCOUNT_NOT_FOUND", 404);

  await rowsFrom(query(
    transaction,
    [
      `SELECT public.set_account_authorization(`,
      `, `,
      `, `,
      `::public.auth_account_role, `,
      `::public.auth_account_status, `,
      `::jsonb) AS account_id`
    ],
    [actorAccountId, targetAccountId, role, status, metadataValue(rawInput.metadata)]
  ));

  const revokedSessionCount = status === "blocked" ||
    (String(before.role).toLowerCase() === "admin" && role !== "admin")
    ? await revokeActiveSessionsInTransaction(transaction, targetAccountId, deps)
    : 0;
  const updatedRows = await rowsFrom(query(
    transaction,
    [`SELECT ${ACCOUNT_RETURNING_COLUMNS}
       FROM accounts
       WHERE account_id = `],
    [targetAccountId]
  ));
  const updated = exactlyOneAccount(updatedRows);
  if (!updated) throw new AuthError("ACCOUNT_UPDATE_FAILED", 500);
  return {
    account: updated,
    authzVersion: updated.authzVersion,
    revokedSessionCount
  };
}

async function deleteAccountInTransaction(transaction, rawInput, deps) {
  assertTransaction(transaction);
  if (!rawInput || typeof rawInput !== "object") throw new AuthError("AUTH_INPUT_INVALID", 400);
  const actorAccountId = accountIdValue(rawInput.actorAccountId, "AUTH_ACCOUNT_INVALID", 400);
  const targetAccountId = accountIdValue(rawInput.targetAccountId, "AUTH_ACCOUNT_INVALID", 400);
  if (actorAccountId === targetAccountId) throw new AuthError("CAPABILITY_SELF_MUTATION", 409);
  const actorRows = await rowsFrom(query(
    transaction,
    [`SELECT account_id
       FROM accounts
       WHERE account_id = `, ` AND role = 'admin' AND status = 'active'`],
    [actorAccountId]
  ));
  if (actorRows.length !== 1) throw new AuthError("CAPABILITY_DENIED", 403);
  const result = await setAuthorizationInTransaction(transaction, {
    actorAccountId,
    targetAccountId,
    role: "blocked",
    status: "blocked",
    metadata: { operation: "admin-delete-user" }
  }, deps);
  return {
    accountId: targetAccountId,
    account: result.account,
    authzVersion: result.authzVersion,
    revokedSessionCount: result.revokedSessionCount,
    deleted: true,
    deletionMode: "soft"
  };
}

async function primaryEmailMasked(sql, accountIdInput, deps) {
  const accountId = accountIdValue(accountIdInput, "AUTH_ACCOUNT_INVALID", 400);
  const rows = await rowsFrom(query(
    sql,
    [`SELECT encrypted_email, encryption_key_version
       FROM account_emails
       WHERE account_id = `,
      ` AND is_primary = TRUE
       AND removed_at IS NULL`],
    [accountId]
  ));
  if (rows.length !== 1 || typeof deps.decryptSecret !== "function") return "";
  const encrypted = field(rows[0], "encryptedEmail", "encrypted_email");
  const keyVersion = field(rows[0], "encryptionKeyVersion", "encryption_key_version");
  if (encrypted === undefined || encrypted === null || keyVersion === undefined || keyVersion === null) return "";
  try {
    const email = await deps.decryptSecret(encrypted, cryptoOptions(deps, keyVersion));
    return maskedEmail(email);
  } catch {
    return "";
  }
}

async function findLegacy(sql, legacyNetlifyUserId) {
  const userId = text(legacyNetlifyUserId);
  const rows = await rowsFrom(query(
    sql,
    [
      `SELECT ${ACCOUNT_COLUMNS}
       FROM migration_records AS m
       JOIN accounts AS a ON a.account_id = m.account_id
       WHERE m.legacy_netlify_user_id = `,
      ` AND m.account_id IS NOT NULL`
    ],
    [userId]
  ));
  return exactlyOneAccount(rows);
}

async function findLegacyMigration(sql, legacyNetlifyUserId, deps) {
  const userId = text(legacyNetlifyUserId);
  if (!deps.environmentId || !deps.siteId) return null;
  const rows = await rowsFrom(query(
    sql,
    [
      `SELECT m.migration_id,
              m.source,
              m.source_user_id,
              m.legacy_netlify_user_id,
              m.account_id,
              m.status,
              m.freeze_at,
              a.migration_id AS account_migration_id
       FROM migration_records AS m
       JOIN accounts AS a ON a.account_id = m.account_id
       WHERE m.legacy_netlify_user_id = `,
      `
         AND m.source_user_id = m.legacy_netlify_user_id
         AND m.source = 'netlify_identity'
         AND m.status IN ('imported', 'reconciled')
         AND m.account_id IS NOT NULL
         AND m.freeze_at IS NOT NULL
         AND a.migration_id = m.migration_id`
    ],
    [userId]
  ));
  if (rows.length !== 1) return null;
  const row = rows[0];
  const migrationId = field(row, "migrationId", "migration_id");
  const source = field(row, "source");
  const sourceUserId = field(row, "sourceUserId", "source_user_id");
  const mappedLegacyUserId = field(row, "legacyNetlifyUserId", "legacy_netlify_user_id");
  const accountId = field(row, "accountId", "account_id");
  const accountMigrationId = field(row, "accountMigrationId", "account_migration_id");
  const status = field(row, "status");
  const freezeAt = field(row, "freezeAt", "freeze_at");
  if ([migrationId, source, sourceUserId, mappedLegacyUserId, accountId, accountMigrationId, status, freezeAt]
    .some((value) => value === undefined || value === null || String(value).trim() === "")) {
    return null;
  }
  if (source !== "netlify_identity" || !["imported", "reconciled"].includes(String(status))) {
    return null;
  }
  if (String(sourceUserId) !== userId || String(mappedLegacyUserId) !== userId ||
      String(accountMigrationId) !== String(migrationId)) return null;
  return {
    migrationId,
    source,
    sourceUserId,
    legacyNetlifyUserId: mappedLegacyUserId,
    accountId,
    status,
    freezeAt,
    environmentId: deps.environmentId,
    siteId: deps.siteId
  };
}

function migrationBatchConflict() {
  return new AuthError("AUTH_MIGRATION_BATCH_CONFLICT", 409);
}

function migrationBatchCount(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  throw migrationBatchConflict();
}

function migrationBatchTimestamp(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw migrationBatchConflict();
    return new Date(value.getTime());
  }
  if (typeof value !== "string" || value.trim() === "") throw migrationBatchConflict();
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw migrationBatchConflict();
  return value.trim();
}

async function findReconciledMigrationBatch(sql, input, deps) {
  const source = requiredText(input?.source, "AUTH_INPUT_INVALID");
  if (source !== "netlify_identity") throw new AuthError("AUTH_INPUT_INVALID", 400);
  const environmentId = requiredText(deps.environmentId, "AUTH_CONFIG_MISSING:AUTH_ENV_ID", 500);
  const siteId = requiredText(deps.siteId, "AUTH_CONFIG_MISSING:NETLIFY_SITE_ID", 500);
  const rows = await rowsFrom(query(
    sql,
    [
      `SELECT batch_id, source, snapshot_id, source_count, imported_count,
              conflict_count, freeze_at, completed_at
       FROM auth_migration_batches
       WHERE source = `,
      ` AND environment_id = `,
      ` AND site_id = `,
      ` AND status = 'reconciled'`
    ],
    [source, environmentId, siteId]
  ));
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !rows[0] || typeof rows[0] !== "object") {
    throw migrationBatchConflict();
  }

  const row = rows[0];
  const batchId = requiredText(field(row, "batchId", "batch_id"), "AUTH_MIGRATION_BATCH_CONFLICT", 409);
  const rowSource = requiredText(field(row, "source"), "AUTH_MIGRATION_BATCH_CONFLICT", 409);
  const snapshotId = requiredText(field(row, "snapshotId", "snapshot_id"), "AUTH_MIGRATION_BATCH_CONFLICT", 409);
  const sourceCount = migrationBatchCount(field(row, "sourceCount", "source_count"));
  const importedCount = migrationBatchCount(field(row, "importedCount", "imported_count"));
  const conflictCount = migrationBatchCount(field(row, "conflictCount", "conflict_count"));
  const freezeAt = migrationBatchTimestamp(field(row, "freezeAt", "freeze_at"));
  const completedAt = migrationBatchTimestamp(field(row, "completedAt", "completed_at"));
  if (rowSource !== source || sourceCount !== importedCount || conflictCount !== 0) {
    throw migrationBatchConflict();
  }

  return Object.freeze({
    batchId,
    source: rowSource,
    snapshotId,
    sourceCount,
    importedCount,
    conflictCount,
    freezeAt,
    completedAt
  });
}

function claimInput(rawInput, deps) {
  if (!rawInput || typeof rawInput !== "object") throw new AuthError("AUTH_INPUT_INVALID", 400);
  const configured = configuredIssuer(deps);
  const issuerOrTenant = canonicalConfiguredIssuer(text(rawInput.issuerOrTenant));
  if (issuerOrTenant !== configured) throw new AuthError("AUTH_INPUT_INVALID", 400);
  return {
    logtoSubject: text(rawInput.logtoSubject),
    issuerOrTenant,
    connectorScope: text(rawInput.connectorScope),
    normalizedEmail: text(rawInput.normalizedEmail)
  };
}

function normalizedIdentity(row) {
  if (!row || typeof row !== "object") return null;
  const accountId = field(row, "accountId", "account_id");
  const issuerOrTenant = field(row, "issuerOrTenant", "issuer_or_tenant");
  const connectorScope = field(row, "connectorScope", "connector_scope");
  const providerSubject = field(row, "providerSubject", "provider_subject");
  const subjectType = field(row, "subjectType", "subject_type");
  const status = field(row, "status");
  const revokedAt = field(row, "revokedAt", "revoked_at");
  if ([accountId, issuerOrTenant, connectorScope, providerSubject, subjectType, status]
    .some((value) => value === undefined || value === null || String(value).trim() === "")) return null;
  if (subjectType !== "sub" || status !== "active" || (revokedAt !== null && revokedAt !== undefined)) return null;
  return { accountId, issuerOrTenant, connectorScope, providerSubject, subjectType, status, revokedAt: null };
}

function conflict() {
  return new AuthError("ACCOUNT_CLAIM_CONFLICT", 409);
}

function validateIdentityRows(rows, accountId, input) {
  if (!Array.isArray(rows)) throw conflict();
  const seen = new Set();
  const identities = [];
  for (const row of rows) {
    const identity = normalizedIdentity(row);
    if (!identity || identity.issuerOrTenant !== input.issuerOrTenant) throw conflict();
    const key = [identity.issuerOrTenant, identity.connectorScope, identity.providerSubject].join("\u0000");
    if (seen.has(key)) throw conflict();
    seen.add(key);
    if (String(identity.accountId) !== String(accountId)) throw conflict();
    if (identity.providerSubject !== input.logtoSubject) throw conflict();
    identities.push(identity);
  }
  return identities;
}

async function claimWithTransaction(transaction, rawInput, deps) {
  assertTransaction(transaction);
  const input = claimInput(rawInput, deps);
  if (typeof deps.emailLookupHash !== "function") throw new AuthError("AUTH_DEPENDENCY_MISSING", 500);

  // Task 4 supplies the HMAC implementation. The raw email is never a SQL value.
  const lookupHash = await deps.emailLookupHash(input.normalizedEmail);
  if (lookupHash === undefined || lookupHash === null) throw new AuthError("AUTH_INPUT_INVALID", 400);

  // The runtime role intentionally has no UPDATE privilege on email or
  // identity rows, so PostgreSQL row-locking SELECTs are not available here.
  // Serialize claims by the non-reversible email lookup key instead.
  await rowsFrom(query(
    transaction,
    [
      `SELECT pg_advisory_xact_lock(
         hashtextextended(encode(CAST(`,
      ` AS bytea), 'hex'), `,
      `)
       )`
    ],
    [lookupHash, EMAIL_SERIALIZATION_SEED]
  ));

  // Fixed order: email advisory lock, active email row, permanent account,
  // subject advisory lock, then identities.
  const emailRows = await rowsFrom(query(
    transaction,
    [
      `SELECT email_id, account_id, email_lookup_hash, verified_at, removed_at
       FROM account_emails
       WHERE email_lookup_hash = `,
      ` AND removed_at IS NULL`
    ],
    [lookupHash]
  ));
  if (emailRows.length === 0) return { kind: "new_account" };
  if (emailRows.length !== 1) throw conflict();
  const email = emailRows[0];
  if (!email) return { kind: "new_account" };
  if (!(email.verified_at ?? email.verifiedAt)) throw conflict();
  const accountId = text(email.account_id ?? email.accountId, "ACCOUNT_CLAIM_CONFLICT", 409);

  const accountRows = await rowsFrom(query(
    transaction,
    [`SELECT ${ACCOUNT_RETURNING_COLUMNS}
      FROM accounts
      WHERE account_id = `, ` AND status = 'active'`],
    [accountId]
  ));
  if (accountRows.length !== 1) throw conflict();
  const account = mapAccountRow(accountRows[0]);
  if (!account || String(account.accountId) !== String(accountId)) throw conflict();

  // The schema's unique index is scoped by connector. Serialize the broader
  // issuer+subject key before inspecting/inserting connector-specific rows so
  // two accounts cannot win different connector scopes concurrently.
  await rowsFrom(query(
    transaction,
    [
      `SELECT pg_advisory_xact_lock(
         hashtextextended(CAST(`,
      ` AS text) || chr(31) || CAST(`,
      ` AS text), `,
      `)
       )`
    ],
    [input.issuerOrTenant, input.logtoSubject, SUBJECT_SERIALIZATION_SEED]
  ));

  const identityRows = await rowsFrom(query(
    transaction,
    [
      `SELECT identity_id, account_id, issuer_or_tenant, connector_scope,
              provider_subject, subject_type, status, revoked_at
       FROM auth_identities
       WHERE issuer_or_tenant = `,
      ` AND provider_subject = `,
        ` AND subject_type = 'sub'
         AND status = 'active'
         AND revoked_at IS NULL`
    ],
    [input.issuerOrTenant, input.logtoSubject]
  ));
  const identities = validateIdentityRows(identityRows, accountId, input);
  if (identities.some((identity) =>
    identity.issuerOrTenant === input.issuerOrTenant &&
    identity.connectorScope === input.connectorScope &&
    identity.providerSubject === input.logtoSubject &&
    identity.subjectType === "sub")) {
    return { kind: "claimed", accountId };
  }

  const insertedRows = await rowsFrom(query(
    transaction,
    [
      `INSERT INTO auth_identities
        (account_id, issuer_or_tenant, connector_scope, provider_subject, subject_type)
       VALUES (`,
      ", ",
      ", ",
      ", ",
      ", ",
      `)
       ON CONFLICT (issuer_or_tenant, connector_scope, provider_subject)
       WHERE revoked_at IS NULL DO NOTHING
       RETURNING account_id`
    ],
    [accountId, input.issuerOrTenant, input.connectorScope, input.logtoSubject, "sub"]
  ));
  if (insertedRows.length > 1) throw conflict();
  if (insertedRows.length === 1) {
    const insertedAccountId = insertedRows[0]?.account_id ?? insertedRows[0]?.accountId;
    if (String(insertedAccountId) !== String(accountId)) throw conflict();
    return { kind: "claimed", accountId };
  }

  // DO NOTHING means another owner may have won the unique race. Only an
  // exact, active, scoped `sub` row owned by this account is idempotent.
  const ownerRows = await rowsFrom(query(
    transaction,
    [
      `SELECT account_id, issuer_or_tenant, connector_scope, provider_subject,
              subject_type, status, revoked_at
       FROM auth_identities
       WHERE account_id = `,
      ` AND issuer_or_tenant = `,
      ` AND connector_scope = `,
      ` AND provider_subject = `,
      ` AND subject_type = 'sub'
         AND status = 'active'
         AND revoked_at IS NULL`
    ],
    [accountId, input.issuerOrTenant, input.connectorScope, input.logtoSubject]
  ));
  if (ownerRows.length !== 1) throw conflict();
  const owner = normalizedIdentity(ownerRows[0]);
  if (!owner || String(owner.accountId) !== String(accountId) ||
      owner.issuerOrTenant !== input.issuerOrTenant ||
      owner.connectorScope !== input.connectorScope ||
      owner.providerSubject !== input.logtoSubject ||
      owner.subjectType !== "sub") throw conflict();
  return { kind: "claimed", accountId };
}

function normalizedEmail(value) {
  const email = text(value, "AUTH_EMAIL_INVALID", 400).toLowerCase();
  if (email.length > 320 || !email.includes("@") || email.startsWith("@") || email.endsWith("@")) {
    throw new AuthError("AUTH_EMAIL_INVALID", 400);
  }
  return email;
}

function identityCreationInput(rawInput, deps) {
  if (!rawInput || typeof rawInput !== "object") throw new AuthError("AUTH_INPUT_INVALID", 400);
  const issuerOrTenant = canonicalConfiguredIssuer(text(rawInput.issuerOrTenant));
  if (issuerOrTenant !== configuredIssuer(deps)) throw new AuthError("AUTH_INPUT_INVALID", 400);
  const rawConnectorScope = text(rawInput.connectorScope).toLowerCase();
  const connectorScope = rawConnectorScope === "email" ? "email-otp" : rawConnectorScope;
  if (!NEW_ACCOUNT_CONNECTOR_SCOPES.has(connectorScope)) {
    throw new AuthError("AUTH_CONNECTOR_UNAVAILABLE", 400);
  }
  if (rawInput.emailVerified !== true) throw new AuthError("AUTH_EMAIL_UNVERIFIED", 400);
  const role = String(rawInput.role ?? "free").trim().toLowerCase() || "free";
  const status = String(rawInput.status ?? "active").trim().toLowerCase() || "active";
  if (role !== "free" || status !== "active") throw new AuthError("AUTH_INPUT_INVALID", 400);
  return {
    normalizedEmail: normalizedEmail(rawInput.normalizedEmail),
    logtoSubject: text(rawInput.logtoSubject),
    issuerOrTenant,
    connectorScope,
    role,
    status
  };
}

async function createAccountWithLogtoIdentityInTransaction(transaction, rawInput, deps) {
  assertTransaction(transaction);
  const input = identityCreationInput(rawInput, deps);
  if (typeof deps.emailLookupHash !== "function" || typeof deps.encryptSecret !== "function") {
    throw new AuthError("AUTH_DEPENDENCY_MISSING", 500);
  }
  const account = await createFreeAccountInTransaction(transaction);

  const lookupHash = await deps.emailLookupHash(input.normalizedEmail, cryptoOptions(deps));
  const encryptedEmail = await deps.encryptSecret(input.normalizedEmail, cryptoOptions(deps));
  const keyVersion = String(deps.keyVersion).trim();
  if (!/^[1-9][0-9]*$/u.test(keyVersion)) throw new AuthError("AUTH_KEY_VERSION_INVALID", 500);
  const emailRows = await rowsFrom(query(
    transaction,
    [
      `INSERT INTO account_emails
        (account_id, email_lookup_hash, encrypted_email, encryption_key_version, is_primary, verified_at)
       VALUES (`, ", ", ", ", ", ", ", ", ", ", `)
       RETURNING email_id`
    ],
    [account.accountId, lookupHash, encryptedEmail, keyVersion, true, new Date()]
  ));
  if (emailRows.length !== 1) throw new AuthError("ACCOUNT_CREATE_FAILED", 500);

  const identityRows = await rowsFrom(query(
    transaction,
    [
      `INSERT INTO auth_identities
        (account_id, issuer_or_tenant, connector_scope, provider_subject, subject_type, logto_user_id)
       VALUES (`, ", ", ", ", ", ", ", ", ", ", `)
       RETURNING identity_id, account_id`
    ],
    [account.accountId, input.issuerOrTenant, input.connectorScope, input.logtoSubject, "sub", input.logtoSubject]
  ));
  if (identityRows.length !== 1) throw new AuthError("ACCOUNT_CREATE_FAILED", 500);
  const identityAccountId = identityRows[0].account_id ?? identityRows[0].accountId;
  if (String(identityAccountId) !== String(account.accountId)) {
    throw new AuthError("ACCOUNT_CLAIM_CONFLICT", 409);
  }
  return account;
}

/** Create an account using the factory's injected transaction runner. */
export async function createAccount(input, deps = {}) {
  return createAccountRepository(deps).createAccount(input);
}

/** Resolve an active Logto `sub` in the factory's configured issuer/tenant. */
export async function findAccountByLogtoSubject(subject, deps = {}) {
  const resolved = dependencies(deps);
  return findLogto(resolved.sql, subject, resolved);
}

/** Resolve an immutable legacy Netlify user ID through migration_records. */
export async function findAccountByLegacyUserId(legacyNetlifyUserId, deps = {}) {
  const resolved = dependencies(deps);
  return findLegacy(resolved.sql, legacyNetlifyUserId);
}

/** Resolve an account by its permanent account identifier. */
export async function findAccountById(accountId, deps = {}) {
  const resolved = repositoryDependencies(deps);
  return findByAccountId(resolved.sql, accountId);
}

export async function listAccounts(deps = {}) {
  const resolved = repositoryDependencies(deps);
  return listAllAccounts(resolved.sql, deps.limit);
}

export async function requestVip(input, deps = {}) {
  return createAccountRepository(deps).requestVip(input);
}

export async function setAccountAuthorization(input, deps = {}) {
  return createAccountRepository(deps).setAuthorization(input);
}

export async function deleteAccount(input, deps = {}) {
  return createAccountRepository(deps).deleteAccount(input);
}

/** Resolve a completed Netlify migration record within the configured app boundary. */
export async function findMigrationRecordByLegacyUserId(legacyNetlifyUserId, deps = {}) {
  const resolved = repositoryDependencies(deps);
  return findLegacyMigration(resolved.sql, legacyNetlifyUserId, resolved);
}

/** Transaction-level claim helper; callers must pass a transaction adapter. */
export async function claimLegacyAccountByVerifiedEmail(transaction, input, deps = {}) {
  return claimWithTransaction(transaction, input, dependencies(deps));
}

/** Create a free Logto account and its verified email/identity atomically. */
export async function createAccountWithLogtoIdentity(input, deps = {}) {
  return createAccountRepository(deps).createAccountWithLogtoIdentity(input);
}

/** Primary composition boundary for production and fake adapters. */
export function createAccountRepository(overrides = {}) {
  const deps = repositoryDependencies(overrides);
  return {
    createAccount(input) {
      return deps.withTransaction((transaction) => insertAccount(transaction, input));
    },
    createAccountWithLogtoIdentity(input) {
      return deps.withTransaction((transaction) =>
        createAccountWithLogtoIdentityInTransaction(transaction, input, deps)
      );
    },
    findAccountByLogtoSubject(subject) {
      return findLogto(deps.sql, subject, deps);
    },
    findAccountByLegacyUserId(legacyNetlifyUserId) {
      return findLegacy(deps.sql, legacyNetlifyUserId);
    },
    findAccountById(accountId) {
      return findByAccountId(deps.sql, accountId);
    },
    listAccounts(options = {}) {
      return listAllAccounts(deps.sql, options?.limit);
    },
    getPrimaryEmailMasked(accountId) {
      return primaryEmailMasked(deps.sql, accountId, deps);
    },
    requestVip(input) {
      return deps.withTransaction((transaction) =>
        requestVipInTransaction(transaction, input, deps)
      );
    },
    setAuthorization(input) {
      return deps.withTransaction((transaction) =>
        setAuthorizationInTransaction(transaction, input, deps)
      );
    },
    deleteAccount(input) {
      return deps.withTransaction((transaction) =>
        deleteAccountInTransaction(transaction, input, deps)
      );
    },
    findMigrationRecordByLegacyUserId(legacyNetlifyUserId) {
      return findLegacyMigration(deps.sql, legacyNetlifyUserId, deps);
    },
    findReconciledMigrationBatch(input) {
      return findReconciledMigrationBatch(deps.sql, input, deps);
    },
    claimLegacyAccountByVerifiedEmail(input) {
      return deps.withTransaction((transaction) => claimWithTransaction(transaction, input, deps));
    }
  };
}
