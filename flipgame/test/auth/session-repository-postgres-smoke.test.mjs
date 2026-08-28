import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertDisposableSmokeTarget,
  parseSmokeArgs
} from "./session-repository-postgres-smoke.mjs";

test("Task 4 PostgreSQL smoke requires the exact disposable socket root", () => {
  assert.throws(
    () => assertDisposableSmokeTarget({
      host: "127.0.0.1",
      port: "55432",
      migration: new URL(
        "../../netlify/database/migrations/202608250001_auth_accounts.sql",
        import.meta.url
      ).pathname
    }),
    /exact disposable socket path/
  );
  assert.throws(
    () => assertDisposableSmokeTarget({
      host: "/private/tmp/shinegame-auth-pg.test/socket",
      port: "5432",
      migration: new URL(
        "../../netlify/database/migrations/202608250001_auth_accounts.sql",
        import.meta.url
      ).pathname
    }),
    /non-default local port/
  );
});

test("Task 4 PostgreSQL smoke argument parser has no implicit live target", () => {
  const options = parseSmokeArgs([
    "--host",
    "/private/tmp/shinegame-auth-pg.test/socket",
    "--port",
    "55432"
  ]);
  assert.equal(options.user, "postgres");
  assert.equal(options.database, "postgres");
  assert.throws(
    () => assertDisposableSmokeTarget(parseSmokeArgs([
      "--host",
      "/private/tmp/shinegame-auth-pg.test/socket"
    ])),
    /non-default local port/
  );
});

test("Task 4 PostgreSQL smoke exercises trusted families, account/env/site isolation, and scoped replay revocation", () => {
  const script = readFileSync(new URL("./session-repository-postgres-smoke.mjs", import.meta.url), "utf8");
  assert.match(script, /uuidGenerator/u);
  assert.doesNotMatch(script, /createAppSession\(\{[^}]*sessionFamilyId:/u);
  assert.match(script, /OTHER_ACCOUNT_ID/u);
  assert.match(script, /PRODUCTION_ENVIRONMENT_ID/u);
  assert.match(script, /environment_id/u);
  assert.match(script, /site_id/u);
  assert.match(script, /SELECT session_family_id/u);
  assert.match(script, /activeRows\.map\(\(row\) => row\.session_family_id\)/u);
  assert.match(script, /\[FAMILY_B\]/u);
  assert.match(script, /transactionId/u);
  assert.match(script, /WHERE transaction_id/u);
  assert.match(script, /count\(\*\)/u);
});

test("Task 4 PostgreSQL smoke proves public family revoke isolates same account and family by environment/site", () => {
  const script = readFileSync(new URL("./session-repository-postgres-smoke.mjs", import.meta.url), "utf8");
  assert.match(script, /const publicTargetSession = await createTrackedSession\(repository,/u);
  assert.match(script, /const productionFamilySession = await createTrackedSession\(productionRepository,/u);
  assert.match(script, /assert\.equal\(publicTargetSession\.accountId, ACCOUNT_ID\)/u);
  assert.match(script, /assert\.equal\(productionFamilySession\.accountId, ACCOUNT_ID\)/u);
  assert.match(script, /assert\.equal\(publicTargetSession\.sessionFamilyId, productionFamilySession\.sessionFamilyId\)/u);
  assert.match(script, /assert\.equal\(publicTargetSession\.sessionFamilyId, FAMILY_A\)/u);
  assert.match(script, /assert\.equal\(productionFamilySession\.sessionFamilyId, FAMILY_A\)/u);
  assert.match(script, /publicTargetSession\.environmentId, ENVIRONMENT_ID/u);
  assert.match(script, /productionFamilySession\.environmentId, PRODUCTION_ENVIRONMENT_ID/u);
  assert.match(script, /publicTargetSession\.siteId, SITE_ID/u);
  assert.match(script, /productionFamilySession\.siteId, PRODUCTION_SITE_ID/u);
});

test("Task 4 PostgreSQL smoke proves replay revoke isolates same account and family by environment/site", () => {
  const script = readFileSync(new URL("./session-repository-postgres-smoke.mjs", import.meta.url), "utf8");
  assert.match(script, /const productionReplaySession = await createTrackedSession\(productionRepository,/u);
  assert.match(script, /assert\.equal\(replayTargetSession\.accountId, productionReplaySession\.accountId\)/u);
  assert.match(script, /assert\.equal\(replayTargetSession\.sessionFamilyId, REPLAY_FAMILY\)/u);
  assert.match(script, /assert\.equal\(productionReplaySession\.sessionFamilyId, REPLAY_FAMILY\)/u);
  assert.match(script, /const stageReplayRows = await sql/u);
  assert.match(script, /const productionReplayRows = await sql/u);
  assert.match(script, /stageReplayRows\.every\(\(row\) => row\.revoked_at !== null\)/u);
  assert.match(script, /productionReplayRows\.every\(\(row\) => row\.revoked_at === null\)/u);
  assert.match(script, /replayTargetSession\.environmentId, ENVIRONMENT_ID/u);
  assert.match(script, /productionReplaySession\.environmentId, PRODUCTION_ENVIRONMENT_ID/u);
  assert.match(script, /replayTargetSession\.siteId, SITE_ID/u);
  assert.match(script, /productionReplaySession\.siteId, PRODUCTION_SITE_ID/u);
});

test("Task 4 PostgreSQL smoke proves OAuth consume is environment/site scoped before and after consumption", () => {
  const script = readFileSync(new URL("./session-repository-postgres-smoke.mjs", import.meta.url), "utf8");
  assert.match(script, /const oauthBeforeProductionConsume = await sql/u);
  assert.match(script, /productionRepository\.consumeOAuthTransaction\(\{[\s\S]*oauth\.state/u);
  assert.match(script, /assert\.equal\(oauthBeforeProductionConsume\[0\]\?\.consumed_at, null\)/u);
  assert.match(script, /const oauthConsumedRow = await sql/u);
  assert.match(script, /assert\.notEqual\(oauthConsumedRow\[0\]\?\.consumed_at, null\)/u);
  assert.match(script, /repository\.consumeOAuthTransaction\(\{[\s\S]*oauth\.state/u);
  assert.match(script, /WHERE transaction_id = \$\{oauthTransactionId\}/u);
});
