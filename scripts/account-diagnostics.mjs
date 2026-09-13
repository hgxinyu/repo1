#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { emailLookupHash } from '../flipgame/netlify/functions/_shared/auth/crypto.mjs';

export const SITE_ID = '34bfd812-74b4-4f9c-ac20-97ab0cefe996';
const PROJECT_ID = 'purple-cloud-20898732';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HELP = `Read-only ShineGame account diagnostics

node scripts/account-diagnostics.mjs --neon-production --summary
node scripts/account-diagnostics.mjs --neon-production --account-id <UUID>
node scripts/account-diagnostics.mjs --neon-production --legacy-user-id <UUID>
node scripts/account-diagnostics.mjs --neon-production --email-stdin

Alternatively use AUTH_DIAGNOSTIC_DATABASE_URL with --environment production|local-test.
Email lookup also requires AUTH_DIAGNOSTIC_HMAC_KEY; no email decryption is performed.
Use exactly one selector. No arbitrary SQL, writes, config changes or login attempts.
`;

function fail(code) { throw Object.assign(new Error(code), { code }); }

export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const out = {};
  const flags = new Map([
    ['--neon-production', 'neonProduction'], ['--summary', 'summary'],
    ['--email-stdin', 'emailStdin'], ['--account-id', 'accountId'],
    ['--legacy-user-id', 'legacyUserId'], ['--environment', 'environment']
  ]);
  for (let i = 0; i < args.length; i++) {
    const key = flags.get(args[i]);
    if (!key || Object.hasOwn(out, key)) fail('INVALID_ARGUMENTS');
    if (['neonProduction', 'summary', 'emailStdin'].includes(key)) out[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail('INVALID_ARGUMENTS');
      out[key] = value;
    }
  }
  if (['summary', 'emailStdin', 'accountId', 'legacyUserId'].filter(k => out[k]).length !== 1) {
    fail('ONE_SELECTOR_REQUIRED');
  }
  if ((out.accountId && !UUID.test(out.accountId)) ||
      (out.legacyUserId && !UUID.test(out.legacyUserId))) fail('INVALID_ID');
  if (out.neonProduction && out.environment && out.environment !== 'production') fail('ENVIRONMENT_MISMATCH');
  if (out.neonProduction) out.environment = 'production';
  if (!['production', 'local-test'].includes(out.environment)) fail('ENVIRONMENT_REQUIRED');
  return out;
}

export async function readEmail(stream) {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk.toString('utf8');
    if (Buffer.byteLength(buffer) > 320) fail('INVALID_EMAIL');
  }
  const email = buffer.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('INVALID_EMAIL');
  return email;
}

