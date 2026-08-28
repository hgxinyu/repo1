import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  realpathSync,
  readSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
  sep
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATION = resolve(
  SCRIPT_DIRECTORY,
  "../../../database/migrations/202608250001_auth_accounts.sql"
);
const TRUSTED_POSTGRES_PREFIX = "/opt/homebrew/opt/postgresql@17";

function usage() {
  return [
    "Usage: node test/auth/postgres-schema-smoke.mjs",
    "  --psql /absolute/path/to/psql",
    "  --host /private/tmp/shinegame-auth-pg.<suffix>/socket",
    "  --port <non-default-local-port>",
    "  --base-migration /absolute/path/to/202608250001_auth_accounts.sql",
    "  [--migration /absolute/path/to/202608250001_auth_accounts.sql]",
    "  [--additional-migration /absolute/path/to/incremental.sql]",
    "  [--derive-pre-batch-base]",
    "  [--user postgres] [--database postgres]"
  ].join("\n");
}

function parseArgs(argv) {
  const values = {
    psql: "",
    host: "",
    port: "",
    user: "postgres",
    database: "postgres",
    baseMigration: DEFAULT_MIGRATION,
    additionalMigrations: [],
    derivePreBatchBase: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(usage());
    const name = argument.slice(2);
    if (name === "derive-pre-batch-base") {
      values.derivePreBatchBase = true;
      continue;
    }
    const isAdditionalMigration = name === "additional-migration";
    const isBaseMigration = name === "base-migration" || name === "migration";
    if (!isAdditionalMigration && !isBaseMigration && !(name in values)) throw new Error(usage());
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(usage());
    if (isAdditionalMigration) values.additionalMigrations.push(value);
    else if (isBaseMigration) values.baseMigration = value;
    else values[name] = value;
    index += 1;
  }
  return values;
}

function hasPathTraversal(pathname) {
  return pathname.split(/[\\/]/u).includes("..");
}

function assertNoSymlinkComponents(pathname, label) {
  const absolutePath = resolve(pathname);
  let currentPath = parse(absolutePath).root;
  for (const component of absolutePath.slice(currentPath.length).split(sep)) {
    if (!component) continue;
    currentPath = join(currentPath, component);
    let componentStat;
    try {
      componentStat = lstatSync(currentPath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (componentStat.isSymbolicLink()) {
      throw new Error(`${label} contains a symlink component: ${currentPath}`);
    }
  }
}

function isNativeExecutable(pathname) {
  const descriptor = openSync(pathname, "r");
  const magic = Buffer.alloc(4);
  try {
    return readSync(descriptor, magic, 0, magic.length, 0) === magic.length && [
      "cffaedfe",
      "feedfacf",
      "cefaedfe",
      "feedface",
      "cafebabe",
      "bebafeca",
      "7f454c46"
    ].includes(magic.toString("hex"));
  } finally {
    closeSync(descriptor);
  }
}

function assertExecutableBinary(pathname, label) {
  const fileStat = statSync(pathname);
  if (!fileStat.isFile() || (fileStat.mode & 0o111) === 0) {
    throw new Error(`${label} must be a regular executable file`);
  }
  if (!isNativeExecutable(pathname)) {
    throw new Error(`${label} is not a native PostgreSQL executable`);
  }
}

function postgresVersion(pathname, label) {
  const versionResult = spawnSync(pathname, ["--version"], { encoding: "utf8" });
  const versionOutput = `${versionResult.stdout || ""}\n${versionResult.stderr || ""}`.trim();
  const versionMatch = versionOutput.match(/\(PostgreSQL\)\s+(\d+\.\d+)/u);
  if (
    versionResult.error ||
    versionResult.status !== 0 ||
    !versionMatch
  ) {
    throw new Error(`${label} did not report a PostgreSQL version`);
  }
  return { output: versionOutput, number: versionMatch[1] };
}

export function canonicalDisposableSocket(host) {
  if (typeof host !== "string" || !isAbsolute(host)) {
    throw new Error("Disposable socket path must be absolute");
  }
  if (hasPathTraversal(host)) {
    throw new Error("Refusing socket path traversal");
  }

  const resolvedHost = resolve(host);
  assertNoSymlinkComponents(resolvedHost, "Disposable socket path");
  let canonicalHost;
  try {
    canonicalHost = realpathSync(resolvedHost);
  } catch {
    throw new Error("Disposable socket path does not exist");
  }

  const canonicalRoot = dirname(canonicalHost);
  if (
    basename(canonicalHost) !== "socket" ||
    !/^\/private\/tmp\/shinegame-auth-pg\.[A-Za-z0-9]+$/u.test(canonicalRoot) ||
    canonicalHost !== join(canonicalRoot, "socket") ||
    !statSync(canonicalHost).isDirectory()
  ) {
    throw new Error("Socket path is outside the canonical disposable cluster root");
  }
  return { host: canonicalHost, clusterRoot: canonicalRoot };
}

export function validatePsqlBinary(psql) {
  if (typeof psql !== "string" || !isAbsolute(psql) || hasPathTraversal(psql)) {
    throw new Error("psql path must be an absolute canonical path");
  }

  let canonicalPsql;
  try {
    canonicalPsql = realpathSync(resolve(psql));
  } catch {
    throw new Error("psql executable does not exist");
  }
  let trustedPrefix;
  try {
    trustedPrefix = realpathSync(TRUSTED_POSTGRES_PREFIX);
  } catch {
    throw new Error(`trusted PostgreSQL installation is missing: ${TRUSTED_POSTGRES_PREFIX}`);
  }
  const trustedBinRoot = join(trustedPrefix, "bin");
  const expectedPsql = join(trustedBinRoot, "psql");
  if (canonicalPsql !== expectedPsql) {
    throw new Error("psql executable is outside the trusted PostgreSQL bin root");
  }
  assertExecutableBinary(canonicalPsql, "psql executable");
  const psqlVersion = postgresVersion(canonicalPsql, "psql executable");
  if (!/^psql\s+\(PostgreSQL\)\s+\d+\.\d+/mu.test(psqlVersion.output)) {
    throw new Error("psql executable did not report the PostgreSQL psql version format");
  }

  for (const executable of ["postgres", "initdb", "pg_ctl"]) {
    const familyPath = join(trustedBinRoot, executable);
    try {
      assertExecutableBinary(familyPath, `${executable} executable`);
    } catch (error) {
      throw new Error(`trusted PostgreSQL binary family is incomplete: ${error.message}`);
    }
    const familyVersion = postgresVersion(familyPath, `${executable} executable`);
    if (familyVersion.number !== psqlVersion.number) {
      throw new Error(
        `PostgreSQL binary version mismatch: psql ${psqlVersion.number}, ${executable} ${familyVersion.number}`
      );
    }
  }
  return {
    path: canonicalPsql,
    version: psqlVersion.output,
    versionNumber: psqlVersion.number
  };
}

export function canonicalMigrationPath(migration) {
  if (typeof migration !== "string" || !isAbsolute(migration)) {
    throw new Error("Migration path must be absolute");
  }
  if (hasPathTraversal(migration)) {
    throw new Error("Refusing migration path traversal");
  }
  assertNoSymlinkComponents(resolve(migration), "Migration path");
  if (!existsSync(migration)) throw new Error(`Migration not found: ${migration}`);
  const canonical = realpathSync(resolve(migration));
  if (!statSync(canonical).isFile()) throw new Error("Migration path is not a file");
  return canonical;
}

function skipSqlLexeme(sqlText, start) {
  const first = sqlText[start];
  const second = sqlText[start + 1];
  if (first === "-" && second === "-") {
    const newlineIndex = sqlText.indexOf("\n", start + 2);
    return newlineIndex === -1 ? sqlText.length : newlineIndex + 1;
  }
  if (first === "/" && second === "*") {
    const closeIndex = sqlText.indexOf("*/", start + 2);
    if (closeIndex === -1) throw new Error("Malformed SQL block comment");
    return closeIndex + 2;
  }
  if (first === "'" || first === "\"") {
    for (let index = start + 1; index < sqlText.length; index += 1) {
      if (sqlText[index] === "\\" && first === "'") {
        index += 1;
        continue;
      }
      if (sqlText[index] !== first) continue;
      if (sqlText[index + 1] === first) {
        index += 1;
        continue;
      }
      return index + 1;
    }
    throw new Error("Malformed SQL quoted literal");
  }
  if (first === "$") {
    const dollarTag = sqlText.slice(start).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u);
    if (dollarTag) {
      const closeIndex = sqlText.indexOf(dollarTag[0], start + dollarTag[0].length);
      if (closeIndex === -1) throw new Error("Malformed SQL dollar-quoted literal");
      return closeIndex + dollarTag[0].length;
    }
  }
  return null;
}

function skipSqlWhitespaceAndComments(sqlText, start) {
  let index = start;
  while (index < sqlText.length) {
    if (/\s/u.test(sqlText[index])) {
      index += 1;
      continue;
    }
    const isComment =
      (sqlText[index] === "-" && sqlText[index + 1] === "-") ||
      (sqlText[index] === "/" && sqlText[index + 1] === "*");
    if (!isComment) return index;
    const skipped = skipSqlLexeme(sqlText, index);
    index = skipped;
  }
  return index;
}

function findSqlPrefixMatches(sqlText, prefixPattern) {
  const matches = [];
  let index = 0;
  while (index < sqlText.length) {
    const skipped = skipSqlLexeme(sqlText, index);
    if (skipped !== null && skipped !== index) {
      index = skipped;
      continue;
    }
    const match = sqlText.slice(index).match(prefixPattern);
    if (match) {
      matches.push({ start: index, end: index + match[0].length });
      index += match[0].length;
      continue;
    }
    index += 1;
  }
  return matches;
}

function findParenthesizedStatementEnd(sqlText, openingIndex, label) {
  if (sqlText[openingIndex] !== "(") {
    throw new Error("Malformed " + label + " statement: missing opening parenthesis");
  }
  let depth = 0;
  let index = openingIndex;
  while (index < sqlText.length) {
    const skipped = skipSqlLexeme(sqlText, index);
    if (skipped !== null && skipped !== index) {
      index = skipped;
      continue;
    }
    const character = sqlText[index];
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth < 0) {
        throw new Error("Malformed " + label + " statement: unbalanced parentheses");
      }
      if (depth === 0) {
        const delimiterIndex = skipSqlWhitespaceAndComments(sqlText, index + 1);
        if (sqlText[delimiterIndex] !== ";") {
          throw new Error("Malformed " + label + " statement: expected semicolon");
        }
        return delimiterIndex + 1;
      }
    }
    index += 1;
  }
  throw new Error("Malformed " + label + " statement: unbalanced parentheses");
}

