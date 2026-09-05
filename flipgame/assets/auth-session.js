const STORAGE_KEY = "gotrue.user";
const LEGACY_COOKIE_NAMES = Object.freeze(["nf_jwt", "nf_refresh"]);
const LEGACY_SESSION_COOKIE = "nf_jwt";
const CSRF_COOKIE = "__Host-shinegame_csrf";
const BRIDGE_ENDPOINT = "/api/auth/legacy-bridge";
const LOGOUT_FALLBACK_PATH = "/Login.html?auth=logged-out";

let bridgeInFlight = null;
let bridgeAttempted = false;
let bridgeResult = false;

const ANONYMOUS_AUTH_STATE = Object.freeze({
  authenticated: false,
  accountId: null,
  capabilities: null
});

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function browserAvailable() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/** Static mock is file:// or the documented Python preview server on :8000. */
export function isStaticMockPreview() {
  if (!browserAvailable() || !window.location) return false;
  if (window.location.protocol === "file:") return true;
  const host = String(window.location.hostname || "").toLowerCase();
  const localHost = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1"
    || /^(?:10|192\.168)\./u.test(host)
    || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host);
  return localHost && String(window.location.port || "") === "8000";
}

function cookieValue(name) {
  if (!browserAvailable()) return null;
  let found = null;
  for (const segment of String(document.cookie || "").split(";")) {
    const trimmed = segment.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0 || trimmed.slice(0, separator).trim() !== name) continue;
    if (found !== null) return null;
    found = trimmed.slice(separator + 1);
  }
  return found;
}

/** Read only the browser-readable double-submit token. Never read a session token. */
export function readCsrfToken() {
  return cookieValue(CSRF_COOKIE);
}

function cookieOptions() {
  return "path=/; secure; samesite=lax";
}

function writeCookie(name, value, maxAge = null) {
  if (!browserAvailable() || !value) return;
  const age = maxAge === null ? "" : `; max-age=${Math.max(0, Math.floor(maxAge))}`;
  document.cookie = `${name}=${encodeURIComponent(value)}${age}; ${cookieOptions()}`;
}

function clearCookie(name) {
  if (!browserAvailable()) return;
  document.cookie = `${name}=; max-age=0; ${cookieOptions()}`;
}

/** Detect whether a legacy browser state exists without reading its secrets. */
export function hasLegacyIdentityState() {
  if (!browserAvailable() || isStaticMockPreview()) return false;
  try {
    if (window.localStorage.getItem(STORAGE_KEY)) return true;
  } catch {
    // A cookie can still prove that a bridge attempt is worth making.
  }
  return Boolean(cookieValue(LEGACY_SESSION_COOKIE));
}

function csrfToken() {
  const existing = readCsrfToken();
  if (existing) return existing;
  if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== "function") return null;
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const value = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  const encoded = globalThis.btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
  if (encoded.length !== 43) return null;
  writeCookie(CSRF_COOKIE, encoded);
  return encoded;
}

function browserOrigin() {
  if (!browserAvailable()) return "";
  const origin = typeof window.location.origin === "string" ? window.location.origin : "";
  if (origin && origin !== "null") return origin;
  const protocol = typeof window.location.protocol === "string" ? window.location.protocol : "";
  const host = typeof window.location.host === "string" && window.location.host ? window.location.host : "localhost";
  return /^(?:https?:|http:)/u.test(protocol) ? `${protocol}//${host}` : "";
}

function authError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizedHeaders(input) {
  if (input && typeof input.forEach === "function") {
    const headers = {};
    input.forEach((value, key) => { headers[key] = value; });
    return headers;
  }
  return { ...(input || {}) };
}

/**
 * Same-origin browser request helper for the first-party BFF. Cookies remain
 * browser-managed; this helper never writes or exposes provider credentials.
 */
export async function authFetch(input, options = {}) {
  if (!browserAvailable() || isStaticMockPreview()) {
    throw authError("AUTH_BROWSER_UNAVAILABLE", "Authentication is unavailable in static preview");
  }
  if (typeof input !== "string" || !input.startsWith("/api/") || input.startsWith("//") || input.includes("\\")) {
    throw authError("AUTH_ENDPOINT_INVALID", "Authentication requests must use a relative BFF path");
  }
  try {
    const parsed = new URL(input, browserOrigin());
    if (parsed.origin !== browserOrigin() || !parsed.pathname.startsWith("/api/")) {
      throw authError("AUTH_ENDPOINT_INVALID", "Authentication requests must use the same-origin BFF");
    }
  } catch (error) {
    if (error && error.code === "AUTH_ENDPOINT_INVALID") throw error;
    throw authError("AUTH_ENDPOINT_INVALID", "Authentication requests must use the same-origin BFF");
  }
  const method = String(options.method || "GET").toUpperCase();
  const headers = normalizedHeaders(options.headers);
  if (MUTATING_METHODS.has(method)) {
    const csrf = readCsrfToken();
    if (!csrf) throw authError("AUTH_CSRF_MISSING", "CSRF token unavailable");
    headers["X-CSRF-Token"] = csrf;
  }
  const fetchOptions = {
    ...options,
    method,
    credentials: "include",
    headers
  };
  // Keep BFF calls relative so the browser supplies the trusted Origin header
  // automatically. JavaScript must not set the forbidden Origin header.
  return window.fetch(input, fetchOptions);
}