export function connectionUrl(options, env, run = execFileSync) {
  let uri = env.AUTH_DIAGNOSTIC_DATABASE_URL;
  if (options.neonProduction) {
    if (uri) fail('AMBIGUOUS_CONNECTION');
    // Capture the CLI output in memory. Never inherit stdout or print exception objects.
    try {
      uri = run('npx', ['--offline', 'neonctl', 'connection-string', 'production',
        '--project-id', PROJECT_ID, '--role-name', 'neondb_owner', '--database-name', 'neondb'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 128 * 1024 });
    } catch { fail('NEON_CONNECTION_UNAVAILABLE'); }
  }
  if (!uri) fail('DATABASE_CONNECTION_REQUIRED');
  uri = uri.trim().replace(/^['"]|['"]$/g, '');
  let parsed;
  try { parsed = new URL(uri); } catch { fail('INVALID_DATABASE_CONNECTION'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) fail('INVALID_DATABASE_CONNECTION');
  return uri;
}

export function clientOptions() {
  return { max: 1, connect_timeout: 12, idle_timeout: 3, onnotice: () => {},
    connection: { default_transaction_read_only: 'on', statement_timeout: 10000 } };
}

export async function collectReport(sql, options, lookupHash) {
  return sql.begin('read only', async tx => {
    const [mode] = await tx`SELECT current_setting('transaction_read_only') AS read_only`;
    if (mode?.read_only !== 'on') fail('READ_ONLY_REQUIRED');
    const batches = await tx`SELECT source, environment_id, site_id, status,
      source_count, imported_count, conflict_count, completed_at
      FROM auth_migration_batches WHERE environment_id=${options.environment} AND site_id=${SITE_ID}`;
    if (!batches.length) fail('ENVIRONMENT_NOT_VERIFIED');
    const report = { checkedAt: new Date().toISOString(), environment: options.environment,
      siteId: SITE_ID, readOnly: true, migrations: batches };
    if (options.summary) {
      report.groups = await tx`SELECT role, status, migration_id IS NOT NULL AS imported,
        COALESCE(btrim(guild),'')<>'' AND COALESCE(btrim(game_name),'')<>'' AS has_profile,
        count(*)::int AS count FROM accounts GROUP BY 1,2,3,4 ORDER BY 1,3,4`;
      return report;
    }
    let ids;
    if (options.accountId) ids = [{ account_id: options.accountId }];
    else if (options.legacyUserId) ids = await tx`SELECT DISTINCT account_id FROM migration_records
      WHERE legacy_netlify_user_id=${options.legacyUserId} AND account_id IS NOT NULL`;
    else {
      if (!Buffer.isBuffer(lookupHash) || lookupHash.length !== 32) fail('EMAIL_LOOKUP_KEY_REQUIRED');
      // Include removed emails and unresolved migration rows; absence in active emails alone
      // is not evidence that the legacy account never existed.
      ids = await tx`SELECT account_id FROM account_emails WHERE email_lookup_hash=${lookupHash}
        UNION SELECT account_id FROM migration_records
        WHERE legacy_email_lookup_hash=${lookupHash} AND account_id IS NOT NULL`;
      report.unresolvedMigrations = await tx`SELECT source,status,error_code,created_at,completed_at
        FROM migration_records WHERE legacy_email_lookup_hash=${lookupHash} AND account_id IS NULL`;
    }
    if (ids.length > 10) fail('TOO_MANY_MATCHES');
    report.accounts = [];
    for (const { account_id: id } of ids) {
      const [account] = await tx`SELECT account_id,role,status,guild,game_name,created_at,updated_at,
        blocked_at,merged_into_account_id,migration_id IS NOT NULL AS imported FROM accounts WHERE account_id=${id}`;
      if (!account) continue;
      const emails = await tx`SELECT is_primary,verified_at,removed_at,created_at
        FROM account_emails WHERE account_id=${id} ORDER BY created_at`;
      const identities = await tx`SELECT connector_scope,status,created_at,updated_at,revoked_at
        FROM auth_identities WHERE account_id=${id} ORDER BY created_at`;
      const sessions = await tx`SELECT auth_source,count(*)::int AS count,max(issued_at) AS last_issued_at,
        max(last_seen_at) AS last_seen_at,
        count(*) FILTER (WHERE revoked_at IS NULL AND idle_expires_at>now() AND absolute_expires_at>now())::int AS active_sessions
        FROM auth_sessions WHERE account_id=${id} AND environment_id=${options.environment} AND site_id=${SITE_ID}
        GROUP BY auth_source`;
      const migration = await tx`SELECT source,status,error_code,created_at,completed_at
        FROM migration_records WHERE account_id=${id}`;
      const changes = await tx`SELECT old_role,new_role,old_status,new_status,changed_at,
        metadata->>'operation' AS operation,actor_account_id=target_account_id AS self_change
        FROM account_authorization_audit WHERE target_account_id=${id} ORDER BY changed_at DESC LIMIT 20`;
      report.accounts.push({ ...account, hasProfile: Boolean(account.guild?.trim() && account.game_name?.trim()),
        emails, identities, sessions, migration, changes });
    }
    report.matches = report.accounts.length;
    return report;
  });
}

const HINTS = {
  EMAIL_LOOKUP_KEY_REQUIRED: 'Use a valid AUTH_DIAGNOSTIC_HMAC_KEY, or resolve the exact legacy user ID in Netlify Identity and use --legacy-user-id. Do not match masked emails.',
  NEON_CONNECTION_UNAVAILABLE: 'Check existing Neon CLI login and installation. No automatic login, install, branch creation or configuration changes were attempted.',
  ENVIRONMENT_NOT_VERIFIED: 'No matching migration scope was found. Check the selected database; no account query was run.',
  DATABASE_CONNECTION_REQUIRED: 'Supply AUTH_DIAGNOSTIC_DATABASE_URL or explicitly use --neon-production.'
};

export function safeError(error) {
  const allowed = new Set(['INVALID_ARGUMENTS','ONE_SELECTOR_REQUIRED','INVALID_ID','ENVIRONMENT_MISMATCH',
    'ENVIRONMENT_REQUIRED','INVALID_EMAIL','AMBIGUOUS_CONNECTION','INVALID_DATABASE_CONNECTION',
    'READ_ONLY_REQUIRED','TOO_MANY_MATCHES', ...Object.keys(HINTS)]);
  const code = allowed.has(error?.code) ? error.code : 'DIAGNOSTIC_FAILED';
  return { error: code, hint: HINTS[code] || 'Check inputs, credentials and database reachability. Raw error details are suppressed.' };
}

async function main() {
  let sql;
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { console.log(HELP); return; }
    let hash;
    if (options.emailStdin) {
      const email = await readEmail(process.stdin);
      const key = process.env.AUTH_DIAGNOSTIC_HMAC_KEY;
      if (!key) fail('EMAIL_LOOKUP_KEY_REQUIRED');
      try { hash = await emailLookupHash(email, { hmacKey: key }); }
      catch { fail('EMAIL_LOOKUP_KEY_REQUIRED'); }
    }
    const uri = connectionUrl(options, process.env);
    const require = createRequire(new URL('../flipgame/package.json', import.meta.url));
    sql = require('postgres')(uri, clientOptions());
    console.log(JSON.stringify(await collectReport(sql, options, hash), null, 2));
  } catch (error) {
    console.error(JSON.stringify(safeError(error)));
    process.exitCode = 1;
  } finally {
    if (sql) { try { await sql.end({ timeout: 2 }); } catch { process.exitCode = 1; } }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
