import test from "node:test";
import assert from "node:assert/strict";
import {
  runFixtureCli,
  seedLocalTestLegacyFixture
} from "../../scripts/auth-migration/seed-local-test-fixture.mjs";

const LOCAL_ENV = {
  AUTH_ENV_ID: "neon-local-test",
  AUTH_EXPECTED_SITE_ID: "shinegame-local-test",
  NETLIFY_SITE_ID: "shinegame-local-test",
  AUTH_LOCAL_FIXTURE_APPLY: "confirmed"
};

function syntheticEmail() {
  return ["legacy-fixture", "synthetic.test"].join("@");
}

function fixtureAdapter() {
  const state = {
    accounts: [],
    emails: [],
    legacyIdentities: [],
    migrationRecords: [],
    batches: []
  };
  let transactions = 0;
  return {
    state,
    get transactions() {
      return transactions;
    },
    async withTransaction(callback) {
      transactions += 1;
      return callback({
        async insertAccount(row) { state.accounts.push({ ...row }); },
        async insertAccountEmail(row) { state.emails.push({ ...row }); },
        async insertLegacyIdentity(row) { state.legacyIdentities.push({ ...row }); },
        async insertMigrationRecord(row) { state.migrationRecords.push({ ...row }); },
        async upsertMigrationBatch(row) { state.batches.push({ ...row }); }
      });
    }
  };
}

function fixtureCrypto({ keyVersion = 7 } = {}) {
  return {
    hmacKey: "runtime-only-hmac-key",
    encryptionKey: "runtime-only-encryption-key",
    keyVersion,
    async emailLookupHash() { return Buffer.from("synthetic-lookup-hash"); },
    async encryptEmail() { return Buffer.from("synthetic-ciphertext"); }
  };
}

function stdinValue(value) {
  return (async function* () {
    yield value;
  }());
}

function outputCapture() {
  const chunks = [];
  return {
    stream: { write(value) { chunks.push(String(value)); } },
    text() { return chunks.join(""); }
  };
}

function assertParameterizedStatement(strings, values) {
  const parts = Array.from(strings.raw || strings);
  assert.equal(parts.length, values.length + 1);
  const rendered = parts.reduce(
    (result, part, index) => `${result}${part}${index < values.length ? `$${index + 1}` : ""}`,
    ""
  );
  const placeholders = [...rendered.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1]));
  assert.deepEqual(placeholders, values.map((_, index) => index + 1));
}

test("local fixture refuses every boundary that is not the exact local-test scope", async () => {
  const fields = ["AUTH_ENV_ID", "AUTH_EXPECTED_SITE_ID", "NETLIFY_SITE_ID", "AUTH_LOCAL_FIXTURE_APPLY"];
  for (const field of fields) {
    const env = { ...LOCAL_ENV, [field]: "production" };
    await assert.rejects(
      () => seedLocalTestLegacyFixture({
        env,
        normalizedEmail: syntheticEmail(),
        profile: { role: "vip", status: "active", guild: "Synthetic", gameName: "Legacy Fixture" },
        adapter: fixtureAdapter(),
        crypto: fixtureCrypto()
      }),
      (error) => error.code === "AUTH_LOCAL_FIXTURE_SCOPE_REQUIRED"
    );
  }
  for (const mode of ["legacy", "frozen", "account", "unknown", " "]) {
    await assert.rejects(
      () => seedLocalTestLegacyFixture({
        env: { ...LOCAL_ENV, MIGRATION_WRITE_MODE: mode },
        normalizedEmail: syntheticEmail(),
        profile: { role: "vip", status: "active", guild: "Synthetic", gameName: "Legacy Fixture" },
        adapter: fixtureAdapter(),
        crypto: fixtureCrypto()
      }),
      (error) => error.code === "AUTH_LOCAL_FIXTURE_PRODUCTION_MODE",
      `fixture must reject migration mode ${mode}`
    );
  }
});

test("local fixture creates exactly one aggregate legacy VIP fixture in one transaction without leaking secrets", async () => {
  const adapter = fixtureAdapter();
  const rawEmail = syntheticEmail();
  const lookupHash = "synthetic-lookup-hash";
  const ciphertext = "synthetic-ciphertext";
  const crypto = fixtureCrypto();
  const result = await seedLocalTestLegacyFixture({
    env: LOCAL_ENV,
    normalizedEmail: rawEmail,
    profile: { role: "vip", status: "active", guild: "Synthetic", gameName: "Legacy Fixture" },
    adapter,
    crypto
  });
  assert.deepEqual(result, {
    fixture: "created",
    accounts: 1,
    emails: 1,
    legacyIdentities: 1,
    migrationRecords: 1,
    reconciledBatches: 1,
    role: "vip",
    status: "active"
  });
  assert.equal(adapter.transactions, 1);
  assert.equal(adapter.state.accounts.length, 1);
  assert.equal(adapter.state.emails.length, 1);
  assert.equal(adapter.state.legacyIdentities.length, 1);
  assert.equal(adapter.state.migrationRecords.length, 1);
  assert.equal(adapter.state.batches.length, 1);
  assert.equal(adapter.state.emails[0].isPrimary, true);
  assert.equal(adapter.state.emails[0].verifiedAt !== undefined, true);
  assert.equal(adapter.state.emails[0].encryptionKeyVersion, 7);
  assert.equal(adapter.state.batches[0].status, "reconciled");
  assert.equal(adapter.state.batches[0].sourceCount, 1);
  assert.equal(adapter.state.batches[0].importedCount, 1);
  assert.equal(adapter.state.batches[0].conflictCount, 0);
  const captured = JSON.stringify(result);
  assert.doesNotMatch(captured, new RegExp(rawEmail, "u"));
  assert.doesNotMatch(captured, new RegExp(lookupHash, "u"));
  assert.doesNotMatch(captured, new RegExp(ciphertext, "u"));
  assert.doesNotMatch(captured, /runtime-only-(?:hmac|encryption)-key/u);
  assert.doesNotMatch(captured, /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/u);
});

