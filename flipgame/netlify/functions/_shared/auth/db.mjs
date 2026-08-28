import postgres from "postgres";
import { assertAuthEnvironment } from "./config.mjs";

let client;
let clientEnvironmentKey;

function environmentKey() {
  const identity = assertAuthEnvironment(process.env);
  return [
    identity.environmentId,
    identity.siteId,
    String(process.env.AUTH_DATABASE_URL).trim(),
    String(process.env.LOGTO_ENDPOINT).trim(),
    String(process.env.LOGTO_APP_ID).trim()
  ].join("\u0000");
}

function getClient() {
  const key = environmentKey();
  if (!client) {
    client = postgres(String(process.env.AUTH_DATABASE_URL).trim(), {
      max: 4,
      idle_timeout: 20
    });
    clientEnvironmentKey = key;
  } else if (clientEnvironmentKey !== key) {
    throw new Error("AUTH_ENV_MISMATCH:DATABASE");
  }
  return client;
}

function taggedSql(strings, ...values) {
  return getClient()(strings, ...values);
}

taggedSql.begin = (...args) => getClient().begin(...args);
taggedSql.end = (...args) => getClient().end(...args);

export const sql = taggedSql;

export function withTransaction(callback) {
  if (typeof callback !== "function") {
    throw new TypeError("withTransaction callback must be a function");
  }
  return sql.begin(async (transaction) => callback(transaction));
}
