import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { hashSnapshot, stableStringify } from "./transform.mjs";

const LEGACY_SOURCE = "netlify_identity";
const PRODUCTION_ENVIRONMENT = "production";

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

function snapshotError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredProductionFreezeAt(value) {
  const candidate = text(value);
  if (!candidate) throw snapshotError("MIGRATION_FREEZE_AT_REQUIRED");
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp) || timestamp < Date.UTC(2000, 0, 1) || timestamp > Date.now() + 5 * 60 * 1000) {
    throw snapshotError("MIGRATION_FREEZE_AT_INVALID");
  }
  return new Date(timestamp).toISOString();
}

/**
 * Validate the explicit production/source boundary before any Netlify module
 * is loaded or any source adapter is called. This does not freeze Netlify
 * itself; the operator must stop legacy writes before invoking the capture.
 */
export function assertProductionSnapshotBoundary({
  env = process.env,
  confirmProductionRead = false,
  sourceFrozen = false,
  runtimeSiteId
} = {}) {
  if (confirmProductionRead !== true) {
    throw snapshotError("AUTH_MIGRATION_PRODUCTION_READ_CONFIRMATION_REQUIRED");
  }
  if (sourceFrozen !== true) throw snapshotError("AUTH_MIGRATION_SOURCE_FREEZE_REQUIRED");

  const environmentId = text(env?.AUTH_ENV_ID);
  if (environmentId !== PRODUCTION_ENVIRONMENT) {
    throw snapshotError("AUTH_MIGRATION_PRODUCTION_REQUIRED");
  }

  const siteId = text(env?.NETLIFY_SITE_ID);
  const expectedSiteId = text(env?.AUTH_EXPECTED_SITE_ID);
  if (!siteId || !expectedSiteId || siteId !== expectedSiteId) {
    throw snapshotError("AUTH_MIGRATION_SITE_MISMATCH");
  }

  for (const candidate of [runtimeSiteId, env?.SITE_ID]) {
    const observedSiteId = text(candidate);
    if (observedSiteId && observedSiteId !== siteId) {
      throw snapshotError("AUTH_MIGRATION_SITE_MISMATCH");
    }
  }

  for (const candidate of [env?.CONTEXT, env?.NETLIFY_CONTEXT]) {
    const context = text(candidate);
    if (context && context !== PRODUCTION_ENVIRONMENT) {
      throw snapshotError("AUTH_MIGRATION_PRODUCTION_CONTEXT_REQUIRED");
    }
  }

  for (const candidate of [env?.URL, env?.DEPLOY_PRIME_URL]) {
    const siteUrl = text(candidate);
    if (!siteUrl) continue;
    let parsed;
    try {
      parsed = new URL(siteUrl);
    } catch {
      throw snapshotError("AUTH_MIGRATION_PRODUCTION_CONTEXT_REQUIRED");
    }
    if (parsed.protocol !== "https:" || ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
      throw snapshotError("AUTH_MIGRATION_PRODUCTION_CONTEXT_REQUIRED");
    }
  }

  return Object.freeze({
    environmentId,
    siteId,
    source: LEGACY_SOURCE
  });
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

function normalizeNetlifyIdentityUser(user) {
  if (!user || typeof user !== "object" || Array.isArray(user)) {
    throw snapshotError("MIGRATION_IDENTITY_USER_INVALID");
  }
  const id = text(user.id ?? user.user_id ?? user.userId ?? user.netlify_user_id ?? user.netlifyUserId ?? user._id);
  const email = text(user.email ?? user.email_address ?? user.emailAddress) ||
    text(user.user_metadata?.email ?? user.userMetadata?.email);
  const confirmedAt = text(user.confirmed_at ?? user.confirmedAt);
  const explicitVerified = user.email_verified ?? user.emailVerified;
  if (explicitVerified !== undefined && typeof explicitVerified !== "boolean") {
    throw snapshotError("MIGRATION_IDENTITY_VERIFICATION_INVALID");
  }
  const emailVerified = typeof explicitVerified === "boolean"
    ? explicitVerified
    : Boolean(confirmedAt);
  const normalized = {
    email_verified: emailVerified,
    confirmed_at: confirmedAt
  };
  if (id) normalized.id = id;
  if (email) normalized.email = email;
  return normalized;
}

function normalizeNetlifyProfile(profile, key) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw snapshotError("MIGRATION_PROFILE_RECORD_INVALID");
  }
  const normalized = {
    key,
    email: text(profile.email ?? profile.email_address ?? profile.emailAddress),
    id: text(profile.id ?? profile.user_id ?? profile.userId ?? profile.netlify_user_id ?? profile.netlifyUserId ??
      profile.identityUserId ?? profile.identity_user_id),
    role: text(profile.role),
    status: text(profile.status),
    guild: text(profile.guild ?? profile.Guild),
    gameName: text(profile.gameName ?? profile.game_name ?? profile.game_name_text ?? profile.GameName)
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== null));
}

