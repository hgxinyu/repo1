import { authJson } from "./_shared/auth/http.mjs";
import {
  authErrorResponse,
  assertBrowserWriteRequest,
  createAuthRuntime,
  requireRequestCapability
} from "./_shared/auth/runtime.mjs";
import {
  publicQualityPrices,
  readQualityPrices as defaultReadQualityPrices,
  writeQualityPrices as defaultWriteQualityPrices
} from "./_shared/quality-prices.mjs";

export function createAdminQualityPricesHandler(overrides = {}) {
  const runtime = createAuthRuntime(overrides);
  const json = overrides.json || authJson;
  const readQualityPrices = overrides.readQualityPrices || defaultReadQualityPrices;
  const writeQualityPrices = overrides.writeQualityPrices || defaultWriteQualityPrices;

  return async function adminQualityPrices(request) {
    if (request?.method !== "GET" && request?.method !== "POST") {
      return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET, POST" } });
    }
    if (request?.method === "POST") {
      try {
        assertBrowserWriteRequest(request, overrides);
      } catch (error) {
        return authErrorResponse(error, json, 403);
      }
    }
    let context;
    try {
      ({ context } = await requireRequestCapability(runtime, request, "isAdmin"));
    } catch (error) {
      return authErrorResponse(error, json, 401);
    }

    if (request?.method === "GET") {
      try {
        const prices = await readQualityPrices();
        return json(publicQualityPrices(prices));
      } catch (error) {
        return authErrorResponse(error, json, 503);
      }
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, { status: 400 });
    }
    try {
      const prices = await writeQualityPrices(body, context.accountId);
      return json({ ok: true, prices });
    } catch (error) {
      return authErrorResponse(error, json, 400);
    }
  };
}

export default async function adminQualityPrices(request) {
  return createAdminQualityPricesHandler()(request);
}

export const config = {
  path: "/api/admin/quality-prices"
};