async function responseJson(response) {
  if (!response || typeof response.json !== "function") return null;
  try {
    const data = await response.json();
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function normalizedCapabilities(data) {
  const nested = data && typeof data.capabilities === "object" && !Array.isArray(data.capabilities);
  const source = nested ? data.capabilities : data;
  if (!source || typeof source !== "object") return null;
  const requiredBooleans = ["authenticated", "canAccessRegistered", "canAccessPremium", "isAdmin"];
  if (source.authenticated !== true || requiredBooleans.some((key) => typeof source[key] !== "boolean")) return null;
  const role = typeof source.role === "string" && source.role.trim() ? source.role.trim().toLowerCase() : "";
  if (!["pending", "free", "vip", "svip", "admin"].includes(role)) return null;
  const outerRole = typeof data.role === "string" ? data.role.trim().toLowerCase() : "";
  const status = nested
    ? (typeof data.status === "string" ? data.status.trim().toLowerCase() : "")
    : (typeof data.profile?.status === "string" ? data.profile.status.trim().toLowerCase() : "");
  if (!status || status !== "active") return null;
  if (nested && (typeof source.blocked !== "boolean" || !outerRole || outerRole !== role)) return null;
  if (!nested && (!outerRole || outerRole !== role)) return null;
  if (source.blocked === true) return null;
  const expected = {
    pending: { premium: false, admin: false },
    free: { premium: false, admin: false },
    vip: { premium: true, admin: false },
    svip: { premium: true, admin: false },
    admin: { premium: true, admin: true }
  }[role];
  if (!source.canAccessRegistered || source.canAccessPremium !== expected.premium || source.isAdmin !== expected.admin) return null;
  const expectedSvip = role === "svip" || role === "admin";
  if (source.canAccessSvip !== undefined && source.canAccessSvip !== expectedSvip) return null;
  if (role === "svip" && source.canAccessSvip !== true) return null;
  return Object.freeze({
    authenticated: true,
    role,
    blocked: false,
    canAccessRegistered: true,
    canAccessPremium: source.canAccessPremium,
    canAccessSvip: source.canAccessSvip === true,
    isAdmin: source.isAdmin
  });
}

/** Normalize BFF responses so malformed, anonymous, and error states fail closed. */
export function normalizeAuthState(data, responseOk = true) {
  if (!responseOk || !data || typeof data !== "object" || Array.isArray(data) || data.authenticated !== true) {
    return { ...ANONYMOUS_AUTH_STATE };
  }
  const accountId = typeof data.accountId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(data.accountId.trim())
    ? data.accountId.trim().toLowerCase()
    : "";
  const capabilities = normalizedCapabilities(data);
  if (!accountId || !capabilities) {
    return { ...ANONYMOUS_AUTH_STATE };
  }
  const result = {
    authenticated: true,
    accountId,
    capabilities
  };
  if (typeof data.role === "string") result.role = data.role.trim().toLowerCase();
  if (typeof data.status === "string") result.status = data.status.trim().toLowerCase();
  if (typeof data.authSource === "string") result.authSource = data.authSource.trim();
  if (data.profile && typeof data.profile === "object" && !Array.isArray(data.profile)) {
    result.profile = {
      primaryEmailMasked: typeof data.profile.primaryEmailMasked === "string" ? data.profile.primaryEmailMasked : "",
      guild: typeof data.profile.guild === "string" ? data.profile.guild : "",
      gameName: typeof data.profile.gameName === "string" ? data.profile.gameName : "",
      status: typeof data.profile.status === "string" ? data.profile.status : ""
    };
  }
  return result;
}

async function fetchNormalizedAuth(path) {
  if (!browserAvailable() || isStaticMockPreview()) return { ...ANONYMOUS_AUTH_STATE };
  if (hasLegacyIdentityState()) await bridgeLegacySession();
  try {
    const response = await authFetch(path, { method: "GET", headers: { Accept: "application/json" } });
    return normalizeAuthState(await responseJson(response), Boolean(response && response.ok));
  } catch {
    return { ...ANONYMOUS_AUTH_STATE };
  }
}

export function getAuthSession() {
  return fetchNormalizedAuth("/api/auth/session");
}

export function getAuthMe() {
  return fetchNormalizedAuth("/api/me");
}

function safeLogoutEndSessionUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname.toLowerCase().endsWith(".logto.app") ||
      parsed.username || parsed.password || parsed.hash || parsed.pathname !== "/oidc/session/end") {
    return null;
  }
  const keys = [...parsed.searchParams.keys()];
  if (keys.length !== 2 || !keys.includes("client_id") || !keys.includes("post_logout_redirect_uri") ||
      parsed.searchParams.has("id_token_hint")) return null;
  let postLogoutRedirect;
  try {
    postLogoutRedirect = new URL(parsed.searchParams.get("post_logout_redirect_uri"));
  } catch {
    return null;
  }
  const local = postLogoutRedirect.hostname === "localhost" || postLogoutRedirect.hostname === "127.0.0.1";
  if ((local ? !["http:", "https:"].includes(postLogoutRedirect.protocol) :
    postLogoutRedirect.protocol !== "https:") || postLogoutRedirect.pathname !== "/Login.html" ||
      postLogoutRedirect.search !== "?auth=logged-out" || postLogoutRedirect.hash ||
      postLogoutRedirect.username || postLogoutRedirect.password ||
      postLogoutRedirect.origin !== browserOrigin()) return null;
  return parsed.href;
}

