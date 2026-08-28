import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  emailLookupHash as productionEmailLookupHash,
  encryptSecret as productionEncryptSecret
} from "../../netlify/functions/_shared/auth/crypto.mjs";
import { withTransaction as productionWithTransaction } from "../../netlify/functions/_shared/auth/db.mjs";
import { reconcileMigration } from "./reconcile.mjs";
import { transformLegacySnapshot, normalizeEmail } from "./transform.mjs";
import { upsertMigrationBatchInTransaction } from "./finalize.mjs";

export const LOCAL_FIXTURE_ENV_ID = "neon-local-test";
export const LOCAL_FIXTURE_SITE_ID = "shinegame-local-test";
export const LOCAL_FIXTURE_APPLY_CONFIRMATION = "confirmed";

const PUBLIC_FIXTURE_ERROR_CODES = new Set([
  "AUTH_LOCAL_FIXTURE_SCOPE_REQUIRED",
  "AUTH_LOCAL_FIXTURE_PRODUCTION_MODE",
  "AUTH_LOCAL_FIXTURE_EMAIL_REQUIRED",
  "AUTH_LOCAL_FIXTURE_EMAIL_INVALID",
  "AUTH_LOCAL_FIXTURE_PROFILE_INVALID",
  "AUTH_LOCAL_FIXTURE_KEY_VERSION_INVALID",
  "AUTH_LOCAL_FIXTURE_CRYPTO_REQUIRED",
  "AUTH_LOCAL_FIXTURE_LOOKUP_INVALID",
  "AUTH_LOCAL_FIXTURE_CIPHERTEXT_INVALID",
  "AUTH_LOCAL_FIXTURE_CRYPTO_INVALID",
  "AUTH_LOCAL_FIXTURE_ADAPTER_INVALID",
  "AUTH_LOCAL_FIXTURE_SQL_SHAPE_INVALID",
  "AUTH_LOCAL_FIXTURE_TRANSACTION_REQUIRED",
  "AUTH_LOCAL_FIXTURE_RECONCILIATION_FAILED",
  "AUTH_LOCAL_FIXTURE_ACCOUNT_WRITER_REQUIRED",
  "AUTH_LOCAL_FIXTURE_MIGRATION_WRITER_REQUIRED",
  "AUTH_LOCAL_FIXTURE_EMAIL_WRITER_REQUIRED",
  "AUTH_LOCAL_FIXTURE_IDENTITY_WRITER_REQUIRED",
  "AUTH_LOCAL_FIXTURE_BATCH_WRITER_REQUIRED",
  "AUTH_LOCAL_FIXTURE_ARGUMENTS_INVALID"
]);

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function fixtureError(code, message = code, status = 503) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.statusCode = status;
  return error;
}

function publicFixtureErrorCode(error) {
  return PUBLIC_FIXTURE_ERROR_CODES.has(error?.code) ? error.code : "AUTH_LOCAL_FIXTURE_FAILED";
}

function hasOwn(value, name) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, name));
}

/** Refuse all non-disposable environments before resolving crypto or adapters. */
export function assertLocalFixtureEnvironment(env = process.env) {
  if (!env || typeof env !== "object" ||
      !hasOwn(env, "AUTH_ENV_ID") || !hasOwn(env, "AUTH_EXPECTED_SITE_ID") ||
      !hasOwn(env, "NETLIFY_SITE_ID") || !hasOwn(env, "AUTH_LOCAL_FIXTURE_APPLY") ||
      env.AUTH_ENV_ID !== LOCAL_FIXTURE_ENV_ID ||
      env.AUTH_EXPECTED_SITE_ID !== LOCAL_FIXTURE_SITE_ID ||
      env.NETLIFY_SITE_ID !== LOCAL_FIXTURE_SITE_ID ||
      env.AUTH_LOCAL_FIXTURE_APPLY !== LOCAL_FIXTURE_APPLY_CONFIRMATION) {
    throw fixtureError("AUTH_LOCAL_FIXTURE_SCOPE_REQUIRED", "Synthetic fixture is restricted to the local-test boundary", 403);
  }
  const mode = env.MIGRATION_WRITE_MODE;
  if (mode !== undefined && mode !== null && String(mode).length > 0) {
    throw fixtureError("AUTH_LOCAL_FIXTURE_PRODUCTION_MODE", "Synthetic fixture does not accept production migration modes", 403);
  }
  return Object.freeze({
    environmentId: LOCAL_FIXTURE_ENV_ID,
    siteId: LOCAL_FIXTURE_SITE_ID
  });
}