/**
 * Build explicitly injected read-only Netlify readers for an operator-owned
 * composition root. Neither reader exposes a write method; the default CLI
 * still accepts fixture files only. The runtime composition below also
 * requires caller-owned adapters and never imports a credential-bearing SDK.
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
      if (!store || typeof store.list !== "function" || typeof store.get !== "function") {
        throw snapshotError("MIGRATION_PROFILE_STORE_INVALID");
      }
      const listing = await store.list({ prefix: "users/" });
      if (!listing || typeof listing !== "object" || !Array.isArray(listing.blobs)) {
        throw snapshotError("MIGRATION_PROFILES_INVALID");
      }
      const profiles = [];
      const keys = new Set();
      for (const entry of listing.blobs) {
        if (!entry || typeof entry !== "object" || typeof entry.key !== "string" || !entry.key.startsWith("users/")) {
          throw snapshotError("MIGRATION_PROFILE_ENTRY_INVALID");
        }
        if (keys.has(entry.key)) throw snapshotError("MIGRATION_PROFILE_DUPLICATE_KEY");
        keys.add(entry.key);
        const profile = await store.get(entry.key, { type: "json" });
        if (profile === null || profile === undefined) throw snapshotError("MIGRATION_PROFILE_RECORD_MISSING");
        profiles.push(normalizeNetlifyProfile(profile, entry.key));
      }
      return profiles;
    },
    async listIdentityUsers() {
      const users = [];
      for (let page = 1; page <= identityMaxPages; page += 1) {
        const pageRows = await identityAdmin.listUsers({ page, perPage: identityPageSize });
        if (!Array.isArray(pageRows)) throw new Error("MIGRATION_IDENTITY_PAGE_INVALID");
        users.push(...pageRows.map(normalizeNetlifyIdentityUser));
        if (pageRows.length < identityPageSize) return users;
      }
      throw new Error("MIGRATION_IDENTITY_PAGINATION_LIMIT");
    }
  };
}

/**
 * Compose the production source capture with explicitly supplied, read-only
 * Netlify adapters. The normal fixture CLI never calls this composition root.
 */
export function createNetlifyProductionSnapshotComposition({
  env = process.env,
  confirmProductionRead = false,
  sourceFrozen = false,
  runtimeSiteId,
  getStore,
  identityAdmin,
  storeName = "vip-users",
  identityPageSize = 100,
  identityMaxPages = 10_000
} = {}) {
  const boundary = assertProductionSnapshotBoundary({
    env,
    confirmProductionRead,
    sourceFrozen,
    runtimeSiteId
  });
  const readers = createNetlifyReadOnlyReaders({
    getStore,
    identityAdmin,
    storeName,
    identityPageSize,
    identityMaxPages
  });
  const frozenReaders = Object.freeze(readers);

  return Object.freeze({
    boundary,
    readers: frozenReaders,
    async capture({
      migrationId,
      snapshotId,
      freezeAt,
      adminEmails = [],
      metadata = {}
    } = {}) {
      const captureFreezeAt = requiredProductionFreezeAt(freezeAt);
      const metadataObject = metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata
        : {};
      return captureLegacySnapshot({
        migrationId,
        snapshotId,
        freezeAt: captureFreezeAt,
        adminEmails,
        metadata: {
          ...metadataObject,
          productionBoundary: boundary
        },
        ...frozenReaders
      });
    }
  });
}

/**
 * Compose the same capture from explicitly constructed runtime adapters. The
 * caller owns the controlled HTTPS Admin API/Blob clients (for example in an
 * operator-only Netlify runtime); this module never imports a deprecated
 * Identity SDK or creates a credential-bearing client by itself.
 */
export function createNetlifyRuntimeSnapshotComposition(options = {}) {
  const {
    netlifyModules,
    ...compositionOptions
  } = options || {};
  assertProductionSnapshotBoundary(compositionOptions);

  const getStore = netlifyModules?.getStore;
  const identityAdmin = netlifyModules?.admin ?? netlifyModules?.identityAdmin;
  if (typeof getStore !== "function" || !identityAdmin || typeof identityAdmin.listUsers !== "function") {
    throw snapshotError("MIGRATION_RUNTIME_ADAPTER_REQUIRED");
  }
  return createNetlifyProductionSnapshotComposition({
    ...compositionOptions,
    getStore,
    identityAdmin
  });
}

export async function writeSnapshotFile(snapshot, outputFile) {
  if (!outputFile) throw snapshotError("MIGRATION_SNAPSHOT_OUTPUT_REQUIRED");
  await writeFile(outputFile, `${stableStringify(snapshot)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
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
  const outputFile = argumentValue(argv, ["--output", "--output-file"]);
  await writeSnapshotFile(snapshot, outputFile);
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