function findImmediateStatementEnd(sqlText, afterPrefix, label) {
  const delimiterIndex = skipSqlWhitespaceAndComments(sqlText, afterPrefix);
  if (sqlText[delimiterIndex] !== ";") {
    throw new Error("Malformed " + label + " statement: expected semicolon");
  }
  return delimiterIndex + 1;
}

function findCommentStatementEnd(sqlText, afterPrefix, label) {
  let index = skipSqlWhitespaceAndComments(sqlText, afterPrefix);
  const isMatch = sqlText.slice(index).match(/^IS\b/iu);
  if (!isMatch) {
    throw new Error("Malformed " + label + " statement: expected IS");
  }
  index = skipSqlWhitespaceAndComments(sqlText, index + isMatch[0].length);

  const nullMatch = sqlText.slice(index).match(/^NULL\b/iu);
  if (nullMatch) {
    index += nullMatch[0].length;
  } else if (sqlText[index] === "'" || sqlText[index] === "$") {
    const literalEnd = skipSqlLexeme(sqlText, index);
    if (literalEnd === null) {
      throw new Error("Malformed " + label + " statement: expected comment text");
    }
    index = literalEnd;
  } else {
    throw new Error("Malformed " + label + " statement: expected comment text");
  }

  return findImmediateStatementEnd(sqlText, index, label);
}

function removeSqlSpans(sqlText, spans) {
  return spans
    .slice()
    .sort((left, right) => right.start - left.start)
    .reduce(
      (result, span) => result.slice(0, span.start) + result.slice(span.end),
      sqlText
    );
}

