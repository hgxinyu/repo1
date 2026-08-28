import { createHash } from "node:crypto";

const ROLES = ["pending", "free", "vip", "admin", "blocked"];
const ROLE_SET = new Set(ROLES);
const SOURCE = "netlify_identity";

function compareStrings(left, right) {
  const first = String(left);
  const second = String(right);
  return first < second ? -1 : first > second ? 1 : 0;
}

function valueAt(object, names) {
  if (!object || typeof object !== "object") return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(object, name) && object[name] !== undefined) {
      return object[name];
    }
  }
  return undefined;
}

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

export function normalizeEmail(value) {
  const email = text(value);
  return email ? email.toLowerCase() : null;
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value
      .map(canonicalValue)
      .sort((left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => key !== "snapshotHash" && value[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalValue(value[key])])
    );
  }
  return value;
}

/** JSON serialization with sorted object keys and order-independent arrays. */
export function stableStringify(value) {
  return JSON.stringify(canonicalValue(value));
}

export function hashSnapshot(snapshot) {
  return createHash("sha256").update(stableStringify(snapshot)).digest("hex");
}

/**
 * Derive a UUID-shaped account ID from the migration and immutable legacy ID.
 * The email is deliberately not an input to this function.
 */
export function deriveAccountId(migrationId, immutableNetlifyUserId) {
  const migration = text(migrationId);
  const userId = text(immutableNetlifyUserId);
  if (!migration || !userId) throw new Error("MIGRATION_IDENTITY_REQUIRED");
  const digest = createHash("sha256")
    .update(migration)
    .update("\u0000")
    .update(userId)
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function roleOf(profile) {
  const raw = text(valueAt(profile, ["role", "Role"]));
  return raw ? raw.toLowerCase() : null;
}

/**
 * Map the legacy profile status conservatively. Pending/free records never
 * acquire a privileged role from a status string; vip/admin require the
 * explicit legacy approval status. Missing pending/free status is retained as
 * a non-privileged active account with an audit warning.
 */
function statusOf(profile, role) {
  const rawValue = valueAt(profile, ["status", "Status"]);
  const raw = text(rawValue)?.toLowerCase() || null;
  if (!raw) {
    if (role === "pending" || role === "free") {
      return { status: "active", warningCode: "STATUS_DEFAULTED_CONSERVATIVE" };
    }
    return { status: null, conflictCode: role === "blocked" ? "BLOCKED_STATUS_MISMATCH" : "MISSING_STATUS" };
  }
  if (raw === "blocked") return { status: "blocked" };
  if (!["pending", "approved", "active"].includes(raw)) {
    return { status: null, conflictCode: "UNKNOWN_STATUS" };
  }
  if (role === "blocked") return { status: null, conflictCode: "BLOCKED_STATUS_MISMATCH" };
  if ((role === "vip" || role === "admin") && raw !== "approved") {
    return { status: null, conflictCode: "PRIVILEGED_STATUS_MISMATCH" };
  }
  return { status: "active" };
}

function sourceUserId(identityUser) {
  return text(valueAt(identityUser, [
    "id",
    "user_id",
    "userId",
    "netlify_user_id",
    "netlifyUserId",
    "_id"
  ]));
}

function profileIdentityId(profile) {
  return text(valueAt(profile, [
    "id",
    "user_id",
    "userId",
    "netlify_user_id",
    "netlifyUserId",
    "identityUserId",
    "identity_user_id"
  ]));
}

function profileEmail(profile) {
  const direct = valueAt(profile, ["email", "email_address", "emailAddress"]);
  if (direct !== undefined) return normalizeEmail(direct);
  const key = text(valueAt(profile, ["key", "blobKey", "blob_key"]));
  const match = key?.match(/^users\/(.+)\.json$/u);
  if (!match) return null;
  try {
    return normalizeEmail(decodeURIComponent(match[1]));
  } catch (error) {
    return null;
  }
}

function identityEmail(identityUser) {
  const direct = valueAt(identityUser, ["email", "email_address", "emailAddress"]);
  if (direct !== undefined) return normalizeEmail(direct);
  const metadata = valueAt(identityUser, ["user_metadata", "userMetadata"]);
  return normalizeEmail(valueAt(metadata, ["email", "email_address", "emailAddress"]));
}

function validTimestamp(value) {
  const candidate = text(value);
  if (!candidate || !Number.isFinite(Date.parse(candidate))) return null;
  return candidate;
}

function confirmationOf(identityUser, profile, freezeAt) {
  const confirmedAtValue = valueAt(identityUser, [
    "emailConfirmedAt",
    "email_confirmed_at",
    "confirmedAt",
    "confirmed_at"
  ]) ?? valueAt(profile, [
    "emailConfirmedAt",
    "email_confirmed_at",
    "confirmedAt",
    "confirmed_at"
  ]);
  const confirmedAt = validTimestamp(confirmedAtValue);
  const explicit = valueAt(identityUser, ["emailVerified", "email_verified"]);
  const verified = typeof explicit === "boolean" ? explicit : null;
  if (verified !== true) return { email_verified: verified, email_confirmed_at: null };
  if (confirmedAt) return { email_verified: true, email_confirmed_at: confirmedAt };
  const fallbackAt = validTimestamp(freezeAt);
  if (fallbackAt) {
    return {
      email_verified: true,
      email_confirmed_at: fallbackAt,
      warningCode: "EMAIL_VERIFIED_TIMESTAMP_FALLBACK_FREEZE_AT"
    };
  }
  return {
    email_verified: true,
    email_confirmed_at: null,
    conflictCode: "VERIFIED_TIMESTAMP_REQUIRED"
  };
}

function namesForAdmin(snapshot) {
  const values = valueAt(snapshot, ["adminEmails", "admin_emails"]);
  const list = Array.isArray(values) ? values : String(values || "").split(",");
  return new Set(list.map(normalizeEmail).filter(Boolean));
}

function conflict(code, fields = {}) {
  return { code, ...fields };
}

function warning(code, fields = {}) {
  return { code, ...fields };
}

function sourceKey(source, sourceUserIdValue) {
  return `${source}\u0000${sourceUserIdValue}`;
}

function sortedEntries(entries, keyNames = ["code", "source_user_id", "normalized_email"]) {
  return [...entries].sort((left, right) => {
    for (const key of keyNames) {
      const comparison = compareStrings(left[key] ?? "", right[key] ?? "");
      if (comparison !== 0) return comparison;
    }
    return compareStrings(stableStringify(left), stableStringify(right));
  });
}

function emptyRoleCounts() {
  return Object.fromEntries(ROLES.map((role) => [role, 0]));
}

function requiredSourceArray(snapshot, names, errorCode) {
  const name = names.find((candidate) => Object.prototype.hasOwnProperty.call(snapshot, candidate));
  if (!name) {
    const error = new Error(errorCode);
    error.code = errorCode;
    throw error;
  }
  if (!Array.isArray(snapshot[name])) {
    const invalidCode = `${errorCode}_INVALID`;
    const error = new Error(invalidCode);
    error.code = invalidCode;
    throw error;
  }
  return snapshot[name];
}

/**
 * Convert a read-only legacy snapshot into a stable, privacy-minimized report.
 * Invalid or ambiguous records remain in conflicts and are never importable.
 */
export function transformLegacySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("MIGRATION_SNAPSHOT_INVALID");
  const profiles = requiredSourceArray(
    snapshot,
    ["profiles", "profileRecords", "legacyProfiles"],
    "MIGRATION_PROFILES_REQUIRED"
  );
  const identityUsers = requiredSourceArray(
    snapshot,
    ["identityUsers", "identity_users", "identity"],
    "MIGRATION_IDENTITY_USERS_REQUIRED"
  );
  const migrationId = text(valueAt(snapshot, ["migrationId", "migration_id"]));
  if (!migrationId) throw new Error("MIGRATION_ID_REQUIRED");
  const snapshotHash = hashSnapshot(snapshot);
  const suppliedHash = text(valueAt(snapshot, ["snapshotHash", "snapshot_hash"]));
  const snapshotId = text(valueAt(snapshot, ["snapshotId", "snapshot_id", "id"])) ||
    `snapshot-${snapshotHash.slice(0, 16)}`;
  const adminEmailSet = namesForAdmin(snapshot);
  const conflicts = [];
  const warnings = [];
  const importable = [];
  const roleCounts = emptyRoleCounts();
  const profileByEmail = new Map();
  const identityByEmail = new Map();
  const identityIds = new Map();

  if (suppliedHash && suppliedHash !== snapshotHash) {
    conflicts.push(conflict("SNAPSHOT_HASH_MISMATCH"));
  }

  for (const profileRecord of profiles) {
    const normalizedEmail = profileEmail(profileRecord);
    if (!normalizedEmail) {
      conflicts.push(conflict("PROFILE_MISSING_EMAIL"));
      continue;
    }
    const records = profileByEmail.get(normalizedEmail) || [];
    records.push(profileRecord);
    profileByEmail.set(normalizedEmail, records);
  }

  for (const identityRecord of identityUsers) {
    const normalizedEmail = identityEmail(identityRecord);
    const immutableId = sourceUserId(identityRecord);
    if (immutableId) {
      const records = identityIds.get(immutableId) || [];
      records.push({ identityRecord, normalizedEmail });
      identityIds.set(immutableId, records);
    }
    if (!normalizedEmail) {
      conflicts.push(conflict("IDENTITY_MISSING_EMAIL", immutableId ? { source_user_id: immutableId } : {}));
      continue;
    }
    const records = identityByEmail.get(normalizedEmail) || [];
    records.push({ identityRecord, immutableId });
    identityByEmail.set(normalizedEmail, records);
  }

  const duplicateEmails = new Set();
  for (const [normalizedEmail, records] of profileByEmail) {
    if (records.length > 1) {
      duplicateEmails.add(normalizedEmail);
      conflicts.push(conflict("DUPLICATE_NORMALIZED_EMAIL", {
        source_user_ids: records.map(profileIdentityId).filter(Boolean).sort()
      }));
    }
  }
  for (const [normalizedEmail, records] of identityByEmail) {
    if (records.length > 1) duplicateEmails.add(normalizedEmail);
  }

  const seenSourceKeys = new Set();
  for (const [normalizedEmail, records] of identityByEmail) {
    if (!profileByEmail.has(normalizedEmail)) {
      for (const record of records) {
        conflicts.push(conflict("IDENTITY_WITHOUT_PROFILE", record.immutableId ? {
          source_user_id: record.immutableId
        } : {}));
      }
    }
  }

  for (const [normalizedEmail, profileRecords] of profileByEmail) {
    const profileRecord = profileRecords[0];
    if (duplicateEmails.has(normalizedEmail)) {
      if (profileRecords.length === 1 && (identityByEmail.get(normalizedEmail) || []).length > 1) {
        conflicts.push(conflict("DUPLICATE_NORMALIZED_EMAIL"));
      }
      continue;
    }
    const matches = identityByEmail.get(normalizedEmail) || [];
    if (matches.length === 0) {
      conflicts.push(conflict("PROFILE_WITHOUT_IDENTITY"));
      continue;
    }
    if (matches.length !== 1) continue;
    const { identityRecord, immutableId } = matches[0];
    if (!immutableId) {
      conflicts.push(conflict("MISSING_IMMUTABLE_USER_ID"));
      continue;
    }
    const declaredId = profileIdentityId(profileRecord);
    if (declaredId && declaredId !== immutableId) {
      conflicts.push(conflict("IMMUTABLE_ID_MISMATCH", { source_user_id: immutableId }));
      continue;
    }
    const key = sourceKey(SOURCE, immutableId);
    if (seenSourceKeys.has(key)) {
      conflicts.push(conflict("DUPLICATE_SOURCE_USER_ID", { source_user_id: immutableId }));
      continue;
    }
    if ((identityIds.get(immutableId) || []).length > 1) {
      conflicts.push(conflict("DUPLICATE_SOURCE_USER_ID", { source_user_id: immutableId }));
      continue;
    }
    seenSourceKeys.add(key);

    const rawRole = roleOf(profileRecord);
    if (!rawRole) {
      conflicts.push(conflict("MISSING_ROLE", { source_user_id: immutableId }));
      continue;
    }
    if (!ROLE_SET.has(rawRole)) {
      conflicts.push(conflict("UNKNOWN_ROLE", { source_user_id: immutableId }));
      continue;
    }
    const adminListed = adminEmailSet.has(normalizedEmail);
    if (rawRole === "admin" && !adminListed) {
      conflicts.push(conflict("ADMIN_EMAIL_MISMATCH", { source_user_id: immutableId }));
      continue;
    }
    if (adminListed && rawRole !== "admin") {
      conflicts.push(conflict("ADMIN_EMAIL_ROLE_MISMATCH", { source_user_id: immutableId }));
      continue;
    }
    const statusResult = statusOf(profileRecord, rawRole);
    if (statusResult.conflictCode) {
      conflicts.push(conflict(statusResult.conflictCode, { source_user_id: immutableId }));
      continue;
    }
    const status = statusResult.status;
    // Preserve the legacy role exactly. Canonical authorization treats a
    // blocked status as dominant, so an admin that is blocked must not be
    // silently downgraded during migration.
    const role = rawRole;
    if (statusResult.warningCode) {
      warnings.push(warning(statusResult.warningCode, { source_user_id: immutableId }));
    }
    if (rawRole === "admin" && status === "blocked") {
      warnings.push(warning("BLOCKED_ADMIN_PRESERVED_AS_BLOCKED", { source_user_id: immutableId }));
    }

    const confirmation = confirmationOf(identityRecord, profileRecord, valueAt(snapshot, ["freezeAt", "freeze_at"]));
    if (confirmation.conflictCode) {
      conflicts.push(conflict(confirmation.conflictCode, { source_user_id: immutableId }));
      continue;
    }
    if (confirmation.email_verified !== true) {
      conflicts.push(conflict("EMAIL_NOT_VERIFIED", { source_user_id: immutableId }));
      continue;
    }
    if (confirmation.warningCode) {
      warnings.push(warning(confirmation.warningCode, { source_user_id: immutableId }));
    }
    const row = {
      source: SOURCE,
      source_user_id: immutableId,
      migration_id: migrationId,
      account_id: deriveAccountId(migrationId, immutableId),
      normalized_email: normalizedEmail,
      role,
      status,
      guild: text(valueAt(profileRecord, ["guild", "Guild"])),
      game_name: text(valueAt(profileRecord, ["gameName", "game_name", "game_name_text", "GameName"])),
      email_verified: confirmation.email_verified,
      email_confirmed_at: confirmation.email_confirmed_at,
      snapshot_hash: snapshotHash
    };
    importable.push(row);
    roleCounts[role] += 1;
  }

  for (const normalizedEmail of adminEmailSet) {
    if (!profileByEmail.has(normalizedEmail)) {
      conflicts.push(conflict("ADMIN_EMAIL_WITHOUT_PROFILE", { normalized_email: normalizedEmail }));
    }
  }

  if (identityUsers.length > 0) {
    const seen = new Set(importable.map((row) => row.source_user_id));
    for (const identityRecord of identityUsers) {
      const immutableId = sourceUserId(identityRecord);
      if (immutableId && !seen.has(immutableId) && ![...conflicts].some((entry) => entry.source_user_id === immutableId)) {
        conflicts.push(conflict("IDENTITY_UNMIGRATED", { source_user_id: immutableId }));
      }
    }
  }

  return {
    snapshotId,
    snapshotHash,
    sourceCounts: { profiles: profiles.length, identityUsers: identityUsers.length },
    roleCounts,
    importable: importable.sort((left, right) => compareStrings(left.source_user_id, right.source_user_id)),
    conflicts: sortedEntries(conflicts),
    warnings: sortedEntries(warnings)
  };
}

export { SOURCE as LEGACY_SOURCE };
