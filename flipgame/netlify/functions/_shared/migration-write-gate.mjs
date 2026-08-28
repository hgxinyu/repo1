const MIGRATION_WRITE_MODES = new Set(["legacy", "frozen", "account"]);

function migrationWriteError(code, operation, message = code) {
  const error = new Error(message);
  error.code = code;
  error.status = 503;
  error.statusCode = 503;
  error.operation = operation;
  return error;
}

/** Read the migration mode without ever defaulting to a writable mode. */
export function getMigrationWriteMode(env = process.env) {
  const raw = env && typeof env === "object" ? env.MIGRATION_WRITE_MODE : undefined;
  const mode = String(raw || "").trim().toLowerCase();
  if (!MIGRATION_WRITE_MODES.has(mode)) {
    throw migrationWriteError("AUTH_MIGRATION_MODE_INVALID", "migration-mode");
  }
  return mode;
}

/**
 * Gate every legacy Blob write. Account-mode callers must use the Postgres
 * account adapters; they may not silently continue writing the legacy store.
 */
export function assertLegacyWriteAllowed(operation, env = process.env) {
  const name = String(operation || "legacy-write").trim() || "legacy-write";
  const mode = getMigrationWriteMode(env);
  if (mode === "frozen") {
    throw migrationWriteError("AUTH_MIGRATION_FROZEN", name, "Legacy writes are frozen during account migration");
  }
  if (mode === "account") {
    throw migrationWriteError("AUTH_MIGRATION_ACCOUNT_MODE", name, "Legacy Blob writes are disabled in account mode");
  }
  return mode;
}
