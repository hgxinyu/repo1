const STORAGE_KEY = "gotrue.user";
const ACCESS_COOKIE = "nf_jwt";
const REFRESH_COOKIE = "nf_refresh";

export const IDENTITY_SESSION_DAYS = 14;

function cookieBase(maxAgeSeconds) {
  const parts = [
    "path=/",
    `max-age=${maxAgeSeconds}`,
    "samesite=lax"
  ];
  if (window.location.protocol === "https:") {
    parts.push("secure");
  }
  return parts.join("; ");
}

function setCookie(name, value, maxAgeSeconds) {
  if (!value) return;
  document.cookie = `${name}=${encodeURIComponent(value)}; ${cookieBase(maxAgeSeconds)}`;
}

function clearCookie(name) {
  const secure = window.location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${name}=; path=/; max-age=0; samesite=lax${secure}`;
}

function readStoredToken() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    return session && session.token ? session.token : null;
  } catch {
    return null;
  }
}

export function persistIdentityCookiesFromStorage(days = IDENTITY_SESSION_DAYS) {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const token = readStoredToken();
  const accessToken = token && token.access_token;
  const refreshToken = token && token.refresh_token;
  if (!accessToken) return false;

  const maxAgeSeconds = Math.max(1, Math.round(days * 24 * 60 * 60));
  setCookie(ACCESS_COOKIE, accessToken, maxAgeSeconds);
  if (refreshToken) {
    setCookie(REFRESH_COOKIE, refreshToken, maxAgeSeconds);
  }
  return true;
}

export function clearPersistentIdentityCookies() {
  if (typeof document === "undefined") return;
  clearCookie(ACCESS_COOKIE);
  clearCookie(REFRESH_COOKIE);
}

export function installIdentityCookiePersistence(identityApi, days = IDENTITY_SESSION_DAYS) {
  if (!identityApi || typeof identityApi.onAuthChange !== "function") return null;
  return identityApi.onAuthChange(() => {
    persistIdentityCookiesFromStorage(days);
  });
}

export async function restoreIdentitySession(identityApi, days = IDENTITY_SESSION_DAYS) {
  if (!identityApi) return null;
  await identityApi.handleAuthCallback().catch(() => null);
  persistIdentityCookiesFromStorage(days);
  if (typeof identityApi.hydrateSession === "function") {
    await identityApi.hydrateSession().catch(() => null);
  }
  if (typeof identityApi.refreshSession === "function") {
    await identityApi.refreshSession().catch(() => null);
  }
  persistIdentityCookiesFromStorage(days);
  const user = await identityApi.getUser().catch(() => null);
  if (user) {
    persistIdentityCookiesFromStorage(days);
  }
  return user;
}