export async function logout() {
  if (!browserAvailable() || isStaticMockPreview()) return false;
  const response = await authFetch("/api/auth/logout", {
    method: "POST",
    headers: { Accept: "application/json" }
  });
  if (!response || !response.ok) {
    throw authError("AUTH_LOGOUT_FAILED", `Logout failed (${response ? response.status : "network"})`);
  }
  const payload = await responseJson(response);
  const endSessionUrl = safeLogoutEndSessionUrl(payload?.endSessionUrl);
  clearLegacyBrowserState();
  const target = endSessionUrl || LOGOUT_FALLBACK_PATH;
  window.location.assign(target);
  return target;
}

const SAFE_REDIRECT_PATHS = new Set([
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

/** Keep browser redirects aligned with the server's finite safe-next allowlist. */
export function safeAuthRedirectPath(value, fallback = "/index.html") {
  const raw = typeof value === "string" ? value.trim() : "";
  const candidate = raw.startsWith("/") ? raw : `/${raw}`;
  const path = candidate.split(/[?#]/u, 1)[0];
  return SAFE_REDIRECT_PATHS.has(path) ? path : fallback;
}

function currentNextPath() {
  if (!browserAvailable()) return "/index.html";
  return safeAuthRedirectPath(window.location.pathname || "/");
}

function clearLegacyBrowserState() {
  if (!browserAvailable()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Cookie clearing below remains best effort.
  }
  for (const name of LEGACY_COOKIE_NAMES) clearCookie(name);
}

/**
 * Exchange an already authenticated legacy browser state for a first-party
 * session. Legacy browser state is removed only after the server responds with
 * a successful bridge redirect.
 */
export async function bridgeLegacySession(next = currentNextPath()) {
  if (!browserAvailable() || isStaticMockPreview() || !hasLegacyIdentityState()) return false;
  if (bridgeAttempted) return bridgeResult;
  if (bridgeInFlight) return bridgeInFlight;

  bridgeInFlight = (async () => {
    bridgeAttempted = true;
    const csrf = csrfToken();
    if (!csrf) return false;
    const target = safeAuthRedirectPath(next, currentNextPath());
    let response;
    try {
      response = await authFetch(
        `${BRIDGE_ENDPOINT}?next=${encodeURIComponent(target)}`,
        {
          method: "POST",
          credentials: "include",
          redirect: "error",
          headers: {
            Accept: "application/json",
            "X-CSRF-Token": csrf
          }
        }
      );
    } catch {
      return false;
    }
    const status = Number(response && response.status);
    const success = (status >= 200 && status < 300) || (status >= 300 && status < 400);
    if (!success) return false;
    clearLegacyBrowserState();
    bridgeResult = true;
    return true;
  })().finally(() => {
    bridgeInFlight = null;
  });

  return bridgeInFlight;
}

// Legacy state is intentionally limited to presence detection plus the
// confirmed server-side bridge above; no browser Identity session is restored.
