import { createSessionRepository } from "./_shared/auth/session-repository.mjs";
import { createLogtoClient } from "./_shared/auth/logto-client.mjs";
import {
  assertTrustedOrigin,
  assertCsrf,
  authJson,
  clearCsrfCookie,
  clearSessionCookie
} from "./_shared/auth/http.mjs";

function publicError(error, fallbackStatus = 503) {
  const status = [400, 401, 403, 409, 429, 500, 502, 503].includes(error?.status)
    ? error.status
    : fallbackStatus;
  return authJson({ error: status === 403 ? "请求来源不可信" : "Logout unavailable" }, { status });
}

function trustedOrigins(overrides) {
  return overrides.trustedOrigins ?? overrides.trustedOrigin ?? process.env.AUTH_TRUSTED_ORIGIN ??
    process.env.SITE_ORIGIN ?? process.env.URL ?? "";
}

function safeEndSessionUrl(value, logtoClient) {
  if (!(value instanceof URL) || value.protocol !== "https:" || value.username ||
      value.password || value.hash || value.searchParams.has("id_token_hint")) return null;
  try {
    const issuer = new URL(logtoClient.issuerOrTenant);
    if (value.origin !== issuer.origin) return null;
  } catch {
    return null;
  }
  return value.href;
}

export function createAuthLogoutHandler(overrides = {}) {
  const sessionRepository = overrides.sessionRepository ||
    createSessionRepository(overrides.sessionRepositoryOptions || {});
  const logtoClient = overrides.logtoClient ||
    createLogtoClient(overrides.logtoClientOptions || {});

  return async function authLogout(request) {
    if (request?.method !== "POST") {
      return authJson({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
    }
    try {
      assertTrustedOrigin(request, { trustedOrigins: trustedOrigins(overrides) });
      assertCsrf(request);
    } catch (error) {
      return publicError({ ...error, status: 403 }, 403);
    }

    let revoked;
    try {
      if (typeof sessionRepository.revokeSessionFromCookie === "function") {
        revoked = await sessionRepository.revokeSessionFromCookie({ request });
      } else {
        const current = typeof sessionRepository.readValidSessionFromCookie === "function"
          ? await sessionRepository.readValidSessionFromCookie(request)
          : null;
        if (current && typeof sessionRepository.revokeSessionFamily === "function" && current.sessionFamilyId) {
          await sessionRepository.revokeSessionFamily({
            accountId: current.accountId,
            sessionFamilyId: current.sessionFamilyId
          });
          revoked = current;
        }
      }
    } catch (error) {
      return publicError(error, 503);
    }

    // Local revocation is already complete before attempting provider
    // revocation. A provider outage must not keep the app session alive.
    if (revoked?.authSource === "logto" && revoked.refreshToken) {
      try {
        await logtoClient.revokeLogtoGrant({ refreshToken: revoked.refreshToken });
      } catch {
        // Do not expose provider details or turn a successful local logout
        // into a retry loop in the browser.
      }
    }
    let endSessionUrl = null;
    if (typeof logtoClient.buildEndSessionUrl === "function") {
      try {
        endSessionUrl = safeEndSessionUrl(await logtoClient.buildEndSessionUrl(), logtoClient);
      } catch {
        // Local revocation is the logout guarantee. If discovery or provider
        // sign-out URL construction is unavailable, the browser falls back to
        // the fixed first-party login path.
      }
    }
    return authJson({ ok: true, endSessionUrl }, {
      status: 200,
      headers: {
        "Set-Cookie": [clearSessionCookie(), clearCsrfCookie()]
      }
    });
  };
}

export default async function authLogout(request) {
  return createAuthLogoutHandler()(request);
}

export const config = {
  path: "/api/auth/logout"
};
