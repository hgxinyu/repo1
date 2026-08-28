const SESSION_COOKIE_NAME = "__Host-shinegame_session";
const CSRF_COOKIE_NAME = "__Host-shinegame_csrf";
const PREAUTH_COOKIE_NAME = "__Host-shinegame_preauth";
const OPAQUE_TOKEN_LENGTH = 43;
const OPAQUE_TOKEN_BYTES = 32;

// Redirect targets are deliberately a finite set. Callers may provide a
// narrower allowlist for a flow, but cannot turn this helper into an open
// redirect by passing arbitrary paths.
const DEFAULT_ALLOWED_PATHS = new Set([
  "/",
  "/index.html",
  "/AIAsk.html",
  "/SoulAscensionCalculator.html",
  "/ExpeditionCalculator.html",
  "/AwakeningRushSimulator.html",
  "/CoreCalculator.html",
  "/DestinyCalculator.html",
  "/Login.html",
  "/Register.html",
  "/Admin.html"
]);

export const PRIVATE_RESPONSE_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "Vary": "Cookie"
});

/** Build an auth-boundary JSON response with private/no-store defaults. */
export function authJson(data, init = {}) {
  const headers = new Headers(PRIVATE_RESPONSE_HEADERS);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(init.headers || {})) {
    if (name.toLowerCase() === "set-cookie" && Array.isArray(value)) {
      for (const cookie of value) headers.append(name, cookie);
    } else {
      headers.set(name, value);
    }
  }
  return new Response(JSON.stringify(data), {
    ...init,
    headers
  });
}

/** Build a redirect that never permits provider or user-controlled headers. */
export function authRedirect(target, status = 302, headers = {}) {
  const location = target instanceof URL ? target.href : String(target);
  const responseHeaders = new Headers(PRIVATE_RESPONSE_HEADERS);
  responseHeaders.set("Location", location);
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "set-cookie" && Array.isArray(value)) {
      for (const cookie of value) responseHeaders.append(name, cookie);
    } else {
      responseHeaders.set(name, value);
    }
  }
  return new Response(null, { status, headers: responseHeaders });
}

function invalidNext() {
  return new Error("INVALID_NEXT");
}

function invalidOrigin() {
  return new Error("UNTRUSTED_ORIGIN");
}

function headerValue(request, name) {
  const headers = request?.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) ?? "");
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return Array.isArray(value) ? value.join(",") : String(value ?? "");
  }
  return "";
}

function pathAllowlist(options = {}) {
  const configured = options.allowedPaths ?? options.allowlist ?? options.nextPathAllowlist;
  if (configured === undefined) return DEFAULT_ALLOWED_PATHS;
  const values = configured instanceof Set ? [...configured] : Array.isArray(configured) ? configured : [];
  const allowed = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/u.test(value)) continue;
    const candidate = value.startsWith("/") ? value : `/${value}`;
    if (!candidate.startsWith("//") && !candidate.includes("?") && !candidate.includes("#")) {
      allowed.add(candidate);
    }
  }
  return allowed;
}

function assertNoEncodedDanger(value) {
  if (/[\\\u0000-\u001f\u007f]/u.test(value) || /%(?:2f|2F|5c|5C|00|0d|0D|0a|0A)/u.test(value)) {
    throw invalidNext();
  }
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw invalidNext();
  }
  if (/[\\\u0000-\u001f\u007f]/u.test(decoded) || /(?:^|\/)\.\.?(?:\/|$)/u.test(decoded)) {
    throw invalidNext();
  }
}

/** Normalize and validate a same-origin relative redirect target. */
export function safeNextPath(input, options = {}) {
  if (typeof input !== "string" || input.length === 0 || input.trim() !== input) throw invalidNext();
  assertNoEncodedDanger(input);
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\\)/u.test(input) || input.startsWith("//")) {
    throw invalidNext();
  }

  const candidate = input.startsWith("/") ? input : `/${input}`;
  const separator = Math.min(
    ...[candidate.indexOf("?"), candidate.indexOf("#")].filter((value) => value >= 0),
    candidate.length
  );
  const path = candidate.slice(0, separator);
  if (!path || path.startsWith("//") || path.includes("\\") || path.includes(":")) throw invalidNext();
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    throw invalidNext();
  }
  if (decodedPath !== path || decodedPath.startsWith("//") || decodedPath.includes("\\") || decodedPath.includes(":")) {
    throw invalidNext();
  }
  if (!pathAllowlist(options).has(path)) throw invalidNext();

  const suffix = candidate.slice(separator);
  if (/[\u0000-\u001f\u007f]/u.test(suffix)) throw invalidNext();
  return `${path}${suffix}`;
}

