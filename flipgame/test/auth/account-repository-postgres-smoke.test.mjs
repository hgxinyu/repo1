import test from "node:test";
import assert from "node:assert/strict";
import {
  assertDisposableSmokeTarget,
  parseSmokeArgs
} from "./account-repository-postgres-smoke.mjs";

test("Task 3 PostgreSQL smoke requires the exact disposable socket root", () => {
  assert.throws(
    () => assertDisposableSmokeTarget({
      host: "127.0.0.1",
      port: "55432",
      migration: new URL(
        "../../../database/migrations/202608250001_auth_accounts.sql",
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
        "../../../database/migrations/202608250001_auth_accounts.sql",
        import.meta.url
      ).pathname
    }),
    /non-default local port/
  );
});

test("Task 3 PostgreSQL smoke argument parser has no implicit live target", () => {
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