test("local fixture SQL path binds every entity and batch value", async () => {
  const calls = [];
  const sql = (strings, ...values) => {
    assertParameterizedStatement(strings, values);
    const text = Array.from(strings.raw || strings).join("");
    calls.push({ text, values });
    if (/INSERT INTO auth_migration_batches/iu.test(text)) {
      return Promise.resolve([{
        source: values[0], environment_id: values[1], site_id: values[2],
        snapshot_id: values[3], snapshot_hash: values[4], status: values[5],
        source_count: values[6], imported_count: values[7], conflict_count: values[8],
        freeze_at: values[9], completed_at: values[10]
      }]);
    }
    return Promise.resolve([]);
  };
  const adapter = {
    async withTransaction(callback) {
      return callback(sql);
    }
  };
  await seedLocalTestLegacyFixture({
    env: LOCAL_ENV,
    normalizedEmail: syntheticEmail(),
    profile: { role: "vip", status: "active", guild: "Synthetic", gameName: "Legacy Fixture" },
    adapter,
    crypto: fixtureCrypto()
  });
  assert.equal(calls.length, 7);
  assert.equal(calls.filter(({ text }) => /INSERT INTO auth_migration_batches/iu.test(text)).length, 1);
  const emailInsert = calls.find(({ text }) => /INSERT INTO account_emails/iu.test(text));
  assert.equal(emailInsert.values[3], 7);
});

test("fixture CLI captures only the fixed aggregate output and sanitized errors", async () => {
  const successOut = outputCapture();
  const successErr = outputCapture();
  await runFixtureCli({
    env: LOCAL_ENV,
    stdin: stdinValue(syntheticEmail()),
    adapter: fixtureAdapter(),
    crypto: fixtureCrypto(),
    stdout: successOut.stream,
    stderr: successErr.stream
  });
  assert.equal(successOut.text(), `${JSON.stringify({
    fixture: "created",
    accounts: 1,
    emails: 1,
    legacyIdentities: 1,
    migrationRecords: 1,
    reconciledBatches: 1,
    role: "vip",
    status: "active"
  })}\n`);
  assert.equal(successErr.text(), "");
  assert.doesNotMatch(successOut.text(), /legacy-fixture|synthetic\.test|synthetic-(?:lookup|ciphertext)|runtime-only/iu);

  const failureOut = outputCapture();
  const failureErr = outputCapture();
  await assert.rejects(
    () => runFixtureCli({
      argv: ["--adapter-module", "untrusted.mjs"],
      env: LOCAL_ENV,
      stdin: stdinValue(syntheticEmail()),
      adapter: fixtureAdapter(),
      crypto: fixtureCrypto(),
      stdout: failureOut.stream,
      stderr: failureErr.stream
    }),
    (error) => error.code === "AUTH_LOCAL_FIXTURE_ARGUMENTS_INVALID"
  );
  assert.equal(failureOut.text(), "");
  assert.equal(failureErr.text(), "AUTH_LOCAL_FIXTURE_ARGUMENTS_INVALID\n");
  assert.doesNotMatch(`${failureOut.text()}${failureErr.text()}`, /legacy-fixture|synthetic\.test|synthetic-(?:lookup|ciphertext)|runtime-only/iu);

  const adapterOut = outputCapture();
  const adapterErr = outputCapture();
  const sensitiveErrorCode = "synthetic-ciphertext";
  const failingAdapter = {
    async withTransaction() {
      const error = new Error("sensitive adapter details");
      error.code = sensitiveErrorCode;
      throw error;
    }
  };
  await assert.rejects(
    () => runFixtureCli({
      env: LOCAL_ENV,
      stdin: stdinValue(syntheticEmail()),
      adapter: failingAdapter,
      crypto: fixtureCrypto(),
      stdout: adapterOut.stream,
      stderr: adapterErr.stream
    }),
    (error) => error.code === sensitiveErrorCode
  );
  assert.equal(adapterOut.text(), "");
  assert.equal(adapterErr.text(), "AUTH_LOCAL_FIXTURE_FAILED\n");
  assert.doesNotMatch(`${adapterOut.text()}${adapterErr.text()}`, /legacy-fixture|synthetic\.test|synthetic-(?:lookup|ciphertext)|runtime-only/iu);
});