function normalizedFixtureEmail(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw fixtureError("AUTH_LOCAL_FIXTURE_EMAIL_REQUIRED", "Synthetic fixture email is required", 400);
  }
  const normalized = normalizeEmail(value);
  if (!normalized || normalized !== value.trim() || normalized.length > 320 ||
      !normalized.includes("@") || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw fixtureError("AUTH_LOCAL_FIXTURE_EMAIL_INVALID", "Synthetic fixture email is invalid", 400);
  }
  return normalized;
}

function fixtureProfile(profile) {
  if (!profile || typeof profile !== "object") throw fixtureError("AUTH_LOCAL_FIXTURE_PROFILE_INVALID", "Synthetic fixture profile is invalid", 400);
  const role = text(profile.role)?.toLowerCase();
  const status = text(profile.status)?.toLowerCase();
  if (role !== "vip" || status !== "active") {
    throw fixtureError("AUTH_LOCAL_FIXTURE_PROFILE_INVALID", "Synthetic fixture profile must be an active VIP", 400);
  }
  return {
    role,
    status,
    guild: text(profile.guild),
    gameName: text(profile.gameName ?? profile.game_name)
  };
}

function fixtureKeyVersion(value) {
  const normalized = String(value ?? "1").trim();
  if (!/^[1-9][0-9]*$/u.test(normalized)) {
    throw fixtureError("AUTH_LOCAL_FIXTURE_KEY_VERSION_INVALID");
  }
  const version = Number(normalized);
  if (!Number.isSafeInteger(version) || version < 1 || version > 0x7fffffff) {
    throw fixtureError("AUTH_LOCAL_FIXTURE_KEY_VERSION_INVALID");
  }
  return version;
}

function configuredCrypto(crypto, env, environmentId, siteId) {
  const configured = crypto && typeof crypto === "object" ? crypto : {};
  const hmacKey = configured.hmacKey ?? configured.authHmacKey ?? env.AUTH_HMAC_KEY;
  const encryptionKey = configured.encryptionKey ?? configured.authEncryptionKey ?? env.AUTH_ENCRYPTION_KEY;
  const keyVersion = fixtureKeyVersion(
    configured.keyVersion ?? configured.encryptionKeyVersion ?? env.AUTH_ENCRYPTION_KEY_VERSION ?? "1"
  );
  const lookup = typeof configured.emailLookupHash === "function"
    ? configured.emailLookupHash.bind(configured)
    : hmacKey
      ? (email) => productionEmailLookupHash(email, { hmacKey, encryptionKey, environmentId, siteId })
      : null;
  const encrypt = typeof configured.encryptEmail === "function"
    ? configured.encryptEmail.bind(configured)
    : typeof configured.encryptSecret === "function"
      ? configured.encryptSecret.bind(configured)
      : encryptionKey
        ? (email, options = {}) => productionEncryptSecret(email, {
          hmacKey,
          encryptionKey,
          keyVersion,
          environmentId,
          siteId,
          ...options
        })
        : null;
  if (!lookup || !encrypt) throw fixtureError("AUTH_LOCAL_FIXTURE_CRYPTO_REQUIRED", "Configured runtime crypto helpers are required");
  return {
    lookup,
    encrypt,
    options: { hmacKey, encryptionKey, keyVersion, environmentId, siteId }
  };
}

function bytes(value, code) {
  if (!(value instanceof Uint8Array) && !Buffer.isBuffer(value)) throw fixtureError(code);
  return Buffer.from(value);
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
  throw fixtureError("AUTH_LOCAL_FIXTURE_ADAPTER_INVALID");
}

function parameterParts(prefix, suffix, count) {
  if (!Number.isInteger(count) || count < 1) throw fixtureError("AUTH_LOCAL_FIXTURE_SQL_SHAPE_INVALID");
  return [prefix, ...Array.from({ length: count - 1 }, () => ", "), suffix];
}

