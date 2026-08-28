import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { createAccountRepository } from "../../netlify/functions/_shared/auth/account-repository.mjs";

const SCRIPT_DIRECTORY = resolve(new URL(".", import.meta.url).pathname);
const DEFAULT_MIGRATION = resolve(
  SCRIPT_DIRECTORY,
  "../../../database/migrations/202608250001_auth_accounts.sql"
);
const DISPOSABLE_SOCKET_PATTERN = /^\/private\/tmp\/shinegame-auth-pg\.[A-Za-z0-9]+\/socket$/u;
const REPOSITORY_MIGRATION_SUFFIX = "/database/migrations/202608250001_auth_accounts.sql";

function usage() {
  return [
    "Usage: node test/auth/account-repository-postgres-smoke.mjs",
    "  --host /private/tmp/shinegame-auth-pg.<suffix>/socket",
    "  --port <non-default-local-port>",
    "  [--user postgres] [--database postgres] [--migration /absolute/path/to/migration.sql]"
  ].join("\n");
}

export function parseSmokeArgs(argv) {
  const values = {
    host: "",
    port: "",
    user: "postgres",
    database: "postgres",
    migration: DEFAULT_MIGRATION
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) throw new Error(usage());
    const name = argument.slice(2);
    if (!(name in values)) throw new Error(usage());
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(usage());
    values[name] = value;
    index += 1;
  }
  return values;
}

export function assertDisposableSmokeTarget(options) {
  if (!DISPOSABLE_SOCKET_PATTERN.test(options.host)) {
    throw new Error("PostgreSQL smoke requires an exact disposable socket path");
  }
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 5432) {
    throw new Error("PostgreSQL smoke requires a non-default local port");
  }
  const migration = realpathSync(resolve(options.migration));
  if (!migration.endsWith(REPOSITORY_MIGRATION_SUFFIX)) {
    throw new Error("PostgreSQL smoke must apply the staged auth migration");
  }
  return { ...options, port, migration };
}

function accountInput(email, logtoSubject, connectorScope = "email-otp") {
  return {
    logtoSubject,
    issuerOrTenant: "tenant-smoke",
    connectorScope,
    normalizedEmail: email
  };
}

