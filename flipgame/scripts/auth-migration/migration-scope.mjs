const MIGRATION_SCOPE_LOCK_NAMESPACE = 772941;

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function migrationError(code, message = code, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.statusCode = status;
  return error;
}

function query(adapter, parts, values = []) {
  const strings = Array.from(parts);
  strings.raw = Array.from(parts);
  if (typeof adapter === "function") return adapter(strings, ...values);
  if (adapter && typeof adapter.query === "function") {
    const sqlText = strings.reduce(
      (result, part, index) => `${result}${part}${index < values.length ? `$${index + 1}` : ""}`,
      ""
    );
    return adapter.query(sqlText, values);
  }
  throw migrationError("AUTH_MIGRATION_ADAPTER_INVALID", "Migration adapter is invalid", 503);
}

async function rowsFrom(result) {
  const value = await result;
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.rows)) return value.rows;
  return [];
}

function scopeValues({ source, environmentId, siteId } = {}) {
  const values = [text(source), text(environmentId), text(siteId)];
  if (values.some((value) => !value)) {
    throw migrationError("AUTH_MIGRATION_SCOPE_REQUIRED", "Migration scope is required", 400);
  }
  return values;
}

/** Serialize every importer/finalizer operation for one migration scope. */
export async function lockMigrationScope(transaction, scope) {
  const values = scopeValues(scope);
  await rowsFrom(query(
    transaction,
    [
      `SELECT pg_advisory_xact_lock(hashtextextended(CAST(`,
      ` AS text) || chr(31) || CAST(`,
      ` AS text) || chr(31) || CAST(`,
      ` AS text), ${MIGRATION_SCOPE_LOCK_NAMESPACE}))`
    ],
    values
  ));
}

/** Read the exact scope row while the shared transaction lock is held. */
export async function readScopedMigrationBatchForUpdate(transaction, scope) {
  const values = scopeValues(scope);
  const rows = await rowsFrom(query(
    transaction,
    [
      `SELECT source, environment_id, site_id, snapshot_id, snapshot_hash, status,
              source_count, imported_count, conflict_count, freeze_at, completed_at
       FROM auth_migration_batches
       WHERE source = `,
      ` AND environment_id = `,
      ` AND site_id = `,
      ` FOR UPDATE`
    ],
    values
  ));
  if (rows.length > 1) throw migrationError("AUTH_MIGRATION_BATCH_CONFLICT");
  return rows[0] || null;
}
