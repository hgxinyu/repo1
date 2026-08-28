import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sql, withTransaction } from "../../netlify/functions/_shared/auth/db.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(
  testDirectory,
  "../../netlify/database/migrations/202608250001_auth_accounts.sql"
);
const hardeningMigrationPath = join(
  testDirectory,
  "../../netlify/database/migrations/202608260001_auth_hardening.sql"
);
const vipRoleVariableFixMigrationPath = join(
  testDirectory,
  "../../netlify/database/migrations/202608270001_fix_request_account_vip_role_variable.sql"
);
const migrationBatchesMigrationPath = join(
  testDirectory,
  "../../netlify/database/migrations/202608270002_auth_migration_batches.sql"
);

function migrationSql() {
  return readFileSync(migrationPath, "utf8").toLowerCase();
}

function hardeningMigrationSql() {
  return readFileSync(hardeningMigrationPath, "utf8").toLowerCase();
}

function vipRoleVariableFixMigrationSql() {
  return readFileSync(vipRoleVariableFixMigrationPath, "utf8").toLowerCase();
}

function migrationBatchesMigrationSql() {
  return existsSync(migrationBatchesMigrationPath)
    ? readFileSync(migrationBatchesMigrationPath, "utf8").toLowerCase()
    : "";
}

function tableBody(sqlText, tableName) {
  const match = sqlText.match(new RegExp(
    `create table ${tableName} \\(([^;]+)\\);`,
    "s"
  ));
  assert.ok(match, `missing table ${tableName}`);
  return match[1];
}

function migrationBatchBody(sqlText) {
  const match = sqlText.match(new RegExp(
    "create table(?: if not exists)? (?:public\\.)?auth_migration_batches \\(([^;]+)\\);",
    "s"
  ));
  assert.ok(match, "missing table auth_migration_batches");
  return match[1]
    .replaceAll("public.auth_migration_status", "auth_migration_status")
    .replace(/\s+/gu, " ")
    .trim();
}

test("migration is transactional and declares all auth and AI limit tables", () => {
  const sqlText = migrationSql();
  const aiLimitsBody = tableBody(sqlText, "ai_hourly_limits");

  assert.match(sqlText, /^\s*begin;[\s\S]*commit;\s*$/);
  for (const tableName of [
    "accounts",
    "account_emails",
    "auth_identities",
    "auth_sessions",
    "oauth_transactions",
    "migration_records",
    "auth_migration_batches",
    "account_merge_operations",
    "ai_hourly_limits",
    "account_authorization_audit"
  ]) {
    assert.match(sqlText, new RegExp(`create table ${tableName} \\(`));
  }
  assert.match(aiLimitsBody, /count integer not null default 0 check \(count >= 0\)/);
  assert.doesNotMatch(aiLimitsBody, /request_count/);
  assert.doesNotMatch(sqlText, /^\s*(drop|truncate)\s+/mu);
});