const CREATE_BATCH_TABLE_PREFIX =
  /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?auth_migration_batches\s*\(/iu;
const REVOKE_BATCH_TABLE_PREFIX =
  /^REVOKE\s+ALL\s+ON\s+(?:TABLE\s+)?(?:public\.)?auth_migration_batches\s+FROM\s+PUBLIC\b/iu;
const COMMENT_BATCH_TABLE_PREFIX =
  /^COMMENT\s+ON\s+TABLE\s+(?:public\.)?auth_migration_batches\b/iu;

export function derivePreBatchBaseMigration(sqlText) {
  if (typeof sqlText !== "string" || !sqlText.trim()) {
    throw new Error("Cannot derive a pre-batch base from empty SQL");
  }

  const createMatches = findSqlPrefixMatches(sqlText, CREATE_BATCH_TABLE_PREFIX);
  if (createMatches.length !== 1) {
    throw new Error(
      "Expected exactly one complete CREATE TABLE auth_migration_batches statement; found " +
      createMatches.length
    );
  }
  const createMatch = createMatches[0];
  const createEnd = findParenthesizedStatementEnd(
    sqlText,
    sqlText.indexOf("(", createMatch.start),
    "CREATE TABLE auth_migration_batches"
  );

  const revokeMatches = findSqlPrefixMatches(sqlText, REVOKE_BATCH_TABLE_PREFIX);
  if (revokeMatches.length !== 1) {
    throw new Error(
      "Expected exactly one complete REVOKE ALL ON auth_migration_batches FROM PUBLIC statement; found " +
      revokeMatches.length
    );
  }
  const revokeMatch = revokeMatches[0];
  const revokeEnd = findImmediateStatementEnd(
    sqlText,
    revokeMatch.end,
    "REVOKE ALL ON auth_migration_batches FROM PUBLIC"
  );

  const commentMatches = findSqlPrefixMatches(sqlText, COMMENT_BATCH_TABLE_PREFIX);
  if (commentMatches.length !== 1) {
    throw new Error(
      "Expected exactly one complete COMMENT ON TABLE auth_migration_batches statement; found " +
      commentMatches.length
    );
  }
  const spans = [
    { start: createMatch.start, end: createEnd },
    { start: revokeMatch.start, end: revokeEnd }
  ];
  const commentMatch = commentMatches[0];
  spans.push({
    start: commentMatch.start,
    end: findCommentStatementEnd(
      sqlText,
      commentMatch.end,
      "COMMENT ON TABLE auth_migration_batches"
    )
  });

  const derivedSql = removeSqlSpans(sqlText, spans);
  if (/\bauth_migration_batches\b/iu.test(derivedSql)) {
    throw new Error("Derived pre-batch base still contains an auth_migration_batches reference");
  }
  const trimmedSql = derivedSql.trim();
  if (
    !/^BEGIN\s*;/iu.test(trimmedSql) ||
    !/COMMIT\s*;\s*$/iu.test(trimmedSql) ||
    !/\bCREATE\s+TYPE\s+auth_migration_status\b/iu.test(derivedSql) ||
    !/\bCREATE\s+TABLE\s+(?:public\.)?accounts\s*\(/iu.test(derivedSql)
  ) {
    throw new Error("Derived pre-batch base does not retain the surrounding auth schema transaction");
  }
  return derivedSql;
}

export function canonicalMigrationChain(baseMigration, additionalMigrations = []) {
  return [baseMigration, ...additionalMigrations]
    .map((migrationPath) => canonicalMigrationPath(migrationPath));
}

function assertLocalTarget({ host, port, psql, baseMigration, additionalMigrations = [] }) {
  const socket = canonicalDisposableSocket(host);
  const psqlBinary = validatePsqlBinary(psql);
  const migrationPaths = canonicalMigrationChain(baseMigration, additionalMigrations);
  const numericPort = Number(port);
  if (
    !Number.isInteger(numericPort) ||
    numericPort < 1024 ||
    numericPort > 65535 ||
    numericPort === 5432
  ) {
    throw new Error("Refusing PostgreSQL default/invalid port; use a non-default local test port");
  }
  return {
    ...socket,
    ...psqlBinary,
    port: numericPort,
    migrationPaths
  };
}

function makeRunner(options, target) {
  const baseArgs = [
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    target.host,
    "-p",
    String(target.port),
    "-U",
    options.user,
    "-d",
    options.database
  ];

  const runPsql = (argumentsForPsql, label) => {
    const result = spawnSync(target.path, [...baseArgs, ...argumentsForPsql], {
      encoding: "utf8"
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    if (result.error) throw new Error(`${label}: ${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`${label} failed (exit ${result.status}): ${output}`);
    }
    return output;
  };
  runPsql.psqlPath = target.path;
  runPsql.baseArgs = baseArgs;
  runPsql.clusterRoot = target.clusterRoot;
  return runPsql;
}

export function createDisposablePreBatchBase(baseMigration, clusterRoot) {
  const derivedPath = join(clusterRoot, "pre-batch-auth-accounts.sql");
  const derivedSql = derivePreBatchBaseMigration(readFileSync(baseMigration, "utf8"));
  let writeSucceeded = false;
  try {
    writeFileSync(derivedPath, derivedSql, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    writeSucceeded = true;
    return {
      path: derivedPath,
      canonicalPath: canonicalMigrationPath(derivedPath)
    };
  } catch (error) {
    if (writeSucceeded) rmSync(derivedPath);
    throw error;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function assertExpectedConstraintError(result, expectedConstraint, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  assert.match(
    result.output,
    new RegExp(`constraint "${escapeRegExp(expectedConstraint)}"`, "u"),
    `${label} did not report expected constraint ${expectedConstraint}`
  );
}

function conciseError(output) {
  const line = output
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.startsWith("ERROR:"));
  return line ? line.replace(/\s+DETAIL:.*$/u, "") : "expected PostgreSQL error";
}

function expectPsqlConstraintError(runPsql, label, sql, expectedConstraint) {
  const result = spawnSync(runPsql.psqlPath, [...runPsql.baseArgs, "-c", sql], {
    encoding: "utf8"
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  assertExpectedConstraintError({ ...result, output }, expectedConstraint, label);
  console.log(`${label}: PASS (${conciseError(output)})`);
}

function expectPsqlError(runPsql, label, sql, expectedPattern) {
  const result = spawnSync(runPsql.psqlPath, [...runPsql.baseArgs, "-c", sql], {
    encoding: "utf8"
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  assert.match(output, expectedPattern, `${label} did not report the expected database error`);
  console.log(`${label}: PASS (${conciseError(output)})`);
}

function assertServerDataDirectory(output, expectedClusterRoot) {
  const dataDirectory = output.trim();
  assert.ok(dataDirectory, "server returned an empty data_directory");
  let canonicalDataDirectory;
  try {
    canonicalDataDirectory = realpathSync(dataDirectory);
  } catch {
    throw new Error("server data_directory does not exist");
  }
  assert.equal(
    canonicalDataDirectory,
    expectedClusterRoot,
    "server data_directory is outside the disposable cluster root"
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let target = assertLocalTarget(options);
  const runPsql = makeRunner(options, target);
  const targetAccountId = "00000000-0000-0000-0000-000000000001";
  const adminAccountId = "00000000-0000-0000-0000-000000000002";
  const nonAdminAccountId = "00000000-0000-0000-0000-000000000003";
  const batchSource = "netlify_identity";
  const batchEnvironmentId = "stage";
  const batchSiteId = "site-stage";
  const bffRole = "shinegame_auth_bff";
  const publicProbeRole = "auth_public_probe";
  const createdAt = "2026-01-01 00:00:00+00";
  let derivedBasePath = "";
  let derivedBaseCreated = false;
  let seeded = false;
  let failure;

  console.log(`psql client: ${target.version}`);
  try {
    if (options.derivePreBatchBase) {
      const derivedBase = createDisposablePreBatchBase(
        target.migrationPaths[0],
        target.clusterRoot
      );
      derivedBasePath = derivedBase.path;
      derivedBaseCreated = true;
      target = {
        ...target,
        migrationPaths: [
          derivedBase.canonicalPath,
          ...target.migrationPaths.slice(1)
        ]
      };
      console.log("pre-batch base derivation: PASS (disposable cluster file)");
    }
    assertServerDataDirectory(
      runPsql(["-At", "-c", "SHOW data_directory;"], "server data_directory"),
      target.clusterRoot
    );
    const serverVersion = runPsql(["-At", "-c", "SHOW server_version;"], "server version");
    const serverVersionMatch = serverVersion.match(/^(\d+\.\d+)/u);
    assert.ok(serverVersionMatch, "server did not report a PostgreSQL version");
    assert.equal(
      serverVersionMatch[1],
      target.versionNumber,
      "server version does not match the trusted PostgreSQL client family"
    );
    console.log(`PostgreSQL server: ${serverVersion}`);
    runPsql(["-c", `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_roles
           WHERE rolname = '${bffRole}'
        ) THEN
          CREATE ROLE ${bffRole}
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
            NOINHERIT NOREPLICATION NOBYPASSRLS;
        END IF;
      END
      $$;
      GRANT ${bffRole} TO CURRENT_USER;
    `], "runtime role setup");
    console.log("runtime role setup: PASS (pre-provisioned without a password)");

    for (const [index, migrationPath] of target.migrationPaths.entries()) {
      runPsql(["-f", migrationPath], `migration apply ${index + 1}`);
      console.log(`migration apply ${index + 1}: PASS`);
    }

    runPsql(["-c", `
      INSERT INTO public.accounts (account_id, role, status, created_at, updated_at)
      VALUES
        ('${targetAccountId}', 'free', 'active', '${createdAt}', '${createdAt}'),
        ('${adminAccountId}', 'admin', 'active', '${createdAt}', '${createdAt}'),
        ('${nonAdminAccountId}', 'free', 'active', '${createdAt}', '${createdAt}');
    `], "smoke seed");
    seeded = true;

    runPsql(["-c", `
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${publicProbeRole}') THEN
          CREATE ROLE ${publicProbeRole} NOLOGIN;
        END IF;
      END
      $$;
    `], "batch runtime role setup");

    runPsql(["-c", `
      INSERT INTO public.auth_migration_batches (
        source, environment_id, site_id, snapshot_id, snapshot_hash, status,
        source_count, imported_count, conflict_count, freeze_at, completed_at
      ) VALUES (
        '${batchSource}', '${batchEnvironmentId}', '${batchSiteId}',
        'synthetic-snapshot', decode(repeat('aa', 32), 'hex'), 'reconciled',
        1, 1, 0, '${createdAt}', '${createdAt}'
      );
    `], "migration batch seed");

    runPsql(["-c", `
      DO $$
      DECLARE
        bff_can_select BOOLEAN;
        bff_can_insert BOOLEAN;
        bff_can_update BOOLEAN;
        bff_can_delete BOOLEAN;
        public_can_select BOOLEAN;
        public_can_insert BOOLEAN;
        public_can_update BOOLEAN;
        public_can_delete BOOLEAN;
      BEGIN
        SELECT
          has_table_privilege('${bffRole}', 'public.auth_migration_batches', 'SELECT'),
          has_table_privilege('${bffRole}', 'public.auth_migration_batches', 'INSERT'),
          has_table_privilege('${bffRole}', 'public.auth_migration_batches', 'UPDATE'),
          has_table_privilege('${bffRole}', 'public.auth_migration_batches', 'DELETE'),
          has_table_privilege('${publicProbeRole}', 'public.auth_migration_batches', 'SELECT'),
          has_table_privilege('${publicProbeRole}', 'public.auth_migration_batches', 'INSERT'),
          has_table_privilege('${publicProbeRole}', 'public.auth_migration_batches', 'UPDATE'),
          has_table_privilege('${publicProbeRole}', 'public.auth_migration_batches', 'DELETE')
        INTO
          bff_can_select, bff_can_insert, bff_can_update, bff_can_delete,
          public_can_select, public_can_insert, public_can_update, public_can_delete;

        IF NOT bff_can_select OR bff_can_insert OR bff_can_update OR bff_can_delete THEN
          RAISE EXCEPTION 'BFF migration-batch privileges are not SELECT-only';
        END IF;
        IF public_can_select OR public_can_insert OR public_can_update OR public_can_delete THEN
          RAISE EXCEPTION 'PUBLIC unexpectedly has migration-batch privileges';
        END IF;
      END
      $$;
    `], "migration batch privilege boundary");
    console.log("migration batch privilege boundary: PASS (BFF SELECT-only; PUBLIC none)");

    runPsql(["-c", `
      BEGIN;
      SET LOCAL ROLE ${bffRole};
      DO $$
      DECLARE
        visible_count INTEGER;
      BEGIN
        SELECT count(*)
          INTO visible_count
          FROM public.auth_migration_batches
         WHERE source = '${batchSource}'
           AND environment_id = '${batchEnvironmentId}'
           AND site_id = '${batchSiteId}'
           AND status = 'reconciled';
        IF visible_count <> 1 THEN
          RAISE EXCEPTION 'expected one exact scoped reconciled batch row, got %', visible_count;
        END IF;
      END
      $$;
      ROLLBACK;
    `], "migration batch exact scoped read");
    console.log("migration batch exact scoped read: PASS");

    runPsql(["-c", `
      BEGIN;
      SET LOCAL ROLE ${bffRole};
      SELECT current_user;
      ROLLBACK;
    `], "anonymous runtime path");
    console.log("anonymous runtime path: PASS (role can establish a read-only request transaction)");

    runPsql(["-c", `
      BEGIN;
      SET LOCAL ROLE ${bffRole};
      INSERT INTO public.oauth_transactions (
        transaction_kind, state_hash, nonce_hash, nonce_encrypted,
        pkce_verifier_encrypted, environment_id, site_id, next_path,
        created_at, expires_at
      ) VALUES (
        'oauth', decode(repeat('01', 32), 'hex'), decode(repeat('02', 32), 'hex'),
        decode(repeat('03', 16), 'hex'), decode(repeat('04', 16), 'hex'),
        '${batchEnvironmentId}', '${batchSiteId}', '/runtime-oauth',
        '${createdAt}', '2026-01-01 00:10:00+00'
      )
      RETURNING transaction_id;
      UPDATE public.oauth_transactions
         SET consumed_at = '${createdAt}'
       WHERE state_hash = decode(repeat('01', 32), 'hex')
         AND environment_id = '${batchEnvironmentId}'
         AND site_id = '${batchSiteId}'
         AND consumed_at IS NULL
      RETURNING consumed_at;
      ROLLBACK;
    `], "OAuth transaction runtime path");
    console.log("OAuth transaction runtime path: PASS (insert/select/consume)");

    runPsql(["-c", `
      BEGIN;
      SET LOCAL ROLE ${bffRole};
      DO $$
      DECLARE
        runtime_account_id UUID;
        runtime_role public.auth_account_role;
        runtime_status public.auth_account_status;
      BEGIN
        SELECT account_id, role, status
          INTO runtime_account_id, runtime_role, runtime_status
          FROM public.create_free_account('runtime-guild', 'runtime-game');
        IF runtime_role <> 'free'::public.auth_account_role OR
           runtime_status <> 'active'::public.auth_account_status THEN
          RAISE EXCEPTION 'fixed account creation function returned an unsafe state';
        END IF;
        INSERT INTO public.account_emails (
          account_id, email_lookup_hash, encrypted_email,
          encryption_key_version, is_primary, verified_at
        ) VALUES (
          runtime_account_id, decode(repeat('05', 16), 'hex'),
          decode(repeat('06', 16), 'hex'), 1, TRUE, '${createdAt}'
        );
        INSERT INTO public.auth_identities (
          account_id, issuer_or_tenant, connector_scope, provider_subject,
          subject_type, logto_user_id
        ) VALUES (
          runtime_account_id, 'runtime-issuer', 'logto', 'runtime-subject',
          'sub', 'runtime-subject'
        );
      END
      $$;
      ROLLBACK;
    `], "account creation runtime path");
    console.log("account creation runtime path: PASS (fixed free/active function + account/email/identity inserts)");

    expectPsqlError(
      runPsql,
      "account creation direct INSERT",
      `BEGIN; SET LOCAL ROLE ${bffRole}; INSERT INTO public.accounts (role, status) VALUES ('admin', 'active'); ROLLBACK;`,
      /permission denied for (?:table|column) accounts?/u
    );

    runPsql(["-c", `
      BEGIN;
      SET LOCAL ROLE ${bffRole};
      INSERT INTO public.auth_sessions (
        auth_source, environment_id, site_id, session_id_hash,
        account_id, logto_subject, encrypted_refresh_token,
        refresh_token_key_version, issued_at, last_seen_at,
        idle_expires_at, absolute_expires_at, authz_version, rotation_version,
        created_at
      ) VALUES (
        'logto', '${batchEnvironmentId}', '${batchSiteId}', decode(repeat('07', 32), 'hex'),
        '${targetAccountId}', 'runtime-session-subject', decode(repeat('08', 16), 'hex'),
        1, '${createdAt}', '${createdAt}',
        '2026-01-01 01:00:00+00', '2026-01-01 02:00:00+00', 1, 1,
        '${createdAt}'
      )
      RETURNING session_id, session_family_id;
      UPDATE public.auth_sessions
         SET encrypted_refresh_token = decode(repeat('09', 16), 'hex'),
             refresh_token_key_version = 1,
             rotation_version = rotation_version + 1,
             last_seen_at = '${createdAt}',
             idle_expires_at = '2026-01-01 01:00:00+00',
             revoked_at = NULL
       WHERE session_id_hash = decode(repeat('07', 32), 'hex')
         AND environment_id = '${batchEnvironmentId}'
         AND site_id = '${batchSiteId}'
      RETURNING session_id, rotation_version;
      ROLLBACK;
    `], "session runtime path");
    console.log("session runtime path: PASS (OAuth session insert/read/rotation/revoke columns)");

    runPsql(["-c", `
      BEGIN;
      SET LOCAL ROLE ${bffRole};
      INSERT INTO public.ai_hourly_limits (account_id, hour_start, count)
      VALUES ('${targetAccountId}', '2026-01-01 00:00:00+00', 1)
      ON CONFLICT (account_id, hour_start)
      DO UPDATE SET count = public.ai_hourly_limits.count + 1,
                    updated_at = now()
      RETURNING count, hour_start;
      ROLLBACK;
    `], "AI rate-limit runtime path");
    console.log("AI rate-limit runtime path: PASS (atomic quota upsert)");

    runPsql(["-c", `
      BEGIN;
      SET LOCAL ROLE ${bffRole};
      SELECT public.set_account_authorization(
        '${adminAccountId}', '${targetAccountId}',
        'vip'::public.auth_account_role, 'active'::public.auth_account_status,
        '{"reason":"schema-smoke-admin"}'::jsonb
      );
      DO $$
      DECLARE
        actual_role public.auth_account_role;
      BEGIN
        SELECT role INTO actual_role
          FROM public.accounts
         WHERE account_id = '${targetAccountId}';
        IF actual_role <> 'vip'::public.auth_account_role THEN
          RAISE EXCEPTION 'admin authorization function did not update the target';
        END IF;
      END
      $$;
      ROLLBACK;
    `], "admin authorization runtime function");
    console.log("admin authorization runtime function: PASS (SECURITY DEFINER only)");

    runPsql(["-c", `
      BEGIN;
      SET LOCAL ROLE ${bffRole};
      SELECT public.request_account_vip(
        '${nonAdminAccountId}', '{"reason":"schema-smoke-vip"}'::jsonb
      );
      DO $$
      DECLARE
        actual_role public.auth_account_role;
      BEGIN
        SELECT role INTO actual_role
          FROM public.accounts
         WHERE account_id = '${nonAdminAccountId}';
        IF actual_role <> 'pending'::public.auth_account_role THEN
          RAISE EXCEPTION 'VIP request function did not update the target';
        END IF;
      END
      $$;
      ROLLBACK;
    `], "VIP request runtime function");
    console.log("VIP request runtime function: PASS (SECURITY DEFINER only)");

    expectPsqlError(
      runPsql,
      "authorization direct mutation",
      `BEGIN; SET LOCAL ROLE ${bffRole}; UPDATE public.accounts SET role = 'vip' WHERE account_id = '${targetAccountId}';`,
      /permission denied for (?:table|column) accounts?/u
    );
    expectPsqlError(
      runPsql,
      "authorization mutation context direct INSERT",
      `BEGIN; SET LOCAL ROLE ${bffRole}; INSERT INTO public.auth_authorization_mutation_context (backend_pid, transaction_id, mutation_token, actor_source, target_account_id) VALUES (pg_backend_pid(), txid_current(), gen_random_uuid(), 'system', '${targetAccountId}');`,
      /permission denied for table auth_authorization_mutation_context/u
    );
    expectPsqlError(
      runPsql,
      "migration record direct UPDATE",
      `BEGIN; SET LOCAL ROLE ${bffRole}; UPDATE public.migration_records SET status = 'failed' WHERE legacy_netlify_user_id = 'runtime-migration-probe';`,
      /permission denied for table migration_records/u
    );
    console.log("owner-only authorization and migration writes: PASS");

    expectPsqlConstraintError(
      runPsql,
      "duplicate migration batch scope",
      `
        BEGIN;
        INSERT INTO public.auth_migration_batches (
          source, environment_id, site_id, snapshot_id, snapshot_hash,
          status, source_count, imported_count, conflict_count, freeze_at, completed_at
        ) VALUES (
          '${batchSource}', '${batchEnvironmentId}', '${batchSiteId}',
          'duplicate-snapshot', decode(repeat('bb', 32), 'hex'), 'reconciled',
          1, 1, 0, '${createdAt}', '${createdAt}'
        );
        ROLLBACK;
      `,
      "auth_migration_batches_source_environment_id_site_id_key"
    );

    expectPsqlConstraintError(
      runPsql,
      "reconciled batch count mismatch",
      `
        BEGIN;
        INSERT INTO public.auth_migration_batches (
          source, environment_id, site_id, snapshot_id, snapshot_hash,
          status, source_count, imported_count, conflict_count, freeze_at, completed_at
        ) VALUES (
          'mismatch-count', '${batchEnvironmentId}', '${batchSiteId}',
          'mismatch-count-snapshot', decode(repeat('cc', 32), 'hex'), 'reconciled',
          1, 0, 0, '${createdAt}', '${createdAt}'
        );
        ROLLBACK;
      `,
      "auth_migration_batches_check"
    );

    expectPsqlConstraintError(
      runPsql,
      "reconciled batch conflict count",
      `
        BEGIN;
        INSERT INTO public.auth_migration_batches (
          source, environment_id, site_id, snapshot_id, snapshot_hash,
          status, source_count, imported_count, conflict_count, freeze_at, completed_at
        ) VALUES (
          'conflict-count', '${batchEnvironmentId}', '${batchSiteId}',
          'conflict-count-snapshot', decode(repeat('dd', 32), 'hex'), 'reconciled',
          1, 1, 1, '${createdAt}', '${createdAt}'
        );
        ROLLBACK;
      `,
      "auth_migration_batches_check"
    );

    expectPsqlConstraintError(
      runPsql,
      "reconciled batch completion timestamp",
      `
        BEGIN;
        INSERT INTO public.auth_migration_batches (
          source, environment_id, site_id, snapshot_id, snapshot_hash,
          status, source_count, imported_count, conflict_count, freeze_at
        ) VALUES (
          'missing-completed-at', '${batchEnvironmentId}', '${batchSiteId}',
          'missing-completed-at-snapshot', decode(repeat('ee', 32), 'hex'), 'reconciled',
          1, 1, 0, '${createdAt}'
        );
        ROLLBACK;
      `,
      "auth_migration_batches_check"
    );

    for (const [label, statement] of [
      [
        "BFF batch INSERT",
        `INSERT INTO public.auth_migration_batches (
          source, environment_id, site_id, snapshot_id, snapshot_hash,
          status, source_count, imported_count, conflict_count, freeze_at, completed_at
        ) VALUES (
          'bff-insert', '${batchEnvironmentId}', '${batchSiteId}',
          'bff-insert-snapshot', decode(repeat('ff', 32), 'hex'), 'pending',
          0, 0, 0, '${createdAt}', NULL
        );`
      ],
      [
        "BFF batch UPDATE",
        `UPDATE public.auth_migration_batches
            SET status = 'pending'
          WHERE source = '${batchSource}'
            AND environment_id = '${batchEnvironmentId}'
            AND site_id = '${batchSiteId}';`
      ],
      [
        "BFF batch DELETE",
        `DELETE FROM public.auth_migration_batches
          WHERE source = '${batchSource}'
            AND environment_id = '${batchEnvironmentId}'
            AND site_id = '${batchSiteId}';`
      ]
    ]) {
      expectPsqlError(
        runPsql,
        label,
        `BEGIN; SET LOCAL ROLE ${bffRole}; ${statement} ROLLBACK;`,
        /permission denied for table auth_migration_batches/u
      );
    }

    runPsql(["-c", `
      BEGIN;
      INSERT INTO public.oauth_transactions (
        transaction_kind, state_hash, nonce_hash, nonce_encrypted, pkce_verifier_encrypted,
        environment_id, site_id, next_path, created_at, expires_at
      ) VALUES (
        'oauth',
        decode(repeat('aa', 32), 'hex'),
        decode(repeat('bb', 32), 'hex'),
        decode(repeat('bc', 186), 'hex'),
        decode(repeat('cc', 186), 'hex'),
        'stage', 'site-stage', '/auth/callback', '${createdAt}', '2026-01-01 00:10:00+00'
      );
      INSERT INTO public.auth_sessions (
        auth_source, environment_id, site_id, session_id_hash, account_id, legacy_netlify_user_id,
        issued_at, last_seen_at, idle_expires_at, absolute_expires_at, created_at
      ) VALUES (
        'legacy_bridge', 'stage', 'site-stage', decode(repeat('dd', 32), 'hex'), '${targetAccountId}',
        'family-default-probe', '${createdAt}', '${createdAt}',
        '2026-01-01 01:00:00+00', '2026-01-01 02:00:00+00', '${createdAt}'
      );
      INSERT INTO public.account_emails (
        account_id, email_lookup_hash, encrypted_email, created_at
      ) VALUES (
        '${targetAccountId}', decode(repeat('ab', 16), 'hex'),
        decode(repeat('ee', 8192), 'hex'), '${createdAt}'
      );
      DO $$
      DECLARE
        pkce_length INTEGER;
        family_id UUID;
        email_length INTEGER;
      BEGIN
        SELECT octet_length(pkce_verifier_encrypted)
          INTO pkce_length
          FROM public.oauth_transactions
         WHERE state_hash = decode(repeat('aa', 32), 'hex');
        IF pkce_length <> 186 THEN
          RAISE EXCEPTION 'expected 186-byte PKCE envelope, got %', pkce_length;
        END IF;
        SELECT session_family_id INTO family_id
          FROM public.auth_sessions
         WHERE legacy_netlify_user_id = 'family-default-probe';
        IF family_id IS NULL THEN
          RAISE EXCEPTION 'session family default was not generated';
        END IF;
        SELECT octet_length(encrypted_email)
          INTO email_length
          FROM public.account_emails
         WHERE email_lookup_hash = decode(repeat('ab', 16), 'hex');
        IF email_length <> 8192 THEN
          RAISE EXCEPTION 'expected 8192-byte encrypted email envelope, got %', email_length;
        END IF;
      END $$;
      ROLLBACK;
    `], "auth storage bounds");
    console.log("auth storage bounds (PKCE envelope/family default/email envelope): PASS");

    expectPsqlConstraintError(
      runPsql,
      "encrypted email upper bound",
      `
        BEGIN;
        INSERT INTO public.account_emails (
          account_id, email_lookup_hash, encrypted_email, created_at
        ) VALUES (
          '${targetAccountId}', decode(repeat('cd', 16), 'hex'),
          decode(repeat('ee', 8193), 'hex'), '${createdAt}'
        );
        ROLLBACK;
      `,
      "account_emails_encrypted_email_check"
    );

    expectPsqlError(
      runPsql,
      "non-admin authorization actor",
      `SELECT public.set_account_authorization('${nonAdminAccountId}', '${targetAccountId}', 'vip', 'active', '{}'::jsonb);`,
      /active admin actor/u
    );
    expectPsqlError(
      runPsql,
      "forged actor GUC direct update",
      `
      BEGIN;
      SET LOCAL app.actor_source = 'account';
      SET LOCAL app.actor_account_id = '${adminAccountId}';
      SET LOCAL app.authz_mutation_token = '00000000-0000-0000-0000-000000000099';
      UPDATE public.accounts SET role = 'vip' WHERE account_id = '${targetAccountId}';
      COMMIT;
      `,
      /controlled authorization boundary/u
    );

    runPsql(["-c", `
      BEGIN;
      SELECT public.request_account_vip(
        '${targetAccountId}',
        '{"reason":"schema-smoke-self-service"}'::jsonb
      );
      DO $$
      DECLARE
        actual_role public.auth_account_role;
        actual_authz_version BIGINT;
        audit_count BIGINT;
      BEGIN
        SELECT account.role, account.authz_version
          INTO actual_role, actual_authz_version
          FROM public.accounts AS account
         WHERE account.account_id = '${targetAccountId}';
        IF actual_role <> 'pending'::public.auth_account_role THEN
          RAISE EXCEPTION 'expected VIP request role pending, got %', actual_role;
        END IF;
        IF actual_authz_version <> 2 THEN
          RAISE EXCEPTION 'expected VIP request authz_version 2, got %', actual_authz_version;
        END IF;
        SELECT count(*) INTO audit_count
          FROM public.account_authorization_audit
         WHERE target_account_id = '${targetAccountId}'
           AND actor_account_id = '${targetAccountId}'
           AND actor_source = 'account'
           AND old_role = 'free'
           AND new_role = 'pending';
        IF audit_count <> 1 THEN
          RAISE EXCEPTION 'expected one self-service VIP audit row, got %', audit_count;
        END IF;
      END;
      $$;
      ROLLBACK;
    `], "self-service VIP authorization boundary");
    console.log("self-service VIP authorization boundary: PASS");

    runPsql(["-c", `
      BEGIN;
      SELECT public.set_account_authorization('${adminAccountId}', '${targetAccountId}', 'vip', 'active', '{"reason":"schema-smoke"}'::jsonb);
      SELECT public.set_account_authorization('${adminAccountId}', '${targetAccountId}', 'vip', 'disabled', '{}'::jsonb);
      SELECT public.set_account_authorization('${adminAccountId}', '${targetAccountId}', 'vip', 'disabled', '{}'::jsonb);
      DO $$
      DECLARE
        audit_count BIGINT;
        selected_audit_id UUID;
        actual_message TEXT;
      BEGIN
        SELECT count(*) INTO audit_count
          FROM public.account_authorization_audit
         WHERE target_account_id = '${targetAccountId}';
        IF audit_count <> 2 THEN
          RAISE EXCEPTION 'expected exactly two authorization audit rows, got %', audit_count;
        END IF;
        IF NOT EXISTS (
          SELECT 1
            FROM public.account_authorization_audit
           WHERE target_account_id = '${targetAccountId}'
             AND actor_account_id = '${adminAccountId}'
             AND actor_source = 'account'
             AND old_role = 'free'
             AND new_role = 'vip'
        ) THEN
          RAISE EXCEPTION 'admin actor provenance was not recorded';
        END IF;
        SELECT audit_id INTO selected_audit_id
          FROM public.account_authorization_audit
         WHERE target_account_id = '${targetAccountId}'
         ORDER BY changed_at, audit_id
         LIMIT 1;

        BEGIN
          INSERT INTO public.account_authorization_audit (
            actor_account_id, actor_source, target_account_id,
            old_role, new_role, old_status, new_status
          ) VALUES (
            '${adminAccountId}', 'account', '${targetAccountId}',
            'free', 'vip', 'active', 'disabled'
          );
          RAISE EXCEPTION 'direct audit INSERT unexpectedly succeeded';
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS actual_message = MESSAGE_TEXT;
          IF actual_message NOT LIKE '%only allowed from the accounts authorization trigger%' THEN
            RAISE EXCEPTION 'unexpected direct audit INSERT error: %', actual_message;
          END IF;
        END;

        BEGIN
          UPDATE public.account_authorization_audit AS audit
             SET metadata = '{}'::jsonb
           WHERE audit.audit_id = selected_audit_id;
          RAISE EXCEPTION 'direct audit UPDATE unexpectedly succeeded';
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS actual_message = MESSAGE_TEXT;
          IF actual_message NOT LIKE '%account_authorization_audit is append-only; UPDATE is not allowed%' THEN
            RAISE EXCEPTION 'unexpected direct audit UPDATE error: %', actual_message;
          END IF;
        END;

        BEGIN
          DELETE FROM public.account_authorization_audit AS audit
           WHERE audit.audit_id = selected_audit_id;
          RAISE EXCEPTION 'direct audit DELETE unexpectedly succeeded';
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS actual_message = MESSAGE_TEXT;
          IF actual_message NOT LIKE '%account_authorization_audit is append-only; DELETE is not allowed%' THEN
            RAISE EXCEPTION 'unexpected direct audit DELETE error: %', actual_message;
          END IF;
        END;

        BEGIN
          TRUNCATE TABLE public.account_authorization_audit;
          RAISE EXCEPTION 'direct audit TRUNCATE unexpectedly succeeded';
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS actual_message = MESSAGE_TEXT;
          IF actual_message NOT LIKE '%account_authorization_audit is append-only; TRUNCATE is not allowed%' THEN
            RAISE EXCEPTION 'unexpected direct audit TRUNCATE error: %', actual_message;
          END IF;
        END;

        SELECT count(*) INTO audit_count
          FROM public.account_authorization_audit
         WHERE target_account_id = '${targetAccountId}';
        IF audit_count <> 2 THEN
          RAISE EXCEPTION 'audit guard changed rows, got %', audit_count;
        END IF;
      END;
      $$;
      ROLLBACK;
    `], "controlled authorization audit boundary");

    expectPsqlConstraintError(
      runPsql,
      "duplicate active email_lookup_hash",
      `
        BEGIN;
        INSERT INTO public.account_emails (account_id, email_lookup_hash, encrypted_email, created_at)
        VALUES ('${targetAccountId}', decode('11111111111111111111111111111111', 'hex'), decode('aaaaaaaaaaaaaaaa', 'hex'), '${createdAt}');
        INSERT INTO public.account_emails (account_id, email_lookup_hash, encrypted_email, created_at)
        VALUES ('${targetAccountId}', decode('11111111111111111111111111111111', 'hex'), decode('bbbbbbbbbbbbbbbb', 'hex'), '${createdAt}');
        ROLLBACK;
      `,
      "account_emails_lookup_uidx"
    );

    expectPsqlConstraintError(
      runPsql,
      "duplicate active scoped identity",
      `
        BEGIN;
        INSERT INTO public.auth_identities (account_id, issuer_or_tenant, connector_scope, provider_subject, subject_type, created_at, updated_at)
        VALUES ('${targetAccountId}', 'stage-tenant', 'wechat-web', 'subject-duplicate', 'sub', '${createdAt}', '${createdAt}');
        INSERT INTO public.auth_identities (account_id, issuer_or_tenant, connector_scope, provider_subject, subject_type, created_at, updated_at)
        VALUES ('${targetAccountId}', 'stage-tenant', 'wechat-web', 'subject-duplicate', 'sub', '${createdAt}', '${createdAt}');
        ROLLBACK;
      `,
      "auth_identities_scope_subject_uidx"
    );

    expectPsqlConstraintError(
      runPsql,
      "duplicate active legacy session",
      `
        BEGIN;
        INSERT INTO public.auth_sessions (auth_source, environment_id, site_id, session_id_hash, account_id, legacy_netlify_user_id, issued_at, last_seen_at, idle_expires_at, absolute_expires_at, created_at)
        VALUES ('legacy_bridge', 'stage', 'site-stage', decode('22222222222222222222222222222222', 'hex'), '${targetAccountId}', 'legacy-user-duplicate', '${createdAt}', '${createdAt}', '2026-01-01 01:00:00+00', '2026-01-02 00:00:00+00', '${createdAt}');
        INSERT INTO public.auth_sessions (auth_source, environment_id, site_id, session_id_hash, account_id, legacy_netlify_user_id, issued_at, last_seen_at, idle_expires_at, absolute_expires_at, created_at)
        VALUES ('legacy_bridge', 'stage', 'site-stage', decode('33333333333333333333333333333333', 'hex'), '${targetAccountId}', 'legacy-user-duplicate', '${createdAt}', '${createdAt}', '2026-01-01 01:00:00+00', '2026-01-02 00:00:00+00', '${createdAt}');
        ROLLBACK;
      `,
      "auth_sessions_legacy_netlify_user_id_uidx"
    );

    runPsql(["-c", `
      BEGIN;
      INSERT INTO public.auth_sessions (auth_source, environment_id, site_id, session_id_hash, account_id, legacy_netlify_user_id, issued_at, last_seen_at, idle_expires_at, absolute_expires_at, created_at)
      VALUES ('legacy_bridge', 'stage', 'site-stage', decode('44444444444444444444444444444444', 'hex'), '${targetAccountId}', 'legacy-user-cross-environment', '${createdAt}', '${createdAt}', '2026-01-01 01:00:00+00', '2026-01-02 00:00:00+00', '${createdAt}');
      INSERT INTO public.auth_sessions (auth_source, environment_id, site_id, session_id_hash, account_id, legacy_netlify_user_id, issued_at, last_seen_at, idle_expires_at, absolute_expires_at, created_at)
      VALUES ('legacy_bridge', 'production', 'site-production', decode('55555555555555555555555555555555', 'hex'), '${targetAccountId}', 'legacy-user-cross-environment', '${createdAt}', '${createdAt}', '2026-01-01 01:00:00+00', '2026-01-02 00:00:00+00', '${createdAt}');
      ROLLBACK;
    `], "legacy session cross-environment/site scope");
    console.log("legacy session cross-environment/site scope: PASS");

    runPsql(["-c", `
      BEGIN;
      INSERT INTO public.auth_sessions (auth_source, environment_id, site_id, session_id_hash, account_id, legacy_netlify_user_id, issued_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at, created_at)
      VALUES ('legacy_bridge', 'stage', 'site-stage', decode('66666666666666666666666666666666', 'hex'), '${targetAccountId}', 'legacy-user-revoked-replace', '${createdAt}', '${createdAt}', '2026-01-01 01:00:00+00', '2026-01-02 00:00:00+00', '${createdAt}', '${createdAt}');
      INSERT INTO public.auth_sessions (auth_source, environment_id, site_id, session_id_hash, account_id, legacy_netlify_user_id, issued_at, last_seen_at, idle_expires_at, absolute_expires_at, created_at)
      VALUES ('legacy_bridge', 'stage', 'site-stage', decode('77777777777777777777777777777777', 'hex'), '${targetAccountId}', 'legacy-user-revoked-replace', '${createdAt}', '${createdAt}', '2026-01-01 01:00:00+00', '2026-01-02 00:00:00+00', '${createdAt}');
      ROLLBACK;
    `], "revoked legacy session replacement");
    console.log("revoked legacy session replacement: PASS");

    expectPsqlConstraintError(
      runPsql,
      "OAuth missing nonce/PKCE",
      `
        BEGIN;
        INSERT INTO public.oauth_transactions (transaction_kind, state_hash, environment_id, site_id, next_path, created_at, expires_at)
        VALUES ('oauth', decode('44444444444444444444444444444444', 'hex'), 'stage', 'site-stage', '/auth/callback', '${createdAt}', '2026-01-01 00:10:00+00');
        ROLLBACK;
      `,
      "oauth_transactions_credentials_check"
    );
    console.log("PostgreSQL schema smoke: PASS");
  } catch (error) {
    failure = error;
  } finally {
    if (derivedBaseCreated) {
      try {
        rmSync(derivedBasePath);
        console.log("pre-batch base cleanup: PASS");
      } catch (cleanupError) {
        if (!failure) failure = cleanupError;
        else console.error("pre-batch base cleanup failed: " + cleanupError.message);
      }
    }
    if (seeded) {
      try {
        runPsql(["-c", `
          BEGIN;
          DELETE FROM public.account_emails
           WHERE account_id IN ('${targetAccountId}', '${adminAccountId}', '${nonAdminAccountId}');
          DELETE FROM public.auth_identities
           WHERE account_id IN ('${targetAccountId}', '${adminAccountId}', '${nonAdminAccountId}');
          DELETE FROM public.auth_sessions
           WHERE account_id IN ('${targetAccountId}', '${adminAccountId}', '${nonAdminAccountId}');
          DELETE FROM public.oauth_transactions
           WHERE account_id IN ('${targetAccountId}', '${adminAccountId}', '${nonAdminAccountId}');
          DELETE FROM public.account_merge_operations
           WHERE source_account_id IN ('${targetAccountId}', '${adminAccountId}', '${nonAdminAccountId}')
              OR target_account_id IN ('${targetAccountId}', '${adminAccountId}', '${nonAdminAccountId}')
              OR requested_by_account_id IN ('${targetAccountId}', '${adminAccountId}', '${nonAdminAccountId}');
          DELETE FROM public.ai_hourly_limits
           WHERE account_id IN ('${targetAccountId}', '${adminAccountId}', '${nonAdminAccountId}');
          DELETE FROM public.auth_migration_batches
           WHERE source IN ('${batchSource}', 'mismatch-count', 'conflict-count', 'missing-completed-at', 'bff-insert')
             AND environment_id = '${batchEnvironmentId}'
             AND site_id = '${batchSiteId}';
          DELETE FROM public.migration_records
           WHERE account_id IN ('${targetAccountId}', '${adminAccountId}', '${nonAdminAccountId}');
          DELETE FROM public.auth_authorization_mutation_context
           WHERE target_account_id IN ('${targetAccountId}', '${adminAccountId}', '${nonAdminAccountId}');
          DELETE FROM public.accounts
           WHERE account_id IN ('${targetAccountId}', '${adminAccountId}', '${nonAdminAccountId}');
          COMMIT;
        `], "smoke cleanup");
        console.log("smoke cleanup: PASS");
      } catch (cleanupError) {
        if (!failure) failure = cleanupError;
        else console.error(`smoke cleanup failed: ${cleanupError.message}`);
      }
    }
  }
  if (failure) throw failure;
}

const invokedScript = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (invokedScript === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
