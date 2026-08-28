import { authJson } from "./_shared/auth/http.mjs";
import {
  authErrorResponse,
  assertBrowserWriteRequest,
  createAuthRuntime,
  requireRequestCapability
} from "./_shared/auth/runtime.mjs";
import { isValidAccountId } from "./_shared/auth/account-repository.mjs";

export function createAdminDeleteUserHandler(overrides = {}) {
  const runtime = createAuthRuntime(overrides);
  const json = overrides.json || authJson;

  return async function adminDeleteUserHandler(req) {
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
    if (accountId === String(context.accountId || "").trim().toLowerCase()) {
      return json({ error: "Cannot delete your own admin account" }, { status: 409 });
    }
    try {
      const result = await runtime.accountRepository.deleteAccount({
        actorAccountId: context.accountId,
        targetAccountId: accountId
      });
      return json({
        ok: true,
        accountId: result.accountId,
        authzVersion: result.authzVersion,
        revokedSessionCount: result.revokedSessionCount || 0
      });
    } catch (error) {
      return authErrorResponse(error, json, 503);
    }
  };
}

export default async function adminDeleteUser(request) {
  return createAdminDeleteUserHandler()(request);
}

export const config = {
  path: "/api/admin/delete-user"
};
