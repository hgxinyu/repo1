import { authJson } from "./_shared/auth/http.mjs";
import {
  authErrorResponse,
  assertBrowserWriteRequest,
  createAuthRuntime,
  requireRequestCapability
} from "./_shared/auth/runtime.mjs";

export function createVipRequestHandler(overrides = {}) {
  const runtime = createAuthRuntime(overrides);
  const json = overrides.json || authJson;

  return async function vipRequestHandler(req) {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
    }

    let context;
    let body = {};
    try {
      assertBrowserWriteRequest(req, overrides);
      ({ context } = await requireRequestCapability(runtime, req, "canAccessRegistered"));
      body = await req.json();
    } catch (error) {
      if (error instanceof SyntaxError || error?.message === "Unexpected end of JSON input") {
        return json({ error: "Invalid JSON" }, { status: 400 });
      }
      return authErrorResponse(error, json, 401);
    }

    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
      return json({ error: "Invalid JSON" }, { status: 400 });
    }

    try {
      const profile = await runtime.accountRepository.requestVip({
        accountId: context.accountId
      });
      return json({ ok: true, profile });
    } catch (error) {
      return authErrorResponse(error, json, 503);
    }
  };
}

export default async function vipRequest(request) {
  return createVipRequestHandler()(request);
}

export const config = {
  path: "/api/vip-request"
};
