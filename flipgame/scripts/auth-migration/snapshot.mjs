import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { hashSnapshot, stableStringify } from "./transform.mjs";

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function compareStrings(left, right) {
  const first = String(left);
  const second = String(right);
  return first < second ? -1 : first > second ? 1 : 0;
}

function arrayValue(value, names = []) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const name of names) if (Array.isArray(value[name])) return value[name];
  return [];
}

function rowsValue(value, names, errorCode) {
  const rows = arrayValue(value, names);
  const valid = Array.isArray(value) || (value && typeof value === "object" && names.some((name) => Array.isArray(value[name])));
  if (!valid) throw new Error(errorCode);
  return rows;
}

function clone(value) {
  return JSON.parse(stableStringify(value));
}

function normalizedAdminEmails(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => text(value)?.toLowerCase())
    .filter(Boolean))].sort(compareStrings);
}

/** Create a local immutable snapshot object. This function has no network/Blob dependencies. */
export function createSnapshot({
  migrationId,
  snapshotId,
  freezeAt = null,
  adminEmails = [],
  profiles,
  identityUsers,
  metadata = {}
} = {}) {
  const migration = text(migrationId);
  if (!migration) throw new Error("MIGRATION_ID_REQUIRED");
  if (profiles === undefined) throw new Error("MIGRATION_PROFILES_REQUIRED");
  if (identityUsers === undefined) throw new Error("MIGRATION_IDENTITY_USERS_REQUIRED");
  if (!Array.isArray(profiles)) throw new Error("MIGRATION_PROFILES_INVALID");
  if (!Array.isArray(identityUsers)) throw new Error("MIGRATION_IDENTITY_USERS_INVALID");
  const extras = metadata && typeof metadata === "object" ? clone(metadata) : {};
  const base = {
    ...extras,
    schemaVersion: 1,
    snapshotId: text(snapshotId) || "snapshot-pending",
    migrationId: migration,
    freezeAt: text(freezeAt),
    adminEmails: normalizedAdminEmails(adminEmails),
    profiles: clone(profiles),
    identityUsers: clone(identityUsers)
  };
  if (!text(snapshotId)) {
    const provisional = hashSnapshot(base);
    base.snapshotId = `snapshot-${provisional.slice(0, 16)}`;
  }
  base.snapshotHash = hashSnapshot(base);
  return base;
}

/**
 * Capture data supplied by explicit local/test readers. The production CLI
 * intentionally has no Netlify/Identity reader, keeping default execution
 * fixture-only and read-only.
 */
export async function captureLegacySnapshot({
  migrationId,
  snapshotId,
  freezeAt = null,
  adminEmails = [],
  listProfiles,
  listIdentityUsers,
  metadata = {}
} = {}) {
  if (typeof listProfiles !== "function" || typeof listIdentityUsers !== "function") {
    throw new Error("MIGRATION_SOURCE_ADAPTER_REQUIRED");
  }
  const profiles = await listProfiles();
  const identityUsers = await listIdentityUsers();
  return createSnapshot({
    migrationId,
    snapshotId,
    freezeAt,
    adminEmails,
    profiles: rowsValue(profiles, ["profiles", "rows", "blobs", "users"], "MIGRATION_PROFILES_INVALID"),
    identityUsers: rowsValue(identityUsers, ["identityUsers", "identity_users", "users", "rows"], "MIGRATION_IDENTITY_USERS_INVALID"),
    metadata
  });
}

/**
 * Build explicitly injected read-only Netlify readers for an operator-owned
 * composition root. No Netlify package is imported here and neither reader
 * exposes a write method; the default CLI still accepts fixture files only.
 */
export function createNetlifyReadOnlyReaders({
  getStore,
  identityAdmin,
  storeName = "vip-users",
  identityPageSize = 100,
  identityMaxPages = 10_000
} = {}) {
  if (typeof getStore !== "function" || !identityAdmin || typeof identityAdmin.listUsers !== "function") {
    throw new Error("MIGRATION_SOURCE_ADAPTER_REQUIRED");
  }
  if (!Number.isInteger(identityPageSize) || identityPageSize < 1 || identityPageSize > 1000 ||
      !Number.isInteger(identityMaxPages) || identityMaxPages < 1 || identityMaxPages > 10_000) {
    throw new Error("MIGRATION_IDENTITY_PAGINATION_INVALID");
  }
  return {
    async listProfiles() {
      const store = getStore({ name: storeName, consistency: "strong" });
      const listing = await store.list({ prefix: "users/" });
      const profiles = [];
      for (const entry of listing?.blobs || []) {
        const profile = await store.get(entry.key, { type: "json" });
        if (profile) profiles.push({ ...profile, key: entry.key });
      }
      return profiles;
    },
    async listIdentityUsers() {
      const users = [];
      for (let page = 1; page <= identityMaxPages; page += 1) {
        const pageRows = await identityAdmin.listUsers({ page, perPage: identityPageSize });
        if (!Array.isArray(pageRows)) throw new Error("MIGRATION_IDENTITY_PAGE_INVALID");
        users.push(...pageRows);
        if (pageRows.length < identityPageSize) return users;
      }
      throw new Error("MIGRATION_IDENTITY_PAGINATION_LIMIT");
    }
  };
}

export async function readJsonFixture(file) {
  if (!file) throw new Error("MIGRATION_FIXTURE_REQUIRED");
  return JSON.parse(await readFile(file, "utf8"));
}

function argumentValue(argv, names) {
  for (const name of names) {
    const index = argv.indexOf(name);
    if (index !== -1) return argv[index + 1] || null;
  }
  return null;
}

async function readFixtureRows(file, names) {
  const value = await readJsonFixture(file);
  return rowsValue(value, names, "MIGRATION_FIXTURE_ROWS_INVALID");
}

async function main(argv = process.argv.slice(2)) {
  const migrationId = argumentValue(argv, ["--migration-id"]);
  const profilesFile = argumentValue(argv, ["--profiles-file", "--profile-file"]);
  const identityFile = argumentValue(argv, ["--identity-users-file", "--identity-file"]);
  if (!migrationId || !profilesFile || !identityFile) {
    throw new Error("Usage: node snapshot.mjs --migration-id <id> --profiles-file <file> --identity-users-file <file> --output <file>");
  }
  const adminFile = argumentValue(argv, ["--admin-emails-file"]);
  const adminArgument = argumentValue(argv, ["--admin-emails"]);
  const adminEmails = adminFile
    ? arrayValue(await readJsonFixture(adminFile), ["adminEmails", "admin_emails", "emails"])
    : String(adminArgument || "").split(",").map((value) => value.trim()).filter(Boolean);
  const snapshot = createSnapshot({
    migrationId,
    snapshotId: argumentValue(argv, ["--snapshot-id"]),
    freezeAt: argumentValue(argv, ["--freeze-at"]),
    adminEmails,
    profiles: await readFixtureRows(profilesFile, ["profiles", "rows", "blobs", "users"]),
    identityUsers: await readFixtureRows(identityFile, ["identityUsers", "identity_users", "users", "rows"])
  });
  const output = `${stableStringify(snapshot)}\n`;
  const outputFile = argumentValue(argv, ["--output", "--output-file"]);
  if (!outputFile) throw new Error("MIGRATION_SNAPSHOT_OUTPUT_REQUIRED");
  await writeFile(outputFile, output, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    status: "snapshot_created",
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    profileCount: snapshot.profiles.length,
    identityUserCount: snapshot.identityUsers.length
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
