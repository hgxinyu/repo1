const SENTINEL_AUTH_SETTINGS = [
  "AUTH_ENV_ID",
  "AUTH_EXPECTED_SITE_ID",
  "NETLIFY_SITE_ID",
  "LOGTO_ENDPOINT"
];

const REQUIRED_CONNECTION_SETTINGS = ["NETLIFY_DB_URL", "LOGTO_APP_ID"];

/** Normalize URL-based tenant identifiers to the same URL.href everywhere. */
export function canonicalIssuer(value) {
  if (typeof value !== "string" || value.trim() === "" || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("AUTH_CONFIG_INVALID:LOGTO_ENDPOINT");
  }
  const normalized = value.trim();
  try {
    return new URL(normalized).href;
  } catch {
    // Existing repository contract tests and non-URL tenant labels remain
    // valid identifiers; URL-based issuers still receive URL.href parity.
    return normalized;
  }
}

function requiredValue(environment, name) {
  const value = String(environment?.[name] ?? "").trim();
  if (!value) throw new Error(`AUTH_CONFIG_MISSING:${name}`);
  return value;
}

export function assertAuthEnvironment(env = process.env) {
  const environment = env ?? process.env;
  const values = {};
  for (const name of SENTINEL_AUTH_SETTINGS) {
    values[name] = requiredValue(environment, name);
  }

  if (values.AUTH_EXPECTED_SITE_ID !== values.NETLIFY_SITE_ID) {
    throw new Error("AUTH_ENV_MISMATCH:SITE");
  }

  let logtoEndpoint;
  try {
    logtoEndpoint = new URL(canonicalIssuer(values.LOGTO_ENDPOINT));
  } catch {
    throw new Error("AUTH_ENV_MISMATCH:LOGTO");
  }
  if (
    logtoEndpoint.protocol !== "https:" ||
    !logtoEndpoint.hostname.toLowerCase().endsWith(".logto.app")
  ) {
    throw new Error("AUTH_ENV_MISMATCH:LOGTO");
  }

  for (const name of REQUIRED_CONNECTION_SETTINGS) {
    values[name] = requiredValue(environment, name);
  }

  return Object.freeze({
    environmentId: values.AUTH_ENV_ID,
    siteId: values.NETLIFY_SITE_ID
  });
}
