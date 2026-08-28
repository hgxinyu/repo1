import { sql as defaultSql } from "./db.mjs";
import { isValidAccountId } from "./account-repository.mjs";

function query(adapter, parts, values = []) {
  const strings = Array.from(parts);
  strings.raw = Array.from(parts);
  if (typeof adapter === "function") return adapter(strings, ...values);
  if (adapter && typeof adapter.query === "function") {
    const text = strings.reduce(
      (result, part, index) => `${result}${part}${index < values.length ? `$${index + 1}` : ""}`,
      ""
    );
    return adapter.query(text, values);
  }
  throw new TypeError("AI rate-limit SQL adapter must be a tagged function or query object");
}

async function rowsFrom(result) {
  const value = await result;
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.rows)) return value.rows;
  return [];
}

function accountIdValue(value) {
  const accountId = String(value ?? "").trim();
  if (!isValidAccountId(accountId)) throw new Error("AUTH_ACCOUNT_INVALID");
  return accountId.toLowerCase();
}

function dateValue(value) {
  const date = value === undefined || value === null ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("AUTH_TIME_INVALID");
  return date;
}

function hourStart(value) {
  const date = dateValue(value);
  date.setUTCMinutes(0, 0, 0);
  return date;
}

/**
 * The only AI quota write path. PostgreSQL owns the counter increment so
 * concurrent requests cannot lose updates; no legacy email/Blob key is
 * consulted or written.
 */
export function createAiRateLimitRepository(overrides = {}) {
  const sql = overrides.sql || defaultSql;
  if (typeof sql !== "function" && !(sql && typeof sql.query === "function")) {
    throw new Error("AUTH_REPOSITORY_DEPENDENCY_MISSING");
  }
  const clock = overrides.clock || (() => new Date());
  if (typeof clock !== "function") throw new Error("AUTH_DEPENDENCY_MISSING");

  return {
    async increment(input = {}) {
      const accountId = accountIdValue(input.accountId);
      dateValue(input.now ?? clock());
      const rows = await rowsFrom(query(
        sql,
        [
          `INSERT INTO ai_hourly_limits (account_id, hour_start, count)
           VALUES (`,
          `, date_trunc('hour', now()), 1)
           ON CONFLICT (account_id, hour_start)
           DO UPDATE SET count = ai_hourly_limits.count + 1,
                         updated_at = now()
           RETURNING count, hour_start`
        ],
        [accountId]
      ));
      if (rows.length !== 1) throw new Error("AI_RATE_LIMIT_UPDATE_FAILED");
      const count = Number(rows[0].count);
      const databaseHour = rows[0].hour_start ?? rows[0].hourStart;
      if (!Number.isSafeInteger(count) || count < 1 || databaseHour === undefined || databaseHour === null) {
        throw new Error("AI_RATE_LIMIT_UPDATE_FAILED");
      }
      const returnedHour = hourStart(databaseHour);
      return {
        accountId,
        count,
        hourStart: returnedHour,
        resetAt: new Date(returnedHour.getTime() + 60 * 60 * 1000)
      };
    }
  };
}

export async function incrementAiHourlyLimit(input, deps = {}) {
  return createAiRateLimitRepository(deps).increment(input);
}