async function writeSqlFixture(transaction, entities) {
  const {
    account,
    email,
    identity,
    migrationRecord,
    batch
  } = entities;
  await query(transaction, parameterParts(
    `INSERT INTO accounts (account_id, role, status, guild, game_name, blocked_at) VALUES (`,
    `) ON CONFLICT (account_id) DO NOTHING`,
    6
  ), [account.account_id, account.role, account.status, account.guild, account.game_name, null]);
  await query(transaction, parameterParts(
    `INSERT INTO migration_records (
       migration_id, source, source_user_id, legacy_netlify_user_id,
       account_id, legacy_email_lookup_hash, snapshot_hash, status,
       freeze_at, created_at, completed_at
     ) VALUES (`,
    `) ON CONFLICT (source, source_user_id) DO NOTHING`,
    11
  ), [
    migrationRecord.migration_id,
    migrationRecord.source,
    migrationRecord.source_user_id,
    migrationRecord.legacy_netlify_user_id,
    migrationRecord.account_id,
    migrationRecord.legacy_email_lookup_hash,
    migrationRecord.snapshot_hash,
    migrationRecord.status,
    migrationRecord.freeze_at,
    migrationRecord.created_at,
    migrationRecord.completed_at
  ]);
  await query(transaction, [
    `UPDATE accounts SET migration_id = `,
    ` WHERE account_id = `,
    ``
  ], [migrationRecord.migration_id, account.account_id]);
  await query(transaction, parameterParts(
    `INSERT INTO account_emails (account_id, email_lookup_hash, encrypted_email, encryption_key_version, is_primary, verified_at) VALUES (`,
    `)`,
    6
  ), [email.account_id, email.email_lookup_hash, email.encrypted_email, email.encryption_key_version, true, email.verified_at]);
  await query(transaction, parameterParts(
    `INSERT INTO auth_identities (account_id, issuer_or_tenant, connector_scope, provider_subject, subject_type, status) VALUES (`,
    `)`,
    6
  ), [
    identity.account_id,
    identity.issuer_or_tenant,
    identity.connector_scope,
    identity.provider_subject,
    identity.subject_type,
    identity.status
  ]);
  await upsertMigrationBatchInTransaction(transaction, batch);
}

async function invokeNamedWriter(transaction, names, value, missingCode) {
  for (const name of names) {
    if (typeof transaction?.[name] === "function") return transaction[name](value);
  }
  throw fixtureError(missingCode, "Fixture adapter is missing a required writer");
}

async function writeFixture(transaction, entities) {
  if (typeof transaction === "function" || typeof transaction?.query === "function") {
    return writeSqlFixture(transaction, entities);
  }
  if (typeof transaction?.seedLegacyFixture === "function") {
    return transaction.seedLegacyFixture(entities);
  }
  await invokeNamedWriter(transaction, ["insertAccount", "createAccount"], entities.account, "AUTH_LOCAL_FIXTURE_ACCOUNT_WRITER_REQUIRED");
  await invokeNamedWriter(transaction, ["insertMigrationRecord", "createMigrationRecord"], entities.migrationRecord, "AUTH_LOCAL_FIXTURE_MIGRATION_WRITER_REQUIRED");
  await invokeNamedWriter(transaction, ["insertAccountEmail", "createAccountEmail", "insertEmail", "createEmail"], entities.email, "AUTH_LOCAL_FIXTURE_EMAIL_WRITER_REQUIRED");
  await invokeNamedWriter(transaction, ["insertLegacyIdentity", "createLegacyIdentity", "insertIdentity", "createIdentity"], entities.identity, "AUTH_LOCAL_FIXTURE_IDENTITY_WRITER_REQUIRED");
  await invokeNamedWriter(transaction, ["upsertMigrationBatch", "insertMigrationBatch", "createMigrationBatch"], entities.batch, "AUTH_LOCAL_FIXTURE_BATCH_WRITER_REQUIRED");
}

function publicEntity(entity, aliases) {
  const value = { ...entity };
  for (const [camel, snake] of aliases) value[camel] = entity[snake];
  return value;
}

/**
 * Create exactly one synthetic legacy VIP fixture. Raw email and crypto
 * material remain in this invocation only; the return value is aggregate-only.
 */