function trustedOrigins(options) {
  const raw = typeof options === "string"
    ? options
    : options?.trustedOrigins ?? options?.allowedOrigins ?? options?.trustedOrigin ?? options?.origin ??
      process.env.AUTH_TRUSTED_ORIGIN ?? process.env.SITE_ORIGIN ?? process.env.URL ?? "";
  const values = Array.isArray(raw) ? raw : [raw];
  return values.flatMap((value) => {
    if (typeof value !== "string" || !value.trim()) return [];
    try {
      const parsed = new URL(value.trim());
      if (!parsed.origin || parsed.username || parsed.password || parsed.pathname !== "/" && parsed.pathname !== "" || parsed.search || parsed.hash) return [];
      return [parsed.origin];
    } catch {
      return [];
    }
  });
}

/** Require an exact configured Origin for state-changing browser requests. */
export function assertTrustedOrigin(request, options = {}) {
  const origin = headerValue(request, "origin");
  const allowed = trustedOrigins(options);
  if (!origin || origin === "null" || origin.includes(",") || allowed.length === 0) throw invalidOrigin();
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw invalidOrigin();
  }
  if (parsed.origin !== origin || !allowed.includes(parsed.origin)) throw invalidOrigin();
  return parsed.origin;
}

function cookieMaxAge(value) {
  const maxAge = Number(value);
  if (!Number.isSafeInteger(maxAge) || maxAge < 0) throw new Error("INVALID_COOKIE_MAX_AGE");
  return maxAge;
}

export function sessionCookie(value, maxAge) {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("INVALID_SESSION_COOKIE");
  }
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; Max-Age=${cookieMaxAge(maxAge)}; Secure; HttpOnly; SameSite=Lax`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

export function preauthCookie(value, maxAge = 10 * 60) {
  const token = opaqueToken(value, "INVALID_PREAUTH");
  const age = cookieMaxAge(maxAge);
  return `${PREAUTH_COOKIE_NAME}=${token}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Lax`;
}

export function clearPreauthCookie() {
  return `${PREAUTH_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

function opaqueToken(value, code) {
  if (typeof value !== "string" || value.length !== OPAQUE_TOKEN_LENGTH ||
      !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(code);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== OPAQUE_TOKEN_BYTES || decoded.toString("base64url") !== value) {
    throw new Error(code);
  }
  return value;
}

/** A readable double-submit token used only for browser write protection. */
export function csrfCookie(value, maxAge = 14 * 24 * 60 * 60) {
  const token = opaqueToken(value, "INVALID_CSRF");
  const age = Number(maxAge);
  if (!Number.isSafeInteger(age) || age < 0) throw new Error("INVALID_CSRF");
  return `${CSRF_COOKIE_NAME}=${token}; Path=/; Max-Age=${age}; Secure; SameSite=Lax`;
}

export function clearCsrfCookie() {
  return `${CSRF_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; SameSite=Lax`;
}

function cookieValue(request, name) {
  const header = headerValue(request, "cookie");
  let found = null;
  for (const segment of header.split(";")) {
    const trimmed = segment.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0 || trimmed.slice(0, separator).trim() !== name) continue;
    if (found !== null) return null;
    found = trimmed.slice(separator + 1);
  }
  return found;
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/** Require the CSRF header to match the readable same-origin CSRF cookie. */
export function assertCsrf(request) {
  const cookie = cookieValue(request, CSRF_COOKIE_NAME);
  const header = headerValue(request, "x-csrf-token");
  try {
    opaqueToken(cookie, "INVALID_CSRF");
    opaqueToken(header, "INVALID_CSRF");
  } catch {
    throw new Error("INVALID_CSRF");
  }
  if (!constantTimeEqual(cookie, header)) throw new Error("INVALID_CSRF");
  return true;
}

/** Require the strict pre-auth cookie to bind this callback to its browser. */
export function assertPreauthState(request, state) {
  const expected = opaqueToken(state, "INVALID_PREAUTH");
  const cookie = cookieValue(request, PREAUTH_COOKIE_NAME);
  const actual = opaqueToken(cookie, "INVALID_PREAUTH");
  if (!constantTimeEqual(actual, expected)) throw new Error("INVALID_PREAUTH");
  return true;
}

export { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, PREAUTH_COOKIE_NAME };
