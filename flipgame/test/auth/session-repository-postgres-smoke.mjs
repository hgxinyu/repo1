import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { createSessionRepository } from "../../netlify/functions/_shared/auth/session-repository.mjs";

const SCRIPT_DIRECTORY = resolve(new URL(".", import.meta.url).pathname);
const DEFAULT_MIGRATION = resolve(
  SCRIPT_DIRECTORY,
  "../../netlify/database/migrations/202608250001_auth_accounts.sql"
);
const DISPOSABLE_SOCKET_PATTERN = /^\/private\/tmp\/shinegame-auth-pg\.[A-Za-z0-9]+\/socket$/u;
const REPOSITORY_MIGRATION_SUFFIX = "/flipgame/netlify/database/migrations/202608250001_auth_accounts.sql";

function usage() {
  return [
    "Usage: node test/auth/session-repository-postgres-smoke.mjs",
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

const HMAC_KEY = Buffer.from("session-smoke-hmac-key-32-bytes!", "utf8");
const ENCRYPTION_KEY = Buffer.from("session-smoke-encryption-key-32!", "utf8");
const ENVIRONMENT_ID = "stage";
const SITE_ID = "site-stage";
const PRODUCTION_ENVIRONMENT_ID = "production";
const PRODUCTION_SITE_ID = "site-production";
const ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ACCOUNT_ID = "55555555-5555-4555-8555-555555555555";
const FAMILY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FAMILY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REPLAY_FAMILY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function queuedUuidGenerator(values) {
  const queue = [...values];
  return () => queue.shift() ?? values.at(-1);
}

function repositoryFor(sql, environmentId, siteId, uuidValues) {
  return createSessionRepository({
    sql,
    withTransaction: (callback) => sql.begin(callback),
    environmentId,
    siteId,
    hmacKey: HMAC_KEY,
    encryptionKey: ENCRYPTION_KEY,
    keyVersion: 1,
    uuidGenerator: queuedUuidGenerator(uuidValues)
  });
}

async function main(options) {
  const target = assertDisposableSmokeTarget(options);
  const migrationSql = readFileSync(target.migration, "utf8");
  const connectionOptions = {
    host: target.host,
    port: target.port,
    user: target.user,
    database: target.database,
    connect_timeout: 5
  };
  const sql = postgres({ ...connectionOptions, max: 8 });
  let seeded = false;
  let oauthTransactionId = null;
  const sessionIds = [];
  try {
    const migrationClient = postgres({ ...connectionOptions, max: 1 });
    try {
      await migrationClient.unsafe(migrationSql);
    } finally {
      await migrationClient.end({ timeout: 5 });
    }
    console.log("Task 4 PostgreSQL migration apply: PASS");

    await sql`
      INSERT INTO accounts (account_id, role, status, authz_version)
      VALUES
        (${ACCOUNT_ID}, 'vip', 'active', 7),
        (${OTHER_ACCOUNT_ID}, 'vip', 'active', 7)
    `;
    seeded = true;

    const repository = repositoryFor(
      sql,
      ENVIRONMENT_ID,
      SITE_ID,
      [FAMILY_A, FAMILY_B, REPLAY_FAMILY, REPLAY_FAMILY]
    );
    const otherAccountRepository = repositoryFor(
      sql,
      ENVIRONMENT_ID,
      SITE_ID,
      [FAMILY_A]
    );
    const productionRepository = repositoryFor(
      sql,
      PRODUCTION_ENVIRONMENT_ID,
      PRODUCTION_SITE_ID,
      [FAMILY_A, REPLAY_FAMILY]
    );

    const oauth = await repository.createOAuthTransaction({
      nextPath: "AIAsk.html"
    });
    oauthTransactionId = oauth.transactionId;
    const oauthBeforeProductionConsume = await sql`
      SELECT transaction_id, environment_id, site_id, consumed_at
      FROM oauth_transactions
      WHERE transaction_id = ${oauthTransactionId}
    `;
    assert.equal(oauthBeforeProductionConsume.length, 1);
    assert.equal(oauthBeforeProductionConsume[0]?.environment_id, ENVIRONMENT_ID);
    assert.equal(oauthBeforeProductionConsume[0]?.site_id, SITE_ID);
    assert.equal(oauthBeforeProductionConsume[0]?.consumed_at, null);
    await assert.rejects(
      () => productionRepository.consumeOAuthTransaction({
        state: oauth.state,
        nonce: oauth.nonce,
        pkceVerifier: oauth.pkceVerifier
      }),
      (error) => {
        assert.match(
          error?.code ?? error?.message ?? "",
          /OAUTH_TRANSACTION_INVALID|TRANSACTION_INVALID|TRANSACTION_REPLAY/
        );
        return true;
      }
    );
    const oauthAfterProductionConsume = await sql`
      SELECT transaction_id, environment_id, site_id, consumed_at
      FROM oauth_transactions
      WHERE transaction_id = ${oauthTransactionId}
    `;
    assert.equal(oauthAfterProductionConsume.length, 1);
    assert.equal(oauthAfterProductionConsume[0]?.environment_id, ENVIRONMENT_ID);
    assert.equal(oauthAfterProductionConsume[0]?.site_id, SITE_ID);
    assert.equal(oauthAfterProductionConsume[0]?.consumed_at, null);
    const consumed = await repository.consumeOAuthTransaction({
      state: oauth.state,
      nonce: oauth.nonce,
      pkceVerifier: oauth.pkceVerifier
    });
    assert.equal(consumed.transactionId, oauth.transactionId);
    assert.equal(consumed.pkceVerifier, oauth.pkceVerifier);
    const oauthConsumedRow = await sql`
      SELECT transaction_id, environment_id, site_id, consumed_at
      FROM oauth_transactions
      WHERE transaction_id = ${oauthTransactionId}
    `;
    assert.equal(oauthConsumedRow.length, 1);
    assert.equal(oauthConsumedRow[0]?.environment_id, ENVIRONMENT_ID);
    assert.equal(oauthConsumedRow[0]?.site_id, SITE_ID);
    assert.notEqual(oauthConsumedRow[0]?.consumed_at, null);
    await assert.rejects(
      () => repository.consumeOAuthTransaction({
        state: oauth.state,
        nonce: oauth.nonce,
        pkceVerifier: oauth.pkceVerifier
      }),
      /TRANSACTION_REPLAY/
    );
    console.log("Task 4 OAuth consume single-use: PASS");

    const createTrackedSession = async (sessionRepository, input) => {
      const session = await sessionRepository.createAppSession(input);
      sessionIds.push(session.sessionId);
      return session;
    };
    const publicTargetSession = await createTrackedSession(repository, {
      authSource: "logto",
      accountId: ACCOUNT_ID,
      logtoSubject: "smoke-logto-public-target",
      refreshToken: "provider-refresh-token-public-target",
      authzVersion: 7
    });
    const otherFamilySession = await createTrackedSession(repository, {
      authSource: "logto",
      accountId: ACCOUNT_ID,
      logtoSubject: "smoke-logto-subject-other-family",
      refreshToken: "provider-refresh-token-other-family",
      authzVersion: 7
    });
    const replayTargetSession = await createTrackedSession(repository, {
      authSource: "logto",
      accountId: ACCOUNT_ID,
      logtoSubject: "smoke-logto-replay-target",
      refreshToken: "provider-refresh-token-replay",
      authzVersion: 7
    });
    const replaySiblingSession = await createTrackedSession(repository, {
      authSource: "logto",
      accountId: ACCOUNT_ID,
      logtoSubject: "smoke-logto-replay-sibling",
      refreshToken: "provider-refresh-token-replay-sibling",
      authzVersion: 7
    });
    const otherAccountFamilySession = await createTrackedSession(otherAccountRepository, {
      authSource: "logto",
      accountId: OTHER_ACCOUNT_ID,
      logtoSubject: "smoke-logto-other-account-family",
      refreshToken: "provider-refresh-token-other-account",
      authzVersion: 7
    });
    const productionFamilySession = await createTrackedSession(productionRepository, {
      authSource: "logto",
      accountId: ACCOUNT_ID,
      logtoSubject: "smoke-logto-production-family",
      refreshToken: "provider-refresh-token-production",
      authzVersion: 7
    });
    const productionReplaySession = await createTrackedSession(productionRepository, {
      authSource: "logto",
      accountId: ACCOUNT_ID,
      logtoSubject: "smoke-logto-production-replay-family",
      refreshToken: "provider-refresh-token-production-replay",
      authzVersion: 7
    });

    assert.equal(publicTargetSession.accountId, ACCOUNT_ID);
    assert.equal(productionFamilySession.accountId, ACCOUNT_ID);
    assert.equal(publicTargetSession.sessionFamilyId, FAMILY_A);
    assert.equal(productionFamilySession.sessionFamilyId, FAMILY_A);
    assert.equal(publicTargetSession.sessionFamilyId, productionFamilySession.sessionFamilyId);
    assert.equal(publicTargetSession.environmentId, ENVIRONMENT_ID);
    assert.equal(publicTargetSession.siteId, SITE_ID);
    assert.equal(productionFamilySession.environmentId, PRODUCTION_ENVIRONMENT_ID);
    assert.equal(productionFamilySession.siteId, PRODUCTION_SITE_ID);
    assert.notEqual(publicTargetSession.environmentId, productionFamilySession.environmentId);
    assert.notEqual(publicTargetSession.siteId, productionFamilySession.siteId);

    assert.equal(replayTargetSession.accountId, ACCOUNT_ID);
    assert.equal(productionReplaySession.accountId, ACCOUNT_ID);
    assert.equal(replayTargetSession.accountId, productionReplaySession.accountId);
    assert.equal(replayTargetSession.sessionFamilyId, REPLAY_FAMILY);
    assert.equal(productionReplaySession.sessionFamilyId, REPLAY_FAMILY);
    assert.equal(replayTargetSession.sessionFamilyId, productionReplaySession.sessionFamilyId);
    assert.equal(replayTargetSession.environmentId, ENVIRONMENT_ID);
    assert.equal(replayTargetSession.siteId, SITE_ID);
    assert.equal(productionReplaySession.environmentId, PRODUCTION_ENVIRONMENT_ID);
    assert.equal(productionReplaySession.siteId, PRODUCTION_SITE_ID);
    assert.notEqual(replayTargetSession.environmentId, productionReplaySession.environmentId);
    assert.notEqual(replayTargetSession.siteId, productionReplaySession.siteId);

    await repository.revokeSessionFamily({
      accountId: ACCOUNT_ID,
      sessionFamilyId: FAMILY_A
    });
    const scopedRows = await sql`
      SELECT account_id, environment_id, site_id, session_family_id, revoked_at
      FROM auth_sessions
      WHERE session_family_id = ${FAMILY_A}
      ORDER BY account_id, environment_id
    `;
    const scopedByAccount = new Map(
      scopedRows.map((row) => [
        `${row.account_id}:${row.environment_id}:${row.site_id}`,
        row.revoked_at !== null
      ])
    );
    assert.equal(scopedByAccount.get(`${ACCOUNT_ID}:${ENVIRONMENT_ID}:${SITE_ID}`), true);
    assert.equal(scopedByAccount.get(`${OTHER_ACCOUNT_ID}:${ENVIRONMENT_ID}:${SITE_ID}`), false);
    assert.equal(
      scopedByAccount.get(`${ACCOUNT_ID}:${PRODUCTION_ENVIRONMENT_ID}:${PRODUCTION_SITE_ID}`),
      false
    );
    assert.equal(
      await repository.readValidSessionFromCookie({
        headers: { cookie: `__Host-shinegame_session=${productionFamilySession.sessionToken}` }
      }),
      null
    );
    await assert.rejects(
      () => repository.rotateSession({
        sessionToken: productionFamilySession.sessionToken,
        presentedRefreshToken: "provider-refresh-token-production",
        expectedRotationVersion: 1
      }),
      /SESSION_REFRESH_REPLAY/
    );
    const productionStillActive = await sql`
      SELECT revoked_at
      FROM auth_sessions
      WHERE session_id = ${productionFamilySession.sessionId}
        AND environment_id = ${PRODUCTION_ENVIRONMENT_ID}
        AND site_id = ${PRODUCTION_SITE_ID}
    `;
    assert.equal(productionStillActive[0]?.revoked_at, null);
    console.log("Task 4 family/account/environment/site isolation: PASS");

    const rotations = await Promise.allSettled([
      repository.rotateSession({
        sessionToken: replayTargetSession.sessionToken,
        presentedRefreshToken: "provider-refresh-token-replay",
        expectedRotationVersion: 1
      }),
      repository.rotateSession({
        sessionToken: replayTargetSession.sessionToken,
        presentedRefreshToken: "provider-refresh-token-replay",
        expectedRotationVersion: 1
      })
    ]);
    assert.equal(rotations.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(rotations.filter((result) => result.status === "rejected").length, 1);
    assert.match(
      rotations.find((result) => result.status === "rejected").reason?.code ?? "",
      /SESSION_REFRESH_REPLAY|SESSION_ROTATION_STALE/
    );
    const stageReplayRows = await sql`
      SELECT account_id, environment_id, site_id, session_family_id, revoked_at
      FROM auth_sessions
      WHERE account_id = ${ACCOUNT_ID}
        AND environment_id = ${ENVIRONMENT_ID}
        AND site_id = ${SITE_ID}
        AND session_family_id = ${REPLAY_FAMILY}
    `;
    assert.equal(stageReplayRows.length, 2);
    assert.equal(stageReplayRows.every((row) => row.revoked_at !== null), true);
    const productionReplayRows = await sql`
      SELECT account_id, environment_id, site_id, session_family_id, revoked_at
      FROM auth_sessions
      WHERE account_id = ${ACCOUNT_ID}
        AND environment_id = ${PRODUCTION_ENVIRONMENT_ID}
        AND site_id = ${PRODUCTION_SITE_ID}
        AND session_family_id = ${REPLAY_FAMILY}
    `;
    assert.equal(productionReplayRows.length, 1);
    assert.equal(productionReplayRows.every((row) => row.revoked_at === null), true);
    assert.equal(productionReplayRows[0]?.account_id, ACCOUNT_ID);
    assert.equal(productionReplayRows[0]?.session_family_id, REPLAY_FAMILY);
    assert.equal(productionReplayRows[0]?.environment_id, PRODUCTION_ENVIRONMENT_ID);
    assert.equal(productionReplayRows[0]?.site_id, PRODUCTION_SITE_ID);
    const activeRows = await sql`
      SELECT session_family_id
      FROM auth_sessions
      WHERE account_id = ${ACCOUNT_ID}
        AND environment_id = ${ENVIRONMENT_ID}
        AND site_id = ${SITE_ID}
        AND revoked_at IS NULL
    `;
    assert.deepEqual(activeRows.map((row) => row.session_family_id), [FAMILY_B]);
    const crossBoundaryRows = await sql`
      SELECT account_id, environment_id, site_id, revoked_at
      FROM auth_sessions
      WHERE session_id IN ${sql([
        otherAccountFamilySession.sessionId,
        productionFamilySession.sessionId,
        productionReplaySession.sessionId
      ])}
      ORDER BY account_id
    `;
    assert.equal(crossBoundaryRows.length, 3);
    assert.equal(crossBoundaryRows.every((row) => row.revoked_at === null), true);
    console.log("Task 4 concurrent refresh/replay family revoke: PASS");
    console.log("Task 4 session repository PostgreSQL smoke: PASS");
  } finally {
    if (oauthTransactionId) {
      await sql`DELETE FROM oauth_transactions WHERE transaction_id = ${oauthTransactionId}`;
      const remainingOAuth = await sql`
        SELECT count(*)::int AS count
        FROM oauth_transactions
        WHERE transaction_id = ${oauthTransactionId}
      `;
      assert.equal(Number(remainingOAuth[0]?.count ?? 0), 0);
      console.log("Task 4 OAuth transaction-id cleanup: PASS");
    }
    if (seeded) {
      if (sessionIds.length > 0) {
        await sql`DELETE FROM auth_sessions WHERE session_id IN ${sql(sessionIds)}`;
        const remainingSessions = await sql`
          SELECT count(*)::int AS count
          FROM auth_sessions
          WHERE session_id IN ${sql(sessionIds)}
        `;
        assert.equal(Number(remainingSessions[0]?.count ?? 0), 0);
        console.log("Task 4 session-id cleanup: PASS");
      }
      const accountIds = [ACCOUNT_ID, OTHER_ACCOUNT_ID];
      await sql`DELETE FROM accounts WHERE account_id IN ${sql(accountIds)}`;
      const remainingAccounts = await sql`
        SELECT count(*)::int AS count
        FROM accounts
        WHERE account_id IN ${sql(accountIds)}
      `;
      assert.equal(Number(remainingAccounts[0]?.count ?? 0), 0);
      console.log("Task 4 PostgreSQL smoke data cleanup: PASS");
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