export async function seedLocalTestLegacyFixture({
  env = process.env,
  normalizedEmail,
  profile,
  adapter,
  crypto
} = {}) {
  const scope = assertLocalFixtureEnvironment(env);
  const email = normalizedFixtureEmail(normalizedEmail);
  const selectedProfile = fixtureProfile(profile);
  if (!adapter || typeof adapter.withTransaction !== "function") {
    throw fixtureError("AUTH_LOCAL_FIXTURE_TRANSACTION_REQUIRED", "Fixture adapter must provide one transaction");
  }
  const helpers = configuredCrypto(crypto, env, scope.environmentId, scope.siteId);
  const freezeAt = new Date().toISOString();
  const migrationId = randomUUID();
  const legacyUserId = randomUUID();
  const sourceSnapshot = {
    migrationId,
    snapshotId: `fixture-${randomUUID()}`,
    freezeAt,
    profiles: [{
      email,
      role: selectedProfile.role,
      // The legacy transform accepts approved as the privileged source state
      // and emits the canonical active account status.
      status: "approved",
      guild: selectedProfile.guild,
      gameName: selectedProfile.gameName
    }],
    identityUsers: [{
      id: legacyUserId,
      email,
      email_verified: true,
      confirmed_at: freezeAt
    }],
    adminEmails: []
  };
  const transformed = transformLegacySnapshot(sourceSnapshot);
  const reconciliationReport = reconcileMigration(sourceSnapshot, transformed.importable);
  if (!reconciliationReport.ok || reconciliationReport.status !== "reconciled" ||
      reconciliationReport.sourceCount !== 1 || reconciliationReport.importedCount !== 1 ||
      reconciliationReport.conflictCount !== 0 || transformed.importable.length !== 1) {
    throw fixtureError("AUTH_LOCAL_FIXTURE_RECONCILIATION_FAILED");
  }
  const row = transformed.importable[0];
  const cryptoOptions = {
    ...helpers.options,
    environmentId: scope.environmentId,
    siteId: scope.siteId
  };
  const lookupHash = bytes(await helpers.lookup(email, cryptoOptions), "AUTH_LOCAL_FIXTURE_LOOKUP_INVALID");
  const encryptedEmail = bytes(await helpers.encrypt(email, cryptoOptions), "AUTH_LOCAL_FIXTURE_CIPHERTEXT_INVALID");
  if (lookupHash.length < 16 || lookupHash.length > 128 || encryptedEmail.length < 1 || encryptedEmail.length > 8192) {
    throw fixtureError("AUTH_LOCAL_FIXTURE_CRYPTO_INVALID");
  }

  const accountId = row.account_id;
  const account = publicEntity({
    account_id: accountId,
    role: row.role,
    status: row.status,
    guild: row.guild,
    game_name: row.game_name,
    migration_id: row.migration_id
  }, [["accountId", "account_id"], ["gameName", "game_name"], ["migrationId", "migration_id"]]);
  const emailEntity = publicEntity({
    account_id: accountId,
    email_lookup_hash: lookupHash,
    encrypted_email: encryptedEmail,
    encryption_key_version: helpers.options.keyVersion,
    is_primary: true,
    verified_at: freezeAt
  }, [["accountId", "account_id"], ["emailLookupHash", "email_lookup_hash"], ["encryptedEmail", "encrypted_email"], ["encryptionKeyVersion", "encryption_key_version"], ["isPrimary", "is_primary"], ["verifiedAt", "verified_at"]]);
  const identityEntity = publicEntity({
    account_id: accountId,
    issuer_or_tenant: "netlify_identity",
    connector_scope: "legacy",
    provider_subject: legacyUserId,
    subject_type: "netlify_user_id",
    status: "active"
  }, [["accountId", "account_id"], ["issuerOrTenant", "issuer_or_tenant"], ["connectorScope", "connector_scope"], ["providerSubject", "provider_subject"], ["subjectType", "subject_type"]]);
  const migrationRecord = publicEntity({
    migration_id: row.migration_id,
    source: "netlify_identity",
    source_user_id: legacyUserId,
    legacy_netlify_user_id: legacyUserId,
    account_id: accountId,
    legacy_email_lookup_hash: lookupHash,
    snapshot_hash: Buffer.from(reconciliationReport.sourceSnapshotHash, "hex"),
    status: "imported",
    freeze_at: freezeAt,
    created_at: freezeAt,
    completed_at: freezeAt
  }, [["migrationId", "migration_id"], ["sourceUserId", "source_user_id"], ["legacyNetlifyUserId", "legacy_netlify_user_id"], ["accountId", "account_id"], ["legacyEmailLookupHash", "legacy_email_lookup_hash"], ["snapshotHash", "snapshot_hash"], ["freezeAt", "freeze_at"], ["createdAt", "created_at"], ["completedAt", "completed_at"]]);
  const batch = publicEntity({
    source: "netlify_identity",
    environment_id: scope.environmentId,
    site_id: scope.siteId,
    snapshot_id: reconciliationReport.snapshotId,
    snapshot_hash: Buffer.from(reconciliationReport.sourceSnapshotHash, "hex"),
    status: "reconciled",
    source_count: 1,
    imported_count: 1,
    conflict_count: 0,
    freeze_at: freezeAt,
    completed_at: freezeAt
  }, [["environmentId", "environment_id"], ["siteId", "site_id"], ["snapshotId", "snapshot_id"], ["snapshotHash", "snapshot_hash"], ["sourceCount", "source_count"], ["importedCount", "imported_count"], ["conflictCount", "conflict_count"], ["freezeAt", "freeze_at"], ["completedAt", "completed_at"]]);

  await adapter.withTransaction((transaction) => writeFixture(transaction, {
    account,
    email: emailEntity,
    identity: identityEntity,
    migrationRecord,
    batch
  }));
  return {
    fixture: "created",
    accounts: 1,
    emails: 1,
    legacyIdentities: 1,
    migrationRecords: 1,
    reconciledBatches: 1,
    role: "vip",
    status: "active"
  };
}