async function main(options) {
  const target = assertDisposableSmokeTarget(options);
  const migrationSql = readFileSync(target.migration, "utf8");
  const hashes = new Map([
    ["first-vip@example.com", Buffer.alloc(32, 0x11)],
    ["second-vip@example.com", Buffer.alloc(32, 0x22)]
  ]);
  const accountIds = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222"
  ];
  const connectionOptions = {
    host: target.host,
    port: target.port,
    user: target.user,
    database: target.database,
    connect_timeout: 5
  };
  const sql = postgres({ ...connectionOptions, max: 8 });
  let seeded = false;
  try {
    // postgres.js reserves transaction-control statements for sql.begin. A
    // one-connection migration client is the supported exception and keeps
    // the staged migration's BEGIN/COMMIT semantics intact.
    const migrationClient = postgres({ ...connectionOptions, max: 1 });
    try {
      await migrationClient.unsafe(migrationSql);
    } finally {
      await migrationClient.end({ timeout: 5 });
    }
    console.log("Task 3 PostgreSQL migration apply: PASS");

    await sql`
      INSERT INTO accounts (account_id, role, status, authz_version)
      VALUES
        (${accountIds[0]}, 'vip', 'active', 1),
        (${accountIds[1]}, 'vip', 'active', 1)
    `;
    await sql`
      INSERT INTO account_emails
        (account_id, email_lookup_hash, encrypted_email, is_primary, verified_at)
      VALUES
        (${accountIds[0]}, ${hashes.get("first-vip@example.com")}, ${Buffer.from("cipher-one")}, TRUE, now()),
        (${accountIds[1]}, ${hashes.get("second-vip@example.com")}, ${Buffer.from("cipher-two")}, TRUE, now())
    `;
    seeded = true;

    const repository = createAccountRepository({
      sql,
      withTransaction: (callback) => sql.begin(callback),
      issuerOrTenant: "tenant-smoke",
      emailLookupHash: async (email) => {
        const hash = hashes.get(email);
        if (!hash) throw new Error("unexpected smoke email input");
        return hash;
      }
    });

    const claims = await Promise.allSettled([
      repository.claimLegacyAccountByVerifiedEmail(
        accountInput("first-vip@example.com", "same-logto-sub")
      ),
      repository.claimLegacyAccountByVerifiedEmail(
        accountInput("second-vip@example.com", "same-logto-sub")
      )
    ]);
    const fulfilled = claims
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.status === "fulfilled");
    const rejected = claims.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one concurrent claim must win");
    assert.equal(rejected.length, 1, "exactly one concurrent claim must lose");
    assert.equal(rejected[0].reason?.code, "ACCOUNT_CLAIM_CONFLICT");
    const winningAccountId = accountIds[fulfilled[0].index];
    assert.deepEqual(fulfilled[0].result.value, {
      kind: "claimed",
      accountId: winningAccountId
    });
    console.log("Task 3 concurrent same-scoped identity: PASS (one winner, one ACCOUNT_CLAIM_CONFLICT)");

    const winningEmail = fulfilled[0].index === 0
      ? "first-vip@example.com"
      : "second-vip@example.com";
    const retry = await repository.claimLegacyAccountByVerifiedEmail(
      accountInput(winningEmail, "same-logto-sub")
    );
    assert.deepEqual(retry, { kind: "claimed", accountId: winningAccountId });
    const identities = await sql`
      SELECT account_id, issuer_or_tenant, connector_scope, provider_subject, subject_type, status, revoked_at
      FROM auth_identities
      WHERE issuer_or_tenant = ${"tenant-smoke"}
        AND provider_subject = ${"same-logto-sub"}
    `;
    assert.equal(identities.length, 1, "same-account retry must not duplicate identity");
    assert.equal(identities[0].account_id, winningAccountId);
    console.log("Task 3 same-account retry idempotence: PASS (one identity row)");

    const crossConnectorSubject = "cross-connector-logto-sub";
    const crossConnectorClaims = await Promise.allSettled([
      repository.claimLegacyAccountByVerifiedEmail(
        accountInput("first-vip@example.com", crossConnectorSubject, "email-otp")
      ),
      repository.claimLegacyAccountByVerifiedEmail(
        accountInput("second-vip@example.com", crossConnectorSubject, "google")
      )
    ]);
    const crossFulfilled = crossConnectorClaims
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.status === "fulfilled");
    const crossRejected = crossConnectorClaims
      .filter((result) => result.status === "rejected");
    assert.equal(crossFulfilled.length, 1, "cross-connector subject must have one winner");
    assert.equal(crossRejected.length, 1, "cross-connector subject must have one conflict");
    assert.equal(crossRejected[0].reason?.code, "ACCOUNT_CLAIM_CONFLICT");
    const crossWinningIndex = crossFulfilled[0].index;
    const crossWinningAccountId = accountIds[crossWinningIndex];
    assert.deepEqual(crossFulfilled[0].result.value, {
      kind: "claimed",
      accountId: crossWinningAccountId
    });
    const crossWinningEmail = crossWinningIndex === 0
      ? "first-vip@example.com"
      : "second-vip@example.com";
    const crossWinningConnector = crossWinningIndex === 0 ? "email-otp" : "google";
    const crossOtherConnector = crossWinningConnector === "email-otp" ? "google" : "email-otp";
    const crossConnectorRetry = await repository.claimLegacyAccountByVerifiedEmail(
      accountInput(crossWinningEmail, crossConnectorSubject, crossOtherConnector)
    );
    assert.deepEqual(crossConnectorRetry, {
      kind: "claimed",
      accountId: crossWinningAccountId
    });
    const crossIdentities = await sql`
      SELECT account_id, connector_scope, provider_subject
      FROM auth_identities
      WHERE issuer_or_tenant = ${"tenant-smoke"}
        AND provider_subject = ${crossConnectorSubject}
        AND status = 'active'
        AND revoked_at IS NULL
    `;
    assert.equal(crossIdentities.length, 2, "same-account cross-connector claim must add one scoped row");
    assert.deepEqual(new Set(crossIdentities.map((row) => row.account_id)), new Set([crossWinningAccountId]));
    assert.deepEqual(
      new Set(crossIdentities.map((row) => row.connector_scope)),
      new Set([crossWinningConnector, crossOtherConnector])
    );
    console.log("Task 3 concurrent cross-connector subject: PASS (one winner, one ACCOUNT_CLAIM_CONFLICT)");
    console.log("Task 3 same-account cross-connector retry: PASS (two scoped rows, one account)");
    console.log("Task 3 account repository PostgreSQL smoke: PASS");
  } finally {
    if (seeded) {
      await sql`
        DELETE FROM auth_identities
        WHERE issuer_or_tenant = ${"tenant-smoke"}
          AND provider_subject IN ${sql(["same-logto-sub", "cross-connector-logto-sub"])}
      `;
      await sql`DELETE FROM account_emails WHERE account_id IN ${sql(accountIds)}`;
      await sql`DELETE FROM accounts WHERE account_id IN ${sql(accountIds)}`;
      console.log("Task 3 PostgreSQL smoke data cleanup: PASS");
    }
    await sql.end({ timeout: 5 });
  }
}

const invokedScript = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (invokedScript === import.meta.url) {
  try {
    await main(assertDisposableSmokeTarget(parseSmokeArgs(process.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
