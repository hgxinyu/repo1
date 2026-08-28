import test from "node:test";
import assert from "node:assert/strict";
import {
  createAccountRepository,
  createAccount,
  findAccountByLogtoSubject,
  findAccountByLegacyUserId,
  claimLegacyAccountByVerifiedEmail
} from "../../netlify/functions/_shared/auth/account-repository.mjs";

const legacyVipAccountId = "11111111-1111-4111-8111-111111111111";
const secondAccountId = "22222222-2222-4222-8222-222222222222";
const thirdAccountId = "33333333-3333-4333-8333-333333333333";
const subjectLockSeed = 20260825;

function fakeTaggedSql(handler) {
  const calls = [];
  const sql = (strings, ...values) => {
    const parts = Array.from(strings.raw || strings);
    const text = parts.reduce(
      (result, part, index) => `${result}${part}${index < values.length ? "<param>" : ""}`,
      ""
    );
    const call = { text, values };
    calls.push(call);
    return Promise.resolve(handler(call, calls.length - 1));
  };
  sql.calls = calls;
  return sql;
}

function accountRow(overrides = {}) {
  return {
    account_id: legacyVipAccountId,
    role: "vip",
    status: "active",
    guild: "Shine",
    game_name: "Player One",
    authz_version: 7,
    merged_into_account_id: null,
    migration_id: null,
    blocked_at: null,
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:00.000Z",
    ...overrides
  };
}

function migrationBatchRow(overrides = {}) {
  return {
    batch_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    source: "netlify_identity",
    snapshot_id: "snapshot-2026-08-27",
    source_count: 4,
    imported_count: 4,
    conflict_count: 0,
    freeze_at: "2026-08-27T00:00:00.000Z",
    completed_at: "2026-08-27T00:05:00.000Z",
    ...overrides
  };
}

function repositoryFor(sql, overrides = {}) {
  const withTransaction = async (callback) => {
    const transaction = (strings, ...values) => sql(strings, ...values);
    transaction.savepoint = () => {};
    return callback(transaction);
  };
  return createAccountRepository({
    sql,
    withTransaction,
    issuerOrTenant: "tenant-dev",
    emailLookupHash: async (value) => {
      assert.equal(value, "vip@example.com");
      return Buffer.from("hash-for-vip-email");
    },
    ...overrides
  });
}

test("createAccount calls the fixed free-account function and maps its returned row", async () => {
  const sql = fakeTaggedSql((call) => {
    assert.match(call.text, /select \* from public\.create_free_account/i);
    assert.deepEqual(call.values, ["Shine", "Player One"]);
    return [accountRow({ role: "free", status: "active" })];
  });

  const account = await repositoryFor(sql).createAccount({
    role: "free",
    status: "active",
    guild: "Shine",
    gameName: "Player One"
  });

  assert.deepEqual(account, {
    accountId: legacyVipAccountId,
    role: "free",
    status: "active",
    guild: "Shine",
    gameName: "Player One",
    authzVersion: 7,
    mergedIntoAccountId: null,
    migrationId: null,
    blockedAt: null,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z"
  });
  assert.equal("account_id" in account, false);
});

test("direct createAccount accepts injected SQL and transaction dependencies", async () => {
  const sql = fakeTaggedSql(() => [accountRow({ role: "free" })]);
  const transaction = (strings, ...values) => sql(strings, ...values);
  transaction.savepoint = () => {};
  const account = await createAccount(
    { role: "free", status: "active" },
    {
      sql,
      withTransaction: async (callback) => callback(transaction)
    }
  );

  assert.equal(account.accountId, legacyVipAccountId);
  assert.equal(account.role, "free");
});

test("createAccount rejects privileged or blocked state before calling the fixed function", async () => {
  const sql = fakeTaggedSql(() => {
    throw new Error("invalid account state must not reach SQL");
  });
  const repository = repositoryFor(sql);
  for (const input of [
    { role: "admin", status: "active" },
    { role: "free", status: "blocked" },
    { role: "vip", status: "active" }
  ]) {
    await assert.rejects(
      () => repository.createAccount(input),
      (error) => error.code === "AUTH_INPUT_INVALID"
    );
  }
  assert.equal(sql.calls.length, 0);
});

test("createAccountWithLogtoIdentity creates a free account, email lookup, and scoped identity in one transaction", async () => {
  const calls = [];
  const sql = fakeTaggedSql((call) => {
    calls.push(call);
    if (/create_free_account/i.test(call.text)) {
      assert.deepEqual(call.values, [null, null]);
      return [accountRow({ role: "free", authz_version: 1 })];
    }
    if (/insert into account_emails/i.test(call.text)) {
      assert.deepEqual(call.values.slice(0, 5), [
        legacyVipAccountId,
        Buffer.from("email-lookup-hash"),
        Buffer.from("encrypted-email"),
        "1",
        true
      ]);
      assert.ok(call.values[5] instanceof Date);
      return [{ email_id: "email-1" }];
    }
    if (/insert into auth_identities/i.test(call.text)) {
      assert.deepEqual(call.values, [
        legacyVipAccountId,
        "tenant-dev",
        "logto",
        "logto-user-new",
        "sub",
        "logto-user-new"
      ]);
      return [{ account_id: legacyVipAccountId }];
    }
    throw new Error(`unexpected query: ${call.text}`);
  });
  const repository = repositoryFor(sql, {
    emailLookupHash: async (value) => {
      assert.equal(value, "new@example.com");
      return Buffer.from("email-lookup-hash");
    },
    encryptSecret: async (value, options) => {
      assert.equal(value, "new@example.com");
      assert.equal(options.environmentId, "stage");
      assert.equal(options.siteId, "site-dev");
      return Buffer.from("encrypted-email");
    },
    environmentId: "stage",
    siteId: "site-dev",
    keyVersion: 1
  });

  const result = await repository.createAccountWithLogtoIdentity({
    role: "free",
    status: "active",
    normalizedEmail: "new@example.com",
    logtoSubject: "logto-user-new",
    issuerOrTenant: "tenant-dev",
    connectorScope: "logto",
    emailVerified: true
  });

  assert.equal(result.accountId, legacyVipAccountId);
  assert.equal(result.role, "free");
  assert.deepEqual(calls.map(({ text }) => {
    if (/create_free_account/i.test(text)) return "account";
    if (/insert into account_emails/i.test(text)) return "email";
    if (/insert into auth_identities/i.test(text)) return "identity";
    return "other";
  }), ["account", "email", "identity"]);
  assert.equal(calls.some(({ values }) => values.includes("new@example.com")), false);
});

