function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function field(row, names) {
  if (!row || typeof row !== "object") return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name) && row[name] !== undefined) return row[name];
  }
  return undefined;
}

function query(adapter, parts, values = []) {
  const strings = Array.from(parts);
  strings.raw = Array.from(parts);
  if (typeof adapter === "function") return adapter(strings, ...values);
  if (adapter && typeof adapter.query === "function") {
    const sqlText = strings.reduce(
      (result, part, index) => `${result}${part}${index < values.length ? `$${index + 1}` : ""}`,
      ""
    );
    return adapter.query(sqlText, values);
  }
  throw conflict();
}

async function rowsFrom(result) {
  const value = await result;
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.rows)) return value.rows;
  return [];
}

function bytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  const normalized = text(value)?.toLowerCase();
  if (!normalized || !/^[a-f0-9]+$/u.test(normalized) || normalized.length % 2 !== 0) return null;
  return Buffer.from(normalized, "hex");
}

function bytesEqual(left, right) {
  const first = bytes(left);
  const second = bytes(right);
  return Boolean(first && second && first.length === second.length && first.equals(second));
}

function sameNullableText(left, right) {
  return text(left) === text(right);
}

function sameNullableTimestamp(left, right) {
  if (left === null || left === undefined || left === "") {
    return right === null || right === undefined || right === "";
  }
  if (right === null || right === undefined || right === "") return false;
  const first = Date.parse(left);
  const second = Date.parse(right);
  return Number.isFinite(first) && Number.isFinite(second) && first === second;
}

