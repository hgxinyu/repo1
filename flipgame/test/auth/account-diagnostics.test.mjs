import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, connectionUrl, collectReport, safeError, readEmail, clientOptions, SITE_ID
} from '../../../scripts/account-diagnostics.mjs';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const cli = fileURLToPath(new URL('../../../scripts/account-diagnostics.mjs', import.meta.url));

function database(respond) {
  const calls = [];
  return {
    calls,
    async begin(mode, callback) {
      assert.equal(mode, 'read only');
      return callback(async (strings, ...values) => {
        const statement = strings.join('?').replace(/\s+/g, ' ').trim();
        assert.match(statement, /^SELECT /);
        calls.push({ statement, values });
        if (statement.includes("current_setting('transaction_read_only')")) return [{ read_only: 'on' }];
        if (statement.includes('FROM auth_migration_batches')) return [{ environment_id: 'production', site_id: SITE_ID, status: 'reconciled' }];
        return respond(statement, values);
      });
    }
  };
}

test('diagnostics require an explicit environment and one unambiguous selector', () => {
  for (const args of [[], ['--summary'], ['--neon-production'],
    ['--neon-production','--summary','--account-id',ID],
    ['--neon-production','--environment','local-test','--summary'],
    ['--neon-production','--account-id',"'; DELETE FROM accounts; --"],
    ['--neon-production','--summary','--sql','SELECT 1']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.equal(parseArgs(['--neon-production','--summary']).environment, 'production');
});

test('invalid input exits without emitting private input or attempting connection', () => {
  const marker = 'PRIVATE_VALUE_DO_NOT_PRINT';
  const result = spawnSync(process.execPath, [cli,'--neon-production','--account-id',marker], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'INVALID_ID');
  assert.ok(!result.stderr.includes(marker));
});

test('email stdin is bounded, normalized, and cannot contain multiple addresses', async () => {
  assert.equal(await readEmail(Readable.from([' Sample@Example.COM\n'])), 'sample@example.com');
  await assert.rejects(readEmail(Readable.from(['a@b.com\nc@d.com'])));
  await assert.rejects(readEmail(Readable.from(['a'.repeat(321)])));
});

test('missing email key stops before starting Neon CLI', () => {
  const env = { ...process.env };
  delete env.AUTH_DIAGNOSTIC_HMAC_KEY;
  const result = spawnSync(process.execPath, [cli,'--neon-production','--email-stdin'], {
    env, input: 'someone@example.com', encoding: 'utf8'
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, 'EMAIL_LOOKUP_KEY_REQUIRED');
  assert.ok(!result.stderr.includes('someone@example.com'));
});

test('connection failures redact captured CLI output and do not install tools', () => {
  const secret = 'postgresql://owner:private-password@example.test/db';
  let called = false;
  assert.throws(() => connectionUrl({ neonProduction: true }, {}, (cmd, args, opts) => {
    called = true;
    assert.equal(cmd, 'npx');
    assert.equal(args[0], '--offline');
    assert.deepEqual(opts.stdio, ['ignore','pipe','pipe']);
    throw Object.assign(new Error(secret), { stdout: secret, stderr: secret });
  }), { code: 'NEON_CONNECTION_UNAVAILABLE' });
  assert.ok(called);
  assert.ok(!JSON.stringify(safeError(new Error(secret))).includes(secret));
  assert.throws(() => connectionUrl({ neonProduction: true }, { AUTH_DIAGNOSTIC_DATABASE_URL: secret }), { code: 'AMBIGUOUS_CONNECTION' });
});

test('both connection defaults and transaction enforce read-only execution', async () => {
  assert.equal(clientOptions().connection.default_transaction_read_only, 'on');
  let count = 0;
  await assert.rejects(collectReport({ begin: async (mode, cb) => {
    assert.equal(mode, 'read only');
    return cb(async () => { count++; return [{ read_only: 'off' }]; });
  } }, { environment: 'production', summary: true }), { code: 'READ_ONLY_REQUIRED' });
  assert.equal(count, 1);
});

test('unverified database scope prevents any account query', async () => {
  let count = 0;
  await assert.rejects(collectReport({ begin: async (_, cb) => cb(async () => {
    count++;
    return count === 1 ? [{ read_only: 'on' }] : [];
  }) }, { environment: 'production', summary: true }), { code: 'ENVIRONMENT_NOT_VERIFIED' });
  assert.equal(count, 2);
});

test('legacy ID resolves permanent account, preserves identity absence and scopes sessions', async () => {
  const db = database((statement, values) => {
    if (statement.includes('SELECT DISTINCT account_id')) {
      assert.equal(values[0], ID);
      return [{ account_id: ID }];
    }
    if (statement.includes('FROM accounts WHERE')) return [{ account_id: ID, role: 'vip', status: 'active', guild: 'Fixture guild', game_name: 'Fixture hero' }];
    if (statement.includes('FROM auth_identities')) return [{ connector_scope: 'legacy', status: 'active' }];
    if (statement.includes('FROM auth_sessions')) {
      assert.deepEqual(values, [ID, 'production', SITE_ID]);
      return [];
    }
    return [];
  });
  const report = await collectReport(db, { environment: 'production', legacyUserId: ID });
  assert.equal(report.matches, 1);
  assert.equal(report.accounts[0].role, 'vip');
  assert.equal(report.accounts[0].hasProfile, true);
  assert.deepEqual(report.accounts[0].sessions, []);
  assert.equal(report.accounts[0].identities[0].connector_scope, 'legacy');
  assert.ok(db.calls.every(c => !c.statement.includes(ID)));
  assert.ok(db.calls.every(c => !/encrypted_email|refresh_token|session_id_hash|provider_subject/.test(c.statement)));
});

test('email lookup reports unresolved legacy import even without an account match', async () => {
  const hash = Buffer.alloc(32, 7);
  const db = database((statement, values) => {
    if (statement.includes('UNION')) { assert.deepEqual(values, [hash, hash]); return []; }
    if (statement.includes('account_id IS NULL')) return [{ source: 'netlify_identity', status: 'conflict', error_code: 'FIXTURE_CONFLICT' }];
    throw new Error('unexpected account read');
  });
  const report = await collectReport(db, { environment: 'production', emailStdin: true }, hash);
  assert.equal(report.matches, 0);
  assert.equal(report.unresolvedMigrations[0].status, 'conflict');
});

test('summary reads aggregates without listing accounts or identities', async () => {
  const db = database(statement => {
    assert.match(statement, /count\(\*\)::int AS count FROM accounts GROUP BY/);
    return [{ role: 'free', has_profile: false, imported: false, count: 3 }];
  });
  const report = await collectReport(db, { environment: 'production', summary: true });
  assert.equal(report.groups[0].count, 3);
  assert.equal(report.accounts, undefined);
  assert.equal(db.calls.length, 3);
});