test("createAccountWithLogtoIdentity rejects non-phase-one connectors and privileged account input before SQL", async () => {
  const sql = fakeTaggedSql(() => {
    throw new Error("rejected identity input must not reach SQL");
  });
  const repository = repositoryFor(sql, {
    emailLookupHash: async () => Buffer.from("email-lookup-hash"),
    encryptSecret: async () => Buffer.from("encrypted-email"),
    environmentId: "stage",
    siteId: "site-dev",
    keyVersion: 1
  });
  const base = {
    role: "free",
    status: "active",
    normalizedEmail: "new@example.com",
    logtoSubject: "logto-user-new",
    issuerOrTenant: "tenant-dev",
    connectorScope: "logto",
    emailVerified: true
  };

  for (const input of [
    { connectorScope: "qq" },
    { connectorScope: "google" },
    { connectorScope: "email-otp" },
    { role: "vip" },
    { status: "blocked" }
  ]) {
    await assert.rejects(
      () => repository.createAccountWithLogtoIdentity({ ...base, ...input }),
      (error) => error.code === "AUTH_CONNECTOR_UNAVAILABLE" || error.code === "AUTH_INPUT_INVALID"
    );
  }
  assert.equal(sql.calls.length, 0);
});

test("repository factory rejects a lone SQL adapter instead of mixing the default runner", () => {
  const sql = fakeTaggedSql(() => [accountRow()]);
  assert.throws(
    () => createAccountRepository({ sql, issuerOrTenant: "tenant-dev" }),
    (error) => error.code === "AUTH_REPOSITORY_DEPENDENCY_MISMATCH"
  );
  assert.equal(sql.calls.length, 0);
});

