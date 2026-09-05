import { authJson } from "./_shared/auth/http.mjs";
import { authErrorResponse, createAuthRuntime } from "./_shared/auth/runtime.mjs";

const ANONYMOUS = Object.freeze({
  authenticated: false,
  accountId: null,
  role: "anonymous",
  canAccessRegistered: false,
  canAccessPremium: false,
  canAccessSvip: false,
  isAdmin: false,
  profile: null
});

function canonicalProfile(account, primaryEmailMasked = "") {
  return {
    primaryEmailMasked: String(primaryEmailMasked || ""),
    guild: account.guild || "",
    gameName: account.gameName || "",
    status: account.status || ""
  };
}

export function createMeHandler(overrides = {}) {
  const runtime = createAuthRuntime(overrides);
  const json = overrides.json || authJson;

  return async function meHandler(request) {
    if (request?.method && request.method !== "GET") {
      return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET" } });
    }
    try {
      const context = await runtime.resolveAuthContext(request);
      if (!context) return json(ANONYMOUS, { status: 401 });
      let primaryEmailMasked = "";
      if (typeof runtime.accountRepository?.getPrimaryEmailMasked === "function") {
        primaryEmailMasked = await runtime.accountRepository.getPrimaryEmailMasked(context.accountId);
      }
      const capabilities = context.capabilities;
      return json({
        authenticated: true,
        accountId: context.accountId,
        role: capabilities.role,
        canAccessRegistered: capabilities.canAccessRegistered,
        canAccessPremium: capabilities.canAccessPremium,
        canAccessSvip: capabilities.canAccessSvip,
        isAdmin: capabilities.isAdmin,
        profile: canonicalProfile(context.account, primaryEmailMasked)
      });
    } catch (error) {
      return authErrorResponse(error, json, 401);
    }
  };
}

export default async function me(request) {
  return createMeHandler()(request);
}

export const config = {
  path: "/api/me"
};
