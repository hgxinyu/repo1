import { createSessionRepository } from "./_shared/auth/session-repository.mjs";
import { createLogtoClient } from "./_shared/auth/logto-client.mjs";
import {
  authJson,
  authRedirect,
  clearPreauthCookie,
  preauthCookie,
  safeNextPath
} from "./_shared/auth/http.mjs";

const PREAUTH_MAX_AGE_SECONDS = 10 * 60;

function publicError(error, fallbackStatus = 500, headers = {}) {
  const code = String(error?.code || error?.message || "");
  const status = [400, 401, 403, 409, 429, 500, 502, 503].includes(error?.status)
    ? error.status
    : code === "INVALID_NEXT" || code === "AUTH_CONNECTOR_UNAVAILABLE" || code === "AUTH_LOCALE_INVALID"
      ? 400
      : fallbackStatus;
  const message = status >= 500 ? "Authentication service unavailable" : "Invalid authentication request";
  return authJson({ error: message }, { status, headers });
}

function connectorHint(value) {
  if (value === null || value === undefined || value === "") return undefined;
  if (value !== "google" && value !== "email") {
    const error = new Error("AUTH_CONNECTOR_UNAVAILABLE");
    error.code = "AUTH_CONNECTOR_UNAVAILABLE";
    error.status = 400;
    throw error;
  }
  return value;
}

export function createAuthSignInHandler(overrides = {}) {
  const sessionRepository = overrides.sessionRepository ||
    createSessionRepository(overrides.sessionRepositoryOptions || {});
  const logtoClient = overrides.logtoClient ||
    createLogtoClient(overrides.logtoClientOptions || {});
  const nextPath = overrides.safeNextPath || safeNextPath;

  return async function authSignIn(request) {
    if (request?.method !== "GET") {
      return authJson({ error: "Method not allowed" }, {
        status: 405,
        headers: { Allow: "GET", "Set-Cookie": clearPreauthCookie() }
      });
    }

    try {
      const url = new URL(request.url);
      const rawNext = url.searchParams.get("next") || "/";
      const validatedNext = nextPath(
        rawNext,
        overrides.allowedPaths === undefined ? {} : { allowedPaths: overrides.allowedPaths }
      );
      const hintFromConnector = url.searchParams.get("connector");
      const hintFromAlias = url.searchParams.get("connectorHint");
      if (hintFromConnector && hintFromAlias && hintFromConnector !== hintFromAlias) {
        const error = new Error("AUTH_CONNECTOR_UNAVAILABLE");
        error.code = "AUTH_CONNECTOR_UNAVAILABLE";
        error.status = 400;
        throw error;
      }
      const hint = connectorHint(hintFromConnector || hintFromAlias);
      const transaction = await sessionRepository.createOAuthTransaction({
        nextPath: validatedNext
      });
      const authorizationUrl = await logtoClient.buildAuthorizationUrl({
        transaction,
        locale: url.searchParams.get("locale") || "en-US",
        connectorHint: hint
      });
      return authRedirect(authorizationUrl, 302, {
        "Set-Cookie": [preauthCookie(transaction.state, PREAUTH_MAX_AGE_SECONDS)]
      });
    } catch (error) {
      return publicError(error, 502, { "Set-Cookie": clearPreauthCookie() });
    }
  };
}

export default async function authSignIn(request) {
  return createAuthSignInHandler()(request);
}

export const config = {
  path: "/api/auth/sign-in"
};