test("VIP request updates only active accounts and never uses a client email", async () => {
  const sql = fakeTaggedSql((call) => {
    if (/request_account_vip/i.test(call.text)) {
      assert.doesNotMatch(call.text, /email/i);
      return [{ account_id: legacyVipAccountId }];
    }
    if (/update accounts/i.test(call.text)) {
      assert.match(call.text, /status\s*=\s*['"]?active/i);
      assert.doesNotMatch(call.text, /role\s*=/i);
      assert.doesNotMatch(call.text, /email/i);
      return [{ account_id: legacyVipAccountId }];
    }
    if (/from accounts/i.test(call.text)) return [accountRow({ role: "pending" })];
    throw new Error(`unexpected SQL: ${call.text}`);
  });
  const repository = repositoryFor(sql, { environmentId: "stage", siteId: "site-dev" });
  const result = await repository.requestVip({
    accountId: legacyVipAccountId,
    guild: "Shine",
    gameName: "Player"
  });
  assert.equal(result.accountId, legacyVipAccountId);
  assert.equal(result.role, "pending");
  assert.equal(sql.calls.length, 3);
});

test("authorization session revocation fails closed when environment/site scope is missing", async () => {
  const sql = fakeTaggedSql((call) => {
    if (/from accounts/i.test(call.text) && /for update/i.test(call.text)) return [accountRow()];
    if (/set_account_authorization/i.test(call.text)) return [{ account_id: legacyVipAccountId }];
    throw new Error(`unexpected SQL after missing deployment scope: ${call.text}`);
  });
  const repository = repositoryFor(sql);
  await assert.rejects(
    () => repository.setAuthorization({
      actorAccountId: thirdAccountId,
      targetAccountId: legacyVipAccountId,
      role: "blocked",
      status: "blocked"
    }),
    (error) => error.code === "AUTH_CONFIG_MISSING:AUTH_ENV_ID" || error.code === "AUTH_CONFIG_MISSING:NETLIFY_SITE_ID"
  );
  assert.equal(sql.calls.some((call) => /update auth_sessions/i.test(call.text)), false);
});

test("authorization account IDs are canonicalized and self-demotion fails closed", async () => {
  const sql = fakeTaggedSql((call) => {
    if (/from accounts/i.test(call.text) && /for update/i.test(call.text)) return [accountRow({ role: "admin" })];
    throw new Error(`self-demotion must be rejected before SQL mutation: ${call.text}`);
  });
  const repository = repositoryFor(sql, { environmentId: "stage", siteId: "site-dev" });
  await assert.rejects(
    () => repository.setAuthorization({
      actorAccountId: legacyVipAccountId.toUpperCase(),
      targetAccountId: legacyVipAccountId.toUpperCase(),
      role: "blocked",
      status: "blocked"
    }),
    (error) => error.code === "CAPABILITY_SELF_MUTATION"
  );
  assert.equal(sql.calls.length, 0);
});

test("authorization session revocation is scoped to the configured environment and site", async () => {
  const sql = fakeTaggedSql((call) => {
    if (/from accounts/i.test(call.text) && /for update/i.test(call.text)) return [accountRow()];
    if (/set_account_authorization/i.test(call.text)) return [{ account_id: legacyVipAccountId }];
    if (/update auth_sessions/i.test(call.text)) {
      assert.match(call.text, /environment_id\s*=\s*<param>/i);
      assert.match(call.text, /site_id\s*=\s*<param>/i);
      assert.match(call.text, /account_id\s*=\s*<param>/i);
      assert.match(call.text, /revoked_at\s+is\s+null/i);
      assert.deepEqual(call.values, ["stage", "site-dev", legacyVipAccountId]);
      return [{ session_id: "session-1" }];
    }
    if (/from accounts/i.test(call.text)) return [accountRow({ role: "blocked", status: "blocked", authz_version: 8 })];
    throw new Error(`unexpected SQL: ${call.text}`);
  });
  const repository = repositoryFor(sql, { environmentId: "stage", siteId: "site-dev" });
  const result = await repository.setAuthorization({
    actorAccountId: thirdAccountId,
    targetAccountId: legacyVipAccountId,
    role: "blocked",
    status: "blocked"
  });
  assert.equal(result.revokedSessionCount, 1);
});

test("repository factory rejects a lone transaction runner instead of mixing the default SQL", () => {
  const withTransaction = async () => {
    throw new Error("must not run");
  };
  assert.throws(
    () => createAccountRepository({ withTransaction, issuerOrTenant: "tenant-dev" }),
    (error) => error.code === "AUTH_REPOSITORY_DEPENDENCY_MISMATCH"
  );
});

test("repository factory uses the default pair only when neither runner is injected", async () => {
  const names = [
    "AUTH_ENV_ID",
    "AUTH_EXPECTED_SITE_ID",
    "NETLIFY_SITE_ID",
    "AUTH_DATABASE_URL",
    "LOGTO_ENDPOINT",
    "LOGTO_APP_ID"
  ];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const repository = createAccountRepository({ issuerOrTenant: "tenant-dev" });
    assert.throws(
      () => repository.createAccount({ role: "free", status: "active" }),
      (error) => String(error.message).startsWith("AUTH_CONFIG_MISSING:AUTH_ENV_ID")
    );
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("findAccountByLogtoSubject returns a sanitized camelCase account", async () => {
  const sql = fakeTaggedSql((call) => {
    assert.match(call.text, /from auth_identities/i);
    assert.match(call.text, /issuer_or_tenant/i);
    assert.match(call.text, /subject_type\s*=\s*'sub'/i);
    assert.match(call.text, /status\s*=\s*'active'/i);
    return [{ ...accountRow(), encrypted_email: "must-not-cross-boundary" }];
  });

  const account = await repositoryFor(sql).findAccountByLogtoSubject("logto-user-1");

  assert.equal(account.accountId, legacyVipAccountId);
  assert.equal(account.authzVersion, 7);
  assert.equal("encrypted_email" in account, false);
  assert.equal("email" in account, false);
});

test("repository canonicalizes a URL issuer before subject lookup", async () => {
  const sql = fakeTaggedSql((call) => {
    assert.equal(call.values[0], "https://tenant.logto.app/");
    return [accountRow()];
  });
  const repository = repositoryFor(sql, { issuerOrTenant: "https://tenant.logto.app" });

  await repository.findAccountByLogtoSubject("logto-user-1");
});

test("findAccountByLegacyUserId resolves through a permanent migration mapping", async () => {
  const sql = fakeTaggedSql((call) => {
    assert.match(call.text, /from migration_records/i);
    assert.match(call.text, /account_id is not null/i);
    return [accountRow({ role: "free" })];
  });

  const account = await repositoryFor(sql).findAccountByLegacyUserId("legacy-user-1");

  assert.deepEqual(account, {
    accountId: legacyVipAccountId,
    role: "free",
    status: "active",
    guild: "Shine",
    gameName: "Player One",
    authzVersion: 7,
    mergedIntoAccountId: null,
    migrationId: null,
    blockedAt: null,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z"
  });
});

test("findMigrationRecordByLegacyUserId returns only a completed netlify mapping bound to its account and DB boundary", async () => {
  const sql = fakeTaggedSql((call) => {
    assert.match(call.text, /from migration_records/i);
    assert.match(call.text, /m\.source\s*=\s*'netlify_identity'/i);
    assert.match(call.text, /m\.status\s+in\s*\('imported',\s*'reconciled'\)/i);
    assert.match(call.text, /m\.account_id\s+is\s+not\s+null/i);
    assert.match(call.text, /a\.migration_id\s*=\s*m\.migration_id/i);
    assert.deepEqual(call.values, ["legacy-user-1"]);
    return [{
      migration_id: "migration-1",
      source: "netlify_identity",
      source_user_id: "legacy-user-1",
      legacy_netlify_user_id: "legacy-user-1",
      account_id: legacyVipAccountId,
      account_migration_id: "migration-1",
      status: "imported",
      freeze_at: "2026-08-25T00:00:00.000Z"
    }];
  });

  const record = await repositoryFor(sql, {
    environmentId: "stage",
    siteId: "site-stage"
  }).findMigrationRecordByLegacyUserId("legacy-user-1");

  assert.deepEqual(record, {
    migrationId: "migration-1",
    source: "netlify_identity",
    sourceUserId: "legacy-user-1",
    legacyNetlifyUserId: "legacy-user-1",
    accountId: legacyVipAccountId,
    status: "imported",
    freezeAt: "2026-08-25T00:00:00.000Z",
    environmentId: "stage",
    siteId: "site-stage"
  });
});

test("findMigrationRecordByLegacyUserId fails closed without a per-record freeze boundary or app boundary", async () => {
  let queries = 0;
  const sql = fakeTaggedSql(() => {
    queries += 1;
    return [{
      migration_id: "migration-1",
      source: "netlify_identity",
      source_user_id: "legacy-user-1",
      legacy_netlify_user_id: "legacy-user-1",
      account_id: legacyVipAccountId,
      account_migration_id: "migration-1",
      status: "reconciled",
      freeze_at: null
    }];
  });

  const missingFreeze = await repositoryFor(sql, {
    environmentId: "stage",
    siteId: "site-stage"
  }).findMigrationRecordByLegacyUserId("legacy-user-1");
  assert.equal(missingFreeze, null);

  const missingBoundary = await repositoryFor(sql, { siteId: "site-stage" })
    .findMigrationRecordByLegacyUserId("legacy-user-1");
  assert.equal(missingBoundary, null);
  assert.equal(queries, 1);
});

test("findReconciledMigrationBatch reads one exact scoped row and returns only a frozen safe shape", async () => {
  const sql = fakeTaggedSql((call) => {
    assert.match(call.text, /from auth_migration_batches/i);
    assert.match(call.text, /source\s*=\s*<param>/i);
    assert.match(call.text, /environment_id\s*=\s*<param>/i);
    assert.match(call.text, /site_id\s*=\s*<param>/i);
    assert.match(call.text, /status\s*=\s*'reconciled'/i);
    assert.deepEqual(call.values, ["netlify_identity", "stage", "site-stage"]);
    return [migrationBatchRow()];
  });
  const batch = await repositoryFor(sql, {
    environmentId: "stage",
    siteId: "site-stage"
  }).findReconciledMigrationBatch({ source: "netlify_identity" });

  assert.deepEqual(batch, {
    batchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    source: "netlify_identity",
    snapshotId: "snapshot-2026-08-27",
    sourceCount: 4,
    importedCount: 4,
    conflictCount: 0,
    freezeAt: "2026-08-27T00:00:00.000Z",
    completedAt: "2026-08-27T00:05:00.000Z"
  });
  assert.equal(Object.isFrozen(batch), true);
  assert.equal("snapshotHash" in batch, false);
  assert.equal("snapshot_hash" in batch, false);
  assert.equal("environmentId" in batch, false);
  assert.equal("siteId" in batch, false);
});

test("findReconciledMigrationBatch returns null when no exact scoped reconciled row exists", async () => {
  const sql = fakeTaggedSql((call) => {
    assert.match(call.text, /status\s*=\s*'reconciled'/i);
    return [];
  });

  const batch = await repositoryFor(sql, {
    environmentId: "stage",
    siteId: "site-stage"
  }).findReconciledMigrationBatch({ source: "netlify_identity" });

  assert.equal(batch, null);
});

test("findReconciledMigrationBatch rejects duplicate or malformed readiness rows as a 409 conflict", async () => {
  const malformedRows = [
    [migrationBatchRow(), migrationBatchRow({ batch_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })],
    [migrationBatchRow({ source_count: "not-a-count" })],
    [migrationBatchRow({ imported_count: 3 })],
    [migrationBatchRow({ conflict_count: 1 })],
    [migrationBatchRow({ freeze_at: "not-a-timestamp" })],
    [migrationBatchRow({ completed_at: null })]
  ];

  for (const rows of malformedRows) {
    const sql = fakeTaggedSql(() => rows);
    await assert.rejects(
      () => repositoryFor(sql, {
        environmentId: "stage",
        siteId: "site-stage"
      }).findReconciledMigrationBatch({ source: "netlify_identity" }),
      (error) => error.code === "AUTH_MIGRATION_BATCH_CONFLICT" && error.status === 409
    );
  }
});

test("findReconciledMigrationBatch ignores caller environment and site overrides", async () => {
  const sql = fakeTaggedSql((call) => {
    assert.deepEqual(call.values, ["netlify_identity", "stage", "site-stage"]);
    return [migrationBatchRow()];
  });

  await repositoryFor(sql, {
    environmentId: "stage",
    siteId: "site-stage"
  }).findReconciledMigrationBatch({
    source: "netlify_identity",
    environmentId: "production",
    siteId: "site-production"
  });
});

test("verified email claim binds one Logto subject to one legacy account", async () => {
  const sql = fakeTaggedSql((call) => {
    if (/from account_emails/i.test(call.text)) {
      return [{ account_id: legacyVipAccountId, verified_at: "2026-08-25T00:00:00.000Z" }];
    }
    if (/from accounts/i.test(call.text)) return [accountRow()];
    if (/pg_advisory_xact_lock/i.test(call.text)) return [];
    if (/from auth_identities/i.test(call.text)) return [];
    if (/insert into auth_identities/i.test(call.text)) return [{ account_id: legacyVipAccountId }];
    throw new Error(`unexpected query: ${call.text}`);
  });

  const result = await repositoryFor(sql).claimLegacyAccountByVerifiedEmail({
    logtoSubject: "logto-user-1",
    issuerOrTenant: "tenant-dev",
    connectorScope: "email-otp",
    normalizedEmail: "vip@example.com"
  });

  assert.deepEqual(result, { kind: "claimed", accountId: legacyVipAccountId });
  assert.equal(sql.calls[0].values[0].toString(), "hash-for-vip-email");
  assert.match(sql.calls[0].text, /for update/i);
  assert.match(sql.calls[1].text, /from accounts/i);
  assert.match(sql.calls[1].text, /for update/i);
  assert.match(sql.calls[2].text, /pg_advisory_xact_lock/i);
  assert.deepEqual(sql.calls[2].values, ["tenant-dev", "logto-user-1", subjectLockSeed]);
  assert.match(sql.calls[3].text, /from auth_identities/i);
  assert.match(sql.calls[3].text, /for update/i);
  assert.deepEqual(sql.calls[1].values, [legacyVipAccountId]);
  assert.deepEqual(sql.calls[3].values, ["tenant-dev", "logto-user-1"]);
  const insert = sql.calls.find(({ text }) => /insert into auth_identities/i.test(text));
  assert.deepEqual(insert.values, [
    legacyVipAccountId,
    "tenant-dev",
    "email-otp",
    "logto-user-1",
    "sub"
  ]);
  assert.equal(sql.calls.some(({ text }) => /insert into auth_identities/i.test(text)), true);
  assert.equal(sql.calls.some(({ values }) => values.includes("vip@example.com")), false);
});

test("claim serializes an issuer subject before reading or inserting identities", async () => {
  let lockIndex = -1;
  let identityIndex = -1;
  const sql = fakeTaggedSql((call) => {
    const index = sql.calls.indexOf(call);
    if (/from account_emails/i.test(call.text)) return [{ account_id: legacyVipAccountId, verified_at: "now" }];
    if (/from accounts/i.test(call.text)) return [accountRow()];
    if (/pg_advisory_xact_lock/i.test(call.text)) {
      lockIndex = index;
      assert.match(call.text, /hashtextextended/i);
      assert.match(call.text, /chr\(31\)/i);
      assert.deepEqual(call.values, ["tenant-dev", "logto-user-1", subjectLockSeed]);
      return [];
    }
    if (/from auth_identities/i.test(call.text)) {
      identityIndex = index;
      assert.match(call.text, /issuer_or_tenant/i);
      assert.match(call.text, /provider_subject/i);
      assert.match(call.text, /subject_type\s*=\s*'sub'/i);
      assert.match(call.text, /status\s*=\s*'active'/i);
      assert.match(call.text, /for update/i);
      assert.deepEqual(call.values, ["tenant-dev", "logto-user-1"]);
      return [];
    }
    if (/insert into auth_identities/i.test(call.text)) return [{ account_id: legacyVipAccountId }];
    throw new Error(`unexpected query: ${call.text}`);
  });

  const result = await repositoryFor(sql).claimLegacyAccountByVerifiedEmail({
    logtoSubject: "logto-user-1",
    issuerOrTenant: "tenant-dev",
    connectorScope: "email-otp",
    normalizedEmail: "vip@example.com"
  });

  assert.deepEqual(result, { kind: "claimed", accountId: legacyVipAccountId });
  assert.ok(lockIndex >= 0, "subject advisory lock must run");
  assert.ok(identityIndex > lockIndex, "identity query must follow subject advisory lock");
});

test("missing verified email returns new_account without creating an identity", async () => {
  const sql = fakeTaggedSql((call) => {
    assert.match(call.text, /from account_emails/i);
    return [];
  });

  const result = await repositoryFor(sql).claimLegacyAccountByVerifiedEmail({
    logtoSubject: "logto-user-1",
    issuerOrTenant: "tenant-dev",
    connectorScope: "email-otp",
    normalizedEmail: "vip@example.com"
  });

  assert.deepEqual(result, { kind: "new_account" });
  assert.equal(sql.calls.length, 1);
});

test("a matching active email row without verified_at conflicts instead of creating a new account", async () => {
  const sql = fakeTaggedSql((call) => {
    if (/from account_emails/i.test(call.text)) {
      return [{ account_id: legacyVipAccountId, verified_at: null }];
    }
    throw new Error(`unexpected write/read after unverified match: ${call.text}`);
  });

  await assert.rejects(
    () => repositoryFor(sql).claimLegacyAccountByVerifiedEmail({
      logtoSubject: "logto-user-unverified",
      issuerOrTenant: "tenant-dev",
      connectorScope: "email-otp",
      normalizedEmail: "vip@example.com"
    }),
    (error) => error.code === "ACCOUNT_CLAIM_CONFLICT" && error.status === 409
  );
  assert.equal(sql.calls.length, 1);
});

test("a different-account identity on another connector still fails closed", async () => {
  const sql = fakeTaggedSql((call) => {
    if (/from account_emails/i.test(call.text)) return [{ account_id: legacyVipAccountId, verified_at: "now" }];
    if (/from accounts/i.test(call.text)) return [accountRow()];
    if (/pg_advisory_xact_lock/i.test(call.text)) return [];
    if (/from auth_identities/i.test(call.text)) {
      return [{
        account_id: secondAccountId,
        issuer_or_tenant: "tenant-dev",
        connector_scope: "google",
        provider_subject: "logto-user-1",
        subject_type: "sub",
        status: "active",
        revoked_at: null
      }];
    }
    if (/insert into auth_identities/i.test(call.text)) {
      throw new Error("insert must not run after a collision");
    }
    throw new Error(`unexpected query: ${call.text}`);
  });

  await assert.rejects(
    () => repositoryFor(sql).claimLegacyAccountByVerifiedEmail({
      logtoSubject: "logto-user-1",
      issuerOrTenant: "tenant-dev",
      connectorScope: "email-otp",
      normalizedEmail: "vip@example.com"
    }),
    (error) => error.code === "ACCOUNT_CLAIM_CONFLICT" && error.name === "AuthError"
  );
  assert.equal(sql.calls.some(({ text }) => /insert into auth_identities/i.test(text)), false);
});

test("claiming an already linked subject is idempotent and does not duplicate the identity", async () => {
  const sql = fakeTaggedSql((call) => {
    if (/from account_emails/i.test(call.text)) return [{ account_id: legacyVipAccountId, verified_at: "now" }];
    if (/from accounts/i.test(call.text)) return [accountRow()];
    if (/pg_advisory_xact_lock/i.test(call.text)) return [];
    if (/from auth_identities/i.test(call.text)) {
      return [{
        account_id: legacyVipAccountId,
        issuer_or_tenant: "tenant-dev",
        connector_scope: "email-otp",
        provider_subject: "logto-user-1",
        subject_type: "sub",
        status: "active",
        revoked_at: null
      }];
    }
    if (/insert into auth_identities/i.test(call.text)) {
      throw new Error("idempotent claim must not insert a duplicate");
    }
    throw new Error(`unexpected query: ${call.text}`);
  });

  const result = await repositoryFor(sql).claimLegacyAccountByVerifiedEmail({
    logtoSubject: "logto-user-1",
    issuerOrTenant: "tenant-dev",
    connectorScope: "email-otp",
    normalizedEmail: "vip@example.com"
  });

  assert.deepEqual(result, { kind: "claimed", accountId: legacyVipAccountId });
});

test("the same Logto subject on another connector still claims the requested scope", async () => {
  let insertCount = 0;
  const sql = fakeTaggedSql((call) => {
    if (/from account_emails/i.test(call.text)) return [{ account_id: legacyVipAccountId, verified_at: "now" }];
    if (/from accounts/i.test(call.text)) return [accountRow()];
    if (/pg_advisory_xact_lock/i.test(call.text)) return [];
    if (/from auth_identities/i.test(call.text)) {
      return [{
        account_id: legacyVipAccountId,
        issuer_or_tenant: "tenant-dev",
        connector_scope: "google",
        provider_subject: "logto-user-1",
        subject_type: "sub",
        status: "active",
        revoked_at: null
      }];
    }
    if (/insert into auth_identities/i.test(call.text)) {
      insertCount += 1;
      assert.deepEqual(call.values, [
        legacyVipAccountId,
        "tenant-dev",
        "email-otp",
        "logto-user-1",
        "sub"
      ]);
      return [{ account_id: legacyVipAccountId }];
    }
    throw new Error(`unexpected query: ${call.text}`);
  });

  const result = await repositoryFor(sql).claimLegacyAccountByVerifiedEmail({
    logtoSubject: "logto-user-1",
    issuerOrTenant: "tenant-dev",
    connectorScope: "email-otp",
    normalizedEmail: "vip@example.com"
  });

  assert.deepEqual(result, { kind: "claimed", accountId: legacyVipAccountId });
  assert.equal(insertCount, 1);
});

test("direct claim operation accepts an explicitly injected email lookup hash", async () => {
  const sql = fakeTaggedSql((call) => {
    assert.match(call.text, /from account_emails/i);
    assert.equal(call.values[0], "injected-hash");
    return [];
  });
  const transaction = (strings, ...values) => sql(strings, ...values);
  transaction.savepoint = () => {};

  const result = await claimLegacyAccountByVerifiedEmail(
    transaction,
    {
      logtoSubject: "logto-user-1",
      issuerOrTenant: "tenant-dev",
      connectorScope: "email-otp",
      normalizedEmail: "vip@example.com"
    },
    { emailLookupHash: () => "injected-hash", issuerOrTenant: "tenant-dev" }
  );

  assert.deepEqual(result, { kind: "new_account" });
});

test("direct repository lookups accept an explicitly injected SQL adapter", async () => {
  const sql = fakeTaggedSql(() => [accountRow()]);

  const account = await findAccountByLogtoSubject("logto-user-1", {
    sql,
    issuerOrTenant: "tenant-dev"
  });
  const legacy = await findAccountByLegacyUserId("legacy-user-1", { sql });

  assert.equal(account.accountId, legacyVipAccountId);
  assert.equal(legacy.accountId, legacyVipAccountId);
});

test("repository returns null when a subject lookup is ambiguous", async () => {
  const sql = fakeTaggedSql(() => [accountRow(), accountRow({ account_id: secondAccountId })]);

  assert.equal(await findAccountByLogtoSubject("logto-user-1", {
    sql,
    issuerOrTenant: "tenant-dev"
  }), null);
});

test("an empty scoped identity insert reads its owner before returning idempotent success", async () => {
  let insertAttempted = false;
  const sql = fakeTaggedSql((call) => {
    if (/from account_emails/i.test(call.text)) return [{ account_id: legacyVipAccountId, verified_at: "now" }];
    if (/from accounts/i.test(call.text)) return [accountRow()];
    if (/pg_advisory_xact_lock/i.test(call.text)) return [];
    if (/insert into auth_identities/i.test(call.text)) {
      insertAttempted = true;
      assert.match(call.text, /on conflict\s*\(\s*issuer_or_tenant\s*,\s*connector_scope\s*,\s*provider_subject\s*\)/i);
      assert.match(call.text, /returning\s+account_id/i);
      return [];
    }
    if (/from auth_identities/i.test(call.text)) {
      return insertAttempted
        ? [{
          account_id: legacyVipAccountId,
          issuer_or_tenant: "tenant-dev",
          connector_scope: "email-otp",
          provider_subject: "logto-user-1",
          subject_type: "sub",
          status: "active",
          revoked_at: null
        }]
        : [];
    }
    throw new Error(`unexpected query: ${call.text}`);
  });

  const result = await repositoryFor(sql).claimLegacyAccountByVerifiedEmail({
    logtoSubject: "logto-user-1",
    issuerOrTenant: "tenant-dev",
    connectorScope: "email-otp",
    normalizedEmail: "vip@example.com"
  });

  assert.deepEqual(result, { kind: "claimed", accountId: legacyVipAccountId });
  const ownerQuery = sql.calls.filter(({ text }) => /from auth_identities/i.test(text)).at(-1);
  assert.match(ownerQuery.text, /account_id =/i);
  assert.match(ownerQuery.text, /for update/i);
  assert.deepEqual(ownerQuery.values, [
    legacyVipAccountId,
    "tenant-dev",
    "email-otp",
    "logto-user-1"
  ]);
});

test("an empty scoped identity insert owned by another account fails closed", async () => {
  let insertAttempted = false;
  const sql = fakeTaggedSql((call) => {
    if (/from account_emails/i.test(call.text)) return [{ account_id: legacyVipAccountId, verified_at: "now" }];
    if (/from accounts/i.test(call.text)) return [accountRow()];
    if (/pg_advisory_xact_lock/i.test(call.text)) return [];
    if (/insert into auth_identities/i.test(call.text)) {
      insertAttempted = true;
      return [];
    }
    if (/from auth_identities/i.test(call.text)) {
      return insertAttempted
        ? [{
          account_id: secondAccountId,
          issuer_or_tenant: "tenant-dev",
          connector_scope: "email-otp",
          provider_subject: "logto-user-1",
          subject_type: "sub",
          status: "active",
          revoked_at: null
        }]
        : [];
    }
    throw new Error(`unexpected query: ${call.text}`);
  });

  await assert.rejects(
    () => repositoryFor(sql).claimLegacyAccountByVerifiedEmail({
      logtoSubject: "logto-user-1",
      issuerOrTenant: "tenant-dev",
      connectorScope: "email-otp",
      normalizedEmail: "vip@example.com"
    }),
    (error) => error.code === "ACCOUNT_CLAIM_CONFLICT"
  );
});

test("an empty scoped identity insert with no owner fails closed", async () => {
  const sql = fakeTaggedSql((call) => {
    if (/from account_emails/i.test(call.text)) return [{ account_id: legacyVipAccountId, verified_at: "now" }];
    if (/from accounts/i.test(call.text)) return [accountRow()];
    if (/pg_advisory_xact_lock/i.test(call.text)) return [];
    if (/from auth_identities/i.test(call.text)) return [];
    if (/insert into auth_identities/i.test(call.text)) return [];
    throw new Error(`unexpected query: ${call.text}`);
  });

  await assert.rejects(
    () => repositoryFor(sql).claimLegacyAccountByVerifiedEmail({
      logtoSubject: "logto-user-1",
      issuerOrTenant: "tenant-dev",
      connectorScope: "email-otp",
      normalizedEmail: "vip@example.com"
    }),
    (error) => error.code === "ACCOUNT_CLAIM_CONFLICT"
  );
});

test("a transaction-level claim helper rejects a root SQL adapter", async () => {
  const sql = fakeTaggedSql(() => []);
  sql.begin = async () => {
    throw new Error("root adapter must not be used as a transaction");
  };

  await assert.rejects(
    () => claimLegacyAccountByVerifiedEmail(
      sql,
      {
        logtoSubject: "logto-user-1",
        issuerOrTenant: "tenant-dev",
        connectorScope: "email-otp",
        normalizedEmail: "vip@example.com"
      },
      { emailLookupHash: () => "hash-for-vip-email", issuerOrTenant: "tenant-dev" }
    ),
    (error) => error.code === "TRANSACTION_REQUIRED"
  );
});

test("transaction helper does not accept a synthetic marker in place of postgres savepoint", async () => {
  const transaction = fakeTaggedSql(() => []);
  transaction.__authTransaction = true;

  await assert.rejects(
    () => claimLegacyAccountByVerifiedEmail(
      transaction,
      {
        logtoSubject: "logto-user-1",
        issuerOrTenant: "tenant-dev",
        connectorScope: "email-otp",
        normalizedEmail: "vip@example.com"
      },
      { emailLookupHash: () => "hash-for-vip-email", issuerOrTenant: "tenant-dev" }
    ),
    (error) => error.code === "TRANSACTION_REQUIRED"
  );
});

test("a claim with duplicate active email rows fails closed before identity insert", async () => {
  const sql = fakeTaggedSql((call) => {
    if (/from account_emails/i.test(call.text)) {
      return [
        { account_id: legacyVipAccountId, verified_at: "now" },
        { account_id: secondAccountId, verified_at: "now" }
      ];
    }
    if (/insert into auth_identities/i.test(call.text)) {
      throw new Error("duplicate email rows must not insert identity");
    }
    return [];
  });

  await assert.rejects(
    () => repositoryFor(sql).claimLegacyAccountByVerifiedEmail({
      logtoSubject: "logto-user-1",
      issuerOrTenant: "tenant-dev",
      connectorScope: "email-otp",
      normalizedEmail: "vip@example.com"
    }),
    (error) => error.code === "ACCOUNT_CLAIM_CONFLICT"
  );
});

test("a claim with duplicate account lock rows fails closed", async () => {
  const sql = fakeTaggedSql((call) => {
    if (/from account_emails/i.test(call.text)) return [{ account_id: legacyVipAccountId, verified_at: "now" }];
    if (/from accounts/i.test(call.text)) return [accountRow(), accountRow({ account_id: thirdAccountId })];
    if (/insert into auth_identities/i.test(call.text)) {
      throw new Error("duplicate account rows must not insert identity");
    }
    return [];
  });

  await assert.rejects(
    () => repositoryFor(sql).claimLegacyAccountByVerifiedEmail({
      logtoSubject: "logto-user-1",
      issuerOrTenant: "tenant-dev",
      connectorScope: "email-otp",
      normalizedEmail: "vip@example.com"
    }),
    (error) => error.code === "ACCOUNT_CLAIM_CONFLICT"
  );
});

test("claim account lock selects only an active permanent account", async () => {
  let accountQuerySeen = false;
  const sql = fakeTaggedSql((call) => {
    if (/from account_emails/i.test(call.text)) return [{ account_id: legacyVipAccountId, verified_at: "now" }];
    if (/from accounts/i.test(call.text)) {
      accountQuerySeen = true;
      assert.match(call.text, /status = 'active'/i);
      return [accountRow()];
    }
    return [];
  });

  await assert.rejects(
    () => repositoryFor(sql).claimLegacyAccountByVerifiedEmail({
      logtoSubject: "logto-user-1",
      issuerOrTenant: "tenant-dev",
      connectorScope: "email-otp",
      normalizedEmail: "vip@example.com"
    }),
    (error) => error.code === "ACCOUNT_CLAIM_CONFLICT"
  );
  assert.equal(accountQuerySeen, true);
});

test("pending identity rows are never treated as an existing claimed subject", async () => {
  let identitySelects = 0;
  const sql = fakeTaggedSql((call) => {
    if (/from account_emails/i.test(call.text)) return [{ account_id: legacyVipAccountId, verified_at: "now" }];
    if (/from accounts/i.test(call.text)) return [accountRow()];
    if (/pg_advisory_xact_lock/i.test(call.text)) return [];
    if (/from auth_identities/i.test(call.text)) {
      identitySelects += 1;
      assert.match(call.text, /status = 'active'/i);
      assert.match(call.text, /subject_type = 'sub'/i);
      if (identitySelects === 1) {
        return [{
          account_id: legacyVipAccountId,
          issuer_or_tenant: "tenant-dev",
          connector_scope: "email-otp",
          provider_subject: "logto-user-1",
          subject_type: "sub",
          status: "pending",
          revoked_at: null
        }];
      }
      return [];
    }
    if (/insert into auth_identities/i.test(call.text)) {
      assert.match(call.text, /returning account_id/i);
      return [];
    }
    throw new Error(`unexpected query: ${call.text}`);
  });

  await assert.rejects(
    () => repositoryFor(sql).claimLegacyAccountByVerifiedEmail({
      logtoSubject: "logto-user-1",
      issuerOrTenant: "tenant-dev",
      connectorScope: "email-otp",
      normalizedEmail: "vip@example.com"
    }),
    (error) => error.code === "ACCOUNT_CLAIM_CONFLICT"
  );
  assert.equal(identitySelects, 1);
  assert.equal(sql.calls.some(({ text }) => /insert into auth_identities/i.test(text)), false);
});

test("legacy lookup fails closed when one legacy ID maps to multiple rows", async () => {
  const sql = fakeTaggedSql((call) => {
    assert.match(call.text, /from migration_records/i);
    return [accountRow(), accountRow()];
  });

  assert.equal(await findAccountByLegacyUserId("legacy-user-1", { sql }), null);
});

test("Logto lookup ignores connector scope and rejects non-sub or inactive rows", async () => {
  const sql = fakeTaggedSql((call) => {
    assert.doesNotMatch(call.text, /connector_scope\s*=/i);
    assert.match(call.text, /subject_type\s*=\s*'sub'/i);
    assert.match(call.text, /status\s*=\s*'active'/i);
    return [];
  });

  assert.equal(await repositoryFor(sql).findAccountByLogtoSubject("logto-user-1"), null);
});

test("same Logto subject across connectors resolves only when every active sub row belongs to one account", async () => {
  const sql = fakeTaggedSql(() => [
    { ...accountRow(), connector_scope: "email-otp" },
    { ...accountRow(), connector_scope: "google" }
  ]);
  const account = await repositoryFor(sql).findAccountByLogtoSubject("logto-user-1");
  assert.equal(account.accountId, legacyVipAccountId);

  const collisionSql = fakeTaggedSql(() => [
    { ...accountRow(), connector_scope: "email-otp" },
    { ...accountRow({ account_id: secondAccountId }), connector_scope: "google" }
  ]);
  assert.equal(await repositoryFor(collisionSql).findAccountByLogtoSubject("logto-user-1"), null);
});