function assertNoUnknownArguments(argv) {
  if (!Array.isArray(argv) || argv.length > 0) {
    throw fixtureError("AUTH_LOCAL_FIXTURE_ARGUMENTS_INVALID");
  }
}

async function readStdin(input = process.stdin) {
  const chunks = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

function trustedFixtureAdapter() {
  return Object.freeze({ withTransaction: productionWithTransaction });
}

function runtimeCrypto(env) {
  if (!text(env.AUTH_HMAC_KEY) || !text(env.AUTH_ENCRYPTION_KEY)) {
    throw fixtureError("AUTH_LOCAL_FIXTURE_CRYPTO_REQUIRED", "Runtime HMAC and encryption keys are required");
  }
  return {
    hmacKey: env.AUTH_HMAC_KEY,
    encryptionKey: env.AUTH_ENCRYPTION_KEY,
    keyVersion: env.AUTH_ENCRYPTION_KEY_VERSION,
    emailLookupHash: (email, options) => productionEmailLookupHash(email, {
      hmacKey: env.AUTH_HMAC_KEY,
      encryptionKey: env.AUTH_ENCRYPTION_KEY,
      environmentId: options?.environmentId || LOCAL_FIXTURE_ENV_ID,
      siteId: options?.siteId || LOCAL_FIXTURE_SITE_ID
    }),
    encryptEmail: (email, options) => productionEncryptSecret(email, {
      hmacKey: env.AUTH_HMAC_KEY,
      encryptionKey: env.AUTH_ENCRYPTION_KEY,
      keyVersion: env.AUTH_ENCRYPTION_KEY_VERSION,
      environmentId: options?.environmentId || LOCAL_FIXTURE_ENV_ID,
      siteId: options?.siteId || LOCAL_FIXTURE_SITE_ID
    })
  };
}

/**
 * Run the CLI boundary with explicit streams and trusted dependencies. No
 * module path is accepted, so an untrusted adapter cannot receive env/keys.
 */
export async function runFixtureCli({
  argv = [],
  env = process.env,
  stdin = process.stdin,
  adapter = null,
  crypto = null,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  try {
    assertNoUnknownArguments(argv);
    assertLocalFixtureEnvironment(env);
    const selectedCrypto = crypto || runtimeCrypto(env);
    const selectedAdapter = adapter || trustedFixtureAdapter();
    const email = await readStdin(stdin);
    const result = await seedLocalTestLegacyFixture({
      env,
      normalizedEmail: email,
      profile: { role: "vip", status: "active", guild: "Synthetic", gameName: "Legacy Fixture" },
      adapter: selectedAdapter,
      crypto: selectedCrypto
    });
    stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    stderr.write(`${publicFixtureErrorCode(error)}\n`);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFixtureCli().catch(() => {
    process.exitCode = 1;
  });
}