test("migration batch readiness is durable and least-privilege in both migration paths", () => {
  const baseSql = migrationSql();
  const batchSql = migrationBatchesMigrationSql();

  assert.match(baseSql, /create table auth_migration_batches\s*\(/u);
  assert.match(batchSql, /create table(?: if not exists)? (?:public\.)?auth_migration_batches\s*\(/u);
  assert.match(baseSql, /unique \(source, environment_id, site_id\)/u);
  assert.match(baseSql, /status <> 'reconciled'[\s\S]*completed_at is not null/u);
  assert.match(baseSql, /source_count = imported_count/u);
  assert.match(baseSql, /conflict_count = 0/u);
  assert.doesNotMatch(batchSql, /grant (insert|update|delete).*public/iu);
  assert.match(batchSql, /revoke all on(?: table)? (?:public\.)?auth_migration_batches from public/u);
  assert.match(batchSql, /create table if not exists (?:public\.)?auth_migration_batches\s*\(/u);
  assert.match(batchSql, /^\s*begin;[\s\S]*commit;\s*$/u);
  assert.equal(
    migrationBatchBody(baseSql),
    migrationBatchBody(batchSql),
    "incremental migration must mirror the complete base table invariant"
  );
  const formattingOnlyBaseSql = baseSql.replace(
    "batch_id uuid primary key",
    "batch_id\n  uuid\tprimary key"
  );
  assert.equal(
    migrationBatchBody(baseSql),
    migrationBatchBody(formattingOnlyBaseSql),
    "formatting-only whitespace must normalize before comparing migration bodies"
  );
});

test("migration enforces the required active email and scoped identity uniqueness", () => {
  const sqlText = migrationSql();

  assert.match(
    sqlText,
    /create unique index auth_identities_scope_subject_uidx\s+on auth_identities\s*\(issuer_or_tenant,\s*connector_scope,\s*provider_subject\)\s+where revoked_at is null;/
  );
  assert.match(
    sqlText,
    /create unique index account_emails_lookup_uidx\s+on account_emails\s*\(email_lookup_hash\)\s+where removed_at is null;/
  );
  assert.match(tableBody(sqlText, "auth_identities"), /issuer_or_tenant/);
  assert.match(tableBody(sqlText, "auth_identities"), /connector_scope/);
  assert.match(tableBody(sqlText, "auth_identities"), /provider_subject/);
  assert.match(tableBody(sqlText, "account_emails"), /email_lookup_hash/);
  assert.match(tableBody(sqlText, "account_emails"), /encrypted_email/);
  assert.match(tableBody(sqlText, "account_emails"), /octet_length\(encrypted_email\) between 1 and 8192/);
  assert.match(tableBody(sqlText, "account_emails"), /removed_at/);
  assert.match(tableBody(sqlText, "account_emails"), /octet_length\(email_lookup_hash\) between 16 and 128/);
});

test("sessions contain source identity, migration, encrypted refresh, expiry, and authorization rotation state", () => {
  const body = tableBody(migrationSql(), "auth_sessions");

  for (const column of [
    "auth_source",
    "environment_id",
    "site_id",
    "session_id_hash",
    "session_family_id",
    "account_id",
    "logto_subject",
    "legacy_netlify_user_id",
    "migration_id",
    "encrypted_refresh_token",
    "idle_expires_at",
    "absolute_expires_at",
    "authz_version",
    "rotation_version",
    "revoked_at"
  ]) {
    assert.match(body, new RegExp(`\\b${column}\\b`), `missing ${column}`);
  }
  assert.match(body, /check[\s\S]*auth_source/);
  assert.match(body, /references accounts[\s\S]*account_id/);
  assert.match(body, /octet_length\(session_id_hash\) between 16 and 128/);
  assert.match(body, /legacy_netlify_user_id is null[\s\S]*length\(legacy_netlify_user_id\) between 1 and 255/);
  assert.match(body, /auth_source = 'legacy_bridge'[\s\S]*encrypted_refresh_token is null/);
  assert.match(body, /session_family_id uuid not null/);
  assert.match(body, /environment_id text not null check \([\s\S]*length\(environment_id\) between 1 and 128/);
  assert.match(body, /site_id text not null check \([\s\S]*length\(site_id\) between 1 and 255/);
  assert.match(body, /encrypted_refresh_token is null[\s\S]*refresh_token_key_version is null/);
  assert.match(body, /encrypted_refresh_token is not null[\s\S]*refresh_token_key_version is not null[\s\S]*refresh_token_key_version > 0/);
  assert.match(
    migrationSql(),
    /create index auth_sessions_family_active_idx[\s\S]*on auth_sessions \(session_family_id, absolute_expires_at\)[\s\S]*where revoked_at is null;/
  );
  assert.match(
    migrationSql(),
    /create index auth_sessions_environment_family_active_idx[\s\S]*on auth_sessions \(environment_id, site_id, session_family_id, absolute_expires_at\)[\s\S]*where revoked_at is null;/
  );
});

test("all dependent auth tables have foreign keys and state checks", () => {
  const sqlText = migrationSql();

  for (const tableName of [
    "account_emails",
    "auth_identities",
    "auth_sessions",
    "oauth_transactions",
    "migration_records",
    "account_merge_operations",
    "ai_hourly_limits",
    "account_authorization_audit"
  ]) {
    const body = tableBody(sqlText, tableName);
    assert.match(body, /references\s+/);
  }
  assert.match(sqlText, /check[\s\S]*role/);
  assert.match(sqlText, /check[\s\S]*status/);
  assert.match(sqlText, /check[\s\S]*expires_at/);
  assert.match(sqlText, /check[\s\S]*source_account_id/);
  assert.match(sqlText, /check[\s\S]*count/);
});

test("OAuth and bridge transactions require mutually exclusive complete credentials", () => {
  const body = tableBody(migrationSql(), "oauth_transactions");

  assert.match(
    body,
    /transaction_kind = 'oauth'[\s\S]*state_hash is not null[\s\S]*nonce_hash is not null[\s\S]*nonce_encrypted is not null[\s\S]*pkce_verifier_encrypted is not null/
  );
  assert.match(
    body,
    /transaction_kind = 'bridge'[\s\S]*legacy_session_id_hash is not null[\s\S]*csrf_token_hash is not null/
  );
  assert.match(body, /transaction_kind = 'oauth'[\s\S]*legacy_session_id_hash is null/);
  assert.match(body, /transaction_kind = 'bridge'[\s\S]*nonce_hash is null[\s\S]*nonce_encrypted is null[\s\S]*pkce_verifier_encrypted is null/);
});

test("legacy bridge lookup is unambiguous and boundary checks reject unsafe values", () => {
  const sqlText = migrationSql();
  const identityBody = tableBody(sqlText, "auth_identities");
  const transactionBody = tableBody(sqlText, "oauth_transactions");

  assert.match(
    sqlText,
    /create unique index auth_sessions_legacy_netlify_user_id_uidx[\s\S]*on auth_sessions \(environment_id, site_id, legacy_netlify_user_id\)[\s\S]*where legacy_netlify_user_id is not null and revoked_at is null;\s/
  );
  assert.match(identityBody, /length\(provider_subject\) between 1 and 512/);
  assert.match(transactionBody, /next_path !~ e'\[\[:cntrl:\]\]'/);
  assert.match(transactionBody, /next_path not like '%\\\\%'/);
  assert.match(
    transactionBody,
    /csrf_token_hash bytea check \(\s*csrf_token_hash is null or octet_length\(csrf_token_hash\) between 16 and 128\s*\)/
  );
});

test("authorization role and blocked-state mutations have append-only audit rows", () => {
  const sqlText = migrationSql();
  const body = tableBody(sqlText, "account_authorization_audit");

  for (const column of [
    "actor_account_id",
    "target_account_id",
    "old_role",
    "new_role",
    "old_status",
    "new_status",
    "changed_at",
    "metadata"
  ]) {
    assert.match(body, new RegExp(`\\b${column}\\b`), `missing ${column}`);
  }
  assert.match(body, /references accounts[\s\S]*account_id/);
  assert.match(body, /check[\s\S]*old_role[\s\S]*new_role[\s\S]*old_status[\s\S]*new_status/);
  assert.match(body, /jsonb_typeof\(metadata\) = 'object'/);
  assert.doesNotMatch(body, /\bupdated_at\b/);
  assert.match(sqlText, /create index account_authorization_audit_target_idx/);
  assert.match(sqlText, /create index account_authorization_audit_actor_idx/);
});

test("authorization audit is append-only and accounts mutations are actor-bound by triggers", () => {
  const sqlText = migrationSql();
  const body = tableBody(sqlText, "account_authorization_audit");

  assert.match(body, /actor_source text not null/);
  assert.match(body, /check[\s\S]*actor_source[\s\S]*system[\s\S]*actor_account_id/);
  assert.match(sqlText, /create table auth_authorization_mutation_context \(/);
  assert.match(sqlText, /create function public\.auth_current_actor\(\)/);
  assert.match(sqlText, /current_setting\('app\.authz_mutation_token', true\)/);
  assert.doesNotMatch(sqlText, /current_setting\('app\.actor_account_id', true\)/);
  assert.doesNotMatch(sqlText, /current_setting\('app\.actor_source', true\)/);
  assert.match(sqlText, /create function public\.record_account_authorization_change\(\)/);
  assert.match(sqlText, /create function public\.set_account_authorization\(/);
  assert.match(sqlText, /security definer[\s\S]*set search_path = pg_catalog, public/);
  assert.match(sqlText, /pg_trigger_depth\(\)/);
  assert.match(sqlText, /set_config\('app\.authz_mutation_token'/);
  assert.match(
    sqlText,
    /create trigger accounts_authorization_audit_trigger[\s\S]*after update of role, status on public\.accounts[\s\S]*execute function public\.record_account_authorization_change\(\)/
  );
  assert.match(
    sqlText,
    /when \(old\.role is distinct from new\.role or old\.status is distinct from new\.status\)/
  );
  assert.match(sqlText, /create function public\.prevent_account_authorization_audit_mutation\(\)/);
  assert.match(
    sqlText,
    /create trigger account_authorization_audit_append_only[\s\S]*before update or delete on public\.account_authorization_audit[\s\S]*execute function public\.prevent_account_authorization_audit_mutation\(\)/
  );
  assert.match(sqlText, /create trigger account_authorization_audit_truncate_guard[\s\S]*before truncate on public\.account_authorization_audit/);
  assert.match(sqlText, /create trigger account_authorization_audit_actor_guard[\s\S]*before insert on public\.account_authorization_audit/);
  assert.match(sqlText, /revoke insert, update, delete, truncate on table public\.account_authorization_audit from public;/);
  assert.match(sqlText, /revoke update \(role, status\) on table public\.accounts from public;/);
  assert.match(sqlText, /revoke execute on function public\.set_account_authorization\([\s\S]*from public;/);
  assert.match(sqlText, /revoke execute on function public\.set_system_account_authorization\(/);
  assert.match(sqlText, /comment on function public\.set_account_authorization\([\s\S]*explicitly grant execute only to a non-owner application role/);
});

test("authorization mutations advance authz_version so stale sessions fail closed", () => {
  const sqlText = migrationSql();
  assert.match(sqlText, /authz_version\s*=\s*authz_version\s*\+\s*1/);
});

test("hardening migration converges legacy session scope and authorization functions", () => {
  const sqlText = hardeningMigrationSql();
  assert.match(sqlText, /^\s*begin;[\s\S]*commit;\s*$/);
  assert.match(sqlText, /drop index if exists public\.auth_sessions_legacy_netlify_user_id_uidx/);
  assert.match(
    sqlText,
    /create unique index auth_sessions_legacy_netlify_user_id_uidx[\s\S]*on public\.auth_sessions \(environment_id, site_id, legacy_netlify_user_id\)[\s\S]*where legacy_netlify_user_id is not null and revoked_at is null/
  );
  assert.match(sqlText, /create or replace function public\.apply_account_authorization_mutation\(/);
  assert.match(sqlText, /authz_version\s*=\s*authz_version\s*\+\s*1/);
  assert.match(sqlText, /revoke execute on function public\.apply_account_authorization_mutation\([\s\S]*from public;/);
  assert.match(sqlText, /to_regprocedure\('public\.request_account_vip\(uuid,jsonb\)'\)/);
  assert.match(sqlText, /create or replace function public\.request_account_vip\(/);
});

test("VIP request function avoids PostgreSQL role-name collisions and is never executable by PUBLIC", () => {
  for (const sqlText of [migrationSql(), hardeningMigrationSql(), vipRoleVariableFixMigrationSql()]) {
    assert.match(sqlText, /^\s*begin;[\s\S]*commit;\s*$/);
    assert.match(sqlText, /(?:create|create or replace) function public\.request_account_vip\(\s*p_account_id uuid/);
    assert.match(sqlText, /v_current_status <> 'active'::public\.auth_account_status/);
    assert.match(sqlText, /v_current_role <> 'free'::public\.auth_account_role/);
    assert.doesNotMatch(sqlText, /\binto current_role, current_status\b/);
    assert.match(sqlText, /public\.apply_account_authorization_mutation\([\s\S]*'pending'::public\.auth_account_role/);
    assert.match(sqlText, /revoke execute on function public\.request_account_vip\(uuid, jsonb\) from public;/);
    assert.match(sqlText, /comment on function public\.request_account_vip\([\s\S]*trusted non-owner bff role[\s\S]*never grant public/);
  }
});

test("schema bounds redirect, subject, legacy IDs, hashes, and refresh-token versions", () => {
  const sqlText = migrationSql();
  const transactionBody = tableBody(sqlText, "oauth_transactions");
  const identityBody = tableBody(sqlText, "auth_identities");
  const migrationBody = tableBody(sqlText, "migration_records");
  const emailBody = tableBody(sqlText, "account_emails");
  const mergeBody = tableBody(sqlText, "account_merge_operations");

  assert.match(transactionBody, /length\(next_path\) between 1 and 2048/);
  assert.match(identityBody, /logto_user_id text check \(logto_user_id is null or length\(logto_user_id\) between 1 and 512\)/);
  assert.match(migrationBody, /source_user_id text not null check \([\s\S]*length\(source_user_id\) between 1 and 512/);
  assert.match(migrationBody, /legacy_netlify_user_id text not null check \([\s\S]*length\(legacy_netlify_user_id\) between 1 and 255/);
  assert.match(emailBody, /octet_length\(email_lookup_hash\) between 16 and 128/);
  assert.match(emailBody, /octet_length\(encrypted_email\) between 1 and 8192/);
  assert.match(migrationBody, /legacy_email_lookup_hash bytea check \([\s\S]*octet_length\(legacy_email_lookup_hash\) between 16 and 128/);
  assert.match(migrationBody, /snapshot_hash bytea not null check \(octet_length\(snapshot_hash\) between 16 and 128\)/);
  assert.match(mergeBody, /source_snapshot_hash bytea not null check \(octet_length\(source_snapshot_hash\) between 16 and 128\)/);
  assert.match(mergeBody, /target_snapshot_hash bytea not null check \(octet_length\(target_snapshot_hash\) between 16 and 128\)/);
  assert.match(transactionBody, /state_hash bytea not null check \(octet_length\(state_hash\) between 16 and 128\)/);
  assert.match(transactionBody, /pkce_verifier_encrypted bytea check \([\s\S]*octet_length\(pkce_verifier_encrypted\) between 1 and 8192/);
  assert.match(transactionBody, /constraint oauth_transactions_credentials_check check/);
});

test("database helpers are import-safe and fail closed before invoking a transaction callback", () => {
  assert.equal(typeof sql, "function");
  assert.equal(typeof sql.begin, "function");

  const original = process.env.AUTH_ENV_ID;
  delete process.env.AUTH_ENV_ID;
  let callbackInvoked = false;
  try {
    assert.throws(
      () => withTransaction(() => {
        callbackInvoked = true;
      }),
      /AUTH_CONFIG_MISSING:AUTH_ENV_ID/
    );
  } finally {
    if (original === undefined) delete process.env.AUTH_ENV_ID;
    else process.env.AUTH_ENV_ID = original;
  }
  assert.equal(callbackInvoked, false);
});

test("withTransaction passes a fake transaction adapter to the callback", async () => {
  const originalBegin = sql.begin;
  const fakeTransaction = { marker: "in-memory" };
  sql.begin = async (callback) => callback(fakeTransaction);

  try {
    const result = await withTransaction((transaction) => ({ transaction }));
    assert.deepEqual(result, { transaction: fakeTransaction });
  } finally {
    sql.begin = originalBegin;
  }
});