function positiveInteger(value) {
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function timestampMillis(value) {
  const normalized = text(value);
  if (!normalized) return null;
  const result = Date.parse(normalized);
  return Number.isFinite(result) ? result : null;
}

function conflict() {
  const error = new Error("Persisted migration state does not exactly match the reviewed snapshot");
  error.code = "AUTH_MIGRATION_PERSISTED_STATE_CONFLICT";
  error.status = 409;
  error.statusCode = 409;
  return error;
}

function expectedRow(rawRow, { migrationId, emailLookupHash, encryptionKeyVersion, freezeAt }) {
  const source = text(rawRow?.source);
  const sourceUserId = text(rawRow?.source_user_id ?? rawRow?.sourceUserId);
  const accountId = text(rawRow?.account_id ?? rawRow?.accountId);
  const role = text(rawRow?.role)?.toLowerCase();
  const status = text(rawRow?.status)?.toLowerCase();
  const snapshotHash = bytes(rawRow?.snapshot_hash ?? rawRow?.snapshotHash);
  const lookupHash = bytes(emailLookupHash);
  const keyVersion = positiveInteger(encryptionKeyVersion);
  const verifiedAt = text(rawRow?.email_confirmed_at ?? rawRow?.emailConfirmedAt);
  if (!source || !sourceUserId || !accountId || !role || !status || !snapshotHash || !lookupHash ||
      !keyVersion || !text(migrationId) || !verifiedAt || rawRow?.email_verified !== true) {
    throw conflict();
  }
  return {
    source,
    sourceUserId,
    accountId,
    role,
    status,
    guild: text(rawRow.guild),
    gameName: text(rawRow.game_name ?? rawRow.gameName),
    migrationId: text(migrationId),
    snapshotHash,
    lookupHash,
    keyVersion,
    freezeAt: text(freezeAt),
    verifiedAt,
    blockedAt: status === "blocked" ? text(freezeAt) : null
  };
}

/**
 * Lock (for production finalization/import) and verify the complete persisted
 * legacy account graph. A caller receives only a canonical import row; partial
 * table evidence is never considered a winner.
 */
export async function verifyPersistedMigrationGraph(transaction, rawRow, {
  migrationId,
  emailLookupHash,
  encryptionKeyVersion,
  freezeAt,
  issuerOrTenant = "netlify_identity",
  connectorScope = "legacy",
  lock = true
} = {}) {
  const expected = expectedRow(rawRow, { migrationId, emailLookupHash, encryptionKeyVersion, freezeAt });
  const lockAccount = lock ? " FOR UPDATE OF m, a" : "";
  const lockRows = lock ? " FOR UPDATE" : "";
  const accountMigrationRows = await rowsFrom(query(
    transaction,
    [
      `SELECT m.migration_id, m.source, m.source_user_id, m.legacy_netlify_user_id,
              m.account_id, m.legacy_email_lookup_hash, m.snapshot_hash,
              m.status AS migration_status, m.error_code, m.freeze_at,
              m.created_at AS migration_created_at,
              m.completed_at AS migration_completed_at,
              a.role AS account_role, a.status AS account_status,
              a.guild AS account_guild, a.game_name AS account_game_name,
              a.authz_version AS account_authz_version,
              a.merged_into_account_id AS account_merged_into_account_id,
              a.migration_id AS account_migration_id,
              a.blocked_at AS account_blocked_at
       FROM migration_records m
       JOIN accounts a ON a.account_id = m.account_id
       WHERE (m.source = `,
      ` AND m.source_user_id = `,
      `) OR m.account_id = `,
      lockAccount
    ],
    [expected.source, expected.sourceUserId, expected.accountId]
  ));
  if (accountMigrationRows.length !== 1) throw conflict();
  const persisted = accountMigrationRows[0];
  const migrationStatus = text(field(persisted, ["migration_status", "migrationStatus", "status"]))?.toLowerCase();
  const migrationCreatedAt = timestampMillis(field(persisted, ["migration_created_at", "migrationCreatedAt", "created_at", "createdAt"]));
  const migrationCompletedAt = timestampMillis(field(persisted, ["migration_completed_at", "migrationCompletedAt", "completed_at", "completedAt"]));
  const expectedFreezeAt = expected.freezeAt === null ? null : timestampMillis(expected.freezeAt);
  if (text(field(persisted, ["migration_id", "migrationId"])) !== expected.migrationId ||
      text(field(persisted, ["source"])) !== expected.source ||
      text(field(persisted, ["source_user_id", "sourceUserId"])) !== expected.sourceUserId ||
      text(field(persisted, ["legacy_netlify_user_id", "legacyNetlifyUserId"])) !== expected.sourceUserId ||
      text(field(persisted, ["account_id", "accountId"])) !== expected.accountId ||
      !bytesEqual(field(persisted, ["legacy_email_lookup_hash", "legacyEmailLookupHash"]), expected.lookupHash) ||
      !bytesEqual(field(persisted, ["snapshot_hash", "snapshotHash"]), expected.snapshotHash) ||
      !["imported", "reconciled"].includes(migrationStatus) ||
      text(field(persisted, ["error_code", "errorCode"])) !== null ||
      !sameNullableTimestamp(field(persisted, ["freeze_at", "freezeAt"]), expected.freezeAt) ||
      migrationCreatedAt === null || migrationCompletedAt === null ||
      migrationCreatedAt > migrationCompletedAt ||
      expectedFreezeAt !== null && expectedFreezeAt > migrationCompletedAt ||
      text(field(persisted, ["account_role", "accountRole"]))?.toLowerCase() !== expected.role ||
      text(field(persisted, ["account_status", "accountStatus"]))?.toLowerCase() !== expected.status ||
      !sameNullableText(field(persisted, ["account_guild", "accountGuild"]), expected.guild) ||
      !sameNullableText(field(persisted, ["account_game_name", "accountGameName"]), expected.gameName) ||
      positiveInteger(field(persisted, ["account_authz_version", "accountAuthzVersion"])) !== 1 ||
      text(field(persisted, ["account_merged_into_account_id", "accountMergedIntoAccountId"])) !== null ||
      text(field(persisted, ["account_migration_id", "accountMigrationId"])) !== expected.migrationId ||
      !sameNullableTimestamp(field(persisted, ["account_blocked_at", "accountBlockedAt"]), expected.blockedAt)) {
    throw conflict();
  }

  const emailRows = await rowsFrom(query(
    transaction,
    [
      `SELECT email_id, account_id, email_lookup_hash, encrypted_email,
              encryption_key_version, is_primary, verified_at, removed_at
       FROM account_emails
       WHERE account_id = `,
      ` OR email_lookup_hash = `,
      ` ORDER BY email_id${lockRows}`
    ],
    [expected.accountId, expected.lookupHash]
  ));
  if (emailRows.length !== 1) throw conflict();
  const email = emailRows[0];
  const encryptedEmail = bytes(field(email, ["encrypted_email", "encryptedEmail"]));
  if (text(field(email, ["account_id", "accountId"])) !== expected.accountId ||
      !bytesEqual(field(email, ["email_lookup_hash", "emailLookupHash"]), expected.lookupHash) ||
      !encryptedEmail || encryptedEmail.length < 1 || encryptedEmail.length > 8192 ||
      positiveInteger(field(email, ["encryption_key_version", "encryptionKeyVersion"])) !== expected.keyVersion ||
      field(email, ["is_primary", "isPrimary"]) !== true ||
      !sameNullableTimestamp(field(email, ["verified_at", "verifiedAt"]), expected.verifiedAt) ||
      text(field(email, ["removed_at", "removedAt"])) !== null) {
    throw conflict();
  }

  const issuer = text(issuerOrTenant);
  const connector = text(connectorScope);
  if (!issuer || !connector) throw conflict();
  const identityRows = await rowsFrom(query(
    transaction,
    [
      `SELECT identity_id, account_id, issuer_or_tenant, connector_scope,
              provider_subject, subject_type, logto_user_id, status, revoked_at
       FROM auth_identities
       WHERE (account_id = `,
      ` AND issuer_or_tenant = `,
      `) OR (issuer_or_tenant = `,
      ` AND provider_subject = `,
      `) ORDER BY identity_id${lockRows}`
    ],
    [expected.accountId, issuer, issuer, expected.sourceUserId]
  ));
  if (identityRows.length !== 1) throw conflict();
  const identity = identityRows[0];
  if (text(field(identity, ["account_id", "accountId"])) !== expected.accountId ||
      text(field(identity, ["issuer_or_tenant", "issuerOrTenant"])) !== issuer ||
      text(field(identity, ["connector_scope", "connectorScope"])) !== connector ||
      text(field(identity, ["provider_subject", "providerSubject"])) !== expected.sourceUserId ||
      text(field(identity, ["subject_type", "subjectType"])) !== "netlify_user_id" ||
      text(field(identity, ["logto_user_id", "logtoUserId"])) !== null ||
      text(field(identity, ["status"]))?.toLowerCase() !== "active" ||
      text(field(identity, ["revoked_at", "revokedAt"])) !== null) {
    throw conflict();
  }

  return Object.freeze({
    source: expected.source,
    source_user_id: expected.sourceUserId,
    account_id: expected.accountId,
    snapshot_hash: expected.snapshotHash.toString("hex"),
    role: expected.role,
    status: expected.status,
    guild: expected.guild,
    game_name: expected.gameName,
    migration_id: expected.migrationId
  });
}
