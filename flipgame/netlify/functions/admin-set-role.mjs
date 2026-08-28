import { authJson } from "./_shared/auth/http.mjs";
import {
  authErrorResponse,
  assertBrowserWriteRequest,
  createAuthRuntime,
  requireRequestCapability
} from "./_shared/auth/runtime.mjs";
import { isValidAccountId } from "./_shared/auth/account-repository.mjs";

const ALLOWED_ROLES = new Set(["pending", "free", "vip", "admin", "blocked"]);

export function createAdminSetRoleHandler(overrides = {}) {
  const runtime = createAuthRuntime(overrides);
  const json = overrides.json || authJson;

  return async function adminSetRoleHandler(req) {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
    }

    let context;
    try {
      assertBrowserWriteRequest(req, overrides);
      ({ context } = await requireRequestCapability(runtime, req, "isAdmin"));
    } catch (error) {
      return authErrorResponse(error, json, 401);
    }

    let body = {};
    try {
      body = await req.json();
    } catch (error) {
      return json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "Invalid JSON" }, { status: 400 });
    }
    const rawAccountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
    if (!isValidAccountId(rawAccountId)) return json({ error: "Account ID is invalid" }, { status: 400 });
    const accountId = rawAccountId.toLowerCase();
    const role = typeof body.role === "string" ? body.role.trim().toLowerCase() : "";
    if (!ALLOWED_ROLES.has(role)) return json({ error: "Role is invalid" }, { status: 400 });
    if (accountId === String(context.accountId || "").trim().toLowerCase() && role !== "admin") {
      return json({ error: "Cannot remove your own admin access" }, { status: 409 });
    }
    const status = role === "blocked" ? "blocked" : "active";
    try {
      const result = await runtime.accountRepository.setAuthorization({
        actorAccountId: context.accountId,
        targetAccountId: accountId,
        role,
        status,
        metadata: { operation: "admin-set-role" }
      });
      return json({
        ok: true,
        account: result.account,
        revokedSessionCount: result.revokedSessionCount || 0
      });
    } catch (error) {
      return authErrorResponse(error, json, 503);
    }
  };
}

export default async function adminSetRole(request) {
  return createAdminSetRoleHandler()(request);
}

export const config = {
  path: "/api/admin/set-role"
};
